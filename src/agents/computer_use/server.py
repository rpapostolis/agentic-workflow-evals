"""
Computer Use Agent Server — Ollama or Claude Edition

Exposes the local browser automation agent as an HTTP endpoint compatible
with AgentEval's evaluation protocol.

Start with:
  cd src && python -m agents.computer_use.server

Environment variables (all optional, have sensible defaults):
  ── CUA Mode ──────────────────────────────────────────────────────────────
  CUA_MODE           "ollama" (default) or "claude"
  CUA_MODEL          Claude model to use when CUA_MODE=claude
                     (default: claude-sonnet-4-5-20250929)
  ── Ollama (CUA_MODE=ollama) ──────────────────────────────────────────────
  OLLAMA_HOST        Ollama base URL  (default: http://localhost:11434)
  OLLAMA_MODEL       Vision model     (default: cua-agent)
  CU_NUM_CTX         Context window   (default: 16384)
  ── Claude (CUA_MODE=claude) ─────────────────────────────────────────────
  ANTHROPIC_API_KEY  API key (or use LLM_API_KEY)
  LLM_API_KEY        Fallback API key
  ── Shared ────────────────────────────────────────────────────────────────
  CU_AGENT_MAX_STEPS Max steps/task   (default: 15)
  CU_AGENT_PORT      Server port      (default: 8001)
  CU_HEADLESS        Run headless     (default: false → visible browser)
  CU_ACTION_TIMEOUT  Seconds per step (default: 30 for Ollama, 60 for Claude)
  CU_VIEWPORT_WIDTH  Viewport width   (default: 1280)
  CU_VIEWPORT_HEIGHT Viewport height  (default: 720)
"""

import asyncio
import logging
import os
import sys
import time
import traceback
from typing import Optional, Union

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from agents.computer_use.agent import ComputerUseAgent

# ClaudeCUAAgent requires the `anthropic` package which is an optional dependency.
# Import lazily so the server starts cleanly in ollama mode even if the package
# is not yet installed.  get_agent() (below) handles the ImportError at runtime.
ClaudeCUAAgent = None  # populated on first use when CUA_MODE=claude

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────

# CUA mode: "ollama" (local, default) or "claude" (Anthropic API)
CUA_MODE = os.environ.get("CUA_MODE", "ollama").lower().strip()

# Shared
CU_HEADLESS       = os.environ.get("CU_HEADLESS", "false").lower() in ("true", "1", "yes")
VIEWPORT_WIDTH    = int(os.environ.get("CU_VIEWPORT_WIDTH", "1280"))
VIEWPORT_HEIGHT   = int(os.environ.get("CU_VIEWPORT_HEIGHT", "720"))
MAX_STEPS         = int(os.environ.get("CU_AGENT_MAX_STEPS", "15"))

# Default action timeout differs per mode: Ollama needs shorter for snappy local response;
# Claude API calls take longer per iteration (network + inference).
_default_timeout = "60" if CUA_MODE == "claude" else "30"
ACTION_TIMEOUT = float(os.environ.get("CU_ACTION_TIMEOUT", _default_timeout))

# Ollama-specific
OLLAMA_HOST  = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "cua-agent")
NUM_CTX      = int(os.environ.get("CU_NUM_CTX", "16384"))

# Claude-specific
CUA_MODEL       = os.environ.get("CUA_MODEL", "claude-sonnet-4-5-20250929")
ANTHROPIC_API_KEY = (
    os.environ.get("CUA_API_KEY")
    or os.environ.get("LLM_API_KEY")
    or os.environ.get("ANTHROPIC_API_KEY")
    or "ollama"
)

# ── FastAPI App ───────────────────────────────────────────────────────────

_mode_label = "Claude" if CUA_MODE == "claude" else "Ollama"
app = FastAPI(
    title="Computer Use Agent",
    description=f"Browser automation agent powered by {_mode_label} + Playwright",
    version="4.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://localhost:5000,http://localhost:5001,http://localhost:5173",
    ).split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Agent Instance (lazy init) ────────────────────────────────────────────

_agent: Optional[ComputerUseAgent] = None


def get_agent() -> ComputerUseAgent:
    """Return (or lazily create) the agent for the configured CUA_MODE."""
    global _agent, ClaudeCUAAgent
    if _agent is not None:
        return _agent

    if CUA_MODE == "claude":
        if ClaudeCUAAgent is None:
            try:
                from agents.computer_use.claude_agent import ClaudeCUAAgent as _CLS
                ClaudeCUAAgent = _CLS
            except ImportError as exc:
                raise RuntimeError(
                    "CUA_MODE=claude requires the 'anthropic' package. "
                    "Run: pip install anthropic"
                ) from exc
        _agent = ClaudeCUAAgent(
            api_key=ANTHROPIC_API_KEY,
            model=CUA_MODEL,
            max_steps=MAX_STEPS,
            viewport_width=VIEWPORT_WIDTH,
            viewport_height=VIEWPORT_HEIGHT,
            headless=CU_HEADLESS,
            action_timeout=ACTION_TIMEOUT,
        )
        logger.info(
            f"Agent initialised: mode=claude, model={CUA_MODEL}, "
            f"headless={CU_HEADLESS}, action_timeout={ACTION_TIMEOUT}s"
        )
    else:
        _agent = ComputerUseAgent(
            ollama_host=OLLAMA_HOST,
            ollama_model=OLLAMA_MODEL,
            max_steps=MAX_STEPS,
            viewport_width=VIEWPORT_WIDTH,
            viewport_height=VIEWPORT_HEIGHT,
            headless=CU_HEADLESS,
            action_timeout=ACTION_TIMEOUT,
            num_ctx=NUM_CTX,
        )
        logger.info(
            f"Agent initialised: mode=ollama, model={OLLAMA_MODEL}, host={OLLAMA_HOST}, "
            f"headless={CU_HEADLESS}, action_timeout={ACTION_TIMEOUT}s, num_ctx={NUM_CTX}"
        )

    return _agent


# ── Concurrency & session tracking ───────────────────────────────────────

_invoke_lock   = asyncio.Lock()
_active_sessions: dict = {}
_cancelled = False


# ── Request / Response Models ─────────────────────────────────────────────

class InvokeRequest(BaseModel):
    input: str
    dataset_id: Optional[str] = None
    test_case_id: Optional[str] = None
    agent_id: Optional[str] = None
    evaluation_run_id: Optional[str] = None
    system_prompt: Optional[str] = None


class InvokeResponse(BaseModel):
    response: str
    tool_calls: list = []
    metadata: dict = {}


# ── Pre-flight checks ────────────────────────────────────────────────────

async def _check_ollama() -> tuple[bool, str]:
    """Check Ollama is reachable and the vision model is available."""
    import httpx as _hx
    try:
        async with _hx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{OLLAMA_HOST}/api/tags")
            if r.status_code != 200:
                return False, f"Ollama returned {r.status_code} at {OLLAMA_HOST}/api/tags"
            tags = r.json()
            model_names = [m.get("name", "") for m in tags.get("models", [])]
            model_base = OLLAMA_MODEL.split(":")[0]
            found = any(model_base in n for n in model_names)
            if not found:
                return False, (
                    f"Model '{OLLAMA_MODEL}' not found in Ollama. "
                    f"Available: {', '.join(model_names[:5])}. "
                    f"Run: ollama pull {OLLAMA_MODEL}"
                )
            return True, "ok"
    except _hx.ConnectError:
        return False, f"Ollama not reachable at {OLLAMA_HOST}. Run: ollama serve"
    except Exception as e:
        return False, f"Ollama check failed: {e}"


async def _check_claude() -> tuple[bool, str]:
    """Check the Anthropic API key is configured and non-trivially valid."""
    key = ANTHROPIC_API_KEY
    if not key or key == "ollama":
        return False, (
            "No API key set for Claude CUA. "
            "Set ANTHROPIC_API_KEY (or LLM_API_KEY) in your environment or .env file."
        )
    if not (key.startswith("sk-ant-") or key.startswith("sk-")):
        return False, (
            f"API key looks malformed (starts with {key[:10]!r}). "
            "Expected an Anthropic key starting with 'sk-ant-'."
        )
    return True, f"API key configured (model: {CUA_MODEL})"


def _check_playwright() -> tuple[bool, str]:
    """Check Playwright Chromium binary is installed (without starting a loop)."""
    try:
        import subprocess
        result = subprocess.run(
            [
                sys.executable, "-c",
                "from playwright.sync_api import sync_playwright; "
                "p = sync_playwright().start(); "
                "print(p.chromium.executable_path); "
                "p.stop()",
            ],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            path = result.stdout.strip()
            if path and os.path.exists(path):
                return True, "ok"
        # Fallback: look for the .local-browsers directory
        try:
            import playwright
            pw_dir = os.path.join(
                os.path.dirname(playwright.__file__), "driver", "package", ".local-browsers"
            )
            if os.path.isdir(pw_dir) and any(
                d.startswith("chromium") for d in os.listdir(pw_dir)
            ):
                return True, "ok"
        except Exception:
            pass
        stderr = (result.stderr or "").strip()[:200]
        return False, f"Playwright check failed: {stderr or 'Chromium not found'}"
    except Exception as e:
        return False, f"Playwright check failed: {e}"


# ── Endpoints ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check — reports backend and Playwright status."""
    pw_ok, pw_msg = _check_playwright()

    if CUA_MODE == "claude":
        backend_ok, backend_msg = await _check_claude()
        status = "ok" if (backend_ok and pw_ok) else "degraded"
        issues = []
        if not backend_ok:
            issues.append(f"claude: {backend_msg}")
        if not pw_ok:
            issues.append(f"playwright: {pw_msg}")
        return {
            "status": status,
            "agent": "computer-use-claude",
            "cua_mode": "claude",
            "model": CUA_MODEL,
            "api_key_configured": backend_ok,
            "api_key_message": backend_msg,
            "playwright_ready": pw_ok,
            "issues": issues or None,
            "active_tasks": len(_active_sessions),
        }
    else:
        ollama_ok, ollama_msg = await _check_ollama()
        status = "ok" if (ollama_ok and pw_ok) else "degraded"
        issues = []
        if not ollama_ok:
            issues.append(f"ollama: {ollama_msg}")
        if not pw_ok:
            issues.append(f"playwright: {pw_msg}")
        return {
            "status": status,
            "agent": "computer-use-ollama",
            "cua_mode": "ollama",
            "model": f"ollama/{OLLAMA_MODEL}",
            "ollama_host": OLLAMA_HOST,
            "ollama_reachable": ollama_ok,
            "playwright_ready": pw_ok,
            "issues": issues or None,
            "active_tasks": len(_active_sessions),
        }


@app.post("/invoke")
async def invoke(request: InvokeRequest):
    """Execute a browser automation task (serialised — one at a time)."""
    global _cancelled
    task_id = request.test_case_id or f"task-{int(time.time())}"
    _cancelled = False

    # ── Pre-flight check ─────────────────────────────────────────────────
    if CUA_MODE == "claude":
        ok, msg = await _check_claude()
    else:
        ok, msg = await _check_ollama()

    if not ok:
        return InvokeResponse(
            response=f"Pre-flight failed: {msg}",
            tool_calls=[],
            metadata={"error": msg, "preflight_failed": True},
        )

    logger.info(f"[{task_id}] Queued ({CUA_MODE}): {request.input[:100]}...")

    async with _invoke_lock:
        if _cancelled:
            _cancelled = False
            return InvokeResponse(
                response="Task cancelled while waiting in queue",
                tool_calls=[],
                metadata={"cancelled": True},
            )

        logger.info(f"[{task_id}] Starting (lock acquired)")
        start = time.time()

        try:
            cu_agent = get_agent()

            execution = await cu_agent.execute_task(
                request.input,
                session_tracker=(_active_sessions, task_id),
                cancel_check=lambda: _cancelled,
                custom_system_prompt=request.system_prompt,
            )

            # Build mode-specific metadata
            if CUA_MODE == "claude":
                model_label = cu_agent.model
                metadata = {
                    "steps_taken":       execution.step_count,
                    "duration_seconds":  round(execution.duration_seconds, 2),
                    "tokens_in":         execution.total_tokens_in,
                    "tokens_out":        execution.total_tokens_out,
                    "cost_usd":          round(execution.total_cost_usd, 6),
                    "task_success":      execution.task_success,
                    "model":             model_label,
                    "cua_mode":          "claude",
                }
            else:
                model_label = f"ollama/{cu_agent.model}"
                metadata = {
                    "steps_taken":       execution.step_count,
                    "duration_seconds":  round(execution.duration_seconds, 2),
                    "tokens_in":         execution.total_tokens_in,
                    "tokens_out":        execution.total_tokens_out,
                    "cost_usd":          0.0,
                    "task_success":      execution.task_success,
                    "model":             model_label,
                    "ollama_host":       cu_agent.ollama_host,
                    "cua_mode":          "ollama",
                }

            if execution.error:
                metadata["error"] = execution.error
            if execution.failure_reason:
                metadata["failure_reason"] = execution.failure_reason
                metadata["aborted_early"] = True

            logger.info(
                f"[{task_id}] Completed ({CUA_MODE}): success={execution.task_success}, "
                f"steps={execution.step_count}, "
                f"duration={execution.duration_seconds:.1f}s"
                + (f", ABORTED: {execution.failure_reason}" if execution.failure_reason else "")
            )

            return InvokeResponse(
                response=execution.final_result,
                tool_calls=execution.to_tool_calls(),
                metadata=metadata,
            )

        except Exception as e:
            tb = traceback.format_exc()
            logger.error(f"[{task_id}] Task execution failed:\n{tb}")
            error_msg = f"{type(e).__name__}: {str(e)}" if str(e) else type(e).__name__
            return InvokeResponse(
                response=f"Agent execution error: {error_msg}",
                tool_calls=[],
                metadata={
                    "error": error_msg,
                    "traceback": tb[-500:],
                    "duration_seconds": round(time.time() - start, 2),
                    "cua_mode": CUA_MODE,
                },
            )
        finally:
            _active_sessions.pop(task_id, None)


@app.post("/cancel")
async def cancel():
    """Cancel all running tasks and close all open browsers."""
    global _cancelled
    _cancelled = True
    killed = 0
    for task_id, session in list(_active_sessions.items()):
        try:
            logger.info(f"Force-closing browser for task {task_id}")
            await session.stop()
            killed += 1
        except Exception as e:
            logger.warning(f"Error closing session {task_id}: {e}")
    _active_sessions.clear()
    logger.info(f"Cancel complete: closed {killed} browser(s)")
    return {"cancelled": True, "browsers_closed": killed}


@app.get("/stats")
async def stats():
    """Return agent configuration and active task count."""
    cu_agent = get_agent()
    if CUA_MODE == "claude":
        return {
            "cua_mode":     "claude",
            "model":        cu_agent.model,
            "max_steps":    cu_agent.max_steps,
            "viewport":     f"{cu_agent.viewport_width}x{cu_agent.viewport_height}",
            "active_tasks": len(_active_sessions),
            "locked":       _invoke_lock.locked(),
        }
    else:
        return {
            "cua_mode":     "ollama",
            "model":        f"ollama/{cu_agent.model}",
            "ollama_host":  cu_agent.ollama_host,
            "max_steps":    cu_agent.max_steps,
            "viewport":     f"{cu_agent.viewport_width}x{cu_agent.viewport_height}",
            "active_tasks": len(_active_sessions),
            "locked":       _invoke_lock.locked(),
        }


@app.get("/progress")
async def progress():
    """Return live step-level progress for the currently running task."""
    cu_agent = get_agent()
    step           = getattr(cu_agent, "_current_step", 0)
    phase          = getattr(cu_agent, "_current_phase", "idle")
    step_started   = getattr(cu_agent, "_current_step_started", 0.0)
    step_elapsed   = round(time.time() - step_started, 1) if step_started else 0.0
    step_remaining = max(0, round(cu_agent.action_timeout - step_elapsed, 1))

    return {
        "current_step":            step,
        "max_steps":               cu_agent.max_steps,
        "phase":                   phase,
        "action_timeout":          cu_agent.action_timeout,
        "step_elapsed_seconds":    step_elapsed,
        "step_remaining_seconds":  step_remaining,
        "active_tasks":            len(_active_sessions),
        "cua_mode":                CUA_MODE,
    }


# ── Main ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CU_AGENT_PORT", "8001"))

    logger.info("=" * 60)
    logger.info(f"  Computer Use Agent  (mode: {CUA_MODE.upper()})")
    logger.info("=" * 60)
    if CUA_MODE == "claude":
        logger.info(f"  Model:         {CUA_MODEL}")
        key_preview = ANTHROPIC_API_KEY[:12] + "..." if len(ANTHROPIC_API_KEY) > 12 else "NOT SET"
        logger.info(f"  API key:       {key_preview}")
    else:
        logger.info(f"  Model:         {OLLAMA_MODEL}")
        logger.info(f"  Ollama:        {OLLAMA_HOST}")
    logger.info(f"  Headless:      {CU_HEADLESS}")
    logger.info(f"  Max steps:     {MAX_STEPS}")
    logger.info(f"  Action timeout:{ACTION_TIMEOUT}s")
    logger.info(f"  Viewport:      {VIEWPORT_WIDTH}x{VIEWPORT_HEIGHT}")
    logger.info(f"  Port:          {port}")
    logger.info("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=port)
