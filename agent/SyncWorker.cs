using System.Text.Json;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

public class SyncWorker : BackgroundService
{
    private readonly SqlReader _reader;
    private readonly CloudClient _cloud;
    private readonly SyncOptions _sync;
    private readonly ILogger<SyncWorker> _log;

    public SyncWorker(SqlReader reader, CloudClient cloud, IOptions<SyncOptions> sync, ILogger<SyncWorker> log)
    {
        _reader = reader;
        _cloud = cloud;
        _sync = sync.Value;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation("SqlSyncAgent started. Interval={Interval}s Schema={Schema}",
            _sync.IntervalSeconds, _sync.Schema);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunCycleAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Cycle failed");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(_sync.IntervalSeconds), stoppingToken);
            }
            catch (TaskCanceledException) { }
        }
    }

    private async Task RunCycleAsync(CancellationToken ct)
    {
        var started = DateTime.UtcNow;
        _log.LogInformation("Cycle start");

        await _cloud.HeartbeatAsync(ct);

        // 1. Get manifest (last_checksum per known table)
        var manifest = await _cloud.GetManifestAsync(ct);
        var lastChecksums = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        if (manifest != null && manifest.RootElement.TryGetProperty("tables", out var tarr))
        {
            foreach (var el in tarr.EnumerateArray())
            {
                var key = $"{el.GetProperty("schema_name").GetString()}.{el.GetProperty("table_name").GetString()}";
                lastChecksums[key] = el.TryGetProperty("last_checksum", out var lc) && lc.ValueKind == JsonValueKind.String
                    ? lc.GetString() : null;
            }
        }

        // 2. Discover tables
        var tables = await _reader.DiscoverTablesAsync(ct);
        _log.LogInformation("Discovered {Count} tables", tables.Count);

        var sentTables = 0;

        foreach (var t in tables)
        {
            try
            {
                var key = $"{t.SchemaName}.{t.TableName}";
                lastChecksums.TryGetValue(key, out var lastCs);
                var snap = await _reader.ReadTableAsync(t, lastCs, ct);

                if (snap.Upserts.Count == 0 && snap.Strategy == "rowversion")
                {
                    // nothing changed, but still report heartbeat
                }

                var ok = await SendTableSnapshotAsync(t, snap, sentTables, tables.Count, ct);
                if (!ok)
                {
                    _log.LogError("Table sync failed for {Schema}.{Table}, aborting cycle", t.SchemaName, t.TableName);
                    return;
                }

                sentTables += 1;
                await _cloud.HeartbeatAsync(ct);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Table {Schema}.{Table} failed", t.SchemaName, t.TableName);
            }
        }

        await _cloud.HeartbeatAsync(ct);
        _log.LogInformation("Cycle done in {Ms}ms ({Count} tables sent)",
            (DateTime.UtcNow - started).TotalMilliseconds, sentTables);
    }

    private async Task<bool> SendTableSnapshotAsync(TableInfo table, TableSnapshot snap, int sentTables, int totalTables, CancellationToken ct)
    {
        var chunkSize = Math.Min(Math.Max(_sync.MaxRowsPerTablePerCycle, 1), 5000);
        var upsertChunks = snap.Upserts.Chunk(chunkSize).ToArray();

        if (upsertChunks.Length == 0)
        {
            upsertChunks = [Array.Empty<UpsertRow>()];
        }

        for (var chunkIndex = 0; chunkIndex < upsertChunks.Length; chunkIndex++)
        {
            var chunk = upsertChunks[chunkIndex];
            var isFinalChunk = chunkIndex == upsertChunks.Length - 1;
            var payload = new
            {
                connection = new { status = "online" },
                progress = new { sent = sentTables, total = totalTables },
                tables = new[]
                {
                    new
                    {
                        schema_name = table.SchemaName,
                        table_name = table.TableName,
                        primary_keys = table.PrimaryKeys,
                        has_rowversion = table.HasRowVersion,
                        strategy = snap.Strategy,
                        row_count = snap.RowCount,
                        last_checksum = snap.LastChecksum ?? string.Empty,
                        upserts = chunk.Select(u => new
                        {
                            pk = u.Pk,
                            data = u.Data,
                            row_hash = u.RowHash,
                        }),
                        full_replace = isFinalChunk && snap.FullReplace,
                        all_pks = isFinalChunk ? snap.AllPks : null,
                    }
                },
            };

            _log.LogInformation(
                "Sending table {Schema}.{Table} chunk {Chunk}/{TotalChunks} ({Rows} rows)",
                table.SchemaName,
                table.TableName,
                chunkIndex + 1,
                upsertChunks.Length,
                chunk.Length);

            var ok = await _cloud.IngestAsync(payload, ct);
            if (!ok) return false;
        }

        return true;
    }
}
