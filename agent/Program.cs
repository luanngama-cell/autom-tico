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

// Memory cap (Windows Job Object) — aplicado o quanto antes no startup.
var memoryOptions = builder.Configuration.GetSection("Memory").Get<MemoryOptions>() ?? new MemoryOptions();
MemoryGuard.Apply(memoryOptions, new Serilog.Extensions.Logging.SerilogLoggerFactory(Log.Logger).CreateLogger("MemoryGuard"));

// Options
builder.Services.Configure<CloudOptions>(builder.Configuration.GetSection("Cloud"));
builder.Services.Configure<SqlOptions>(builder.Configuration.GetSection("Sql"));
builder.Services.Configure<SyncOptions>(builder.Configuration.GetSection("Sync"));
builder.Services.Configure<BiOptions>(builder.Configuration.GetSection("Bi"));
builder.Services.Configure<MemoryOptions>(builder.Configuration.GetSection("Memory"));
builder.Services.Configure<LargeTablesOptions>(builder.Configuration.GetSection("LargeTables"));

builder.Services.AddHttpClient("cloud", (sp, client) =>
{
    var cloud = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<CloudOptions>>().Value;
    client.BaseAddress = new Uri(cloud.BaseUrl.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromMinutes(5);
});

builder.Services.AddSingleton<SqlReader>();
builder.Services.AddSingleton<CloudClient>();
builder.Services.AddSingleton<TableScheduler>();
builder.Services.AddSingleton<BiScriptRunner>();
builder.Services.AddHostedService<SyncWorker>();
builder.Services.AddHostedService<BiPushWorker>();

var host = builder.Build();

var startupLog = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
var syncOptions = host.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<SyncOptions>>().Value;
var largeOptions = host.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<LargeTablesOptions>>().Value;
startupLog.LogInformation(
    "Sync config: Schema={Schema} IntervalSeconds={Interval} ChunkSize={Chunk} LargeTables={LargeCount} SLA={Hours}h",
    syncOptions.Schema,
    syncOptions.IntervalSeconds,
    syncOptions.MaxRowsPerTablePerCycle,
    largeOptions.Tables.Count,
    largeOptions.MaxStalenessHours);

host.Run();
