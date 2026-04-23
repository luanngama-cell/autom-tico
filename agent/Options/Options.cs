namespace SqlSyncAgent.Options;

public class CloudOptions
{
    public string BaseUrl { get; set; } = "";
    public string AgentSecret { get; set; } = "";
    public string Token { get; set; } = "";
}

public class SqlOptions
{
    public string Host { get; set; } = "";
    public int Port { get; set; } = 1433;
    public string Database { get; set; } = "";
    /// <summary>"Sql" or "Windows"</summary>
    public string AuthMode { get; set; } = "Sql";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public bool Encrypt { get; set; } = true;
    public bool TrustServerCertificate { get; set; } = true;
    public int ConnectTimeoutSeconds { get; set; } = 15;
}

public class SyncOptions
{
    public int IntervalSeconds { get; set; } = 60;
    public string Schema { get; set; } = "dbo";
    public int MaxRowsPerTablePerCycle { get; set; } = 5000;
    public List<string> ExcludedTables { get; set; } = new();
}

public class BiOptions
{
    /// <summary>Habilita execução periódica do script BI e push do snapshot.</summary>
    public bool Enabled { get; set; } = false;
    /// <summary>Caminho absoluto do arquivo .sql a ser executado.</summary>
    public string ScriptPath { get; set; } = "";
    /// <summary>Intervalo entre execuções do script BI (segundos).</summary>
    public int IntervalSeconds { get; set; } = 300;
    /// <summary>Timeout do comando SQL (segundos).</summary>
    public int CommandTimeoutSeconds { get; set; } = 600;
    /// <summary>Path da rota de push (default /api/public/bi/push).</summary>
    public string PushPath { get; set; } = "api/public/bi/push";
}
