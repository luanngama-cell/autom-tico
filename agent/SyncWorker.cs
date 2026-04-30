using System.Text.Json;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

public class SyncWorker : BackgroundService
{
    private readonly SqlReader _reader;
    private readonly CloudClient _cloud;
    private readonly TableScheduler _scheduler;
    private readonly SyncOptions _sync;
    private readonly LargeTablesOptions _largeOpts;
    private readonly ILogger<SyncWorker> _log;

    public SyncWorker(
        SqlReader reader,
        CloudClient cloud,
        TableScheduler scheduler,
        IOptions<SyncOptions> sync,
        IOptions<LargeTablesOptions> largeOpts,
        ILogger<SyncWorker> log)
    {
        _reader = reader;
        _cloud = cloud;
        _scheduler = scheduler;
        _sync = sync.Value;
        _largeOpts = largeOpts.Value;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _log.LogInformation(
            "SqlSyncAgent started. Interval={Interval}s Schema={Schema} ChunkSize={Chunk} LargeTables={Large}",
            _sync.IntervalSeconds, _sync.Schema, _sync.MaxRowsPerTablePerCycle, _largeOpts.Tables.Count);

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
        _log.LogInformation("Cycle start (mem {Mem:F0} MB)", TableScheduler.CurrentMemoryMb());

        await _cloud.HeartbeatAsync(ct);

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

        var allTables = await _reader.DiscoverTablesAsync(ct);
        var (normal, large) = _scheduler.SplitForCycle(allTables);
        _log.LogInformation(
            "Discovered {Total} tables → {Normal} normal + {Large} large (this cycle)",
            allTables.Count, normal.Count, large.Count);

        var sentTables = 0;
        var totalToSend = normal.Count + large.Count;

        // 1. Tabelas normais primeiro (rápidas, ciclo "leve")
        foreach (var t in normal)
        {
            if (await ProcessTableAsync(t, lastChecksums, sentTables, totalToSend, _sync.MaxRowsPerTablePerCycle, isLarge: false, ct))
            {
                sentTables++;
            }
        }

        // 2. Tabelas grandes (streaming + chunk pequeno)
        foreach (var t in large)
        {
            if (await ProcessTableAsync(t, lastChecksums, sentTables, totalToSend, _largeOpts.ChunkSize, isLarge: true, ct))
            {
                sentTables++;
                _scheduler.MarkSynced(t.SchemaName, t.TableName);
            }
        }

        await _cloud.HeartbeatAsync(ct);
        _log.LogInformation("Cycle done in {Ms}ms ({Sent}/{Total} tables, mem {Mem:F0} MB)",
            (DateTime.UtcNow - started).TotalMilliseconds, sentTables, totalToSend, TableScheduler.CurrentMemoryMb());
    }

    private async Task<bool> ProcessTableAsync(
        TableInfo t,
        Dictionary<string, string?> lastChecksums,
        int sentTables,
        int totalTables,
        int chunkSize,
        bool isLarge,
        CancellationToken ct)
    {
        try
        {
            var key = $"{t.SchemaName}.{t.TableName}";
            lastChecksums.TryGetValue(key, out var lastCs);

            ChunkSenderAsync sender = async (chunk, chunkIndex, chunksTotal, isFinal, finalCs, sct) =>
            {
                var payload = new
                {
                    connection = new { status = "online" },
                    progress = new { sent = sentTables, total = totalTables },
                    tables = new[]
                    {
                        new
                        {
                            schema_name = t.SchemaName,
                            table_name = t.TableName,
                            primary_keys = t.PrimaryKeys,
                            has_rowversion = t.HasRowVersion,
                            strategy = t.HasRowVersion ? "rowversion" : "full_scan",
                            row_count = chunk.Count, // approx — atualizado no final via última call
                            last_checksum = isFinal ? finalCs ?? string.Empty : null,
                            upserts = chunk.Select(u => new
                            {
                                pk = u.Pk,
                                data = u.Data,
                                row_hash = u.RowHash,
                            }),
                            chunk_index = chunkIndex,
                            chunks_total = chunksTotal > 0 ? chunksTotal : 9999, // placeholder; servidor só usa para detectar "final"
                            full_replace = false,
                            // Para tabelas grandes NUNCA enviamos all_pks (consumiria GBs de RAM).
                            // Reconciliação de deletes para large tables fica desabilitada (deletes via tombstone seria próximo passo).
                            all_pks = (object?)null,
                        }
                    },
                };

                return await _cloud.IngestAsync(payload, sct);
            };

            var result = await _reader.StreamTableAsync(t, lastCs, sender, chunkSize, ct);

            _log.LogInformation(
                "{Tag} {Schema}.{Table}: {Rows} rows in {Chunks} chunks (strategy={Strategy})",
                isLarge ? "[LARGE]" : "[norm]",
                t.SchemaName, t.TableName, result.TotalRowsStreamed, result.TotalChunksSent, result.Strategy);

            return true;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Table {Schema}.{Table} failed", t.SchemaName, t.TableName);
            return false;
        }
        finally
        {
            // Liberação agressiva entre tabelas
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }
    }
}
