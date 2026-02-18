#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Computer Use Agent — Quick Start
# ─────────────────────────────────────────────────────────────
#
#  Prerequisites:
#    1. Ollama running locally  (ollama serve)
#    2. qwen3-vl:4b pulled      (ollama pull qwen3-vl:4b)
#    3. AgentEval backend on port 8000
#
#  Run:
#    bash src/agents/computer_use/run.sh
#
# ─────────────────────────────────────────────────────────────

set -e
cd "$(dirname "$0")/../.."

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3-vl:4b}"

export OLLAMA_HOST OLLAMA_MODEL

echo "═══════════════════════════════════════════════════════════"
echo "  Computer Use Agent — Quick Start"
echo "═══════════════════════════════════════════════════════════"
echo "  Model:  $OLLAMA_MODEL"
echo "  Ollama: $OLLAMA_HOST"
echo

# Check Ollama is running
echo "▸ Checking Ollama service..."
if ! curl -sf "$OLLAMA_HOST/api/tags" > /dev/null 2>&1; then
    echo "  ✗ Ollama not reachable at $OLLAMA_HOST"
    echo "    Start it with:  ollama serve"
    exit 1
fi
echo "  ✓ Ollama is running"

# Check model is available
echo "▸ Checking for $OLLAMA_MODEL..."
if ! curl -sf "$OLLAMA_HOST/api/tags" 2>/dev/null | grep -q "$(echo $OLLAMA_MODEL | cut -d: -f1)"; then
    echo "  ⚠ $OLLAMA_MODEL not found. Pulling..."
    ollama pull "$OLLAMA_MODEL"
fi
echo "  ✓ Model ready"
echo

# Step 1: Register agent + create dataset
echo "▸ Step 1: Setting up agent and dataset in AgentEval..."
python -m agents.computer_use.setup
echo

# Step 2: Start the agent server
echo "▸ Step 2: Starting Computer Use Agent server on port ${CU_AGENT_PORT:-8001}..."
echo "   (Press Ctrl+C to stop)"
echo
python -m agents.computer_use.server
