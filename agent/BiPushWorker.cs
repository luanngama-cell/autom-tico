using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

/// <summary>
/// Roda o BiScriptRunner em loop independente do SyncWorker (intervalos
/// diferentes: tabelas a cada minuto, BI snapshot a cada 5min por padrão).
/// O endpoint /api/public/bi/push faz a deduplicação por hash, então rodar
/// "à toa" não envia bytes pra rede se nada mudou.
/// </summary>
public class BiPushWorker : BackgroundService
{
    private readonly BiScriptRunner _runner;
    private readonly CloudClient _cloud;
    private readonly BiOptions _opts;
    private readonly ILogger<BiPushWorker> _log;

    public BiPushWorker(BiScriptRunner runner, CloudClient cloud, IOptions<BiOptions> opts, ILogger<BiPushWorker> log)
    {
        _runner = runner;
        _cloud = cloud;
        _opts = opts.Value;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_runner.Enabled)
        {
            _log.LogInformation("BiPushWorker disabled (Bi.Enabled=false or ScriptPath empty)");
            return;
        }

        _log.LogInformation("BiPushWorker started. Interval={Interval}s Script={Path}",
            _opts.IntervalSeconds, _opts.ScriptPath);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var started = DateTime.UtcNow;
                _log.LogInformation("BI cycle start");

                var snapshot = await _runner.BuildSnapshotAsync(stoppingToken);
                if (snapshot != null)
                {
                    var ok = await _cloud.PushBiSnapshotAsync(_opts.PushPath, snapshot, stoppingToken);
                    snapshot.Dispose();
                    _log.LogInformation("BI cycle done in {Ms}ms ok={Ok}",
                        (DateTime.UtcNow - started).TotalMilliseconds, ok);
                }
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "BI cycle failed");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(_opts.IntervalSeconds), stoppingToken);
            }
            catch (TaskCanceledException) { }
        }
    }
}
