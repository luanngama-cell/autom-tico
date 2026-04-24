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

public record TableSnapshot(
    TableInfo Table,
    string Strategy,           // "rowversion" or "full_scan"
    long RowCount,
    string? LastChecksum,      // hex of MAX(rowversion) for incremental
    List<UpsertRow> Upserts,
    bool FullReplace,
    List<Dictionary<string, object?>> AllPks);  // ALL live PKs in source (for reconciliation)

public record UpsertRow(
    Dictionary<string, object?> Pk,
    Dictionary<string, object?> Data,
    string RowHash);

public class SqlReader
{
    private readonly SqlOptions _opts;
    private readonly SyncOptions _sync;
    private readonly ILogger<SqlReader> _log;

    public SqlReader(IOptions<SqlOptions> opts, IOptions<SyncOptions> sync, ILogger<SqlReader> log)
    {
        _opts = opts.Value;
        _sync = sync.Value;
        _log = log;
    }

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

        // Tables in schema
        var sql = @"
SELECT t.TABLE_SCHEMA, t.TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES t
WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA = @schema
ORDER BY t.TABLE_NAME";

        var tableNames = new List<(string s, string t)>();
        await using (var cmd = new SqlCommand(sql, conn))
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
ORDER BY kcu.ORDINAL_POSITION", conn))
            {
                cmd.Parameters.AddWithValue("@s", schema);
                cmd.Parameters.AddWithValue("@t", table);
                await using var rd = await cmd.ExecuteReaderAsync(ct);
                while (await rd.ReadAsync(ct)) pks.Add(rd.GetString(0));
            }

            // detect rowversion / timestamp column
            bool hasRv = false;
            await using (var cmd = new SqlCommand(@"
SELECT COUNT(*) FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = @s AND t.name = @t AND c.system_type_id = 189", conn)) // 189 = timestamp/rowversion
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

    public async Task<TableSnapshot> ReadTableAsync(
        TableInfo table,
        string? lastChecksum,
        CancellationToken ct)
    {
        await using var conn = new SqlConnection(ConnectionString);
        await conn.OpenAsync(ct);

        // count
        long rowCount;
        await using (var cmd = new SqlCommand(
            $"SELECT COUNT_BIG(*) FROM [{table.SchemaName}].[{table.TableName}]", conn))
        {
            rowCount = (long)(await cmd.ExecuteScalarAsync(ct) ?? 0L);
        }

        if (table.HasRowVersion)
        {
            return await ReadIncrementalAsync(conn, table, lastChecksum, rowCount, ct);
        }
        return await ReadFullScanAsync(conn, table, rowCount, ct);
    }

    private async Task<TableSnapshot> ReadIncrementalAsync(
        SqlConnection conn, TableInfo table, string? lastChecksum, long rowCount, CancellationToken ct)
    {
        // find rowversion column name
        string rvCol;
        await using (var cmd = new SqlCommand(@"
SELECT TOP 1 c.name FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE s.name = @s AND t.name = @t AND c.system_type_id = 189", conn))
        {
            cmd.Parameters.AddWithValue("@s", table.SchemaName);
            cmd.Parameters.AddWithValue("@t", table.TableName);
            rvCol = (string)(await cmd.ExecuteScalarAsync(ct) ?? "rv");
        }

        byte[] minRv;
        if (!string.IsNullOrEmpty(lastChecksum) && lastChecksum.Length == 16)
        {
            minRv = Convert.FromHexString(lastChecksum);
        }
        else
        {
            minRv = new byte[8]; // zero
        }

        var upserts = new List<UpsertRow>();
        byte[]? maxRv = null;

        var top = _sync.MaxRowsPerTablePerCycle;
        var sql = $"SELECT TOP ({top}) *, [{rvCol}] AS __rv FROM [{table.SchemaName}].[{table.TableName}] " +
                  $"WHERE [{rvCol}] > @rv ORDER BY [{rvCol}] ASC";

        await using (var qcmd = new SqlCommand(sql, conn) { CommandTimeout = 60 })
        {
            qcmd.Parameters.Add(new SqlParameter("@rv", SqlDbType.Timestamp) { Value = minRv });

            await using var rd = await qcmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct))
            {
                var (row, rv) = ReadRow(rd);
                if (rv != null) maxRv = rv;
                upserts.Add(BuildUpsert(table, row));
            }
        }

        // Collect ALL live PKs for reconciliation (deletes propagation).
        var allPks = await ReadAllPksAsync(conn, table, ct);

        return new TableSnapshot(
            table,
            "rowversion",
            rowCount,
            maxRv != null ? Convert.ToHexString(maxRv).ToLowerInvariant() : lastChecksum,
            upserts,
            FullReplace: false,
            AllPks: allPks);
    }

    private async Task<TableSnapshot> ReadFullScanAsync(
        SqlConnection conn, TableInfo table, long rowCount, CancellationToken ct)
    {
        var upserts = new List<UpsertRow>();
        var top = _sync.MaxRowsPerTablePerCycle;
        var sql = $"SELECT TOP ({top}) * FROM [{table.SchemaName}].[{table.TableName}]";
        await using (var cmd = new SqlCommand(sql, conn) { CommandTimeout = 120 })
        {
            await using var rd = await cmd.ExecuteReaderAsync(ct);
            while (await rd.ReadAsync(ct))
            {
                var (row, _) = ReadRow(rd);
                upserts.Add(BuildUpsert(table, row));
            }
        }

        // For full_scan tables that fit in one cycle, full_replace handles deletes.
        // For larger ones, we still send all_pks so the server can reconcile.
        var fullReplace = rowCount <= top;
        var allPks = fullReplace
            ? new List<Dictionary<string, object?>>()
            : await ReadAllPksAsync(conn, table, ct);

        return new TableSnapshot(table, "full_scan", rowCount, null, upserts, fullReplace, allPks);
    }

    private async Task<List<Dictionary<string, object?>>> ReadAllPksAsync(
        SqlConnection conn, TableInfo table, CancellationToken ct)
    {
        var pks = new List<Dictionary<string, object?>>();
        var pkCols = string.Join(", ", table.PrimaryKeys.Select(c => $"[{c}]"));
        var sql = $"SELECT {pkCols} FROM [{table.SchemaName}].[{table.TableName}]";
        await using var cmd = new SqlCommand(sql, conn) { CommandTimeout = 120 };
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        while (await rd.ReadAsync(ct))
        {
            var dict = new Dictionary<string, object?>(rd.FieldCount);
            for (int i = 0; i < rd.FieldCount; i++)
            {
                var name = rd.GetName(i);
                var val = rd.IsDBNull(i) ? null : rd.GetValue(i);
                dict[name] = NormalizeValue(val);
            }
            pks.Add(dict);
        }
        return pks;
    }

    private static (Dictionary<string, object?> row, byte[]? rv) ReadRow(SqlDataReader rd)
    {
        var dict = new Dictionary<string, object?>(rd.FieldCount);
        byte[]? rv = null;
        for (int i = 0; i < rd.FieldCount; i++)
        {
            var name = rd.GetName(i);
            var val = rd.IsDBNull(i) ? null : rd.GetValue(i);

            if (name == "__rv" && val is byte[] b) { rv = b; continue; }

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

        // stable JSON: sorted keys
        var sorted = new SortedDictionary<string, object?>(row, StringComparer.Ordinal);
        var json = JsonSerializer.Serialize(sorted);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();

        return new UpsertRow(pk, row, hash);
    }
}
