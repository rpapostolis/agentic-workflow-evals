"""
Configuration Module

Loads environment variables and provides configuration constants for the API.
Configured for fully local operation — no cloud services required.

==============================================================================
FEATURES CONFIGURED IN THIS MODULE:
==============================================================================

1. RETRY CONFIGURATION FOR RATE LIMITING (Feature: rate-limit-retry)
   - RETRY_MAX_ATTEMPTS: How many times to retry before giving up
   - RETRY_BASE_DELAY: Initial delay (seconds), doubles each retry
   - RETRY_MAX_DELAY: Maximum delay cap to prevent excessive waits

==============================================================================
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file
load_dotenv()

# SQLite (local database)
SQLITE_DB_PATH = os.getenv("SQLITE_DB_PATH", os.path.join(os.path.dirname(__file__), "..", "..", "data", "evals.db"))

# API
API_TITLE = os.getenv("API_TITLE", "AgentEval API")
API_HOST = os.getenv("API_HOST", "0.0.0.0")
API_PORT = int(os.getenv("API_PORT", "8000"))
API_DEBUG = os.getenv("API_DEBUG", "false").lower() == "true"

# CORS
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:5000,http://localhost:5001,http://localhost:5173").split(",")

# LLM Configuration (local Ollama or any OpenAI-compatible endpoint)
# Key resolution order: LLM_API_KEY → ANTHROPIC_API_KEY → "ollama" (no-auth fallback)
# Ollama doesn't require a real key; for Claude set either LLM_API_KEY or ANTHROPIC_API_KEY.
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://localhost:11434/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or "ollama"
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3-coder:latest")  # Default model for evals judge

# Agent LLM (can be different from eval judge)
# Key resolution order: AGENT_LLM_API_KEY → LLM_API_KEY → ANTHROPIC_API_KEY → "ollama"
AGENT_LLM_BASE_URL = os.getenv("AGENT_LLM_BASE_URL", "http://localhost:11434/v1")
AGENT_LLM_API_KEY = os.getenv("AGENT_LLM_API_KEY") or LLM_API_KEY
AGENT_LLM_MODEL = os.getenv("AGENT_LLM_MODEL", "qwen3-coder:latest")

# ==============================================================================
# COMPUTER USE AGENT (CUA) MODE  (Feature: claude-cua-mode)
# ==============================================================================
# CUA_MODE controls which browser automation backend powers the CUA agent:
#   "ollama"  — local Ollama model (default, no API key needed)
#   "claude"  — Anthropic Claude API (requires ANTHROPIC_API_KEY or LLM_API_KEY)
#
# CUA_MODEL is only used when CUA_MODE=claude; it selects the Claude model.
# CUA_API_KEY follows the same resolution chain as LLM_API_KEY.
# ==============================================================================
CUA_MODE = os.getenv("CUA_MODE", "ollama")  # "ollama" | "claude"
CUA_MODEL = os.getenv("CUA_MODEL", "claude-sonnet-4-5-20250929")
CUA_API_KEY = os.getenv("CUA_API_KEY") or os.getenv("LLM_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or "ollama"

# Evaluation Configuration
MAX_CONCURRENT_TESTS = int(os.getenv("MAX_CONCURRENT_TESTS", "1"))
EVALUATION_TIMEOUT_SECONDS = int(os.getenv("EVALUATION_TIMEOUT_SECONDS", "900"))  # 15 min — CU Agent with larger models needs time for multi-step browser tasks

# ==============================================================================
# RETRY CONFIGURATION FOR RATE LIMITING (Feature: rate-limit-retry)
# ==============================================================================
# These settings control how the evaluator handles LLM rate limit (429) errors.
#
# - RETRY_MAX_ATTEMPTS: More attempts = more resilient, but longer potential wait
# - RETRY_BASE_DELAY: Higher = more conservative, lower = more aggressive
# - RETRY_MAX_DELAY: Cap to prevent waiting forever on persistent rate limits
#
# With defaults (5 attempts, 2s base): waits 2s, 4s, 8s, 16s, 32s = 62s max
# ==============================================================================
RETRY_MAX_ATTEMPTS = int(os.getenv("RETRY_MAX_ATTEMPTS", "5"))
RETRY_BASE_DELAY = float(os.getenv("RETRY_BASE_DELAY", "2.0"))
RETRY_MAX_DELAY = float(os.getenv("RETRY_MAX_DELAY", "60.0"))

# ==============================================================================
# COST ATTRIBUTION (Feature: cost-attribution)
# ==============================================================================
# Maps model names to per-1K-token pricing.
# Local Ollama models cost $0 since they run on your hardware.
# "_default" is the fallback for unknown models.
# ==============================================================================
PRICING_TABLE: dict = {
    "qwen3-coder:latest": {"input_per_1k": 0.0, "output_per_1k": 0.0},
    "qwen3-coder": {"input_per_1k": 0.0, "output_per_1k": 0.0},
    "llama3": {"input_per_1k": 0.0, "output_per_1k": 0.0},
    "mistral": {"input_per_1k": 0.0, "output_per_1k": 0.0},
    "gpt-4o": {"input_per_1k": 0.005, "output_per_1k": 0.015},
    "gpt-4o-mini": {"input_per_1k": 0.00015, "output_per_1k": 0.0006},
    "gpt-4-turbo": {"input_per_1k": 0.01, "output_per_1k": 0.03},
    "gpt-3.5-turbo": {"input_per_1k": 0.0005, "output_per_1k": 0.0015},
    # Claude 3.x
    "claude-3-5-sonnet": {"input_per_1k": 0.003, "output_per_1k": 0.015},
    "claude-3-haiku": {"input_per_1k": 0.00025, "output_per_1k": 0.00125},
    # Claude 4 Opus (higher quality, higher cost)
    "claude-opus-4-6-20251101": {"input_per_1k": 0.015, "output_per_1k": 0.075},
    "claude-opus-4-5-20251101": {"input_per_1k": 0.015, "output_per_1k": 0.075},
    "claude-opus-4-6":          {"input_per_1k": 0.015, "output_per_1k": 0.075},
    "claude-opus-4-5":          {"input_per_1k": 0.015, "output_per_1k": 0.075},
    # Claude 4 Sonnet (balanced)
    "claude-sonnet-4-6-20250929": {"input_per_1k": 0.003, "output_per_1k": 0.015},
    "claude-sonnet-4-5-20250929": {"input_per_1k": 0.003, "output_per_1k": 0.015},
    "claude-sonnet-4-6":          {"input_per_1k": 0.003, "output_per_1k": 0.015},
    "claude-sonnet-4-5":          {"input_per_1k": 0.003, "output_per_1k": 0.015},
    # Claude 4 Haiku (fastest, lowest cost)
    "claude-haiku-4-5-20251001": {"input_per_1k": 0.00025, "output_per_1k": 0.00125},
    "claude-haiku-4-5":          {"input_per_1k": 0.00025, "output_per_1k": 0.00125},
    "_default": {"input_per_1k": 0.001, "output_per_1k": 0.002},
}

# ==============================================================================
# TELEMETRY & SAMPLING (Feature: online-evals)
# ==============================================================================
DEFAULT_SAMPLING_RATE = float(os.getenv("DEFAULT_SAMPLING_RATE", "0.15"))
TIER_1_SAMPLING_RATE = float(os.getenv("TIER_1_SAMPLING_RATE", "1.0"))

# ==============================================================================
# PRODUCTION TRACES (Feature: production-trace-support)
# ==============================================================================
PRODUCTION_TRACE_RETENTION_DAYS = int(os.getenv("PRODUCTION_TRACE_RETENTION_DAYS", "90"))
ENABLE_PII_DETECTION = os.getenv("ENABLE_PII_DETECTION", "true").lower() == "true"
TRACE_BATCH_SIZE = int(os.getenv("TRACE_BATCH_SIZE", "1000"))  # For bulk operations
