# ============================================================
#  SqlSyncAgent - Instalador / Atualizador automatico (Windows)
# ------------------------------------------------------------
#  Uso (PowerShell como Administrador, no servidor do hospital):
#
#    # Primeira instalacao
#    powershell -ExecutionPolicy Bypass -File .\install.ps1 `
#       -RepoUrl "https://github.com/SUA-ORG/SEU-REPO.git" `
#       -CloudBaseUrl "https://automaocaobd.lovable.app" `
#       -CloudToken "CONNECTION-ID.RAW-TOKEN" `
#       -SqlHost "127.0.0.1" -SqlDatabase "MV2000" `
#       -SqlUser "sa" -SqlPassword "SENHA"
#
#    # Atualizacao (mesmos parametros - faz git pull, recompila, reinicia)
#    powershell -ExecutionPolicy Bypass -File .\install.ps1 -UpdateOnly
#
#  Requisitos: Windows Server, internet, permissao de Administrador.
#  O proprio script instala (se faltar): git, .NET 8 SDK e NSSM.
# ============================================================

[CmdletBinding()]
param(
  [string]$RepoUrl       = "",
  [string]$InstallDir    = "C:\sqlsync",
  [string]$ServiceName   = "SqlSyncAgent",
  [string]$CloudBaseUrl  = "",
  [string]$CloudToken    = "",
  [string]$AgentSecret   = "",
  [string]$SqlHost       = "127.0.0.1",
  [int]   $SqlPort       = 1433,
  [string]$SqlDatabase   = "",
  [string]$SqlAuthMode   = "Sql",
  [string]$SqlUser       = "sa",
  [string]$SqlPassword   = "",
  [int]   $SyncInterval  = 60,
  [int]   $MaxRows       = 50000,
  [switch]$UpdateOnly
)

$ErrorActionPreference = "Stop"
function Info($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "[ ok    ] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[ warn  ] $msg" -ForegroundColor Yellow }

# 0. Admin?
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$current).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Rode este script como Administrador." }

# 1. Garante winget / choco para dependencias
function Ensure-Tool($name, $wingetId, $chocoId) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { Ok "$name encontrado"; return }
  Info "Instalando $name..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id $wingetId -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install $chocoId -y | Out-Null
  } else {
    throw "Nem winget nem choco disponiveis. Instale $name manualmente."
  }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

Ensure-Tool "git"     "Git.Git"             "git"
Ensure-Tool "dotnet"  "Microsoft.DotNet.SDK.8" "dotnet-8.0-sdk"

# 2. Clona ou atualiza repositorio
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$repoDir = Join-Path $InstallDir "repo"

if (Test-Path (Join-Path $repoDir ".git")) {
  Info "Atualizando repositorio em $repoDir ..."
  Push-Location $repoDir
  git fetch --all --prune | Out-Null
  git reset --hard origin/HEAD | Out-Null
  Pop-Location
} else {
  if (-not $RepoUrl) { throw "Primeira instalacao requer -RepoUrl <url-do-git>." }
  Info "Clonando $RepoUrl ..."
  git clone $RepoUrl $repoDir | Out-Null
}
Ok "Repositorio pronto."

# 3. Compila o agente (publish self-contained nao - usa runtime instalado)
$agentSrc = Join-Path $repoDir "agent"
$publishDir = Join-Path $InstallDir "app"
if (-not (Test-Path $agentSrc)) { throw "Pasta 'agent' nao encontrada no repo." }

Info "Compilando agente..."
dotnet publish (Join-Path $agentSrc "SqlSyncAgent.csproj") `
  -c Release -o $publishDir --nologo | Out-Null
Ok "Compilado em $publishDir"

# 4. Gera/atualiza appsettings.json (preserva existente em UpdateOnly)
$cfgPath = Join-Path $publishDir "appsettings.json"
if ($UpdateOnly -and (Test-Path (Join-Path $InstallDir "appsettings.json"))) {
  Copy-Item (Join-Path $InstallDir "appsettings.json") $cfgPath -Force
  Ok "appsettings.json existente preservado."
} else {
  if (-not $CloudBaseUrl) { throw "Faltou -CloudBaseUrl" }
  if (-not $CloudToken)   { throw "Faltou -CloudToken (formato connection-id.raw-token)" }
  if (-not $SqlDatabase)  { throw "Faltou -SqlDatabase" }

  $cfg = [ordered]@{
    Cloud = [ordered]@{
      BaseUrl     = $CloudBaseUrl
      AgentSecret = $AgentSecret
      Token       = $CloudToken
    }
    Sql = [ordered]@{
      Host                   = $SqlHost
      Port                   = $SqlPort
      Database               = $SqlDatabase
      AuthMode               = $SqlAuthMode
      Username               = $SqlUser
      Password               = $SqlPassword
      Encrypt                = $true
      TrustServerCertificate = $true
      ConnectTimeoutSeconds  = 15
    }
    Sync = [ordered]@{
      IntervalSeconds         = $SyncInterval
      Schema                  = "dbo"
      MaxRowsPerTablePerCycle = $MaxRows
      ExcludedTables          = @()
    }
    Bi = [ordered]@{
      Enabled               = $false
      ScriptPath            = "C:\sqlsync\extrair-pmedico_19.sql"
      IntervalSeconds       = 300
      CommandTimeoutSeconds = 600
      PushPath              = "api/public/bi/push"
    }
  }
  ($cfg | ConvertTo-Json -Depth 6) | Set-Content -Encoding UTF8 $cfgPath
  Copy-Item $cfgPath (Join-Path $InstallDir "appsettings.json") -Force
  Ok "appsettings.json gerado."
}

# 5. Instala NSSM se necessario e (re)registra o servico
$nssm = Join-Path $InstallDir "nssm.exe"
if (-not (Test-Path $nssm)) {
  Info "Baixando NSSM (tentando varios mirrors)..."
  $zip = Join-Path $env:TEMP "nssm.zip"
  $mirrors = @(
    "https://web.archive.org/web/2024/https://nssm.cc/release/nssm-2.24.zip",
    "https://packages.chocolatey.org/NSSM.2.24.0.20180307.nupkg",
    "https://nssm.cc/release/nssm-2.24.zip"
  )
  $downloaded = $false
  foreach ($url in $mirrors) {
    try {
      Info "  -> $url"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 60
      if ((Get-Item $zip).Length -gt 100000) { $downloaded = $true; break }
    } catch { Warn "Mirror falhou: $($_.Exception.Message)" }
  }
  if (-not $downloaded) { throw "Nao consegui baixar o NSSM de nenhum mirror." }

  $extractDir = Join-Path $env:TEMP "nssm_extract"
  if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
  Expand-Archive $zip -DestinationPath $extractDir -Force

  # Procura nssm.exe em qualquer subpasta (estrutura varia por mirror)
  $found = Get-ChildItem -Path $extractDir -Recurse -Filter "nssm.exe" |
           Where-Object { $_.FullName -match "win64|x64" } |
           Select-Object -First 1
  if (-not $found) {
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter "nssm.exe" | Select-Object -First 1
  }
  if (-not $found) { throw "nssm.exe nao encontrado dentro do pacote baixado." }
  Copy-Item $found.FullName $nssm -Force
  Remove-Item $zip -Force
  Remove-Item $extractDir -Recurse -Force
  Ok "NSSM instalado."
}

$exe = Join-Path $publishDir "SqlSyncAgent.exe"
if (-not (Test-Path $exe)) {
  # publish gera dll - usar dotnet como host
  $exe = "$env:ProgramFiles\dotnet\dotnet.exe"
  $exeArgs = "`"$(Join-Path $publishDir 'SqlSyncAgent.dll')`""
} else {
  $exeArgs = ""
}

# Para servico se ja existir
$existing = & $nssm status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Info "Parando servico existente..."
  & $nssm stop $ServiceName confirm | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
}

Info "Registrando servico Windows '$ServiceName'..."
& $nssm install $ServiceName $exe $exeArgs | Out-Null
& $nssm set $ServiceName AppDirectory $publishDir | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $InstallDir "agent.out.log") | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $InstallDir "agent.err.log") | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $nssm set $ServiceName Description "Espelho SQL Server -> Lovable Cloud (sincroniza 100% das tabelas)" | Out-Null

Info "Iniciando servico..."
& $nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3
& $nssm status $ServiceName

Ok "Concluido. Logs em: $InstallDir\agent.out.log e agent.err.log"
Ok "Para atualizar futuramente:  powershell -ExecutionPolicy Bypass -File .\install.ps1 -UpdateOnly"
