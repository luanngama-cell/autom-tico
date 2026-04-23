# SQL Sync Agent (Windows)

Worker Service em .NET 8. Faz **dois trabalhos** independentes:

1. **SyncWorker** — sincroniza tabelas SQL Server → Lovable Cloud (`/api/public/agent/ingest`).
2. **BiPushWorker** — executa o script `extrair-pmedico_19.sql` periodicamente e envia o JSON resultante para `/api/public/bi/push`. O endpoint deduplica por hash, então rodar "à toa" não envia bytes desnecessários.

## Pré-requisitos

- Windows Server 2016+ ou Windows 10/11
- .NET 8 SDK (somente para compilar — depois roda self-contained)
- Acesso de rede ao SQL Server

## Build

```powershell
cd agent
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o C:\sqlsync-agent
```

## Configuração (`appsettings.json`)

```json
{
  "Cloud": {
    "BaseUrl": "https://automaocaobd.lovable.app",
    "AgentSecret": "<AGENT_INGEST_SECRET>",
    "Token": "<connectionId>.<rawToken>"
  },
  "Sql": {
    "Host": "127.0.0.1",
    "Port": 1433,
    "Database": "MyDatabase",
    "AuthMode": "Sql",
    "Username": "sa",
    "Password": "***",
    "Encrypt": true,
    "TrustServerCertificate": true
  },
  "Sync": {
    "IntervalSeconds": 60,
    "Schema": "dbo",
    "MaxRowsPerTablePerCycle": 5000,
    "ExcludedTables": []
  },
  "Bi": {
    "Enabled": true,
    "ScriptPath": "C:\\sqlsync\\extrair-pmedico_19.sql",
    "IntervalSeconds": 300,
    "CommandTimeoutSeconds": 600,
    "PushPath": "api/public/bi/push"
  }
}
```

### Convenções para o script BI

O `BiScriptRunner` aceita 3 formas:

1. **Script já retorna JSON completo** (ex.: `SELECT (... FOR JSON PATH) AS json`):
   é detectado automaticamente — o conteúdo vira o snapshot direto.

2. **Múltiplos resultsets nomeados**: cada `SELECT` vira uma "section". Use a
   coluna `__section` para nomear:
   ```sql
   SELECT 'kpis' AS __section, COUNT(*) AS pacientes, SUM(valor) AS receita FROM ...;
   SELECT 'agenda' AS __section, * FROM v_agenda;
   ```
   Resultado: `{ generated_at, source, sections: { kpis: {...}, agenda: [...] } }`.

3. **Sem `__section`**: cada resultset vira `section_1`, `section_2`, etc.

Linhas únicas viram objeto; múltiplas viram array. `DateTime` é serializado em ISO-8601, `byte[]` em base64.

## Instalação como serviço Windows

```powershell
sc.exe create SqlSyncAgent binPath= "C:\sqlsync-agent\SqlSyncAgent.exe" start= auto
sc.exe start SqlSyncAgent
```

Logs: `C:\sqlsync-agent\agent.log` (rolagem diária, 14 dias) + Event Viewer.

## Push BI: como funciona o delta

- O agente envia o JSON completo a cada `Bi.IntervalSeconds`.
- O endpoint `/api/public/bi/push` calcula `sha256(payload)` + sha256 por seção.
- Se igual ao último `bi_snapshots.payload_hash`: registra `skipped` em `bi_deliveries` e **não** repassa pro destino BI.
- Se mudou: faz `POST` pro `endpoint_url` de cada destino habilitado, atualiza snapshot e loga.
- Falhas não atualizam o snapshot (permitem retry no próximo ciclo).

## Endpoints disponíveis no Cloud

| Rota | Método | Uso |
|------|--------|-----|
| `/api/public/agent/manifest` | GET | manifest de tabelas (last_checksum) |
| `/api/public/agent/ingest` | POST | sync de tabelas SQL Server |
| `/api/public/bi/push` | POST | push do snapshot do script BI |
| `/api/public/bi/snapshot` | GET | leitura do último snapshot (BI consome) |

Auth: `Authorization: Bearer <id>.<token>` + `X-Agent-Secret: <segredo>` (este último só no agente).
