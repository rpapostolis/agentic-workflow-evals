#!/usr/bin/env bash
# =============================================================================
# services.sh — Start, stop, and restart all AgentEval services
#
# Usage:
#   ./services.sh start     Start API, Agent, and Webapp
#   ./services.sh stop      Stop all services
#   ./services.sh restart   Restart all services
#   ./services.sh status    Show which services are running
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/.logs"

API_PORT=8000
AGENT_PORT=8001
WEBAPP_PORT=5001

# ── Load .env ────────────────────────────────────────────────────────────────
# Source .env for config (OLLAMA_MODEL, CU_HEADLESS, etc.)
# Command-line env vars take precedence: OLLAMA_MODEL=qwen2.5vl:72b ./services.sh start
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a  # auto-export all assignments
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

mkdir -p "$PID_DIR" "$LOG_DIR"

# ── Resolve judge backend (computed once after .env is loaded) ────────────────
_LLM_URL="${LLM_BASE_URL:-http://localhost:11434/v1}"
_LLM_MODEL="${LLM_MODEL:-qwen3-coder:latest}"

if [[ "$_LLM_URL" == *"anthropic.com"* ]]; then
    _JUDGE_BACKEND="Claude API"
    if [[ ( -n "${LLM_API_KEY:-}" && "${LLM_API_KEY:-}" != "ollama" ) || -n "${ANTHROPIC_API_KEY:-}" ]]; then
        _JUDGE_KEY_STATUS="${GREEN}key configured${NC}"
        _JUDGE_KEY_OK=true
    else
        _JUDGE_KEY_STATUS="${RED}⚠ no API key — set LLM_API_KEY or ANTHROPIC_API_KEY${NC}"
        _JUDGE_KEY_OK=false
    fi
elif [[ "$_LLM_URL" == *"openai.com"* ]]; then
    _JUDGE_BACKEND="OpenAI API"
    if [[ -n "${LLM_API_KEY:-}" && "${LLM_API_KEY:-}" != "ollama" ]]; then
        _JUDGE_KEY_STATUS="${GREEN}key configured${NC}"
        _JUDGE_KEY_OK=true
    else
        _JUDGE_KEY_STATUS="${RED}⚠ no API key — set LLM_API_KEY${NC}"
        _JUDGE_KEY_OK=false
    fi
else
    _JUDGE_BACKEND="Ollama (local)"
    _JUDGE_KEY_STATUS="${CYAN}no auth required${NC}"
    _JUDGE_KEY_OK=true
fi

# ── Resolve CUA mode (computed once after .env is loaded) ─────────────────────
_CUA_MODE="${CUA_MODE:-ollama}"
if [[ "$_CUA_MODE" == "claude" ]]; then
    _CUA_DISPLAY="Claude API"
    _CUA_MODEL="${CUA_MODEL:-claude-sonnet-4-5-20250929}"
    _CUA_KEY_OK=false
    if [[ ( -n "${CUA_API_KEY:-}" && "${CUA_API_KEY:-}" != "ollama" ) \
       || ( -n "${LLM_API_KEY:-}"  && "${LLM_API_KEY:-}"  != "ollama" ) \
       || -n "${ANTHROPIC_API_KEY:-}" ]]; then
        _CUA_KEY_STATUS="${GREEN}key configured${NC}"
        _CUA_KEY_OK=true
    else
        _CUA_KEY_STATUS="${RED}⚠ no API key — set ANTHROPIC_API_KEY or LLM_API_KEY${NC}"
        _CUA_KEY_OK=false
    fi
else
    _CUA_DISPLAY="Ollama (local)"
    _CUA_MODEL="${OLLAMA_MODEL:-cua-agent}"
    _CUA_KEY_STATUS="${CYAN}no auth required${NC}"
    _CUA_KEY_OK=true
fi

# ── Activate project virtualenv ──────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.venv/bin/activate"
elif [[ -f "$SCRIPT_DIR/venv/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/venv/bin/activate"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

log()   { echo -e "${CYAN}[services]${NC} $1"; }
ok()    { echo -e "${GREEN}  ✓${NC} $1"; }
warn()  { echo -e "${YELLOW}  ⚠${NC} $1"; }
err()   { echo -e "${RED}  ✗${NC} $1"; }

is_running() {
    local pidfile="$PID_DIR/$1.pid"
    if [[ -f "$pidfile" ]]; then
        local pid
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$pidfile"
    fi
    return 1
}

wait_for_port() {
    # Usage: wait_for_port <port> <name> [pid]
    # If pid is supplied, we bail early the moment that process exits — no point
    # waiting 90 s for a port that will never open because the server crashed.
    local port=$1 name=$2 watch_pid=${3:-} retries=90
    for ((i=1; i<=retries; i++)); do
        if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            return 0
        fi
        if [[ -n "$watch_pid" ]] && ! kill -0 "$watch_pid" 2>/dev/null; then
            warn "$name (pid $watch_pid) exited before port $port opened"
            return 1
        fi
        sleep 1
    done
    warn "$name did not start on port $port within ${retries}s"
    return 1
}

# Wait until nothing is listening on a port (used after kill to confirm release).
wait_port_free() {
    local port=$1 retries=${2:-8}
    for ((i=1; i<=retries; i++)); do
        lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
        sleep 1
    done
    return 1  # still occupied — caller decides what to do
}

kill_port() {
    local port=$1
    local pids
    # Gather ALL pids using this port (listen + established) and SIGKILL immediately.
    # These are local dev servers — no graceful shutdown needed.
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
    # Wait up to 3 s for the port to be released (avoids "address already in use" on restart)
    wait_port_free "$port" 3 || true
}

# ── Start ────────────────────────────────────────────────────────────────────

start_api() {
    if is_running api; then
        warn "API already running (pid $(cat "$PID_DIR/api.pid"))"
        return 0
    fi
    kill_port "$API_PORT"
    log "Starting API on port $API_PORT..."
    log "  Judge backend : $_JUDGE_BACKEND"
    log "  Judge model   : $_LLM_MODEL"
    if [[ "$_JUDGE_KEY_OK" == "false" ]]; then
        warn "No API key configured for judge — evaluation runs will fail"
    fi
    cd "$SCRIPT_DIR"
    nohup python -m uvicorn src.api.main:app \
        --host 0.0.0.0 --port "$API_PORT" --reload \
        --reload-dir src/api \
        > "$LOG_DIR/api.log" 2>&1 &
    local api_pid=$!
    echo "$api_pid" > "$PID_DIR/api.pid"
    if wait_for_port "$API_PORT" "API" "$api_pid"; then
        ok "API running (pid $api_pid, port $API_PORT)"
    else
        err "API failed to start — last lines of $LOG_DIR/api.log:"
        tail -8 "$LOG_DIR/api.log" 2>/dev/null || true
    fi
}

start_agent() {
    if is_running agent; then
        warn "Agent already running (pid $(cat "$PID_DIR/agent.pid"))"
        return 0
    fi
    kill_port "$AGENT_PORT"
    log "Starting Computer Use Agent on port $AGENT_PORT..."
    cd "$SCRIPT_DIR"

    # Ensure Playwright browsers are installed
    if ! python -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); p.chromium.executable_path; p.stop()" 2>/dev/null; then
        log "Installing Playwright browsers (first run)..."
        python -m playwright install chromium 2>&1 | tail -1
        ok "Playwright chromium installed"
    fi

    export CU_AGENT_PORT="$AGENT_PORT"
    # Auto-adjust timeout if not explicitly set
    if [[ -z "${CU_ACTION_TIMEOUT:-}" ]]; then
        if [[ "$_CUA_MODE" == "claude" ]]; then
            export CU_ACTION_TIMEOUT=60   # Claude API calls take ~30-60s incl. network
        else
            case "$OLLAMA_MODEL" in
                *72b*|*70b*) export CU_ACTION_TIMEOUT=90 ;;
                *32b*)       export CU_ACTION_TIMEOUT=60 ;;
                *)           export CU_ACTION_TIMEOUT=30 ;;
            esac
        fi
    fi
    log "  CUA mode: ${_CUA_DISPLAY} — ${_CUA_MODEL}"
    log "  Action timeout: ${CU_ACTION_TIMEOUT}s per step"
    if [[ "$_CUA_KEY_OK" == "false" ]]; then
        warn "No API key configured for Claude CUA — agent tasks will fail"
    fi
    nohup python -m uvicorn src.agents.computer_use.server:app \
        --host 0.0.0.0 --port "$AGENT_PORT" --reload \
        --reload-dir src/agents/computer_use \
        > "$LOG_DIR/agent.log" 2>&1 &
    local agent_pid=$!
    echo "$agent_pid" > "$PID_DIR/agent.pid"
    if wait_for_port "$AGENT_PORT" "Agent" "$agent_pid"; then
        ok "Computer Use Agent running (pid $agent_pid, port $AGENT_PORT)"
    else
        err "Agent failed to start — last lines of $LOG_DIR/agent.log:"
        tail -8 "$LOG_DIR/agent.log" 2>/dev/null || true
    fi
}

start_webapp() {
    if is_running webapp; then
        warn "Webapp already running (pid $(cat "$PID_DIR/webapp.pid"))"
        return 0
    fi
    kill_port "$WEBAPP_PORT"
    log "Starting Webapp on port $WEBAPP_PORT..."
    cd "$SCRIPT_DIR/src/webapp"
    nohup npm run dev -- --port "$WEBAPP_PORT" \
        > "$LOG_DIR/webapp.log" 2>&1 &
    local webapp_pid=$!
    echo "$webapp_pid" > "$PID_DIR/webapp.pid"
    if wait_for_port "$WEBAPP_PORT" "Webapp" "$webapp_pid"; then
        ok "Webapp running (pid $webapp_pid, port $WEBAPP_PORT)"
    else
        err "Webapp failed to start — last lines of $LOG_DIR/webapp.log:"
        tail -8 "$LOG_DIR/webapp.log" 2>/dev/null || true
    fi
}

# ── Stop ─────────────────────────────────────────────────────────────────────

stop_service() {
    local name=$1 port=$2
    local pid=""
    [[ -f "$PID_DIR/$name.pid" ]] && pid=$(cat "$PID_DIR/$name.pid" 2>/dev/null || true)

    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        log "Stopping $name (pid $pid)..."
        # Kill the saved process, then its direct children.
        # Note: kill -9 -- "-$pid" (process-group kill) does NOT work in non-interactive
        # scripts because background jobs inherit the script's own PGID — they are never
        # group leaders. Use explicit parent + pkill -P instead.
        kill -9 "$pid"         2>/dev/null || true
        pkill -9 -P "$pid"     2>/dev/null || true   # direct children (uvicorn worker, node)
        sleep 0.2                                     # let orphans propagate to lsof
    fi
    rm -f "$PID_DIR/$name.pid" 2>/dev/null || true
    # Kill anything still holding the port (catches grandchildren / already-orphaned procs)
    kill_port "$port"
    ok "$name stopped"
}

# ── Commands ─────────────────────────────────────────────────────────────────

seed_demo_data() {
    log "Seeding demo data..."
    local retries=15
    for ((i=1; i<=retries; i++)); do
        if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
            local resp
            resp=$(curl -sf -X POST "http://localhost:$API_PORT/api/admin/seed-demo" 2>&1) && {
                ok "Demo data seeded (agents, datasets, evaluations)"
                return 0
            }
            warn "Seed API call failed: $resp"
            return 1
        fi
        sleep 1
    done
    warn "API not reachable after ${retries}s — skipping seed"
    return 1
}

do_start() {
    local seed_flag=false
    for arg in "$@"; do
        case "$arg" in
            --seed) seed_flag=true ;;
        esac
    done

    log "Starting all services..."
    echo ""
    start_api
    start_agent
    start_webapp

    # Seed demo data if --seed flag is set OR if this is the first run (no DB)
    if $seed_flag; then
        echo ""
        seed_demo_data
    elif [[ ! -f "$SCRIPT_DIR/data/evals.db" ]]; then
        echo ""
        log "First run detected (no database). Seeding demo data automatically..."
        seed_demo_data
    fi

    echo ""
    log "All services started:"
    echo -e "  Frontend : ${GREEN}http://localhost:$WEBAPP_PORT${NC}"
    echo -e "  API Docs : ${GREEN}http://localhost:$API_PORT/api/docs${NC}"
    echo -e "  CU Agent : ${GREEN}http://localhost:$AGENT_PORT${NC}  (${_CUA_DISPLAY} / ${_CUA_MODEL})"
    echo ""
    log "LLM configuration:"
    echo -e "  Judge    : ${YELLOW}$_JUDGE_BACKEND${NC} — ${YELLOW}$_LLM_MODEL${NC}  ($_JUDGE_KEY_STATUS)"
    echo -e "  CU Agent : ${YELLOW}$_CUA_DISPLAY${NC} — ${YELLOW}${_CUA_MODEL}${NC}  ($_CUA_KEY_STATUS)"
    echo ""
    echo -e "  Logs in  : $LOG_DIR/"
    echo -e "  Stop with: ${CYAN}./services.sh stop${NC}"
}

do_stop() {
    log "Stopping all services..."
    echo ""

    # Tell the CU Agent to close any open browsers before killing it.
    # --max-time 2: cap at 2 s — /cancel does Playwright cleanup which can block.
    if lsof -i :"$AGENT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        curl -sf --max-time 2 -X POST "http://localhost:$AGENT_PORT/cancel" >/dev/null 2>&1 && \
            ok "Sent cancel to CU Agent (browsers closing)" || true
    fi

    stop_service webapp "$WEBAPP_PORT"
    stop_service agent  "$AGENT_PORT"
    stop_service api    "$API_PORT"

    # Backstop: pkill any surviving uvicorn/vite/node workers by name.
    # These can outlive their parent when the process-group kill above misses
    # processes that were already detached (e.g. uvicorn --reload worker respawn).
    pkill -9 -f "uvicorn src\.agents\.computer_use" 2>/dev/null || true
    pkill -9 -f "uvicorn src\.api\.main"             2>/dev/null || true
    pkill -9 -f "vite.*--port.*$WEBAPP_PORT"         2>/dev/null || true
    # Give ports a moment to clear after the backstop kills
    wait_port_free "$AGENT_PORT"  3 || true
    wait_port_free "$API_PORT"    3 || true
    wait_port_free "$WEBAPP_PORT" 3 || true

    # Kill any stray Playwright/Chromium processes
    local chrome_pids
    chrome_pids=$(pgrep -f "chromium|chrome.*Testing|playwright" 2>/dev/null || true)
    if [[ -n "$chrome_pids" ]]; then
        echo "$chrome_pids" | xargs kill -9 2>/dev/null || true
        ok "Killed stray Chromium/Playwright processes"
    fi

    echo ""
    ok "All services stopped"
}

do_restart() {
    do_stop
    echo ""
    do_start
}

do_kill() {
    log "Force-killing everything..."
    echo ""

    # 1. Cancel running agent tasks (close browsers gracefully first)
    curl -sf -X POST "http://localhost:$AGENT_PORT/cancel" >/dev/null 2>&1 || true

    # 2. Kill services by port
    for pair in "Webapp:$WEBAPP_PORT" "Agent:$AGENT_PORT" "API:$API_PORT"; do
        local name="${pair%%:*}" port="${pair##*:}"
        kill_port "$port"
        ok "$name killed (port $port)"
    done

    # 3. Kill all uvicorn workers
    pkill -9 -f "uvicorn.*agents" 2>/dev/null || true
    pkill -9 -f "uvicorn.*api" 2>/dev/null || true

    # 4. Kill all Playwright / Chromium processes
    pkill -9 -f "chromium" 2>/dev/null || true
    pkill -9 -f "chrome.*Testing" 2>/dev/null || true
    pkill -9 -f "playwright" 2>/dev/null || true
    ok "Killed all Chromium/Playwright processes"

    # 5. Clean up PID files
    rm -f "$PID_DIR"/*.pid

    echo ""
    ok "Everything killed"
}

do_status() {
    log "Service status:"
    echo ""
    for svc in api agent webapp; do
        if is_running "$svc"; then
            local pid
            pid=$(cat "$PID_DIR/$svc.pid")
            ok "$svc is running (pid $pid)"
        else
            err "$svc is not running"
        fi
    done
    echo ""

    # Also check ports directly
    for pair in "API:$API_PORT" "Agent:$AGENT_PORT" "Webapp:$WEBAPP_PORT"; do
        local name="${pair%%:*}" port="${pair##*:}"
        if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            ok "Port $port ($name) is listening"
        else
            err "Port $port ($name) is not listening"
        fi
    done

    echo ""
    log "LLM configuration:"
    echo -e "  Judge    : ${YELLOW}$_JUDGE_BACKEND${NC} — ${YELLOW}$_LLM_MODEL${NC}  ($_JUDGE_KEY_STATUS)"
    echo -e "  CU Agent : ${YELLOW}$_CUA_DISPLAY${NC} — ${YELLOW}${_CUA_MODEL}${NC}  ($_CUA_KEY_STATUS)"
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
    start)   shift; do_start "$@"   ;;
    stop)    do_stop    ;;
    restart) do_restart ;;
    kill)    do_kill    ;;
    status)  do_status  ;;
    seed)    seed_demo_data ;;
    reset)
        log "Resetting database and reseeding..."
        echo ""
        if [[ -f "$SCRIPT_DIR/data/evals.db" ]]; then
            rm -f "$SCRIPT_DIR/data/evals.db"
            ok "Deleted existing database"
        else
            warn "No database found — nothing to delete"
        fi
        # Ensure API is running (or start it)
        if ! lsof -i :"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            log "API not running — starting it for seeding..."
            start_api
        fi
        echo ""
        seed_demo_data
        ;;
    *)
        echo "Usage: ./services.sh {start|stop|restart|kill|status|seed|reset}"
        echo ""
        echo "  start [--seed]  Start API (8000), CU Agent (8001), and Webapp (5001)"
        echo "                  --seed  Populate demo data (auto on first run)"
        echo "  stop            Graceful stop (cancels agent tasks, closes browsers)"
        echo "  restart         Stop then start all services"
        echo "  kill            Force-kill everything (services, browsers, Chromium)"
        echo "  status          Show which services are running"
        echo "  seed            Populate demo data (services must be running)"
        echo "  reset           Delete database and reseed (services must be running)"
        exit 1
        ;;
esac
