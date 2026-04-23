using Microsoft.Extensions.Hosting.WindowsServices;
using Serilog;
using Serilog.Events;
using SqlSyncAgent;
using SqlSyncAgent.Options;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(o =>
{
    o.ServiceName = "SqlSyncAgent";
});

// Logging
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.File(
        path: Path.Combine(AppContext.BaseDirectory, "agent.log"),
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 14)
    .WriteTo.EventLog("SqlSyncAgent", manageEventSource: WindowsServiceHelpers.IsWindowsService())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(Log.Logger);

// Options
builder.Services.Configure<CloudOptions>(builder.Configuration.GetSection("Cloud"));
builder.Services.Configure<SqlOptions>(builder.Configuration.GetSection("Sql"));
builder.Services.Configure<SyncOptions>(builder.Configuration.GetSection("Sync"));

builder.Services.AddHttpClient("cloud", (sp, client) =>
{
    var cloud = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<CloudOptions>>().Value;
    client.BaseAddress = new Uri(cloud.BaseUrl.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromMinutes(2);
});

builder.Services.AddSingleton<SqlReader>();
builder.Services.AddSingleton<CloudClient>();
builder.Services.AddHostedService<SyncWorker>();

var host = builder.Build();
host.Run();
