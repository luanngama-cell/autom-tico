# Instalação do SqlSyncAgent (servidor do hospital)

Tudo é feito por **um único comando** no PowerShell rodando como **Administrador**.
Esse comando instala git, .NET 8 SDK e NSSM (se faltar), clona o repositório,
compila o agente, gera o `appsettings.json`, registra o serviço Windows com
**inicialização automática** e **reinício automático em caso de falha**, e inicia o serviço.

## 1. Primeira instalação

```powershell
# Baixe só o instalador
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://raw.githubusercontent.com/SUA-ORG/SEU-REPO/main/agent/install.ps1" `
  -OutFile "$env:TEMP\install.ps1"

# Execute (substitua os valores entre <>)
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1" `
  -RepoUrl       "https://github.com/SUA-ORG/SEU-REPO.git" `
  -CloudBaseUrl  "https://automaocaobd.lovable.app" `
  -CloudToken    "<CONNECTION-ID>.<RAW-TOKEN>" `
  -SqlHost       "127.0.0.1" `
  -SqlPort       1433 `
  -SqlDatabase   "<NOME_DO_BANCO>" `
  -SqlUser       "sa" `
  -SqlPassword   "<SENHA_DO_SQL>"
```

Pronto. O serviço **SqlSyncAgent** fica registrado e roda 24/7. Se o servidor
reiniciar, o serviço sobe sozinho. Se o agente cair, o NSSM reinicia em 5s.

## 2. Atualizações futuras (sem perder configuração)

```powershell
powershell -ExecutionPolicy Bypass -File C:\sqlsync\repo\agent\install.ps1 -UpdateOnly
```

Faz `git pull`, recompila e reinicia. Mantém o `appsettings.json` existente.

## 3. Onde ficam os arquivos

| Caminho | O que é |
|---|---|
| `C:\sqlsync\repo\` | Código-fonte (sempre atualizado por git pull) |
| `C:\sqlsync\app\` | Binário compilado em uso pelo serviço |
| `C:\sqlsync\appsettings.json` | Configuração (preservada em updates) |
| `C:\sqlsync\agent.out.log` | Log padrão (rotaciona a cada 10 MB) |
| `C:\sqlsync\agent.err.log` | Log de erros |

## 4. Comandos úteis

```powershell
# Status
C:\sqlsync\nssm.exe status SqlSyncAgent

# Parar / iniciar / reiniciar manualmente
C:\sqlsync\nssm.exe stop    SqlSyncAgent
C:\sqlsync\nssm.exe start   SqlSyncAgent
C:\sqlsync\nssm.exe restart SqlSyncAgent

# Ver logs ao vivo
Get-Content C:\sqlsync\agent.out.log -Wait -Tail 50
```

## 5. Garantias

- **Espelho 100% completo**: paginação por `rowversion` (incremental) e `OFFSET/FETCH`
  (full-scan) varrem **todas** as linhas a cada ciclo. Sem teto de 5000.
- **Reconciliação de exclusões**: o agente envia todas as PKs; o servidor remove
  no Postgres o que sumiu no SQL Server.
- **Auto-restart**: NSSM reinicia o processo se cair; serviço configurado como
  `SERVICE_AUTO_START` (sobe junto com o Windows).
- **Sem ação no servidor após instalado**: atualizações de código no Lovable
  não exigem mexer no servidor. Só rode `-UpdateOnly` quando você quiser puxar
  uma nova versão do agente.
