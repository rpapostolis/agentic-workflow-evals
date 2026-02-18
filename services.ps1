# =============================================================================
# services.ps1 — Start, stop, and restart all AgentEval services (Windows)
#
# Usage:
#   .\services.ps1 start      Start API, Agent, and Webapp
#   .\services.ps1 stop       Stop all services
#   .\services.ps1 restart    Restart all services
#   .\services.ps1 status     Show which services are running
#   .\services.ps1 kill       Force-kill everything
#   .\services.ps1 seed       Populate demo data (services must be running)
#   .\services.ps1 reset      Delete database and reseed
#
# Environment variables override:
#   $env:OLLAMA_MODEL = "qwen2.5vl:72b"; .\services.ps1 start
# =============================================================================

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "restart", "kill", "status", "seed", "reset")]
    [string]$Command,

    [switch]$Seed
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidDir    = Join-Path $ScriptDir ".pids"
$LogDir    = Join-Path $ScriptDir ".logs"

$ApiPort   = 8000
$AgentPort = 8001
$WebappPort = 5001

# ── Load .env ────────────────────────────────────────────────────────────────
$EnvFile = Join-Path $ScriptDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        # Skip comments and blank lines
        if ($line -and -not $line.StartsWith("#")) {
            # Handle VAR=value (skip lines with ${} variable interpolation)
            if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                $varName  = $Matches[1]
                $varValue = $Matches[2].Trim('"').Trim("'")
                # Skip values that reference other env vars (${...})
                if ($varValue -notmatch '\$\{') {
                    # Only set if not already set (command-line env vars take precedence)
                    if (-not [Environment]::GetEnvironmentVariable($varName, "Process")) {
                        [Environment]::SetEnvironmentVariable($varName, $varValue, "Process")
                    }
                }
            }
        }
    }
}

# Resolve interpolated values that depend on other vars
$OllamaHost = if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST } else { "http://localhost:11434" }
if (-not $env:LLM_BASE_URL)    { $env:LLM_BASE_URL    = "$OllamaHost/v1" }
if (-not $env:MCP_SERVER_URL)  { $env:MCP_SERVER_URL  = "http://localhost:${ApiPort}/mcp" }
if (-not $env:VITE_API_URL)    { $env:VITE_API_URL    = "http://localhost:${ApiPort}/api" }
if (-not $env:OLLAMA_MODEL)    { $env:OLLAMA_MODEL    = "qwen3-vl:latest" }

# ── Resolve judge backend (computed once after .env is loaded) ────────────────
$JudgeLlmUrl   = $env:LLM_BASE_URL
$JudgeLlmModel = if ($env:LLM_MODEL) { $env:LLM_MODEL } else { "qwen3-coder:latest" }

if ($JudgeLlmUrl -match "anthropic\.com") {
    $JudgeBackend = "Claude API"
    $keySet = ($env:LLM_API_KEY -and $env:LLM_API_KEY -ne "ollama") -or $env:ANTHROPIC_API_KEY
    if ($keySet) {
        $JudgeKeyStatus = "key configured"
        $JudgeKeyOk     = $true
    } else {
        $JudgeKeyStatus = "WARNING: no API key — set LLM_API_KEY or ANTHROPIC_API_KEY"
        $JudgeKeyOk     = $false
    }
} elseif ($JudgeLlmUrl -match "openai\.com") {
    $JudgeBackend = "OpenAI API"
    $keySet = $env:LLM_API_KEY -and $env:LLM_API_KEY -ne "ollama"
    if ($keySet) {
        $JudgeKeyStatus = "key configured"
        $JudgeKeyOk     = $true
    } else {
        $JudgeKeyStatus = "WARNING: no API key — set LLM_API_KEY"
        $JudgeKeyOk     = $false
    }
} else {
    $JudgeBackend   = "Ollama (local)"
    $JudgeKeyStatus = "no auth required"
    $JudgeKeyOk     = $true
}

# ── Resolve CUA mode (computed once after .env is loaded) ─────────────────────
$CuaMode = if ($env:CUA_MODE) { $env:CUA_MODE.ToLower() } else { "ollama" }
if ($CuaMode -eq "claude") {
    $CuaDisplay  = "Claude API"
    $CuaModel    = if ($env:CUA_MODEL) { $env:CUA_MODEL } else { "claude-sonnet-4-5-20250929" }
    $cuaKeySet   = ($env:CUA_API_KEY -and $env:CUA_API_KEY -ne "ollama") `
                   -or ($env:LLM_API_KEY -and $env:LLM_API_KEY -ne "ollama") `
                   -or $env:ANTHROPIC_API_KEY
    if ($cuaKeySet) {
        $CuaKeyStatus = "key configured"
        $CuaKeyOk     = $true
    } else {
        $CuaKeyStatus = "WARNING: no API key — set ANTHROPIC_API_KEY or LLM_API_KEY"
        $CuaKeyOk     = $false
    }
} else {
    $CuaDisplay  = "Ollama (local)"
    $CuaModel    = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "cua-agent" }
    $CuaKeyStatus = "no auth required"
    $CuaKeyOk     = $true
}

# ── Ensure directories ──────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $PidDir  -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir  -Force | Out-Null

# ── Activate virtualenv ─────────────────────────────────────────────────────
$VenvActivate = Join-Path $ScriptDir ".venv\Scripts\Activate.ps1"
if (-not (Test-Path $VenvActivate)) {
    $VenvActivate = Join-Path $ScriptDir "venv\Scripts\Activate.ps1"
}
if (Test-Path $VenvActivate) {
    & $VenvActivate
}

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Log   { param([string]$Msg) Write-Host "[services] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "  ✓ $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "  ⚠ $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "  ✗ $Msg" -ForegroundColor Red }

function Get-PidFile {
    param([string]$Name)
    return Join-Path $PidDir "$Name.pid"
}

function Test-ServiceRunning {
    param([string]$Name)
    $pidFile = Get-PidFile $Name
    if (Test-Path $pidFile) {
        $pid = [int](Get-Content $pidFile)
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            return $true
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    return $false
}

function Test-PortListening {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $conn)
}

function Stop-PortProcesses {
    param([int]$Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        $conns | ForEach-Object {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

function Wait-ForPort {
    param([int]$Port, [string]$Name, [int]$Retries = 90)
    for ($i = 1; $i -le $Retries; $i++) {
        if (Test-PortListening $Port) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    Write-Warn "$Name did not start on port $Port within ${Retries}s"
    return $false
}

# ── Start functions ──────────────────────────────────────────────────────────

function Start-Api {
    if (Test-ServiceRunning "api") {
        $pid = Get-Content (Get-PidFile "api")
        Write-Warn "API already running (pid $pid)"
        return
    }
    Stop-PortProcesses $ApiPort
    Write-Log "Starting API on port $ApiPort..."
    Write-Log "  Judge backend : $JudgeBackend"
    Write-Log "  Judge model   : $JudgeLlmModel"
    if (-not $JudgeKeyOk) {
        Write-Warn $JudgeKeyStatus
    }

    $logFile = Join-Path $LogDir "api.log"
    $proc = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "uvicorn", "src.api.main:app",
        "--host", "0.0.0.0", "--port", $ApiPort, "--reload",
        "--reload-dir", "src/api"
    ) -WorkingDirectory $ScriptDir -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru

    $proc.Id | Out-File -FilePath (Get-PidFile "api") -Encoding ascii
    if (Wait-ForPort $ApiPort "API") {
        Write-Ok "API running (pid $($proc.Id), port $ApiPort)"
    }
}

function Start-Agent {
    if (Test-ServiceRunning "agent") {
        $pid = Get-Content (Get-PidFile "agent")
        Write-Warn "Agent already running (pid $pid)"
        return
    }
    Stop-PortProcesses $AgentPort
    Write-Log "Starting Computer Use Agent on port $AgentPort..."

    # Ensure Playwright browsers are installed
    $pwCheck = & python -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); p.chromium.executable_path; p.stop()" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Installing Playwright browsers (first run)..."
        & python -m playwright install chromium
        Write-Ok "Playwright chromium installed"
    }

    # Auto-adjust timeout if not explicitly set
    $env:CU_AGENT_PORT = $AgentPort
    if (-not $env:CU_ACTION_TIMEOUT) {
        if ($CuaMode -eq "claude") {
            $env:CU_ACTION_TIMEOUT = "60"   # Claude API calls take longer
        } else {
            $model = $env:OLLAMA_MODEL
            if ($model -match "72b|70b")    { $env:CU_ACTION_TIMEOUT = "90" }
            elseif ($model -match "32b")    { $env:CU_ACTION_TIMEOUT = "60" }
            else                            { $env:CU_ACTION_TIMEOUT = "30" }
        }
    }
    Write-Log "  CUA mode: $CuaDisplay — $CuaModel"
    Write-Log "  Action timeout: $($env:CU_ACTION_TIMEOUT)s per step"
    if (-not $CuaKeyOk) {
        Write-Warn $CuaKeyStatus
    }

    $logFile = Join-Path $LogDir "agent.log"
    $proc = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "uvicorn", "src.agents.computer_use.server:app",
        "--host", "0.0.0.0", "--port", $AgentPort, "--reload",
        "--reload-dir", "src/agents/computer_use"
    ) -WorkingDirectory $ScriptDir -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru

    $proc.Id | Out-File -FilePath (Get-PidFile "agent") -Encoding ascii
    if (Wait-ForPort $AgentPort "Agent") {
        Write-Ok "Computer Use Agent running (pid $($proc.Id), port $AgentPort)"
    }
}

function Start-Webapp {
    if (Test-ServiceRunning "webapp") {
        $pid = Get-Content (Get-PidFile "webapp")
        Write-Warn "Webapp already running (pid $pid)"
        return
    }
    Stop-PortProcesses $WebappPort
    Write-Log "Starting Webapp on port $WebappPort..."

    $webappDir = Join-Path $ScriptDir "src\webapp"
    $logFile = Join-Path $LogDir "webapp.log"
    $proc = Start-Process -FilePath "npm" -ArgumentList @(
        "run", "dev", "--", "--port", $WebappPort
    ) -WorkingDirectory $webappDir -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" -PassThru

    $proc.Id | Out-File -FilePath (Get-PidFile "webapp") -Encoding ascii
    if (Wait-ForPort $WebappPort "Webapp") {
        Write-Ok "Webapp running (pid $($proc.Id), port $WebappPort)"
    }
}

# ── Stop functions ───────────────────────────────────────────────────────────

function Stop-Service {
    param([string]$Name, [int]$Port)
    $pidFile = Get-PidFile $Name
    if (Test-Path $pidFile) {
        $pid = [int](Get-Content $pidFile)
        Write-Log "Stopping $Name (pid $pid)..."

        # Kill the process and all its children (important for uvicorn/node)
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc -and -not $proc.HasExited) {
            # Kill the process tree
            Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pid } | ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    # Clean up anything else on the port
    Stop-PortProcesses $Port
    Write-Ok "$Name stopped"
}

# ── Seed ─────────────────────────────────────────────────────────────────────

function Invoke-SeedDemoData {
    Write-Log "Seeding demo data..."
    $retries = 15
    for ($i = 1; $i -le $retries; $i++) {
        try {
            $health = Invoke-RestMethod "http://localhost:$ApiPort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($health) {
                try {
                    $resp = Invoke-RestMethod -Method Post "http://localhost:$ApiPort/api/admin/seed-demo" -TimeoutSec 30
                    Write-Ok "Demo data seeded (agents, datasets, evaluations)"
                    return
                } catch {
                    Write-Warn "Seed API call failed: $_"
                    return
                }
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Write-Warn "API not reachable after ${retries}s — skipping seed"
}

# ── Commands ─────────────────────────────────────────────────────────────────

function Invoke-Start {
    Write-Log "Starting all services..."
    Write-Host ""
    Start-Api
    Start-Agent
    Start-Webapp

    # Seed demo data if --Seed flag is set OR if this is the first run (no DB)
    $dbPath = Join-Path $ScriptDir "data\evals.db"
    if ($Seed -or -not (Test-Path $dbPath)) {
        Write-Host ""
        if (-not (Test-Path $dbPath)) {
            Write-Log "First run detected (no database). Seeding demo data automatically..."
        }
        Invoke-SeedDemoData
    }

    Write-Host ""
    Write-Log "All services started:"
    Write-Host "  Frontend : http://localhost:$WebappPort" -ForegroundColor Green
    Write-Host "  API Docs : http://localhost:$ApiPort/api/docs" -ForegroundColor Green
    Write-Host "  CU Agent : http://localhost:$AgentPort  ($CuaDisplay / $CuaModel)" -ForegroundColor Green
    Write-Host ""
    Write-Log "LLM configuration:"
    Write-Host "  Judge    : " -NoNewline
    Write-Host "$JudgeBackend — $JudgeLlmModel" -ForegroundColor Yellow -NoNewline
    Write-Host "  ($JudgeKeyStatus)"
    Write-Host "  CU Agent : " -NoNewline
    Write-Host "$CuaDisplay — $CuaModel" -ForegroundColor Yellow -NoNewline
    Write-Host "  ($CuaKeyStatus)"
    Write-Host ""
    Write-Host "  Logs in  : $LogDir"
    Write-Host "  Stop with: " -NoNewline
    Write-Host ".\services.ps1 stop" -ForegroundColor Cyan
}

function Invoke-Stop {
    Write-Log "Stopping all services..."
    Write-Host ""

    # Tell the CU Agent to close any open browsers before killing it
    if (Test-PortListening $AgentPort) {
        try {
            Invoke-RestMethod -Method Post "http://localhost:$AgentPort/cancel" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
            Write-Ok "Sent cancel to CU Agent (browsers closing)"
        } catch { }
    }

    Stop-Service "webapp" $WebappPort
    Stop-Service "agent"  $AgentPort
    Stop-Service "api"    $ApiPort

    # Kill any stray Chromium/Playwright processes
    $strayProcs = Get-Process -Name "chrome", "chromium", "msedge" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq "" -or $_.Path -match "playwright|Chromium" }
    if ($strayProcs) {
        $strayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Ok "Killed stray Chromium/Playwright processes"
    }

    Write-Host ""
    Write-Ok "All services stopped"
}

function Invoke-Restart {
    Invoke-Stop
    Write-Host ""
    Invoke-Start
}

function Invoke-Kill {
    Write-Log "Force-killing everything..."
    Write-Host ""

    # 1. Cancel running agent tasks
    try {
        Invoke-RestMethod -Method Post "http://localhost:$AgentPort/cancel" -TimeoutSec 3 -ErrorAction SilentlyContinue | Out-Null
    } catch { }

    # 2. Kill services by port
    @(
        @{ Name = "Webapp"; Port = $WebappPort },
        @{ Name = "Agent";  Port = $AgentPort },
        @{ Name = "API";    Port = $ApiPort }
    ) | ForEach-Object {
        Stop-PortProcesses $_.Port
        Write-Ok "$($_.Name) killed (port $($_.Port))"
    }

    # 3. Kill all uvicorn workers
    Get-Process -Name "python", "python3" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "uvicorn" } |
        Stop-Process -Force -ErrorAction SilentlyContinue

    # 4. Kill all Playwright / Chromium processes
    Get-Process -Name "chrome", "chromium", "msedge" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -match "playwright|Chromium|Testing" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Ok "Killed all Chromium/Playwright processes"

    # 5. Clean up PID files
    Remove-Item "$PidDir\*.pid" -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Ok "Everything killed"
}

function Invoke-Status {
    Write-Log "Service status:"
    Write-Host ""
    foreach ($svc in @("api", "agent", "webapp")) {
        if (Test-ServiceRunning $svc) {
            $pid = Get-Content (Get-PidFile $svc)
            Write-Ok "$svc is running (pid $pid)"
        } else {
            Write-Err "$svc is not running"
        }
    }
    Write-Host ""

    # Also check ports directly
    @(
        @{ Name = "API";    Port = $ApiPort },
        @{ Name = "Agent";  Port = $AgentPort },
        @{ Name = "Webapp"; Port = $WebappPort }
    ) | ForEach-Object {
        if (Test-PortListening $_.Port) {
            Write-Ok "Port $($_.Port) ($($_.Name)) is listening"
        } else {
            Write-Err "Port $($_.Port) ($($_.Name)) is not listening"
        }
    }

    Write-Host ""
    Write-Log "LLM configuration:"
    Write-Host "  Judge    : " -NoNewline
    Write-Host "$JudgeBackend — $JudgeLlmModel" -ForegroundColor Yellow -NoNewline
    Write-Host "  ($JudgeKeyStatus)"
    Write-Host "  CU Agent : " -NoNewline
    Write-Host "$CuaDisplay — $CuaModel" -ForegroundColor Yellow -NoNewline
    Write-Host "  ($CuaKeyStatus)"
}

function Invoke-Reset {
    Write-Log "Resetting database and reseeding..."
    Write-Host ""
    $dbPath = Join-Path $ScriptDir "data\evals.db"
    if (Test-Path $dbPath) {
        Remove-Item $dbPath -Force
        Write-Ok "Deleted existing database"
    } else {
        Write-Warn "No database found — nothing to delete"
    }
    # Ensure API is running (or start it)
    if (-not (Test-PortListening $ApiPort)) {
        Write-Log "API not running — starting it for seeding..."
        Start-Api
    }
    Write-Host ""
    Invoke-SeedDemoData
}

# ── Main ─────────────────────────────────────────────────────────────────────

if (-not $Command) {
    Write-Host "Usage: .\services.ps1 {start|stop|restart|kill|status|seed|reset}"
    Write-Host ""
    Write-Host "  start [-Seed]   Start API (8000), CU Agent (8001), and Webapp (5001)"
    Write-Host "                  -Seed  Populate demo data (auto on first run)"
    Write-Host "  stop            Graceful stop (cancels agent tasks, closes browsers)"
    Write-Host "  restart         Stop then start all services"
    Write-Host "  kill            Force-kill everything (services, browsers, Chromium)"
    Write-Host "  status          Show which services are running"
    Write-Host "  seed            Populate demo data (services must be running)"
    Write-Host "  reset           Delete database and reseed (services must be running)"
    exit 1
}

switch ($Command) {
    "start"   { Invoke-Start }
    "stop"    { Invoke-Stop }
    "restart" { Invoke-Restart }
    "kill"    { Invoke-Kill }
    "status"  { Invoke-Status }
    "seed"    { Invoke-SeedDemoData }
    "reset"   { Invoke-Reset }
}
