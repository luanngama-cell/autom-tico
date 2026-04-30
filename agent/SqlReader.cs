using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

public record TableInfo(
    string SchemaName,
    string TableName,
    List<string> PrimaryKeys,
    bool HasRowVersion);

public record UpsertRow(
    Dictionary<string, object?> Pk,
    Dictionary<string, object?> Data,
    string RowHash);

/// <summary>
/// Resumo retornado após sync streaming de uma tabela.
/// NÃO contém as linhas — elas foram enviadas durante o stream via callback.
/// </summary>
public record TableStreamResult(
    TableInfo Table,
    string Strategy,
    long RowCount,
    string? LastChecksum,
    int TotalRowsStreamed,
    int TotalChunksSent);

/// <summary>
/// Callback para enviar um lote de upserts ao Cloud durante o stream.
/// Recebe: chunk de linhas, índice do chunk (1-based), total de chunks (-1 se desconhecido),
/// é o último? (último chunk inclui last_checksum e libera reconciliação).
/// Retorna false se o envio falhou — leitura é abortada.
/// </summary>
public delegate Task<bool> ChunkSenderAsync(
    IReadOnlyList<UpsertRow> chunk,
    int chunkIndex,
    int chunksTotal,
    bool isFinal,
    string? finalChecksum,
    CancellationToken ct);

public class SqlReader
{
    private readonly SqlOptions _opts;
    private readonly SyncOptions _sync;
    private readonly LargeTablesOptions _largeTables;
    private readonly ILogger<SqlReader> _log;

    public SqlReader(
        IOptions<SqlOptions> opts,
        IOptions<SyncOptions> sync,
        IOptions<LargeTablesOptions> largeTables,
        ILogger<SqlReader> log)
    {
        _opts = opts.Value;
        _sync = sync.Value;
        _largeTables = largeTables.Value;
        _log = log;
    }

    public bool IsLargeTable(string tableName) =>
        _largeTables.Tables.Contains(tableName, StringComparer.OrdinalIgnoreCase);

    private string ConnectionString
    {
        get
        {
            var b = new SqlConnectionStringBuilder
            {
                DataSource = $"{_opts.Host},{_opts.Port}",
                InitialCatalog = _opts.Database,
                Encrypt = _opts.Encrypt,
                TrustServerCertificate = _opts.TrustServerCertificate,
                ConnectTimeout = _opts.ConnectTimeoutSeconds,
                ApplicationName = "SqlSyncAgent",
            };

            if (string.Equals(_opts.AuthMode, "Windows", StringComparison.OrdinalIgnoreCase))
            {
                b.IntegratedSecurity = true;
            }
            else
            {
                b.UserID = _opts.Username;
                b.Password = _opts.Password;
            }

            return b.ConnectionString;
        }
    }

    public async Task<List<TableInfo>> DiscoverTablesAsync(CancellationToken ct)
    {
        var result = new List<TableInfo>();
        await using var conn = new SqlConnection(ConnectionString);
        await conn.OpenAsync(ct);

        var sql = @"
SELECT t.TABLE_SCHEMA, t.TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA = @schema
ORDER BY t.TABLE_NAME";

        var tableNames = new List<(string s, string t)>();
        await using (var cmd = new SqlCommand(sql, conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
        {
            cmd.Parameters.AddWithValue("@schema", _sync.Schema);
            await using var rd = await cmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct))
            {
                tableNames.Add((rd.GetString(0), rd.GetString(1)));
            }
        }

        foreach (var (schema, table) in tableNames)
        {
            if (_sync.ExcludedTables.Contains(table, StringComparer.OrdinalIgnoreCase)) continue;

            var pks = new List<string>();
            await using (var cmd = new SqlCommand(@"
SELECT kcu.COLUMN_NAME
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
 AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  AND tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t
ORDER BY kcu.ORDINAL_POSITION", conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
            {
                cmd.Parameters.AddWithValue("@s", schema);
                cmd.Parameters.AddWithValue("@t", table);
                await using var rd = await cmd.ExecuteReaderAsync(ct);
                while (await rd.ReadAsync(ct)) pks.Add(rd.GetString(0));
            }

            bool hasRv = false;
            await using (var cmd = new SqlCommand(@"
SELECT COUNT(*) FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = @s AND t.name = @t AND c.system_type_id = 189", conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
            {
                cmd.Parameters.AddWithValue("@s", schema);
                cmd.Parameters.AddWithValue("@t", table);
                hasRv = (int)(await cmd.ExecuteScalarAsync(ct) ?? 0) > 0;
            }

            if (pks.Count == 0)
            {
                _log.LogWarning("Skipping {Schema}.{Table}: no primary key", schema, table);
                continue;
            }

            result.Add(new TableInfo(schema, table, pks, hasRv));
        }

        return result;
    }

    /// <summary>
    /// Lê uma tabela em modo STREAMING: lê N linhas, envia via sender, libera memória, repete.
    /// Não acumula nada em listas. Não carrega all_pks (reconciliação fica desabilitada para tabelas grandes
    /// — mudanças aparecem via upsert; deletes só são detectados em ciclos de "full reconcile" agendados).
    /// </summary>
    public async Task<TableStreamResult> StreamTableAsync(
        TableInfo table,
        string? lastChecksum,
        ChunkSenderAsync sender,
        int chunkSize,
        CancellationToken ct)
    {
        await using var conn = new SqlConnection(ConnectionString);
        await conn.OpenAsync(ct);

        long rowCount;
        await using (var cmd = new SqlCommand(
            $"SELECT COUNT_BIG(*) FROM [{table.SchemaName}].[{table.TableName}]",
            conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
        {
            rowCount = (long)(await cmd.ExecuteScalarAsync(ct) ?? 0L);
        }

        return table.HasRowVersion
            ? await StreamIncrementalAsync(conn, table, lastChecksum, rowCount, sender, chunkSize, ct)
            : await StreamKeysetAsync(conn, table, rowCount, sender, chunkSize, ct);
    }

    /// <summary>
    /// Streaming incremental via rowversion. Lê em lotes ordenados por rv,
    /// envia cada lote, descarta da memória, continua de onde parou.
    /// </summary>
    private async Task<TableStreamResult> StreamIncrementalAsync(
        SqlConnection conn,
        TableInfo table,
        string? lastChecksum,
        long rowCount,
        ChunkSenderAsync sender,
        int chunkSize,
        CancellationToken ct)
    {
        string rvCol;
        await using (var cmd = new SqlCommand(@"
SELECT TOP 1 c.name FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = @s AND t.name = @t AND c.system_type_id = 189", conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
        {
            cmd.Parameters.AddWithValue("@s", table.SchemaName);
            cmd.Parameters.AddWithValue("@t", table.TableName);
            rvCol = (string)(await cmd.ExecuteScalarAsync(ct) ?? "rv");
        }

        var cursorRv = !string.IsNullOrEmpty(lastChecksum) && lastChecksum.Length == 16
            ? Convert.FromHexString(lastChecksum)
            : new byte[8];

        byte[]? maxRv = null;
        var totalStreamed = 0;
        var chunkIndex = 0;
        var batch = new List<UpsertRow>(chunkSize);

        while (!ct.IsCancellationRequested)
        {
            var sql = $"SELECT TOP ({chunkSize}) *, [{rvCol}] AS __rv FROM [{table.SchemaName}].[{table.TableName}] " +
                      $"WHERE [{rvCol}] > @rv ORDER BY [{rvCol}] ASC";

            var batchCount = 0;
            byte[]? batchLastRv = null;

            await using (var qcmd = new SqlCommand(sql, conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
            {
                qcmd.Parameters.Add(new SqlParameter("@rv", SqlDbType.Timestamp) { Value = cursorRv });

                await using var rd = await qcmd.ExecuteReaderAsync(ct);
                while (await rd.ReadAsync(ct))
                {
                    var (row, rv) = ReadRow(rd);
                    if (rv != null)
                    {
                        batchLastRv = rv;
                        maxRv = rv;
                    }

                    batch.Add(BuildUpsert(table, row));
                    batchCount++;
                }
            }

            if (batchCount == 0) break;

            chunkIndex++;
            // Não sabemos chunks_total a priori — usamos -1 e o servidor aceita.
            // Marca como final se o batch foi menor que chunkSize (último).
            var isFinal = batchCount < chunkSize;
            var finalCs = isFinal && maxRv != null
                ? Convert.ToHexString(maxRv).ToLowerInvariant()
                : null;

            var ok = await sender(batch, chunkIndex, -1, isFinal, finalCs, ct);
            if (!ok)
            {
                _log.LogError("Sender returned false for {Schema}.{Table} chunk {Chunk}",
                    table.SchemaName, table.TableName, chunkIndex);
                throw new InvalidOperationException("Chunk send failed");
            }

            totalStreamed += batchCount;
            batch.Clear();
            // Hint pro GC liberar buffers SQL/JSON entre chunks
            if (chunkIndex % 5 == 0) GC.Collect(0, GCCollectionMode.Optimized);

            if (batchLastRv == null) break;
            cursorRv = batchLastRv;
            if (isFinal) break;
        }

        // Caso não tenha lido nada, ainda manda um chunk vazio final para atualizar o heartbeat
        if (chunkIndex == 0)
        {
            await sender(Array.Empty<UpsertRow>(), 1, 1, true, lastChecksum, ct);
            chunkIndex = 1;
        }

        return new TableStreamResult(
            table,
            "rowversion",
            rowCount,
            maxRv != null ? Convert.ToHexString(maxRv).ToLowerInvariant() : lastChecksum,
            totalStreamed,
            chunkIndex);
    }

    /// <summary>
    /// Streaming via keyset pagination (PK > cursor). Substitui o OFFSET/FETCH antigo
    /// (que ficava cada vez mais lento). Funciona bem para tabelas sem rowversion mas com PK.
    ///
    /// PROTEÇÃO DE MEMÓRIA: monitora o tamanho do batch em bytes (estimativa via JSON).
    /// Se passar de ~50 MB, força flush imediato mesmo sem ter chegado a chunkSize.
    /// Isso protege contra tabelas com BLOBs/imagens DICOM que podem ter linhas de vários MB cada.
    /// </summary>
    private async Task<TableStreamResult> StreamKeysetAsync(
        SqlConnection conn,
        TableInfo table,
        long rowCount,
        ChunkSenderAsync sender,
        int chunkSize,
        CancellationToken ct)
    {
        const long MAX_BATCH_BYTES = 50L * 1024 * 1024; // 50 MB por batch
        var orderBy = string.Join(", ", table.PrimaryKeys.Select(c => $"[{c}] ASC"));
        var pkCols = table.PrimaryKeys.Select(c => $"[{c}]").ToArray();

        Dictionary<string, object?>? cursor = null;
        var totalStreamed = 0;
        var chunkIndex = 0;
        var batch = new List<UpsertRow>(chunkSize);
        long batchBytes = 0;

        while (!ct.IsCancellationRequested)
        {
            string whereClause = "";
            if (cursor != null)
            {
                if (table.PrimaryKeys.Count == 1)
                {
                    whereClause = $"WHERE [{table.PrimaryKeys[0]}] > @pk0";
                }
                else
                {
                    var cols = string.Join(",", pkCols);
                    var pars = string.Join(",", table.PrimaryKeys.Select((_, i) => $"@pk{i}"));
                    whereClause = $"WHERE ({cols}) > ({pars})";
                }
            }

            var sql = $"SELECT TOP ({chunkSize}) * FROM [{table.SchemaName}].[{table.TableName}] " +
                      $"{whereClause} ORDER BY {orderBy}";

            var batchCount = 0;
            Dictionary<string, object?>? lastPk = null;
            var readAnyThisQuery = false;

            await using (var qcmd = new SqlCommand(sql, conn) { CommandTimeout = _opts.CommandTimeoutSeconds })
            {
                if (cursor != null)
                {
                    for (int i = 0; i < table.PrimaryKeys.Count; i++)
                    {
                        var pkName = table.PrimaryKeys[i];
                        cursor.TryGetValue(pkName, out var val);
                        qcmd.Parameters.AddWithValue($"@pk{i}", val ?? DBNull.Value);
                    }
                }

                // SequentialAccess: lê coluna a coluna sem buffering — essencial para tabelas com BLOBs.
                await using var rd = await qcmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct);
                while (await rd.ReadAsync(ct))
                {
                    readAnyThisQuery = true;
                    var (row, _) = ReadRow(rd);
                    var upsert = BuildUpsert(table, row);
                    batch.Add(upsert);
                    lastPk = upsert.Pk;
                    batchCount++;

                    // Estima bytes do upsert (PK + Data já serializadas no hash anteriormente — refazemos uma estimativa rápida).
                    batchBytes += EstimateRowBytes(upsert);

                    // Se o batch ficou pesado, FLUSH antes de continuar lendo
                    if (batchBytes >= MAX_BATCH_BYTES)
                    {
                        chunkIndex++;
                        _log.LogInformation(
                            "{Schema}.{Table}: flushing chunk {Chunk} early ({Rows} rows, ~{MB} MB) due to payload size",
                            table.SchemaName, table.TableName, chunkIndex, batch.Count, batchBytes / (1024 * 1024));

                        var okEarly = await sender(batch, chunkIndex, -1, false, null, ct);
                        if (!okEarly) throw new InvalidOperationException("Early chunk send failed");

                        totalStreamed += batch.Count;
                        batch.Clear();
                        batchBytes = 0;
                        GC.Collect(0, GCCollectionMode.Optimized);
                    }
                }
            }

            if (!readAnyThisQuery && batch.Count == 0) break;

            if (batch.Count > 0)
            {
                chunkIndex++;
                var isFinal = batchCount < chunkSize;
                var ok = await sender(batch, chunkIndex, -1, isFinal, isFinal ? "" : null, ct);
                if (!ok) throw new InvalidOperationException("Chunk send failed");

                totalStreamed += batch.Count;
                batch.Clear();
                batchBytes = 0;
                if (chunkIndex % 5 == 0) GC.Collect(0, GCCollectionMode.Optimized);

                if (lastPk == null || isFinal) break;
                cursor = lastPk;
            }
            else
            {
                break;
            }
        }

        if (chunkIndex == 0)
        {
            await sender(Array.Empty<UpsertRow>(), 1, 1, true, "", ct);
            chunkIndex = 1;
        }

        return new TableStreamResult(table, "full_scan", rowCount, null, totalStreamed, chunkIndex);
    }

    /// <summary>Estimativa rápida de bytes de uma linha (sem reserializar JSON inteiro).</summary>
    private static long EstimateRowBytes(UpsertRow row)
    {
        long total = 64; // overhead base
        foreach (var kv in row.Data)
        {
            total += (kv.Key?.Length ?? 0) * 2;
            total += kv.Value switch
            {
                null => 8,
                string s => s.Length * 2 + 16,
                _ => 32
            };
        }
        return total;
    }

    private static (Dictionary<string, object?> row, byte[]? rv) ReadRow(SqlDataReader rd)
    {
        var dict = new Dictionary<string, object?>(rd.FieldCount);
        byte[]? rv = null;
        for (int i = 0; i < rd.FieldCount; i++)
        {
            var name = rd.GetName(i);
            var val = rd.IsDBNull(i) ? null : rd.GetValue(i);

            if (name == "__rv" && val is byte[] b)
            {
                rv = b;
                continue;
            }

            dict[name] = NormalizeValue(val);
        }
        return (dict, rv);
    }

    private static object? NormalizeValue(object? v)
    {
        return v switch
        {
            null => null,
            DateTime dt => dt.ToString("o", CultureInfo.InvariantCulture),
            DateTimeOffset dto => dto.ToString("o", CultureInfo.InvariantCulture),
            byte[] bytes => Convert.ToBase64String(bytes),
            Guid g => g.ToString(),
            decimal d => d.ToString(CultureInfo.InvariantCulture),
            _ => v
        };
    }

    private static UpsertRow BuildUpsert(TableInfo table, Dictionary<string, object?> row)
    {
        var pk = new Dictionary<string, object?>(table.PrimaryKeys.Count);
        foreach (var k in table.PrimaryKeys)
        {
            row.TryGetValue(k, out var v);
            pk[k] = v;
        }

        var sorted = new SortedDictionary<string, object?>(row, StringComparer.Ordinal);
        var json = JsonSerializer.Serialize(sorted);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();

        return new UpsertRow(pk, row, hash);
    }
}
