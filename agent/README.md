# SQL Sync Agent (Windows)

Worker Service em .NET 8 que lê tabelas de um SQL Server local e sincroniza com a nuvem (Lovable Cloud) a cada 1 minuto.

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

Copie/edite `C:\sqlsync-agent\appsettings.json` antes de iniciar.

## Configuração (`appsettings.json`)

```json
{
  "Cloud": {
    "BaseUrl": "https://seu-projeto.lovable.app",
    "AgentSecret": "<AGENT_INGEST_SECRET>",
    "Token": "<connectionId>.<rawToken>"
  },
  "Sql": {
    "Host": "192.168.1.10",
    "Port": 1433,
    "Database": "MeuBanco",
    "AuthMode": "Sql",
    "Username": "sa",
    "Password": "***",
    "Encrypt": true,
    "TrustServerCertificate": true
  },
  "Sync": {
    "IntervalSeconds": 60,
    "Schema": "dbo",
    "MaxRowsPerTablePerCycle": 5000
  }
}
```

`AuthMode`:
- `Sql` — usa `Username` + `Password`
- `Windows` — usa a conta do serviço Windows (Integrated Security)

## Instalar como Windows Service

```powershell
sc.exe create SqlSyncAgent binPath= "C:\sqlsync-agent\SqlSyncAgent.exe" start= auto
sc.exe description SqlSyncAgent "SQL Server -> Lovable Cloud sync agent"
sc.exe start SqlSyncAgent
```

Para rodar com Windows Authentication, configure a conta do serviço:

```powershell
sc.exe config SqlSyncAgent obj= "DOMINIO\usuario" password= "***"
```

## Logs

```powershell
Get-EventLog -LogName Application -Source SqlSyncAgent -Newest 50
# ou: arquivo agent.log ao lado do executável
```

## Como funciona

1. A cada `IntervalSeconds`, o agente:
   - Consulta `INFORMATION_SCHEMA` para listar tabelas do schema configurado.
   - Detecta `rowversion` em cada tabela.
   - **Tabelas com rowversion**: lê apenas linhas com `[rowversion] > @ultimo_checksum`.
   - **Tabelas sem rowversion**: lê todas as linhas, calcula SHA-256 por linha e envia em modo `full_replace` (a nuvem deduplica via `row_hash`).
2. POST para `/api/public/agent/ingest` com Bearer token + header `X-Agent-Secret`.
3. Atualiza `last_checksum` e marca `last_synced_at` na nuvem.

## Segurança

- Senha do SQL nunca sai do servidor — só os dados das tabelas.
- Token do agente é hash SHA-256 do lado da nuvem; o valor original existe apenas no `appsettings.json`.
- Comunicação via HTTPS.
