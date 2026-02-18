"""
Main FastAPI Application Entry Point

==============================================================================
FEATURES IMPLEMENTED IN THIS MODULE:
==============================================================================

1. ORPHAN EVALUATION CLEANUP ON STARTUP (Feature: orphan-cleanup)
   - cleanup_orphaned_evaluations() called during lifespan startup
   - Automatically cancels evaluations that were "running" when server crashed
   - Prevents accumulation of stuck evaluations that confuse users

2. AUTO-SEED DEFAULT JUDGE CONFIGS ON STARTUP (Feature: auto-seed)
   - ensure_default_judge_configs() called during lifespan startup
   - If no judge configs exist in the database, seeds two defaults:
     a) Default Binary Judge — general-purpose assertion evaluator
     b) Computer Use Agent Judge — specialized for browser automation
   - Ensures evaluations can run out of the box on first launch

3. AUTO-SEED DEFAULT CU AGENT RECORD ON STARTUP (Feature: auto-seed)
   - ensure_default_agents() called during lifespan startup
   - services.sh starts the CU Agent process on port 8001, but evaluations
     need a DB record to reference. This seeds that record automatically.
   - Only seeds if no agents exist (won't overwrite user-created agents)

==============================================================================
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import logging
import asyncio
from .controllers import router
from . import config
from .mcp_middleware import MCP400ErrorHandlerMiddleware
from .mcp_server import get_mcp_server
from .sqlite_service import get_db_service
from .evaluator_service import get_evaluator_service

logger = logging.getLogger(__name__)

mcp = get_mcp_server()
mcp_app = mcp.http_app(path="/")


# ==============================================================================
# BACKGROUND TASKS (Feature: production-trace-support)
# ==============================================================================

async def cleanup_expired_traces_task(db):
    """Background task to delete expired production traces daily."""
    while True:
        try:
            await asyncio.sleep(86400)  # Sleep 24 hours
            logger.info("Running production trace cleanup task...")
            deleted_count = await db.delete_expired_production_traces()
            if deleted_count > 0:
                logger.info(f"Deleted {deleted_count} expired production traces")
        except asyncio.CancelledError:
            logger.info("Production trace cleanup task cancelled")
            break
        except Exception as e:
            logger.error(f"Error in trace cleanup task: {str(e)}")
            # Continue running despite errors


# ==============================================================================
# LIFESPAN MANAGER (Feature: orphan-cleanup)
# ==============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Combined lifespan manager for MCP and evaluation cleanup.

    Startup actions:
    1. Initialize database and evaluator services
    2. Cancel any orphaned evaluations from previous runs
    3. Hand off to MCP's lifespan manager

    Shutdown actions:
    1. Log shutdown message
    """
    # Startup
    logger.info("Starting API server...")
    try:
        db = get_db_service()
        evaluator = get_evaluator_service(db)

        # 1. Clean up orphaned evaluations (Feature: orphan-cleanup)
        # This marks any 'running' or 'pending' evaluations as 'cancelled'
        await evaluator.cleanup_orphaned_evaluations()
        logger.info("Orphaned evaluation cleanup completed")

        # 2. Ensure default judge configs exist (Feature: auto-seed)
        # Seeds required configs on first run so evaluations work out of the box
        seeded = await db.ensure_default_judge_configs()
        if seeded > 0:
            logger.info(f"Seeded {seeded} default judge config(s)")

        # 3. Ensure default system prompts exist (Feature: configurable-prompts)
        # Seeds proposal generation + comparison explanation prompts
        prompt_seeded = await db.ensure_default_system_prompts()
        if prompt_seeded > 0:
            logger.info(f"Seeded {prompt_seeded} default system prompt(s)")

        # 4. Ensure CU Agent is registered (Feature: auto-seed)
        # services.sh starts the process on port 8001 — this adds the DB record
        agent_seeded = await db.ensure_default_agents()
        if agent_seeded > 0:
            logger.info(f"Seeded {agent_seeded} default agent(s)")

        # 5. Start background cleanup task for production traces (Feature: production-trace-support)
        cleanup_task = asyncio.create_task(cleanup_expired_traces_task(db))
        logger.info("Started production trace cleanup task")
    except Exception as e:
        logger.error(f"Error during startup: {str(e)}")
        cleanup_task = None

    # Delegate to MCP lifespan for its startup/shutdown
    try:
        async with mcp_app.lifespan(app):
            yield
    finally:
        # Cancel background tasks
        if cleanup_task:
            cleanup_task.cancel()
            try:
                await cleanup_task
            except asyncio.CancelledError:
                pass

    # Shutdown
    logger.info("API server shutting down...")


app = FastAPI(title=config.API_TITLE, docs_url="/api/docs", lifespan=lifespan)

app.mount("/mcp", mcp_app)

# Add MCP 400 error handling middleware
app.add_middleware(MCP400ErrorHandlerMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

@app.get("/")
async def root():
    return {"message": "AgentEval API", "docs": "/api/docs"}

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run("src.api.main:app", host=config.API_HOST, port=config.API_PORT, reload=config.API_DEBUG)
