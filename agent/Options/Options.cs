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
    /// <summary>Timeout para queries SELECT/COUNT (segundos). Default: 600s (10min) — necessário para tabelas gigantes.</summary>
    public int CommandTimeoutSeconds { get; set; } = 600;
}

public class SyncOptions
{
    public int IntervalSeconds { get; set; } = 60;
    public string Schema { get; set; } = "dbo";
    /// <summary>Tamanho do lote enviado ao Cloud por chunk. Streaming: cada chunk é enviado e descartado da RAM imediatamente.</summary>
    public int MaxRowsPerTablePerCycle { get; set; } = 2000;
    public List<string> ExcludedTables { get; set; } = new();
}

public class MemoryOptions
{
    /// <summary>Percentual máximo da RAM física que o agente pode usar (10–90). Default: 25%.</summary>
    public int MaxPercentOfTotalRam { get; set; } = 25;
    /// <summary>Limiar (MB) acima do qual tabelas grandes ficam pausadas até a memória baixar. Default: 1500 MB.</summary>
    public int LargeTablePauseAboveMb { get; set; } = 1500;
}

public class LargeTablesOptions
{
    /// <summary>Lista de nomes de tabelas (case-insensitive) tratadas como "grandes": só rodam quando memória está baixa, com SLA garantido.</summary>
    public List<string> Tables { get; set; } = new();
    /// <summary>SLA em horas: se uma tabela grande não foi sincronizada nesse intervalo, vira prioritária no próximo ciclo (mesmo sob pressão de memória).</summary>
    public int MaxStalenessHours { get; set; } = 2;
    /// <summary>Quantas tabelas grandes processar por ciclo (em condição normal). Default: 1.</summary>
    public int MaxPerCycle { get; set; } = 1;
    /// <summary>Tamanho do lote para streaming de tabelas grandes (linhas por chunk). Default: 200 (pequeno por causa de BLOBs).</summary>
    public int ChunkSize { get; set; } = 200;
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
