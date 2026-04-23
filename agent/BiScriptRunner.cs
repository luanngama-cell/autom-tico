using System.Data;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

/// <summary>
/// Executa um script SQL (que retorna 1 ou mais resultsets) no SQL Server e
/// monta um JSON snapshot. Cada resultset vira uma "section" pelo nome da
/// primeira coluna especial __section, ou "section_{N}" se não houver.
///
/// Convenção recomendada no script: SELECT 'kpis' AS __section, COUNT(*) AS pacientes ...
/// Se o script já produz um único JSON via FOR JSON, BiScriptRunner detecta:
/// quando há um único resultset com uma única coluna do tipo string contendo
/// JSON válido, usa esse objeto como snapshot diretamente.
/// </summary>
public class BiScriptRunner
{
    private readonly SqlOptions _sql;
    private readonly BiOptions _bi;
    private readonly ILogger<BiScriptRunner> _log;

    public BiScriptRunner(IOptions<SqlOptions> sql, IOptions<BiOptions> bi, ILogger<BiScriptRunner> log)
    {
        _sql = sql.Value;
        _bi = bi.Value;
        _log = log;
    }

    public bool Enabled => _bi.Enabled && !string.IsNullOrWhiteSpace(_bi.ScriptPath);

    public async Task<JsonDocument?> BuildSnapshotAsync(CancellationToken ct)
    {
        if (!Enabled) return null;

        if (!File.Exists(_bi.ScriptPath))
        {
            _log.LogError("BI script not found: {Path}", _bi.ScriptPath);
            return null;
        }

        var script = await File.ReadAllTextAsync(_bi.ScriptPath, ct);
        var connStr = BuildConnectionString();

        using var conn = new SqlConnection(connStr);
        await conn.OpenAsync(ct);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = script;
        cmd.CommandTimeout = _bi.CommandTimeoutSeconds;

        var sections = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        int sectionIndex = 0;

        using var reader = await cmd.ExecuteReaderAsync(ct);

        do
        {
            sectionIndex++;
            var schema = reader.GetSchemaTable();
            if (schema == null || reader.FieldCount == 0) continue;

            // Caso especial: 1 resultset, 1 coluna, valor é string JSON
            if (reader.FieldCount == 1 && sectionIndex == 1)
            {
                var firstColType = reader.GetFieldType(0);
                if (firstColType == typeof(string))
                {
                    var concat = new StringBuilder();
                    while (await reader.ReadAsync(ct))
                    {
                        if (!reader.IsDBNull(0)) concat.Append(reader.GetString(0));
                    }
                    var combined = concat.ToString().Trim();
                    if (combined.StartsWith("{") || combined.StartsWith("["))
                    {
                        try
                        {
                            // Se o script JÁ retorna o JSON completo, usa direto
                            var parsed = JsonDocument.Parse(combined);
                            if (parsed.RootElement.ValueKind == JsonValueKind.Object && !await reader.NextResultAsync(ct))
                            {
                                return parsed;
                            }
                            // se houver mais resultsets, registra como seção e segue
                            sections[$"section_{sectionIndex}"] = JsonSerializer.Deserialize<object>(combined)!;
                            continue;
                        }
                        catch { /* não era JSON, trata como tabela normal */ }
                    }
                    // se chegou aqui, era texto comum: salva como lista
                    sections[$"section_{sectionIndex}"] = new[] { combined };
                    continue;
                }
            }

            var rows = new List<Dictionary<string, object?>>();
            string? sectionName = null;

            while (await reader.ReadAsync(ct))
            {
                var row = new Dictionary<string, object?>(reader.FieldCount);
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    var name = reader.GetName(i);
                    var val = reader.IsDBNull(i) ? null : reader.GetValue(i);
                    if (string.Equals(name, "__section", StringComparison.OrdinalIgnoreCase))
                    {
                        sectionName ??= val?.ToString();
                        continue;
                    }
                    row[name] = NormalizeValue(val);
                }
                rows.Add(row);
            }

            var key = !string.IsNullOrWhiteSpace(sectionName)
                ? sectionName!
                : $"section_{sectionIndex}";

            // Se a seção retornou exatamente uma linha, expõe como objeto (KPIs).
            if (rows.Count == 1)
                sections[key] = rows[0];
            else
                sections[key] = rows;

        } while (await reader.NextResultAsync(ct));

        var envelope = new
        {
            generated_at = DateTime.UtcNow.ToString("o"),
            source = _sql.Database,
            sections,
        };

        var json = JsonSerializer.Serialize(envelope);
        return JsonDocument.Parse(json);
    }

    private static object? NormalizeValue(object? val)
    {
        return val switch
        {
            null => null,
            DateTime dt => dt.ToString("o"),
            DateTimeOffset dto => dto.ToString("o"),
            byte[] bytes => Convert.ToBase64String(bytes),
            decimal d => d,
            _ => val,
        };
    }

    private string BuildConnectionString()
    {
        var b = new SqlConnectionStringBuilder
        {
            DataSource = $"{_sql.Host},{_sql.Port}",
            InitialCatalog = _sql.Database,
            Encrypt = _sql.Encrypt,
            TrustServerCertificate = _sql.TrustServerCertificate,
            ConnectTimeout = _sql.ConnectTimeoutSeconds,
        };
        if (string.Equals(_sql.AuthMode, "Windows", StringComparison.OrdinalIgnoreCase))
        {
            b.IntegratedSecurity = true;
        }
        else
        {
            b.UserID = _sql.Username;
            b.Password = _sql.Password;
        }
        return b.ConnectionString;
    }
}
