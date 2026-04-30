using System.Runtime;
using System.Diagnostics;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

/// <summary>
/// Decide quais tabelas processar em cada ciclo, separando "normais" das "grandes".
///
/// Estratégia:
///   - Tabelas normais: TODAS rodam em todo ciclo (60s).
///   - Tabelas grandes: SÓ rodam quando memória do agente está abaixo de LargeTablePauseAboveMb,
///     LIMITADAS a MaxPerCycle por ciclo, e SEMPRE em ordem de mais "stale" primeiro (mais tempo sem sync).
///   - Garantia SLA: se uma tabela grande passou de MaxStalenessHours sem sync, ela vira PRIORITÁRIA
///     (entra no ciclo independente do estado de memória — ainda processada com streaming, então não estoura).
///
/// Estado persistido em arquivo JSON local (large_tables_state.json) — sobrevive a restarts.
/// </summary>
public class TableScheduler
{
    private readonly LargeTablesOptions _largeOpts;
    private readonly MemoryOptions _memOpts;
    private readonly ILogger<TableScheduler> _log;
    private readonly string _stateFile;
    private readonly object _lock = new();
    private Dictionary<string, DateTime> _lastSyncedUtc;

    public TableScheduler(
        IOptions<LargeTablesOptions> largeOpts,
        IOptions<MemoryOptions> memOpts,
        ILogger<TableScheduler> log)
    {
        _largeOpts = largeOpts.Value;
        _memOpts = memOpts.Value;
        _log = log;
        _stateFile = Path.Combine(AppContext.BaseDirectory, "large_tables_state.json");
        _lastSyncedUtc = LoadState();
    }

    public bool IsLarge(string tableName) =>
        _largeOpts.Tables.Contains(tableName, StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Memória atual do processo em MB.
    /// </summary>
    public static double CurrentMemoryMb()
    {
        using var p = Process.GetCurrentProcess();
        p.Refresh();
        return p.WorkingSet64 / 1024.0 / 1024.0;
    }

    /// <summary>
    /// Separa as tabelas descobertas em (normais, grandes-a-rodar-neste-ciclo).
    /// Tabelas grandes que NÃO devem rodar agora simplesmente ficam de fora.
    /// </summary>
    public (List<TableInfo> normal, List<TableInfo> largeToRun) SplitForCycle(IEnumerable<TableInfo> discovered)
    {
        var normal = new List<TableInfo>();
        var largeAll = new List<TableInfo>();

        foreach (var t in discovered)
        {
            if (IsLarge(t.TableName)) largeAll.Add(t);
            else normal.Add(t);
        }

        if (largeAll.Count == 0) return (normal, new List<TableInfo>());

        var memMb = CurrentMemoryMb();
        var pauseAbove = _memOpts.LargeTablePauseAboveMb;
        var nowUtc = DateTime.UtcNow;
        var slaCutoff = nowUtc - TimeSpan.FromHours(_largeOpts.MaxStalenessHours);

        // Calcula stale time de cada tabela grande
        var ranked = largeAll
            .Select(t =>
            {
                var key = $"{t.SchemaName}.{t.TableName}";
                _lastSyncedUtc.TryGetValue(key, out var lastUtc);
                if (lastUtc == default) lastUtc = DateTime.MinValue;
                var staleness = nowUtc - lastUtc;
                var slaBreached = lastUtc < slaCutoff;
                return new { Table = t, LastSync = lastUtc, Staleness = staleness, SlaBreached = slaBreached };
            })
            .OrderByDescending(x => x.SlaBreached)        // SLA quebrado primeiro
            .ThenByDescending(x => x.Staleness)           // depois mais stale
            .ToList();

        var slaBreached = ranked.Where(x => x.SlaBreached).ToList();

        if (slaBreached.Count > 0)
        {
            // SLA quebrado — força execução INDEPENDENTE de memória
            _log.LogWarning(
                "SLA breach: {Count} large table(s) past {Hours}h staleness. Forcing run regardless of memory ({Mem:F0} MB).",
                slaBreached.Count, _largeOpts.MaxStalenessHours, memMb);
            return (normal, slaBreached.Select(x => x.Table).ToList());
        }

        if (memMb >= pauseAbove)
        {
            _log.LogInformation(
                "Memory {Mem:F0} MB >= {Pause} MB threshold. Skipping large tables this cycle.",
                memMb, pauseAbove);
            return (normal, new List<TableInfo>());
        }

        // Memória OK e nenhum SLA quebrado — pega as N mais stale
        var pick = ranked.Take(_largeOpts.MaxPerCycle).Select(x => x.Table).ToList();
        if (pick.Count > 0)
        {
            _log.LogInformation(
                "Memory {Mem:F0} MB < {Pause} MB. Processing {N} large table(s) this cycle: {Tables}",
                memMb, pauseAbove, pick.Count, string.Join(", ", pick.Select(t => t.TableName)));
        }
        return (normal, pick);
    }

    public void MarkSynced(string schemaName, string tableName)
    {
        if (!IsLarge(tableName)) return;
        var key = $"{schemaName}.{tableName}";
        lock (_lock)
        {
            _lastSyncedUtc[key] = DateTime.UtcNow;
            SaveState();
        }
    }

    private Dictionary<string, DateTime> LoadState()
    {
        try
        {
            if (!File.Exists(_stateFile)) return new(StringComparer.OrdinalIgnoreCase);
            var json = File.ReadAllText(_stateFile);
            var dict = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, DateTime>>(json);
            return dict != null
                ? new Dictionary<string, DateTime>(dict, StringComparer.OrdinalIgnoreCase)
                : new(StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to load large_tables_state.json, starting fresh");
            return new(StringComparer.OrdinalIgnoreCase);
        }
    }

    private void SaveState()
    {
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(_lastSyncedUtc);
            File.WriteAllText(_stateFile, json);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to save large_tables_state.json");
        }
    }
}
