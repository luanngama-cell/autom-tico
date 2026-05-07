using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using SqlSyncAgent.Options;

namespace SqlSyncAgent;

public class CloudClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IHttpClientFactory _http;
    private readonly CloudOptions _opts;
    private readonly ILogger<CloudClient> _log;

    public CloudClient(IHttpClientFactory http, IOptions<CloudOptions> opts, ILogger<CloudClient> log)
    {
        _http = http;
        _opts = opts.Value;
        _log = log;
    }

    private HttpClient Client()
    {
        var c = _http.CreateClient("cloud");
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _opts.Token);
        c.DefaultRequestHeaders.Remove("X-Agent-Secret");
        c.DefaultRequestHeaders.Add("X-Agent-Secret", _opts.AgentSecret);
        return c;
    }

    public async Task<JsonDocument?> GetManifestAsync(CancellationToken ct)
    {
        using var c = Client();
        using var res = await c.GetAsync("api/public/agent/manifest", ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            _log.LogWarning("Manifest failed {Status}: {Body}", (int)res.StatusCode, body);
            return null;
        }
        return JsonDocument.Parse(body);
    }

    public async Task<bool> HeartbeatAsync(CancellationToken ct)
    {
        using var c = Client();
        using var res = await c.PostAsJsonAsync("api/public/agent/heartbeat", new { status = "online" }, JsonOptions, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            _log.LogWarning("Heartbeat failed {Status}: {Body}", (int)res.StatusCode, body);
            return false;
        }
        _log.LogDebug("Heartbeat ok: {Body}", body);
        return true;
    }

    public async Task<bool> IngestAsync(object payload, CancellationToken ct)
    {
        using var c = Client();
        using var res = await c.PostAsJsonAsync("api/public/agent/ingest", payload, JsonOptions, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            _log.LogError("Ingest failed {Status}: {Body}", (int)res.StatusCode, body);
            return false;
        }
        _log.LogInformation("Ingest ok: {Body}", body);
        return true;
    }

    public async Task<bool> PushBiSnapshotAsync(string path, JsonDocument snapshot, CancellationToken ct)
    {
        using var c = Client();
        using var content = new StringContent(snapshot.RootElement.GetRawText(),
            Encoding.UTF8, "application/json");
        c.DefaultRequestHeaders.Remove("X-Triggered-By");
        c.DefaultRequestHeaders.Add("X-Triggered-By", "agent-script");

        using var res = await c.PostAsync(path, content, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            _log.LogError("BI push failed {Status}: {Body}", (int)res.StatusCode, body);
            return false;
        }
        _log.LogInformation("BI push ok: {Body}", body);
        return true;
    }
}
