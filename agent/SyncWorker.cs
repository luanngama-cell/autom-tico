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

        var payloadTables = new List<object>();

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

                payloadTables.Add(new
                {
                    schema_name = t.SchemaName,
                    table_name = t.TableName,
                    primary_keys = t.PrimaryKeys,
                    has_rowversion = t.HasRowVersion,
                    strategy = snap.Strategy,
                    row_count = snap.RowCount,
                    last_checksum = snap.LastChecksum ?? string.Empty,
                    upserts = snap.Upserts.Select(u => new
                    {
                        pk = u.Pk,
                        data = u.Data,
                        row_hash = u.RowHash,
                    }),
                    full_replace = snap.FullReplace,
                });
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "Table {Schema}.{Table} failed", t.SchemaName, t.TableName);
            }
        }

        // Send in batches to stay under Cloudflare's 100MB request limit and avoid 502 timeouts.
        const int batchSize = 5;
        var totalBatches = (int)Math.Ceiling(payloadTables.Count / (double)batchSize);
        var batchIndex = 0;

        for (int i = 0; i < payloadTables.Count; i += batchSize)
        {
            batchIndex++;
            var chunk = payloadTables.GetRange(i, Math.Min(batchSize, payloadTables.Count - i));

            var payload = new
            {
                connection = new { status = "online" },
                batch = new { index = batchIndex, total = totalBatches },
                tables = chunk,
            };

            _log.LogInformation("Sending batch {Index}/{Total} ({Count} tables)",
                batchIndex, totalBatches, chunk.Count);

            var ok = await _cloud.IngestAsync(payload, ct);
            if (!ok)
            {
                _log.LogError("Batch {Index}/{Total} failed, aborting cycle", batchIndex, totalBatches);
                break;
            }
        }

        _log.LogInformation("Cycle done in {Ms}ms ({Count} tables in {Batches} batches)",
            (DateTime.UtcNow - started).TotalMilliseconds, payloadTables.Count, totalBatches);
    }
}
