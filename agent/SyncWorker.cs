using System.Collections.Concurrent;
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

    // Quantas tabelas NORMAIS o agente sincroniza em paralelo.
    // 2 = seguro pra PCs com 8GB. Aumente para 4 ou 8 em servidores maiores.
    private const int PARALLEL_NORMAL_TABLES = 2;

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
            "SqlSyncAgent started. Interval={Interval}s Schema={Schema} ChunkSize={Chunk} Parallel={Par} LargeTables={Large}",
            _sync.IntervalSeconds, _sync.Schema, _sync.MaxRowsPerTablePerCycle, PARALLEL_NORMAL_TABLES, _largeOpts.Tables.Count);

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

        // Lê do manifest: last_checksum, excluded, last_rowversion (Aprovação 2)
        var lastChecksums = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var lastRowversions = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var excluded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (manifest != null && manifest.RootElement.TryGetProperty("tables", out var tarr))
        {
            foreach (var el in tarr.EnumerateArray())
            {
                var key = $"{el.GetProperty("schema_name").GetString()}.{el.GetProperty("table_name").GetString()}";

                lastChecksums[key] = el.TryGetProperty("last_checksum", out var lc) && lc.ValueKind == JsonValueKind.String
                    ? lc.GetString() : null;

                lastRowversions[key] = el.TryGetProperty("last_rowversion", out var lrv) && lrv.ValueKind == JsonValueKind.String
                    ? lrv.GetString() : null;

                if (el.TryGetProperty("excluded", out var ex) && ex.ValueKind == JsonValueKind.True)
                {
                    excluded.Add(key);
                }
            }
        }

        var allTables = await _reader.DiscoverTablesAsync(ct);

        // Aplica blacklist da nuvem (Aprovação 2)
        var beforeFilter = allTables.Count;
        allTables = allTables.Where(t => !excluded.Contains($"{t.SchemaName}.{t.TableName}")).ToList();
        if (excluded.Count > 0)
        {
            _log.LogInformation("Cloud blacklist: {Excluded} table(s) skipped ({Before} -> {After})",
                excluded.Count, beforeFilter, allTables.Count);
        }

        var (normal, large) = _scheduler.SplitForCycle(allTables);
        _log.LogInformation(
            "Discovered {Total} tables → {Normal} normal + {Large} large (this cycle)",
            allTables.Count, normal.Count, large.Count);

        var totalToSend = normal.Count + large.Count;
        var sentCounter = 0;

        // 1. Tabelas normais EM PARALELO (com semáforo) — Aprovação 2
        using var sem = new SemaphoreSlim(PARALLEL_NORMAL_TABLES, PARALLEL_NORMAL_TABLES);
        var normalTasks = normal.Select(async t =>
        {
            await sem.WaitAsync(ct);
            try
            {
                var ok = await ProcessTableAsync(
                    t, lastChecksums, lastRowversions,
                    Interlocked.CompareExchange(ref sentCounter, 0, 0),
                    totalToSend, _sync.MaxRowsPerTablePerCycle, isLarge: false, ct);
                if (ok) Interlocked.Increment(ref sentCounter);
            }
            finally
            {
                sem.Release();
            }
        }).ToList();

        await Task.WhenAll(normalTasks);

        // 2. Tabelas grandes — SEMPRE sequencial (memória é o gargalo)
        foreach (var t in large)
        {
            var ok = await ProcessTableAsync(
                t, lastChecksums, lastRowversions,
                sentCounter, totalToSend,
                _largeOpts.ChunkSize, isLarge: true, ct);
            if (ok)
            {
                Interlocked.Increment(ref sentCounter);
                _scheduler.MarkSynced(t.SchemaName, t.TableName);
            }
        }

        await _cloud.HeartbeatAsync(ct);
        _log.LogInformation("Cycle done in {Ms}ms ({Sent}/{Total} tables, mem {Mem:F0} MB)",
            (DateTime.UtcNow - started).TotalMilliseconds, sentCounter, totalToSend, TableScheduler.CurrentMemoryMb());
    }

    private async Task<bool> ProcessTableAsync(
        TableInfo t,
        Dictionary<string, string?> lastChecksums,
        Dictionary<string, string?> lastRowversions,
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
            lastRowversions.TryGetValue(key, out var lastRv);

            // Se a nuvem mandou last_rowversion (delta sync infra), usa ele como cursor preferencial
            // — o SqlReader.StreamIncrementalAsync já interpreta o checksum como rowversion hex.
            var cursor = !string.IsNullOrEmpty(lastRv) ? lastRv : lastCs;

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
                            row_count = chunk.Count,
                            last_checksum = isFinal ? finalCs ?? string.Empty : null,
                            last_rowversion = isFinal && t.HasRowVersion ? finalCs : null,
                            upserts = chunk.Select(u => new
                            {
                                pk = u.Pk,
                                data = u.Data,
                                row_hash = u.RowHash,
                            }),
                            chunk_index = chunkIndex,
                            chunks_total = chunksTotal > 0 ? chunksTotal : 9999,
                            full_replace = false,
                            all_pks = (object?)null,
                        }
                    },
                };

                return await _cloud.IngestAsync(payload, sct);
            };

            var result = await _reader.StreamTableAsync(t, cursor, sender, chunkSize, ct);

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
            // Liberação de memória entre tabelas (mesmo em paralelo: GC é global)
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }
    }
}
