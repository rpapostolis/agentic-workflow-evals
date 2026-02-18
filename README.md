# AgentEval

A comprehensive demo platform for testing, evaluating, and continuously improving AI agents. Register agents, run evaluations with LLM-powered judging, annotate results at both the run and tool-call level, and use those annotations to generate prompt improvement proposals — all running locally against Ollama and SQLite.

## Architecture

AgentEval consists of three main components:

### 1. API (Backend) — Port 8000
FastAPI backend that provides:
- Test case dataset management (create, import, holdout sets)
- Agent registration and evaluation with LLM judging
- MCP (Model Context Protocol) server for tool execution
- 2-layer annotation API (run-level + action-level)
- Evaluation comparison, regression detection, and annotation export
- Prompt proposal generation from annotation data

### 2. Agent — Port 8001
Sample AI agent implementation that:
- Connects to the API's MCP server for tool access
- Uses a local LLM (via Ollama) for intelligent task execution
- Demonstrates calendar scheduling and email capabilities
- Serves as a reference implementation for agent development

### 3. Webapp (Frontend) — Port 5001
React-based web interface for:
- Creating and managing test datasets
- Registering and configuring agents
- Running evaluations and viewing results with regression alerts
- Annotating evaluation runs (run-level + action-level per tool call)
- Comparing evaluations side-by-side with delta analysis
- Prompt versioning via PromptLab with AI-generated improvement proposals
- Annotation queue for efficient batch review

## Prerequisites

- **Python 3.10+** — [python.org/downloads](https://www.python.org/downloads/)
- **Node.js 18+** and npm — [nodejs.org](https://nodejs.org/)
- **Git** — [git-scm.com](https://git-scm.com/)
- **Ollama** — [ollama.com/download](https://ollama.com/download) (macOS, Linux, Windows)

**For the Computer Use Agent (E2E browser automation):**
- **Playwright** — installed automatically on first agent start via `services.sh`, or manually with `python -m playwright install chromium`
- A **vision-capable** Ollama model (e.g. `qwen3-vl:latest`, `qwen2.5vl:7b`) for the CU Agent
- A **reasoning** model (e.g. `qwen3-coder:latest`) for the LLM Judge

**Hardware:** 16 GB+ RAM recommended. Both models run through the same Ollama instance but never simultaneously — the CU Agent finishes its browser steps first, then the judge evaluates the trace. With less VRAM, Ollama swaps models in/out (slower but works).

## Getting Started

### 1. Clone and Configure

```bash
git clone <repo-url> AgentEval
cd AgentEval
cp .env.example .env
```

The defaults work out of the box with Ollama. Edit `.env` if you need to change models or ports:

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server address |
| `LLM_MODEL` | `qwen3-coder:latest` | Model for the eval judge (needs reasoning) |
| `OLLAMA_MODEL` | `qwen3-vl:latest` | Model for the CU Agent (needs vision) |
| `CU_HEADLESS` | `false` | Set `true` to hide the browser during CU Agent runs |
| `API_PORT` | `8000` | API server port |
| `SQLITE_DB_PATH` | `./data/evals.db` | Path to SQLite database file |

### 2. Pull Ollama Models

```bash
ollama serve   # start Ollama if not already running (keep this terminal open)

# In another terminal:
ollama pull qwen3-coder:latest   # Judge / reasoning model
ollama pull qwen3-vl:latest      # CU Agent / vision model
```

Verify both are available:

```bash
ollama list
# Should show both qwen3-coder:latest and qwen3-vl:latest
```

### 3. Install Dependencies

**Linux / macOS:**

```bash
# Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate

# Install Python packages
pip install -r src/api/requirements.txt
pip install -r src/agents/requirements.txt
pip install -r src/agents/computer_use/requirements.txt

# Install Playwright browser (for the CU Agent)
python -m playwright install chromium

# Install webapp dependencies
cd src/webapp && npm install && cd ../..
```

**Windows (PowerShell):**

```powershell
# Create a virtual environment (recommended)
python -m venv .venv
.venv\Scripts\Activate.ps1

# Install Python packages
pip install -r src\api\requirements.txt
pip install -r src\agents\requirements.txt
pip install -r src\agents\computer_use\requirements.txt

# Install Playwright browser (for the CU Agent)
python -m playwright install chromium

# Install webapp dependencies
cd src\webapp
npm install
cd ..\..
```

> **Windows note — Execution Policy:** If `.venv\Scripts\Activate.ps1` fails with a script execution error, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first, then try again.

### 4. Run the Services

**Using `services.sh` (Linux / macOS) or `services.ps1` (Windows):**

```bash
# Linux / macOS
./services.sh start

# Windows (PowerShell)
.\services.ps1 start
```

This starts all three services (API on 8000, CU Agent on 8001, Webapp on 5001), auto-installs Playwright if needed, and seeds demo data on first run.

Other commands: `stop`, `restart`, `status`, `kill` (force), `seed`, `reset`.

**Using VS Code launch profiles (all platforms):**

The workspace includes pre-configured launch profiles in `.vscode/launch.json`:
- **API** — FastAPI backend on port 8000 with hot reload
- **Agent** — Sample agent server on port 8001 with hot reload
- **WebApp** — React frontend dev server on port 5001
- **API + Agent + WebApp** — Starts all three simultaneously

Open the Run and Debug panel (Ctrl+Shift+D), select a profile, and press F5.

**Manual startup (all platforms):**

Open three separate terminals (or PowerShell windows on Windows). Make sure your virtual environment is activated in each.

```bash
# Terminal 1 — API (from repo root)
python -m uvicorn src.api.main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — CU Agent (from repo root)
python -m uvicorn src.agents.computer_use.server:app --host 0.0.0.0 --port 8001 --reload

# Terminal 3 — Webapp
cd src/webapp
npm run dev
```

> **Windows note:** The commands above work identically in PowerShell. Use `cd src\webapp` instead of `cd src/webapp` if you prefer, though PowerShell accepts both.

### 5. Verify Everything Is Running

```bash
# API health
curl http://localhost:8000/health

# CU Agent health
curl http://localhost:8001/health

# Open the frontend
# → http://localhost:5001
```

On Windows without `curl`, use PowerShell:

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8001/health
```

### 6. Access the Application

- **Frontend**: http://localhost:5001
- **API Docs**: http://localhost:8000/api/docs
- **CU Agent**: http://localhost:8001

## Key Features

### Annotation System
The platform includes a 2-layer annotation system for human review of evaluation runs:

**Run-level annotations** provide quick triage of each test case run: outcome rating (1–5), efficiency assessment, issue tagging, and free-text notes.

**Action-level annotations** let you drill into individual tool calls within a run: correctness, parameter quality, information utilization, whether the action contributed to an error, and correction notes.

### Evaluation Comparison
Compare two evaluations side-by-side with per-test-case deltas, regression highlighting, and holdout set breakdowns.

### Regression Detection
When an evaluation completes, the system automatically compares against the most recent previous evaluation for the same agent+dataset. Test cases that previously passed but now fail are flagged as regressions.

### Prompt Improvement Proposals
Once 80% of test cases in an evaluation are annotated, the system can generate AI-powered prompt improvement proposals using the annotation data (corrections, tool failures, issue patterns) as evidence.

### Annotation Export
Export all run-level and action-level annotations as JSON or CSV for external analysis.

## Project Structure

```
agent-eval/
├── .env                  # Configuration (LLM endpoints, DB path, ports)
├── .env.example          # Configuration template
├── data/                 # SQLite database directory
│   └── .gitkeep
├── src/
│   ├── api/              # Backend API service
│   │   ├── main.py               # FastAPI app entrypoint
│   │   ├── config.py             # Configuration (env vars)
│   │   ├── controllers.py        # API route handlers + annotation endpoints
│   │   ├── models.py             # Pydantic models (incl. annotation models)
│   │   ├── sqlite_service.py     # SQLite data layer
│   │   ├── evaluator_service.py  # LLM-powered evaluation judge
│   │   ├── mcp_service.py        # MCP tool server
│   │   └── requirements.txt
│   ├── agents/           # Sample agent implementation
│   │   ├── agent_server.py       # LLM-powered agent
│   │   └── requirements.txt
│   └── webapp/           # React frontend
│       └── src/
│           ├── lib/api.ts                          # API client + types
│           ├── hooks/useAnnotations.ts             # Annotation state hook
│           ├── components/annotations/
│           │   └── AnnotationQueuePage.tsx         # Annotation queue
│           ├── components/results/
│           │   ├── EvaluationResultsPage.tsx       # Results + regression alerts
│           │   ├── EvaluationComparisonPage.tsx    # Side-by-side comparison
│           │   └── TestCaseResultPage.tsx          # Detail view + annotations
│           └── components/prompts/
│               └── PromptLabPage.tsx               # Prompt versioning + proposals
└── README.md
```

## Evaluating Your Own Agent

To integrate your own agent with the evaluation platform, your agent must expose an unauthenticated HTTP POST endpoint that conforms to the following specification.

### Endpoint

**Method**: POST

Your agent can use any endpoint path (e.g., `/invoke`, `/agents/calendar/invoke`). You'll register this endpoint URL when configuring your agent in the platform.

### Request Format

```json
{
  "dataset_id": "string",
  "test_case_id": "string",
  "agent_id": "string",
  "evaluation_run_id": "string",
  "input": "string"
}
```

### Response Format

```json
{
  "response": "string",
  "tool_calls": [
    {
      "name": "string",
      "arguments": [
        { "name": "string", "value": "any" }
      ]
    }
  ]
}
```

**Fields:**
- `response` (string, required): The agent's natural language response
- `tool_calls` (array, required): List of tools the agent invoked during execution
  - `name` (string): The tool name
  - `arguments` (array): Parameters passed to the tool

See [src/agents/agent_server.py](src/agents/agent_server.py) for a reference implementation.

## Troubleshooting

### Ollama Connection Errors

Make sure Ollama is running (`ollama serve`) and that you've pulled the models specified in your `.env` file:

```bash
ollama list                        # verify models are available
ollama pull qwen3-coder:latest     # judge model
ollama pull qwen3-vl:latest        # CU Agent vision model
```

### Throttling / Rate Limiting During Evaluations

If evaluations run slowly or time out with many test cases, reduce the concurrency in your `.env` file:

```bash
# Lower this if your local LLM is resource-constrained (default is 3)
MAX_CONCURRENT_TESTS=2
```

### Database Issues

The SQLite database is created automatically at `data/evals.db` on first run. To reset it, simply delete the file:

```bash
rm data/evals.db          # Linux/macOS
del data\evals.db         # Windows
```

### Playwright / Chromium Issues

If the CU Agent fails to start with a browser error:

```bash
# Reinstall Playwright's Chromium
python -m playwright install chromium

# On Linux, you may also need system dependencies:
python -m playwright install-deps chromium
```

### Windows-Specific Issues

**`services.sh` not available:** Use `services.ps1` instead — it's the PowerShell equivalent with identical commands (`.\services.ps1 start`, `.\services.ps1 stop`, etc.). Alternatively, use the VS Code launch profiles or manual startup commands.

**PowerShell execution policy:** If activating the virtual environment fails, run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**Port conflicts:** If a port is already in use, find and stop the process:

```powershell
# Find what's using port 8000
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | Select-Object OwningProcess
# Then kill it
Stop-Process -Id <PID> -Force
```

**Line endings:** If you see `\r` errors when running Python or shell scripts, configure Git to use LF:

```powershell
git config core.autocrlf input
```

## Documentation

- [API Documentation](src/api/README.md) — Detailed API endpoints and usage
- [Agent Documentation](src/agents/README.md) — Agent implementation guide
- [Evaluator Guide](src/api/EVALUATOR.md) — Evaluation system details
- [Frontend Documentation](src/webapp/README.md) — Webapp development guide

## Acknowledgments

AgentEval is inspired by and originally forked from Microsoft's [EvalsforAgentsInterop](https://github.com/microsoft/EvalsforAgentsInterop).

## Security

See [SECURITY.md](SECURITY.md) for security policies and vulnerability reporting.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.
