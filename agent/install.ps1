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
#  O proprio script instala (se faltar): git e .NET 8 SDK.
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
  try {
    $existingCfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($null -eq $existingCfg.Sync) {
      $existingCfg | Add-Member -NotePropertyName Sync -NotePropertyValue ([pscustomobject]@{})
    }
    if ($null -eq $existingCfg.Sync.MaxRowsPerTablePerCycle -or [int]$existingCfg.Sync.MaxRowsPerTablePerCycle -eq 5000) {
      $existingCfg.Sync.MaxRowsPerTablePerCycle = 50000
      ($existingCfg | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 $cfgPath
      Copy-Item $cfgPath (Join-Path $InstallDir "appsettings.json") -Force
      Ok "appsettings.json migrado: MaxRowsPerTablePerCycle=50000"
    }
  } catch {
    Warn "Nao consegui migrar appsettings.json automaticamente: $($_.Exception.Message)"
  }
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

# 5. Registra o servico usando o Service Control Manager nativo do Windows
$exe = Join-Path $publishDir "SqlSyncAgent.exe"
if (-not (Test-Path $exe)) {
  # publish gera dll - usar dotnet como host
  $exe = "$env:ProgramFiles\dotnet\dotnet.exe"
  $exeArgs = "`"$(Join-Path $publishDir 'SqlSyncAgent.dll')`""
} else {
  $exeArgs = ""
}

$serviceBinPath = if ($exeArgs) {
  "`"$exe`" $exeArgs"
} else {
  "`"$exe`""
}

# Para servico se ja existir
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Info "Parando servico existente..."
  try {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  } catch {
    Warn "Nao consegui parar o servico de imediato: $($_.Exception.Message)"
  }
  sc.exe delete $ServiceName | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
}

Info "Registrando servico Windows '$ServiceName'..."
sc.exe create $ServiceName binPath= $serviceBinPath start= auto | Out-Null
sc.exe description $ServiceName "Espelho SQL Server -> Lovable Cloud (sincroniza 100% das tabelas)" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
sc.exe failureflag $ServiceName 1 | Out-Null

Info "Iniciando servico..."
Start-Service -Name $ServiceName
for ($i = 0; $i -lt 15; $i++) {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq "Running") { break }
  Start-Sleep -Seconds 1
}
Get-Service -Name $ServiceName

Ok "Concluido. Logs em: $publishDir\agent.log"
Ok "Para atualizar futuramente:  powershell -ExecutionPolicy Bypass -File .\install.ps1 -UpdateOnly"
