"""
SQLite-backed storage service.

Uses a single SQLite database with JSON documents stored per table.
Fully local, no cloud dependencies.
"""

import asyncio
import aiosqlite
import json
import os
import uuid
from typing import List, Optional

from .models import (
    Dataset, DatasetResponse, TestCaseResponse, Agent,
    TestCase, EvaluatorContract, Metadata, SeedScenario,
    ToolCallResult, McpToolLogEntry
)
from . import config

import logging
logger = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "evals.db")


class SQLiteService:
    """Local SQLite storage service."""

    def __init__(self):
        self._db_path = config.SQLITE_DB_PATH
        self._initialized = False

    async def _ensure_initialized(self):
        if self._initialized:
            return
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        async with aiosqlite.connect(self._db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS datasets (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS testcases (
                    id TEXT PRIMARY KEY,
                    dataset_id TEXT NOT NULL,
                    data TEXT NOT NULL
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS evaluations (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT,
                    data TEXT NOT NULL
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_tc_dataset ON testcases(dataset_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_eval_agent ON evaluations(agent_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_eval_dataset ON evaluations(json_extract(data, '$.dataset_id'))")
            await db.execute("""
                CREATE TABLE IF NOT EXISTS run_annotations (
                    id TEXT PRIMARY KEY,
                    evaluation_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    data TEXT NOT NULL,
                    UNIQUE(evaluation_id, run_id)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS action_annotations (
                    id TEXT PRIMARY KEY,
                    evaluation_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    action_index INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    UNIQUE(evaluation_id, run_id, action_index)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS agent_prompts (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    UNIQUE(agent_id, version)
                )
            """)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS prompt_proposals (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    data TEXT NOT NULL
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_prompts_agent ON agent_prompts(agent_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_proposals_agent ON prompt_proposals(agent_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_proposals_status ON prompt_proposals(status)")
            await db.execute("""
                CREATE TABLE IF NOT EXISTS judge_configs (
                    id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    PRIMARY KEY (id, version)
                )
            """)
            # ==== Cost Records (Feature: cost-attribution) ====
            await db.execute("""
                CREATE TABLE IF NOT EXISTS cost_records (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_cost_eval ON cost_records(json_extract(data, '$.evaluation_id'))")

            # ==== System Prompts (Feature: configurable-prompts) ====
            await db.execute("""
                CREATE TABLE IF NOT EXISTS system_prompts (
                    key TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    content TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # ==== Production Traces (Feature: production-trace-support) ====
            await db.execute("""
                CREATE TABLE IF NOT EXISTS production_traces (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    trace_id TEXT UNIQUE,
                    input TEXT NOT NULL,
                    output TEXT NOT NULL,
                    tool_calls TEXT,
                    latency_ms REAL,
                    model TEXT,
                    tokens_in INTEGER,
                    tokens_out INTEGER,
                    timestamp TEXT NOT NULL,
                    metadata TEXT,
                    sampled BOOLEAN DEFAULT 1,
                    sampling_decision TEXT,
                    status TEXT DEFAULT 'pending',
                    dataset_id TEXT,
                    testcase_id TEXT,
                    evaluation_id TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    expires_at TEXT,
                    pii_detected BOOLEAN DEFAULT 0,
                    pii_flags TEXT,
                    pii_scan_completed BOOLEAN DEFAULT 0
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_agent ON production_traces(agent_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_status ON production_traces(status)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_timestamp ON production_traces(timestamp)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_testcase ON production_traces(testcase_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_expires ON production_traces(expires_at)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_trace_pii ON production_traces(pii_detected)")

            await db.execute("""
                CREATE TABLE IF NOT EXISTS trace_annotations (
                    id TEXT PRIMARY KEY,
                    trace_id TEXT NOT NULL UNIQUE,
                    outcome INTEGER,
                    efficiency TEXT,
                    issues TEXT,
                    notes TEXT,
                    action_count INTEGER DEFAULT 0,
                    action_annotations TEXT,
                    pii_detected BOOLEAN,
                    sensitive_content TEXT,
                    testcase_candidate BOOLEAN,
                    conversion_notes TEXT,
                    annotated_by TEXT,
                    annotated_at TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_traceanon_trace ON trace_annotations(trace_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_traceanon_outcome ON trace_annotations(outcome)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_traceanon_candidate ON trace_annotations(testcase_candidate)")

            await db.execute("""
                CREATE TABLE IF NOT EXISTS trace_to_testcase_conversions (
                    id TEXT PRIMARY KEY,
                    trace_id TEXT NOT NULL,
                    testcase_id TEXT NOT NULL,
                    dataset_id TEXT NOT NULL,
                    conversion_type TEXT,
                    reason TEXT,
                    extracted_fields TEXT,
                    pii_redacted TEXT,
                    converted_by TEXT,
                    converted_at TEXT,
                    approved_by TEXT,
                    approved_at TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_conv_trace ON trace_to_testcase_conversions(trace_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_conv_testcase ON trace_to_testcase_conversions(testcase_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_conv_dataset ON trace_to_testcase_conversions(dataset_id)")

            await db.commit()
        self._initialized = True

    def _conn(self) -> aiosqlite.Connection:
        """Return an aiosqlite connection context manager (do NOT await here)."""
        return aiosqlite.connect(self._db_path)

    # ===== Dataset CRUD =====

    async def create_dataset_from_contract(self, contract: EvaluatorContract) -> Dataset:
        await self._ensure_initialized()
        contract_dict = contract.model_dump(mode='json')
        dataset = Dataset(
            id=contract_dict['id'],
            metadata=Metadata(**contract_dict['metadata']),
            seed=SeedScenario(**contract_dict['seed']),
            test_case_ids=[],
            created_at=contract_dict.get('created_at') or contract_dict['metadata']['created_at']
        )
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO datasets (id, data) VALUES (?, ?)",
                (dataset.id, dataset.model_dump_json())
            )
            await db.commit()

        test_case_ids = []
        for test_case in contract.test_cases:
            tc_dict = test_case.model_dump(mode='json')
            tc_dict['dataset_id'] = contract_dict['id']
            api_test_case = TestCase(**tc_dict)
            stored_tc = await self.create_testcase(api_test_case)
            test_case_ids.append(stored_tc.id)

        dataset.test_case_ids = test_case_ids
        return await self.update_dataset(dataset)

    async def create_dataset(self, dataset_or_contract) -> Dataset:
        await self._ensure_initialized()
        if isinstance(dataset_or_contract, EvaluatorContract):
            return await self.create_dataset_from_contract(dataset_or_contract)

        dataset: Dataset = dataset_or_contract
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO datasets (id, data) VALUES (?, ?)",
                (dataset.id, dataset.model_dump_json())
            )
            await db.commit()
        return dataset

    async def get_dataset(self, dataset_id: str) -> Optional[Dataset]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM datasets WHERE id = ?", (dataset_id,))
            row = await cursor.fetchone()
            if row:
                return Dataset(**json.loads(row[0]))
            return None

    async def list_datasets(self, skip: int = 0, limit: int = 100) -> List[Dataset]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM datasets ORDER BY json_extract(data, '$.created_at') DESC LIMIT ? OFFSET ?",
                (limit, skip)
            )
            rows = await cursor.fetchall()
            return [Dataset(**json.loads(r[0])) for r in rows]

    async def update_dataset(self, dataset: Dataset) -> Dataset:
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute(
                "UPDATE datasets SET data = ? WHERE id = ?",
                (dataset.model_dump_json(), dataset.id)
            )
            await db.commit()
        return dataset

    async def delete_dataset(self, dataset_id: str) -> bool:
        await self._ensure_initialized()
        test_cases = await self.list_testcases_by_dataset(dataset_id)
        for tc in test_cases:
            await self.delete_testcase(tc.id, dataset_id)
        async with self._conn() as db:
            cursor = await db.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))
            await db.commit()
            return cursor.rowcount > 0

    # ===== TestCase CRUD =====

    async def create_testcase(self, test_case: TestCase) -> TestCase:
        await self._ensure_initialized()
        async with self._conn() as db:
            # Insert test case and update dataset in one transaction
            await db.execute(
                "INSERT INTO testcases (id, dataset_id, data) VALUES (?, ?, ?)",
                (test_case.id, test_case.dataset_id, test_case.model_dump_json())
            )
            # Update the dataset's test_case_ids atomically
            cursor = await db.execute(
                "SELECT data FROM datasets WHERE id = ?",
                (test_case.dataset_id,)
            )
            row = await cursor.fetchone()
            if row:
                dataset = Dataset(**json.loads(row[0]))
                if test_case.id not in dataset.test_case_ids:
                    dataset.test_case_ids.append(test_case.id)
                    await db.execute(
                        "UPDATE datasets SET data = ? WHERE id = ?",
                        (dataset.model_dump_json(), dataset.id)
                    )
            await db.commit()
        return test_case

    async def get_testcase(self, testcase_id: str, dataset_id: str) -> Optional[TestCase]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM testcases WHERE id = ? AND dataset_id = ?",
                (testcase_id, dataset_id)
            )
            row = await cursor.fetchone()
            if row:
                return TestCase(**json.loads(row[0]))
            return None

    async def get_testcase_by_id(self, testcase_id: str) -> Optional[TestCase]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM testcases WHERE id = ?", (testcase_id,))
            row = await cursor.fetchone()
            if row:
                return TestCase(**json.loads(row[0]))
            return None

    async def list_testcases_by_dataset(self, dataset_id: str) -> List[TestCase]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM testcases WHERE dataset_id = ?", (dataset_id,)
            )
            rows = await cursor.fetchall()
            return [TestCase(**json.loads(r[0])) for r in rows]

    async def update_testcase(self, test_case: TestCase) -> TestCase:
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute(
                "UPDATE testcases SET data = ? WHERE id = ?",
                (test_case.model_dump_json(), test_case.id)
            )
            await db.commit()
        return test_case

    async def delete_testcase(self, testcase_id: str, dataset_id: str) -> bool:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "DELETE FROM testcases WHERE id = ? AND dataset_id = ?",
                (testcase_id, dataset_id)
            )
            await db.commit()
            deleted = cursor.rowcount > 0

        if deleted:
            dataset = await self.get_dataset(dataset_id)
            if dataset and testcase_id in dataset.test_case_ids:
                dataset.test_case_ids.remove(testcase_id)
                await self.update_dataset(dataset)
        return deleted

    # ===== Agent CRUD =====

    async def create_agent(self, agent: Agent) -> Agent:
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO agents (id, data) VALUES (?, ?)",
                (agent.id, agent.model_dump_json())
            )
            await db.commit()
        return agent

    async def get_agent(self, agent_id: str) -> Optional[Agent]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM agents WHERE id = ?", (agent_id,))
            row = await cursor.fetchone()
            if row:
                return Agent(**json.loads(row[0]))
            return None

    async def list_agents(self, skip: int = 0, limit: int = 100) -> List[Agent]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM agents ORDER BY json_extract(data, '$.created_at') DESC LIMIT ? OFFSET ?",
                (limit, skip)
            )
            rows = await cursor.fetchall()
            return [Agent(**json.loads(r[0])) for r in rows]

    async def update_agent(self, agent_id: str, agent: Agent) -> Agent:
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute(
                "UPDATE agents SET data = ? WHERE id = ?",
                (agent.model_dump_json(), agent_id)
            )
            await db.commit()
        return agent

    async def delete_agent(self, agent_id: str) -> bool:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
            # Cascade: clean up related data
            await db.execute("DELETE FROM evaluations WHERE json_extract(data, '$.agent_id') = ?", (agent_id,))
            await db.execute("DELETE FROM agent_prompts WHERE json_extract(data, '$.agent_id') = ?", (agent_id,))
            await db.execute("DELETE FROM prompt_proposals WHERE agent_id = ?", (agent_id,))
            await db.commit()
            return cursor.rowcount > 0

    # ===== Auto-seed Default Agents =====

    async def ensure_default_agents(self) -> int:
        """Ensure the Computer Use Agent is registered on startup.

        services.sh always starts the CU Agent process on port 8001,
        but evaluations need a corresponding DB record to reference.
        This seeds that record if no agents exist yet, so the CU Agent
        is usable out of the box without manual registration.

        Returns the number of agents seeded (0 if agents already exist).
        """
        await self._ensure_initialized()
        existing = await self.list_agents()
        if existing:
            return 0

        logger.info("No agents found — seeding default Computer Use Agent")

        from datetime import datetime, timezone
        cua = Agent(
            id="agent_cua_default",
            name="Computer Use Agent",
            description=(
                "Vision-enabled browser automation agent running locally on port 8001. "
                "Uses Playwright + Ollama with a multimodal model to navigate websites, "
                "fill forms, extract information, and perform web interactions."
            ),
            model=os.getenv("OLLAMA_MODEL", "qwen2.5vl:7b"),
            agent_invocation_url="http://localhost:8001/invoke",
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        await self.create_agent(cua)

        # Seed the CUA's built-in system prompt so it appears in Prompt Lab
        # and on the Agent Detail page. This is the same prompt hardcoded in
        # agents/computer_use/agent.py — seeding it here makes it visible
        # and editable through the UI.
        try:
            cua_system_prompt = (
                "You are a browser automation agent controlling a Chromium browser.\n"
                "You receive a screenshot and page text after every action. "
                "Based on the task and what you observe, output the next action.\n\n"
                "RESPOND WITH ONLY A SINGLE JSON OBJECT — no markdown fences, no extra text, no <think> blocks:\n"
                '{"thought": "brief reasoning", "action": "action_name", "params": {...}}\n\n'
                "Available actions and their params:\n"
                '  navigate       {"url": "https://..."}\n'
                '  click          {"x": <int>, "y": <int>}          — pixel coordinates on the screenshot\n'
                '  type_text      {"text": "string to type"}         — types into the currently focused field\n'
                '  click_and_type {"x": <int>, "y": <int>, "text": "value"} — click a form field then type into it\n'
                '  press_key      {"key": "Enter"}                   — Enter, Tab, Escape, ctrl+c, …\n'
                '  scroll         {"direction": "down", "amount": 1} — direction: up|down, amount: 1-3\n'
                '  select_option  {"x": <int>, "y": <int>}          — click a radio button, checkbox, or dropdown option\n'
                '  read_page_text {}                                  — extract ALL visible text\n'
                '  done           {"result": "your final answer", "success": true}\n\n'
                "RULES:\n"
                "1. Start by navigating to the relevant URL.\n"
                "2. Use the page text AND the screenshot to understand the page.\n"
                "3. Click precisely — estimate coordinates from the screenshot layout.\n"
                "4. Call \"done\" when you have the answer or have completed the task.\n"
                "5. Be efficient — minimise the number of steps.\n"
                "6. If an action fails, try a DIFFERENT approach — do NOT repeat the same action.\n"
                "7. NEVER call the same action with the same parameters twice in a row.\n"
                "8. FORM FILLING: Use click_and_type for text fields. Use select_option for radio/checkboxes/dropdowns."
            )
            prompt_data = {
                "id": f"prompt_{cua.id}_v1",
                "agent_id": cua.id,
                "system_prompt": cua_system_prompt,
                "version": 1,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "notes": "Default CUA system prompt (seeded from agent.py built-in prompt)",
                "is_active": True,
            }
            await self.create_agent_prompt(prompt_data)
            logger.info("Seeded default system prompt v1 for Computer Use Agent")
        except Exception as e:
            logger.warning(f"Failed to seed default prompt for CUA: {e}")

        return 1

    # ===== Evaluation Run CRUD =====

    async def create_evaluation_run(self, evaluation_run) -> "EvaluationRun":
        await self._ensure_initialized()
        from .models import EvaluationRun
        data_json = evaluation_run.model_dump_json()
        data_dict = json.loads(data_json)
        agent_id = data_dict.get("agent_id", "")
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO evaluations (id, agent_id, data) VALUES (?, ?, ?)",
                (evaluation_run.id, agent_id, data_json)
            )
            await db.commit()
        return EvaluationRun(**data_dict)

    async def get_evaluation_run(self, evaluation_id: str) -> Optional["EvaluationRun"]:
        await self._ensure_initialized()
        from .models import EvaluationRun
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM evaluations WHERE id = ?", (evaluation_id,))
            row = await cursor.fetchone()
            if row:
                return EvaluationRun(**json.loads(row[0]))
            return None

    async def list_evaluation_runs(self, skip: int = 0, limit: int = 100, agent_id: Optional[str] = None) -> List["EvaluationRun"]:
        await self._ensure_initialized()
        from .models import EvaluationRun
        async with self._conn() as db:
            if agent_id:
                cursor = await db.execute(
                    "SELECT data FROM evaluations WHERE agent_id = ? ORDER BY json_extract(data, '$.created_at') DESC LIMIT ? OFFSET ?",
                    (agent_id, limit, skip)
                )
            else:
                cursor = await db.execute(
                    "SELECT data FROM evaluations ORDER BY json_extract(data, '$.created_at') DESC LIMIT ? OFFSET ?",
                    (limit, skip)
                )
            rows = await cursor.fetchall()
            return [EvaluationRun(**json.loads(r[0])) for r in rows]

    async def update_evaluation_run(self, evaluation_run) -> "EvaluationRun":
        await self._ensure_initialized()
        from .models import EvaluationRun
        data_json = evaluation_run.model_dump_json()
        data_dict = json.loads(data_json)
        agent_id = data_dict.get("agent_id", "")
        async with self._conn() as db:
            await db.execute(
                "UPDATE evaluations SET agent_id = ?, data = ? WHERE id = ?",
                (agent_id, data_json, evaluation_run.id)
            )
            await db.commit()
        return EvaluationRun(**data_dict)

    async def delete_evaluation_run(self, evaluation_id: str) -> bool:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("DELETE FROM evaluations WHERE id = ?", (evaluation_id,))
            await db.commit()
            return cursor.rowcount > 0

    # ===== MCP Tool Logging =====

    async def log_tool_call(self, correlation_id: str, testcase_id: str, tool_name: str, parameters: dict, response: "ToolCallResult") -> None:
        await self._ensure_initialized()
        log_entry = McpToolLogEntry(
            tool_name=tool_name,
            input_parameters=parameters,
            result=response
        ).model_dump_json()

        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM evaluations WHERE id = ?", (correlation_id,))
            row = await cursor.fetchone()
            if not row:
                raise ValueError(f"Evaluation run with ID {correlation_id} not found for logging.")

            existing_doc = json.loads(row[0])
            test_cases = existing_doc.get("test_cases", [])
            testcase_found = False
            for test_case in test_cases:
                if test_case.get("testcase_id") == testcase_id:
                    if "actualToolCalls" not in test_case:
                        test_case["actualToolCalls"] = []
                    test_case["actualToolCalls"].append(log_entry)
                    testcase_found = True
                    break

            if not testcase_found:
                raise ValueError(f"Test case with ID {testcase_id} not found in evaluation run {correlation_id}")

            await db.execute(
                "UPDATE evaluations SET data = ? WHERE id = ?",
                (json.dumps(existing_doc), correlation_id)
            )
            await db.commit()



    # ===== Run Annotations =====

    async def upsert_run_annotation(self, annotation) -> dict:
        await self._ensure_initialized()
        import uuid
        from datetime import datetime, timezone
        data = annotation if isinstance(annotation, dict) else annotation.model_dump(mode='json')
        data['annotated_at'] = data.get('annotated_at') or datetime.now(timezone.utc).isoformat()
        ann_id = f"{data['evaluation_id']}:{data['run_id']}"
        data_json = json.dumps(data)
        async with self._conn() as db:
            await db.execute(
                """INSERT INTO run_annotations (id, evaluation_id, run_id, data)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(evaluation_id, run_id) DO UPDATE SET data = excluded.data""",
                (ann_id, data['evaluation_id'], data['run_id'], data_json)
            )
            await db.commit()
        return data

    async def get_run_annotation(self, evaluation_id: str, run_id: str) -> Optional[dict]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM run_annotations WHERE evaluation_id = ? AND run_id = ?",
                (evaluation_id, run_id)
            )
            row = await cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def list_run_annotations(self, evaluation_id: str) -> list:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM run_annotations WHERE evaluation_id = ?",
                (evaluation_id,)
            )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def delete_run_annotation(self, evaluation_id: str, run_id: str) -> bool:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "DELETE FROM run_annotations WHERE evaluation_id = ? AND run_id = ?",
                (evaluation_id, run_id)
            )
            await db.commit()
            return cursor.rowcount > 0

    # ===== Action Annotations =====

    async def upsert_action_annotation(self, annotation) -> dict:
        await self._ensure_initialized()
        from datetime import datetime, timezone
        data = annotation if isinstance(annotation, dict) else annotation.model_dump(mode='json')
        data['annotated_at'] = data.get('annotated_at') or datetime.now(timezone.utc).isoformat()
        ann_id = f"{data['evaluation_id']}:{data['run_id']}:{data['action_index']}"
        data_json = json.dumps(data)
        async with self._conn() as db:
            await db.execute(
                """INSERT INTO action_annotations (id, evaluation_id, run_id, action_index, data)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(evaluation_id, run_id, action_index) DO UPDATE SET data = excluded.data""",
                (ann_id, data['evaluation_id'], data['run_id'], data['action_index'], data_json)
            )
            await db.commit()
        return data

    async def get_action_annotation(self, evaluation_id: str, run_id: str, action_index: int) -> Optional[dict]:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM action_annotations WHERE evaluation_id = ? AND run_id = ? AND action_index = ?",
                (evaluation_id, run_id, action_index)
            )
            row = await cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def list_action_annotations(self, evaluation_id: str, run_id: Optional[str] = None) -> list:
        await self._ensure_initialized()
        async with self._conn() as db:
            if run_id:
                cursor = await db.execute(
                    "SELECT data FROM action_annotations WHERE evaluation_id = ? AND run_id = ?",
                    (evaluation_id, run_id)
                )
            else:
                cursor = await db.execute(
                    "SELECT data FROM action_annotations WHERE evaluation_id = ?",
                    (evaluation_id,)
                )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def delete_action_annotation(self, evaluation_id: str, run_id: str, action_index: int) -> bool:
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "DELETE FROM action_annotations WHERE evaluation_id = ? AND run_id = ? AND action_index = ?",
                (evaluation_id, run_id, action_index)
            )
            await db.commit()
            return cursor.rowcount > 0

    async def clear_all_annotations(self, evaluation_id: str) -> None:
        """Delete ALL run and action annotations for an evaluation."""
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute("DELETE FROM run_annotations WHERE evaluation_id = ?", (evaluation_id,))
            await db.execute("DELETE FROM action_annotations WHERE evaluation_id = ?", (evaluation_id,))
            await db.commit()

    async def get_annotation_summary(self, evaluation_id: str) -> dict:
        await self._ensure_initialized()
        run_anns = await self.list_run_annotations(evaluation_id)
        action_anns = await self.list_action_annotations(evaluation_id)

        eval_run = await self.get_evaluation_run(evaluation_id)
        total_runs = len(eval_run.test_cases) if eval_run else 0
        total_actions = sum(len(tc.actual_tool_calls) for tc in eval_run.test_cases) if eval_run else 0

        issue_counts = {}
        outcome_dist = {}
        for ann in run_anns:
            for issue in ann.get('issues', []):
                issue_counts[issue] = issue_counts.get(issue, 0) + 1
            outcome = ann.get('outcome')
            if outcome:
                outcome_dist[outcome] = outcome_dist.get(outcome, 0) + 1

        return {
            "evaluation_id": evaluation_id,
            "total_runs": total_runs,
            "annotated_runs": len(run_anns),
            "total_actions": total_actions,
            "annotated_actions": len(action_anns),
            "issue_counts": issue_counts,
            "outcome_distribution": outcome_dist,
        }

    # ===== Production Traces (Feature: production-trace-support) =====

    async def create_production_trace(self, trace_data: dict) -> dict:
        """Create a new production trace record."""
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute(
                """INSERT INTO production_traces
                   (id, agent_id, trace_id, input, output, tool_calls, latency_ms, model,
                    tokens_in, tokens_out, timestamp, metadata, sampled, status, expires_at,
                    pii_detected, pii_flags, pii_scan_completed)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (trace_data["id"], trace_data["agent_id"], trace_data.get("trace_id"),
                 trace_data["input"], trace_data["output"], trace_data.get("tool_calls"),
                 trace_data.get("latency_ms"), trace_data.get("model"),
                 trace_data.get("tokens_in"), trace_data.get("tokens_out"),
                 trace_data["timestamp"], trace_data.get("metadata"),
                 trace_data.get("sampled", True), trace_data.get("status", "pending"),
                 trace_data.get("expires_at"),
                 trace_data.get("pii_detected", False), trace_data.get("pii_flags"),
                 trace_data.get("pii_scan_completed", False))
            )
            await db.commit()
        return trace_data

    async def get_production_trace(self, trace_id: str) -> Optional[dict]:
        """Retrieve a production trace by ID or trace_id."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT * FROM production_traces WHERE id = ? OR trace_id = ?",
                (trace_id, trace_id)
            )
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_trace_dict(row)

    async def list_production_traces(self, agent_id: Optional[str] = None,
                                      status: Optional[str] = None,
                                      skip: int = 0, limit: int = 100) -> list:
        """List production traces with filtering."""
        await self._ensure_initialized()
        async with self._conn() as db:
            query = "SELECT * FROM production_traces WHERE 1=1"
            params = []

            if agent_id:
                query += " AND agent_id = ?"
                params.append(agent_id)
            if status:
                query += " AND status = ?"
                params.append(status)

            query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
            params.extend([limit, skip])

            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            return [self._row_to_trace_dict(r) for r in rows]

    async def update_production_trace(self, trace_id: str, updates: dict) -> Optional[dict]:
        """Update production trace fields."""
        await self._ensure_initialized()
        async with self._conn() as db:
            update_parts = []
            params = []
            for key, value in updates.items():
                update_parts.append(f"{key} = ?")
                params.append(value)

            if not update_parts:
                return await self.get_production_trace(trace_id)

            params.append(trace_id)
            params.append(trace_id)
            update_sql = ", ".join(update_parts)
            await db.execute(
                f"UPDATE production_traces SET {update_sql} WHERE id = ? OR trace_id = ?",
                params
            )
            await db.commit()
        return await self.get_production_trace(trace_id)

    async def delete_expired_production_traces(self) -> int:
        """Delete traces past their expiration date. Returns count deleted."""
        await self._ensure_initialized()
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()

        async with self._conn() as db:
            cursor = await db.execute(
                "DELETE FROM production_traces WHERE expires_at IS NOT NULL AND expires_at < ?",
                (now,)
            )
            await db.commit()
            return cursor.rowcount

    async def upsert_trace_annotation(self, annotation: dict) -> dict:
        """Create or update a trace annotation."""
        await self._ensure_initialized()
        from datetime import datetime, timezone

        ann_id = f"traceanon_{uuid.uuid4().hex[:16]}"
        annotated_at = annotation.get("annotated_at") or datetime.now(timezone.utc).isoformat()

        async with self._conn() as db:
            await db.execute(
                """INSERT INTO trace_annotations
                   (id, trace_id, outcome, efficiency, issues, notes, action_count,
                    action_annotations, pii_detected, sensitive_content, testcase_candidate,
                    conversion_notes, annotated_by, annotated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(trace_id) DO UPDATE SET
                    outcome=excluded.outcome, efficiency=excluded.efficiency,
                    issues=excluded.issues, notes=excluded.notes,
                    action_count=excluded.action_count, action_annotations=excluded.action_annotations,
                    pii_detected=excluded.pii_detected, sensitive_content=excluded.sensitive_content,
                    testcase_candidate=excluded.testcase_candidate, conversion_notes=excluded.conversion_notes,
                    annotated_by=excluded.annotated_by, annotated_at=excluded.annotated_at""",
                (ann_id, annotation["trace_id"], annotation.get("outcome"), annotation.get("efficiency"),
                 json.dumps(annotation.get("issues", [])), annotation.get("notes"),
                 annotation.get("action_count", 0), json.dumps(annotation.get("action_annotations", [])),
                 annotation.get("pii_detected"), annotation.get("sensitive_content", "none"),
                 annotation.get("testcase_candidate", False), annotation.get("conversion_notes"),
                 annotation.get("annotated_by"), annotated_at)
            )
            await db.commit()
        annotation["annotated_at"] = annotated_at
        return annotation

    async def get_trace_annotation(self, trace_id: str) -> Optional[dict]:
        """Get annotation for a trace."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT * FROM trace_annotations WHERE trace_id = ?",
                (trace_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_annotation_dict(row)

    async def create_trace_to_testcase_conversion(self, conversion: dict) -> dict:
        """Record a trace-to-testcase conversion."""
        await self._ensure_initialized()
        from datetime import datetime, timezone

        conv_id = f"conv_{uuid.uuid4().hex[:16]}"

        async with self._conn() as db:
            await db.execute(
                """INSERT INTO trace_to_testcase_conversions
                   (id, trace_id, testcase_id, dataset_id, conversion_type, reason,
                    extracted_fields, pii_redacted, converted_by, converted_at,
                    approved_by, approved_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (conv_id, conversion["trace_id"], conversion["testcase_id"],
                 conversion["dataset_id"], conversion.get("conversion_type"),
                 conversion.get("reason"), json.dumps(conversion.get("extracted_fields", {})),
                 json.dumps(conversion.get("pii_redacted", [])),
                 conversion.get("converted_by", "system"),
                 conversion.get("converted_at", datetime.now(timezone.utc).isoformat()),
                 conversion.get("approved_by"), conversion.get("approved_at"))
            )
            await db.commit()
        return conversion

    async def list_trace_conversions(self, dataset_id: Optional[str] = None,
                                      skip: int = 0, limit: int = 100) -> list:
        """List trace-to-testcase conversions."""
        await self._ensure_initialized()
        async with self._conn() as db:
            query = "SELECT * FROM trace_to_testcase_conversions WHERE 1=1"
            params = []

            if dataset_id:
                query += " AND dataset_id = ?"
                params.append(dataset_id)

            query += " ORDER BY converted_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, skip])

            cursor = await db.execute(query, params)
            rows = await cursor.fetchall()
            return [self._row_to_conversion_dict(r) for r in rows]

    async def get_production_trace_dashboard_summary(self) -> dict:
        """Generate dashboard stats: production vs eval performance."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT COUNT(*) FROM production_traces WHERE status='pending'")
            pending_traces = (await cursor.fetchone())[0]

            cursor = await db.execute("SELECT COUNT(*) FROM production_traces WHERE status='annotated'")
            annotated_traces = (await cursor.fetchone())[0]

            cursor = await db.execute("SELECT COUNT(*) FROM production_traces")
            total_traces = (await cursor.fetchone())[0]

            cursor = await db.execute("SELECT COUNT(*) FROM trace_to_testcase_conversions")
            total_conversions = (await cursor.fetchone())[0]

            cursor = await db.execute("SELECT COUNT(*) FROM production_traces WHERE pii_detected = 1")
            pii_count = (await cursor.fetchone())[0]

            cursor = await db.execute(
                "SELECT outcome, COUNT(*) as count FROM trace_annotations WHERE outcome IS NOT NULL GROUP BY outcome"
            )
            outcome_dist = {str(row[0]): row[1] for row in await cursor.fetchall()}

            cursor = await db.execute("SELECT AVG(latency_ms) FROM production_traces WHERE latency_ms IS NOT NULL")
            avg_latency_result = await cursor.fetchone()
            avg_latency = round(avg_latency_result[0], 2) if avg_latency_result[0] else 0

            cursor = await db.execute(
                "SELECT model, COUNT(*) as count FROM production_traces WHERE model IS NOT NULL GROUP BY model"
            )
            model_dist = {row[0]: row[1] for row in await cursor.fetchall()}

            return {
                "total_traces": total_traces,
                "pending_traces": pending_traces,
                "annotated_traces": annotated_traces,
                "total_conversions": total_conversions,
                "pii_detected_count": pii_count,
                "pii_rate": round(pii_count / total_traces * 100, 1) if total_traces > 0 else 0,
                "outcome_distribution": outcome_dist,
                "avg_latency_ms": avg_latency,
                "model_distribution": model_dist
            }

    def _row_to_trace_dict(self, row) -> dict:
        """Convert SQLite row to trace dictionary."""
        return {
            "id": row[0],
            "agent_id": row[1],
            "trace_id": row[2],
            "input": row[3],
            "output": row[4],
            "tool_calls": json.loads(row[5]) if row[5] else None,
            "latency_ms": row[6],
            "model": row[7],
            "tokens_in": row[8],
            "tokens_out": row[9],
            "timestamp": row[10],
            "metadata": json.loads(row[11]) if row[11] else None,
            "sampled": bool(row[12]),
            "sampling_decision": row[13],
            "status": row[14],
            "dataset_id": row[15],
            "testcase_id": row[16],
            "evaluation_id": row[17],
            "created_at": row[18],
            "expires_at": row[19],
            "pii_detected": bool(row[20]) if row[20] is not None else False,
            "pii_flags": json.loads(row[21]) if row[21] else [],
            "pii_scan_completed": bool(row[22]) if row[22] is not None else False
        }

    def _row_to_annotation_dict(self, row) -> dict:
        """Convert SQLite row to annotation dictionary."""
        return {
            "id": row[0],
            "trace_id": row[1],
            "outcome": row[2],
            "efficiency": row[3],
            "issues": json.loads(row[4]) if row[4] else [],
            "notes": row[5],
            "action_count": row[6],
            "action_annotations": json.loads(row[7]) if row[7] else [],
            "pii_detected": bool(row[8]) if row[8] is not None else None,
            "sensitive_content": row[9],
            "testcase_candidate": bool(row[10]) if row[10] is not None else False,
            "conversion_notes": row[11],
            "annotated_by": row[12],
            "annotated_at": row[13],
            "created_at": row[14]
        }

    def _row_to_conversion_dict(self, row) -> dict:
        """Convert SQLite row to conversion dictionary."""
        return {
            "id": row[0],
            "trace_id": row[1],
            "testcase_id": row[2],
            "dataset_id": row[3],
            "conversion_type": row[4],
            "reason": row[5],
            "extracted_fields": json.loads(row[6]) if row[6] else {},
            "pii_redacted": json.loads(row[7]) if row[7] else [],
            "converted_by": row[8],
            "converted_at": row[9],
            "approved_by": row[10],
            "approved_at": row[11],
            "created_at": row[12]
        }

    # ===== Agent Prompts =====

    async def create_agent_prompt(self, prompt) -> dict:
        """Store new prompt version. Uses same JSON-in-TEXT pattern as other tables."""
        await self._ensure_initialized()
        data_dict = prompt if isinstance(prompt, dict) else prompt.model_dump(mode='json')
        data_json = json.dumps(data_dict)
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO agent_prompts (id, agent_id, version, data) VALUES (?, ?, ?, ?)",
                (data_dict['id'], data_dict['agent_id'], data_dict['version'], data_json)
            )
            await db.commit()
        return data_dict

    async def get_agent_prompt(self, agent_id: str, version: int):
        """Get specific prompt version by agent_id + version."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM agent_prompts WHERE agent_id = ? AND version = ?",
                (agent_id, version)
            )
            row = await cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def get_active_prompt(self, agent_id: str):
        """Get the prompt where is_active=True for this agent (query data JSON)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM agent_prompts WHERE agent_id = ? ORDER BY version DESC",
                (agent_id,)
            )
            rows = await cursor.fetchall()
            for row in rows:
                data = json.loads(row[0])
                if data.get('is_active'):
                    return data
            return None

    async def list_agent_prompts(self, agent_id: str) -> list:
        """List all prompt versions for an agent, ordered by version desc."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM agent_prompts WHERE agent_id = ? ORDER BY version DESC",
                (agent_id,)
            )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def set_active_prompt(self, agent_id: str, version: int):
        """Set one prompt as active and deactivate all others for this agent."""
        await self._ensure_initialized()
        async with self._conn() as db:
            # Atomically deactivate all prompts for this agent
            await db.execute(
                "UPDATE agent_prompts SET data = json_set(data, '$.is_active', 0) WHERE json_extract(data, '$.agent_id') = ?",
                (agent_id,)
            )
            # Atomically activate the target version
            await db.execute(
                "UPDATE agent_prompts SET data = json_set(data, '$.is_active', 1) WHERE json_extract(data, '$.agent_id') = ? AND json_extract(data, '$.version') = ?",
                (agent_id, version)
            )
            await db.commit()

    async def get_next_prompt_version(self, agent_id: str) -> int:
        """Get next version number for this agent (max + 1, or 1 if none)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT MAX(version) FROM agent_prompts WHERE agent_id = ?",
                (agent_id,)
            )
            row = await cursor.fetchone()
            max_version = row[0] if row and row[0] else 0
            return max_version + 1

    # ===== Prompt Proposals =====

    async def create_proposal(self, proposal) -> dict:
        """Store new proposal."""
        await self._ensure_initialized()
        data_dict = proposal if isinstance(proposal, dict) else proposal.model_dump(mode='json')
        data_json = json.dumps(data_dict)
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO prompt_proposals (id, agent_id, status, data) VALUES (?, ?, ?, ?)",
                (data_dict['id'], data_dict['agent_id'], data_dict.get('status', 'pending'), data_json)
            )
            await db.commit()
        return data_dict

    async def get_proposal(self, proposal_id: str):
        """Get proposal by ID."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM prompt_proposals WHERE id = ?",
                (proposal_id,)
            )
            row = await cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def list_proposals(self, agent_id: str, status: str = None) -> list:
        """List proposals for agent, optionally filtered by status."""
        await self._ensure_initialized()
        async with self._conn() as db:
            if status:
                cursor = await db.execute(
                    "SELECT data FROM prompt_proposals WHERE agent_id = ? AND status = ?",
                    (agent_id, status)
                )
            else:
                cursor = await db.execute(
                    "SELECT data FROM prompt_proposals WHERE agent_id = ?",
                    (agent_id,)
                )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def update_proposal_status(self, proposal_id: str, status: str):
        """Update proposal status (applied, dismissed)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM prompt_proposals WHERE id = ?",
                (proposal_id,)
            )
            row = await cursor.fetchone()
            if row:
                data = json.loads(row[0])
                data['status'] = status
                await db.execute(
                    "UPDATE prompt_proposals SET status = ?, data = ? WHERE id = ?",
                    (status, json.dumps(data), proposal_id)
                )
                await db.commit()

    async def delete_proposal(self, proposal_id: str):
        """Delete a proposal by ID."""
        await self._ensure_initialized()
        async with self._conn() as db:
            await db.execute("DELETE FROM prompt_proposals WHERE id = ?", (proposal_id,))
            await db.commit()

    async def delete_proposals_bulk(self, agent_id: str, prompt_version: int = None) -> int:
        """Delete all proposals for an agent, optionally filtered by prompt version."""
        await self._ensure_initialized()
        async with self._conn() as db:
            if prompt_version is not None:
                # Get proposals for this agent + version, then delete matching ones
                cursor = await db.execute(
                    "SELECT id, data FROM prompt_proposals WHERE agent_id = ?",
                    (agent_id,)
                )
                rows = await cursor.fetchall()
                ids_to_delete = []
                for row in rows:
                    data = json.loads(row[1])
                    if data.get("prompt_version") == prompt_version:
                        ids_to_delete.append(row[0])
                for pid in ids_to_delete:
                    await db.execute("DELETE FROM prompt_proposals WHERE id = ?", (pid,))
                await db.commit()
                return len(ids_to_delete)
            else:
                cursor = await db.execute(
                    "DELETE FROM prompt_proposals WHERE agent_id = ?",
                    (agent_id,)
                )
                await db.commit()
                return cursor.rowcount

    # ===== Judge Configs =====

    async def ensure_default_judge_configs(self) -> int:
        """Ensure at least one judge config exists in the database.

        On startup, check if any judge configs are present. If not, seed
        the default built-in config so evaluations can run without manual
        setup. Returns the number of configs seeded (0 if already present).
        """
        await self._ensure_initialized()
        existing = await self.list_judge_configs()
        if existing:
            # Run migrations on existing configs (order matters — rubric first, then v3)
            await self._migrate_cua_config_to_rubric()
            await self._migrate_cua_v3_click_accuracy()
            return 0

        logger.info("No judge configs found — seeding default configurations")

        default_binary = {
            "id": "default-binary",
            "name": "Default Binary Judge",
            "version": 1,
            "is_active": False,
            "scoring_mode": "binary",
            "pass_threshold": None,
            "rubric": [],
            "system_prompt": (
                "You are a precise evaluator. Assess each assertion objectively "
                "and return ONLY valid JSON. Keep each reasoning to ONE sentence. "
                "Return passed=true only if the assertion is clearly satisfied."
            ),
            "user_prompt_template_batched": (
                "You are evaluating multiple assertions about an AI agent's tool usage in a single pass.\n"
                "\n"
                "**Test Context:**\n"
                "- Input: {{test_input}}\n"
                "- Description: {{test_description}}\n"
                "\n"
                "**Tool:** {{tool_name}}\n"
                "**Agent's Tool Calls:** {{tool_calls_json}}\n"
                "**Actual Tools Used:** {{actual_tools}}\n"
                "\n"
                "**Assertions to evaluate (evaluate ALL of them):**\n"
                "{{assertions_block}}\n"
                "\n"
                "**Task:** For EACH assertion, determine if it is satisfied (true/false) "
                "with a one-sentence explanation.\n"
                "\n"
                "Respond with ONLY a JSON object containing a \"results\" array, "
                "one entry per assertion in the SAME ORDER:\n"
                "{\n"
                "    \"results\": [\n"
                "        {\"index\": 0, \"passed\": true, \"reasoning\": \"One sentence explanation.\"},\n"
                "        {\"index\": 1, \"passed\": false, \"reasoning\": \"One sentence explanation.\"}\n"
                "    ]\n"
                "}"
            ),
            "user_prompt_template_single": (
                "You are evaluating a specific assertion about an AI agent's performance.\n"
                "\n"
                "**Test Context:**\n"
                "- Input: {{test_input}}\n"
                "- Description: {{test_description}}\n"
                "\n"
                "{{assertion_context}}\n"
                "\n"
                "**Task:** Determine if this assertion is satisfied (True/False).\n"
                "\n"
                "Respond in JSON format with a single human-readable sentence explanation:\n"
                "{\n"
                "    \"passed\": true,\n"
                "    \"reasoning\": \"One sentence explaining why this assertion passed or failed.\"\n"
                "}"
            ),
        }

        default_cua = {
            "id": "default-cua",
            "name": "Computer Use Agent Judge",
            "version": 1,
            "is_active": True,
            "scoring_mode": "rubric",
            "pass_threshold": 3.0,
            "rubric": [
                {
                    "name": "Tool Selection Accuracy",
                    "description": "Did the agent choose the correct browser action for the task?",
                    "levels": [
                        {"score": 1, "description": "Wrong tool entirely (e.g., click when should type, navigate when should scroll)"},
                        {"score": 2, "description": "Related but incorrect tool (e.g., right_click instead of left_click)"},
                        {"score": 3, "description": "Correct tool but suboptimal for the situation"},
                        {"score": 4, "description": "Correct tool with minor issues in usage pattern"},
                        {"score": 5, "description": "Optimal tool selection for the task"},
                    ],
                },
                {
                    "name": "Selector Precision",
                    "description": "Did the agent target the correct UI element?",
                    "levels": [
                        {"score": 1, "description": "Completely wrong element targeted"},
                        {"score": 2, "description": "Wrong element but in the correct area of the page"},
                        {"score": 3, "description": "Right element type but wrong instance (e.g., wrong button in a list)"},
                        {"score": 4, "description": "Correct element with slightly imprecise targeting"},
                        {"score": 5, "description": "Precise, robust element targeting"},
                    ],
                },
                {
                    "name": "Parameter Quality",
                    "description": "Were the action parameters (coordinates, text input, values) correct?",
                    "levels": [
                        {"score": 1, "description": "Parameters cause failure or trigger the wrong action"},
                        {"score": 2, "description": "Parameters partially correct but produce visible errors"},
                        {"score": 3, "description": "Parameters work but are suboptimal (e.g., extra whitespace, imprecise coords)"},
                        {"score": 4, "description": "Good parameters with only minor imprecision"},
                        {"score": 5, "description": "Optimal parameters for the action"},
                    ],
                },
                {
                    "name": "Task Completion",
                    "description": "Did the agent make meaningful progress toward the stated goal?",
                    "levels": [
                        {"score": 1, "description": "No progress or regression from starting state"},
                        {"score": 2, "description": "Minimal progress with significant issues or side effects"},
                        {"score": 3, "description": "Partial progress toward the goal"},
                        {"score": 4, "description": "Substantial progress with only minor gaps remaining"},
                        {"score": 5, "description": "Full task completion matching the expected outcome"},
                    ],
                },
                {
                    "name": "Error Recovery",
                    "description": "How well did the agent handle unexpected states or errors?",
                    "levels": [
                        {"score": 1, "description": "Failed to recognize errors, got stuck in a loop"},
                        {"score": 2, "description": "Recognized the error but chose the wrong recovery approach"},
                        {"score": 3, "description": "Basic recovery but inefficient (extra steps, partial backtracking)"},
                        {"score": 4, "description": "Good error recovery with only minor delays"},
                        {"score": 5, "description": "Excellent error detection and efficient recovery"},
                    ],
                },
            ],
            "system_prompt": (
                "You are an expert judge evaluating a computer use agent's performance "
                "on web automation tasks. You assess whether the agent correctly identified "
                "the right tools, used proper selectors, and achieved the intended outcome. "
                "Score each rubric criterion on a 1-5 scale based on the provided level descriptions. "
                "Be precise and objective in your scoring."
            ),
            "user_prompt_template_batched": (
                "You are evaluating multiple assertions about a computer-use AI agent's browser actions.\n"
                "\n"
                "**Test Context:**\n"
                "- Input: {{test_input}}\n"
                "- Description: {{test_description}}\n"
                "\n"
                "**Tool:** {{tool_name}}\n"
                "**Agent's Tool Calls:** {{tool_calls_json}}\n"
                "**Actual Tools Used:** {{actual_tools}}\n"
                "\n"
                "**Assertions to evaluate (evaluate ALL of them):**\n"
                "{{assertions_block}}\n"
                "\n"
                "**Task:** For EACH assertion, determine if it is satisfied (true/false) "
                "with a one-sentence explanation.\n"
                "\n"
                "Respond with ONLY a JSON object containing a \"results\" array, "
                "one entry per assertion in the SAME ORDER:\n"
                "{\n"
                "    \"results\": [\n"
                "        {\"index\": 0, \"passed\": true, \"reasoning\": \"One sentence explanation.\"},\n"
                "        {\"index\": 1, \"passed\": false, \"reasoning\": \"One sentence explanation.\"}\n"
                "    ]\n"
                "}"
            ),
            "user_prompt_template_single": (
                "You are evaluating a specific assertion about a computer-use AI agent's browser actions.\n"
                "\n"
                "**Test Context:**\n"
                "- Input: {{test_input}}\n"
                "- Description: {{test_description}}\n"
                "\n"
                "{{assertion_context}}\n"
                "\n"
                "**Task:** Determine if this assertion is satisfied (True/False).\n"
                "\n"
                "Respond in JSON format with a single human-readable sentence explanation:\n"
                "{\n"
                "    \"passed\": true,\n"
                "    \"reasoning\": \"One sentence explaining why this assertion passed or failed.\"\n"
                "}"
            ),
        }

        seeded = 0
        for config in [default_binary, default_cua]:
            try:
                await self.create_judge_config(config)
                seeded += 1
                logger.info(f"Seeded judge config: {config['name']} (id={config['id']})")
            except Exception as e:
                logger.error(f"Failed to seed judge config {config['id']}: {e}")

        return seeded

    async def _migrate_cua_config_to_rubric(self):
        """One-time migration: upgrade existing default-cua config to rubric mode.

        If the default-cua config exists but still has scoring_mode='binary',
        create a new version with rubric criteria and activate it.
        Idempotent — skips if already migrated.
        """
        try:
            versions = await self.list_judge_config_versions("default-cua")
            if not versions:
                return  # No CUA config exists — nothing to migrate

            latest = versions[0]  # newest first
            if latest.get('scoring_mode') == 'rubric' and latest.get('rubric'):
                return  # Already migrated

            logger.info("Migrating default-cua config to rubric scoring mode")

            next_version = await self.get_next_judge_config_version("default-cua")
            rubric_config = {
                "id": "default-cua",
                "name": latest.get("name", "Computer Use Agent Judge"),
                "version": next_version,
                "is_active": False,  # Will be activated by set_active below
                "scoring_mode": "rubric",
                "pass_threshold": 3.0,
                "rubric": [
                    {
                        "name": "Tool Selection Accuracy",
                        "description": "Did the agent choose the correct browser action for the task?",
                        "levels": [
                            {"score": 1, "description": "Wrong tool entirely (e.g., click when should type, navigate when should scroll)"},
                            {"score": 2, "description": "Related but incorrect tool (e.g., right_click instead of left_click)"},
                            {"score": 3, "description": "Correct tool but suboptimal for the situation"},
                            {"score": 4, "description": "Correct tool with minor issues in usage pattern"},
                            {"score": 5, "description": "Optimal tool selection for the task"},
                        ],
                    },
                    {
                        "name": "Selector Precision",
                        "description": "Did the agent target the correct UI element?",
                        "levels": [
                            {"score": 1, "description": "Completely wrong element targeted"},
                            {"score": 2, "description": "Wrong element but in the correct area of the page"},
                            {"score": 3, "description": "Right element type but wrong instance (e.g., wrong button in a list)"},
                            {"score": 4, "description": "Correct element with slightly imprecise targeting"},
                            {"score": 5, "description": "Precise, robust element targeting"},
                        ],
                    },
                    {
                        "name": "Parameter Quality",
                        "description": "Were the action parameters (coordinates, text input, values) correct?",
                        "levels": [
                            {"score": 1, "description": "Parameters cause failure or trigger the wrong action"},
                            {"score": 2, "description": "Parameters partially correct but produce visible errors"},
                            {"score": 3, "description": "Parameters work but are suboptimal (e.g., extra whitespace, imprecise coords)"},
                            {"score": 4, "description": "Good parameters with only minor imprecision"},
                            {"score": 5, "description": "Optimal parameters for the action"},
                        ],
                    },
                    {
                        "name": "Task Completion",
                        "description": "Did the agent make meaningful progress toward the stated goal?",
                        "levels": [
                            {"score": 1, "description": "No progress or regression from starting state"},
                            {"score": 2, "description": "Minimal progress with significant issues or side effects"},
                            {"score": 3, "description": "Partial progress toward the goal"},
                            {"score": 4, "description": "Substantial progress with only minor gaps remaining"},
                            {"score": 5, "description": "Full task completion matching the expected outcome"},
                        ],
                    },
                    {
                        "name": "Error Recovery",
                        "description": "How well did the agent handle unexpected states or errors?",
                        "levels": [
                            {"score": 1, "description": "Failed to recognize errors, got stuck in a loop"},
                            {"score": 2, "description": "Recognized the error but chose the wrong recovery approach"},
                            {"score": 3, "description": "Basic recovery but inefficient (extra steps, partial backtracking)"},
                            {"score": 4, "description": "Good error recovery with only minor delays"},
                            {"score": 5, "description": "Excellent error detection and efficient recovery"},
                        ],
                    },
                ],
                "system_prompt": (
                    "You are an expert judge evaluating a computer use agent's performance "
                    "on web automation tasks. You assess whether the agent correctly identified "
                    "the right tools, used proper selectors, and achieved the intended outcome. "
                    "Score each rubric criterion on a 1-5 scale based on the provided level descriptions. "
                    "Be precise and objective in your scoring."
                ),
                "user_prompt_template_batched": latest.get("user_prompt_template_batched", ""),
                "user_prompt_template_single": latest.get("user_prompt_template_single", ""),
                "notes": "Auto-migrated to rubric scoring mode with CUA-specific criteria",
            }

            await self.create_judge_config(rubric_config)
            await self.set_active_judge_config("default-cua", next_version)
            logger.info(f"Migrated default-cua to rubric mode (v{next_version}), now active")

        except Exception as e:
            logger.error(f"CUA rubric migration failed (non-fatal): {e}")

    async def _migrate_cua_v3_click_accuracy(self):
        """One-time migration: replace Selector Precision with Click Accuracy and fix system prompt.

        The old 'Selector Precision' criterion penalises the agent for using pixel
        coordinates instead of CSS selectors — but that is inherent to computer-use
        agents (they see screenshots, not the DOM). This migration:
          1. Replaces that criterion with 'Click Accuracy' (did the right element get
             clicked? — which is what actually matters for CUAs).
          2. Updates the system prompt to tell the judge not to deduct for stylistic
             differences or architectural constraints the agent cannot change.
        Idempotent — skips if already on a version without 'Selector Precision'.
        """
        try:
            versions = await self.list_judge_config_versions("default-cua")
            if not versions:
                logger.info("CUA v3 migration: no default-cua versions found, skipping")
                return

            latest = versions[0]  # newest first
            criteria_names = [c.get("name") for c in latest.get("rubric", [])]
            logger.info(
                f"CUA v3 migration check: latest=v{latest.get('version')}, "
                f"criteria={criteria_names}"
            )

            # Skip only if already migrated (Click Accuracy already present)
            if "Click Accuracy" in criteria_names:
                logger.info("CUA v3 migration: already migrated (Click Accuracy present), skipping")
                return

            logger.info("Migrating default-cua: replacing Selector Precision → Click Accuracy")

            next_version = await self.get_next_judge_config_version("default-cua")
            new_rubric = []
            for c in latest["rubric"]:
                if c["name"] == "Selector Precision":
                    new_rubric.append({
                        "name": "Click Accuracy",
                        "description": (
                            "Did the agent click the correct element? CUAs navigate by pixel "
                            "coordinates from screenshots — targeting precision is what matters."
                        ),
                        "levels": [
                            {"score": 1, "description": "Clicked the wrong element, causing an unintended action"},
                            {"score": 2, "description": "Clicked in the right area but hit an adjacent or wrong element"},
                            {"score": 3, "description": "Clicked the right element but coordinates were noticeably off"},
                            {"score": 4, "description": "Clicked the correct element; slightly off-centre but functional"},
                            {"score": 5, "description": "Clicked the intended element correctly"},
                        ],
                    })
                elif c["name"] == "Task Completion":
                    # Update level descriptions to not penalise for output formatting
                    # details that were never specified in the task input.
                    new_rubric.append({
                        "name": "Task Completion",
                        "description": c.get("description", "Did the agent complete the stated goal?"),
                        "levels": [
                            {"score": 1, "description": "No progress or regression from starting state"},
                            {"score": 2, "description": "Minimal progress with significant missing steps or side effects"},
                            {"score": 3, "description": "Partial progress — key information found but goal not fully met"},
                            {"score": 4, "description": "Goal substantially met; minor gap between result and expectation"},
                            {"score": 5, "description": "Goal fully met — all requested information retrieved and reported. "
                                         "Do not deduct for output formatting details not explicitly specified in the task."},
                        ],
                    })
                else:
                    new_rubric.append(c)

            v3_config = dict(latest)
            v3_config["version"] = next_version
            v3_config["is_active"] = False
            v3_config["rubric"] = new_rubric
            v3_config["notes"] = (
                "Replaced Selector Precision (inapplicable to CUA) with Click Accuracy; "
                "updated system prompt to prevent hairsplitting on style/architecture differences"
            )
            v3_config["system_prompt"] = (
                "You are an expert judge evaluating a computer use agent's performance on web automation tasks. "
                "The agent controls a real browser using screenshots and pixel coordinates — it cannot inspect "
                "the DOM or use CSS selectors. "
                "Score each rubric criterion on a 1-5 scale based on the provided level descriptions.\n\n"
                "Scoring guidelines:\n"
                "- Award 5 when the agent fully accomplishes what the criterion describes. "
                "Do not require academic perfection — 5 means the goal was achieved correctly.\n"
                "- Only deduct points for functionally significant issues: wrong element clicked, "
                "wrong data extracted, task not completed, unnecessary steps that caused a problem.\n"
                "- Do NOT deduct for: stylistic differences (e.g. pressing Enter vs clicking a button — "
                "both achieve the same result), architectural constraints the agent cannot change "
                "(e.g. it uses coordinates from screenshots, not DOM selectors), "
                "or valid alternative approaches that still work correctly.\n"
                "- Score 4 = a real minor issue genuinely affected the outcome or efficiency. "
                "Score 5 = the task was done correctly and completely."
            )

            await self.create_judge_config(v3_config)
            await self.set_active_judge_config("default-cua", next_version)
            logger.info(f"Migrated default-cua to v{next_version} with Click Accuracy criterion, now active")

        except Exception as e:
            logger.error(f"CUA v3 migration failed (non-fatal): {e}")

    # ===== System Prompts CRUD (Feature: configurable-prompts) =====

    async def list_system_prompts(self) -> list:
        """List all system prompts."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT key, name, description, content, updated_at FROM system_prompts ORDER BY key")
            rows = await cursor.fetchall()
            return [{"key": r[0], "name": r[1], "description": r[2], "content": r[3], "updated_at": r[4]} for r in rows]

    async def get_system_prompt(self, key: str) -> dict | None:
        """Get a single system prompt by key."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT key, name, description, content, updated_at FROM system_prompts WHERE key = ?", (key,))
            row = await cursor.fetchone()
            if not row:
                return None
            return {"key": row[0], "name": row[1], "description": row[2], "content": row[3], "updated_at": row[4]}

    async def upsert_system_prompt(self, key: str, name: str, description: str, content: str) -> dict:
        """Create or update a system prompt."""
        await self._ensure_initialized()
        from datetime import datetime, timezone
        updated_at = datetime.now(timezone.utc).isoformat()
        async with self._conn() as db:
            await db.execute(
                "INSERT OR REPLACE INTO system_prompts (key, name, description, content, updated_at) VALUES (?, ?, ?, ?, ?)",
                (key, name, description, content, updated_at)
            )
            await db.commit()
        return {"key": key, "name": name, "description": description, "content": content, "updated_at": updated_at}

    async def ensure_default_system_prompts(self) -> int:
        """Seed default system prompts if none exist.

        These are the LLM prompts used internally by the evaluator
        for proposal generation and evaluation comparison.
        Returns the number of prompts seeded (0 if already present).
        """
        await self._ensure_initialized()
        existing = await self.list_system_prompts()
        if existing:
            return 0

        logger.info("No system prompts found — seeding defaults")

        defaults = [
            {
                "key": "proposal_generation_system",
                "name": "Proposal Generation — System",
                "description": "System message for the LLM when generating prompt improvement proposals from failure annotations.",
                "content": "You are a precise prompt engineering expert. Return ONLY valid JSON with no additional text.",
            },
            {
                "key": "proposal_generation_user",
                "name": "Proposal Generation — User Template",
                "description": (
                    "User prompt template for proposal generation. Available variables: "
                    "{{current_prompt}}, {{tag}}, {{count}}, {{total_runs}}, {{sample_notes}}, "
                    "{{action_issues_count}}, {{tool_failure_summary}}, {{correction_samples}}, "
                    "{{correction_examples}}, {{concrete_examples}}, {{dedup_section}}, "
                    "{{rubric_section}}, {{json_fields}}"
                ),
                "content": (
                    "You are a prompt engineering expert. Analyze this agent failure pattern "
                    "and suggest ONE specific system prompt improvement.\n\n"
                    "CURRENT SYSTEM PROMPT:\n{{current_prompt}}\n\n"
                    "FAILURE PATTERN FROM HUMAN ANNOTATIONS:\n"
                    "- Issue \"{{tag}}\" occurred {{count}} times across {{total_runs}} test runs\n"
                    "- Sample annotator notes: {{sample_notes}}\n"
                    "- Number of incorrect action annotations: {{action_issues_count}}\n"
                    "{{tool_failure_summary}}\n"
                    "- Sample corrections suggested: {{correction_samples}}\n"
                    "{{correction_examples}}\n"
                    "{{concrete_examples}}\n"
                    "{{dedup_section}}\n"
                    "Based on these specific failures and tool-level patterns, provide a "
                    "targeted improvement that addresses the root cause.\n"
                    "{{rubric_section}}\n"
                    "Respond as JSON with these exact fields:\n{{json_fields}}"
                ),
            },
            {
                "key": "comparison_explanation",
                "name": "Evaluation Comparison — System",
                "description": "System prompt for the LLM when explaining differences between two evaluation runs.",
                "content": (
                    "You are a senior QA engineer analyzing an AI agent's evaluation results. "
                    "You are given step-by-step execution traces for each test case across two runs "
                    "(Baseline and Latest).\n\n"
                    "Your job is to identify SPECIFIC, CONCRETE root causes — not generic observations. "
                    "Compare the actual step sequences between runs to explain what the agent did differently.\n\n"
                    "Structure your analysis as:\n"
                    "## What Improved\n"
                    "For each improved test, explain specifically what the agent did differently in the latest run "
                    "(e.g., 'used navigate instead of click', 'correctly called done with result instead of looping', "
                    "'handled the form by clicking field first then typing'). Reference step numbers.\n\n"
                    "## What Regressed\n"
                    "For each regressed test, pinpoint the exact step where things went wrong "
                    "(e.g., 'got stuck repeating click at (53,604)', 'timed out at step 3', "
                    "'typed answer into page instead of calling done'). Reference the error message.\n\n"
                    "## Still Failing\n"
                    "For tests that failed in both runs, identify what's blocking them and whether there's progress.\n\n"
                    "## Recommendations\n"
                    "Give 2-3 SPECIFIC, ACTIONABLE fixes (e.g., 'add auto-rescue for click loops on form submit buttons', "
                    "'increase timeout for Wikipedia pages', 'add explicit form-filling guidance to system prompt'). "
                    "Do NOT give generic advice like 'add more tests' or 'monitor performance'.\n\n"
                    "Keep it under 400 words. Be direct."
                ),
            },
        ]

        seeded = 0
        for p in defaults:
            try:
                await self.upsert_system_prompt(p["key"], p["name"], p["description"], p["content"])
                seeded += 1
                logger.info(f"Seeded system prompt: {p['name']} (key={p['key']})")
            except Exception as e:
                logger.error(f"Failed to seed system prompt {p['key']}: {e}")

        return seeded

    async def create_judge_config(self, config) -> dict:
        """Store new judge config version. Uses JSON-in-TEXT pattern."""
        await self._ensure_initialized()
        data_dict = config if isinstance(config, dict) else config.model_dump(mode='json')
        data_json = json.dumps(data_dict)
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO judge_configs (id, version, data) VALUES (?, ?, ?)",
                (data_dict['id'], data_dict['version'], data_json)
            )
            await db.commit()
        return data_dict

    async def get_judge_config(self, config_id: str, version: int):
        """Get specific judge config by (id, version)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM judge_configs WHERE id = ? AND version = ?",
                (config_id, version)
            )
            row = await cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def get_active_judge_config(self):
        """Get the globally active judge config (is_active=True in JSON)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM judge_configs ORDER BY version DESC"
            )
            rows = await cursor.fetchall()
            for row in rows:
                data = json.loads(row[0])
                if data.get('is_active'):
                    return data
        return None

    async def list_judge_configs(self) -> list:
        """List all judge configs (all versions), newest first."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM judge_configs ORDER BY id, version DESC"
            )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def list_judge_config_versions(self, config_id: str) -> list:
        """List all versions of a specific judge config, newest first."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM judge_configs WHERE id = ? ORDER BY version DESC",
                (config_id,)
            )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def set_active_judge_config(self, config_id: str, version: int) -> bool:
        """Make one config version active, deactivate ALL others globally."""
        await self._ensure_initialized()
        async with self._conn() as db:
            # Atomically deactivate all judge configs
            await db.execute(
                "UPDATE judge_configs SET data = json_set(data, '$.is_active', 0)"
            )
            # Atomically activate the requested version
            cursor = await db.execute(
                "UPDATE judge_configs SET data = json_set(data, '$.is_active', 1) WHERE id = ? AND version = ?",
                (config_id, version)
            )
            await db.commit()
            # Verify the update succeeded
            cursor = await db.execute(
                "SELECT data FROM judge_configs WHERE id = ? AND version = ?",
                (config_id, version)
            )
            row = await cursor.fetchone()
            if row:
                data = json.loads(row[0])
                return data.get('is_active', False)
            return False

    async def get_next_judge_config_version(self, config_id: str) -> int:
        """Get next version number for this config (max + 1, or 1 if none)."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT MAX(version) FROM judge_configs WHERE id = ?",
                (config_id,)
            )
            row = await cursor.fetchone()
            max_version = row[0] if row and row[0] else 0
            return max_version + 1

    async def delete_judge_config(self, config_id: str, version: int) -> bool:
        """Delete a specific judge config version. Blocks deletion of active configs."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute(
                "SELECT data FROM judge_configs WHERE id = ? AND version = ?",
                (config_id, version)
            )
            row = await cursor.fetchone()
            if not row:
                return False
            data = json.loads(row[0])
            if data.get('is_active'):
                return False  # Cannot delete the active config
            await db.execute(
                "DELETE FROM judge_configs WHERE id = ? AND version = ?",
                (config_id, version)
            )
            await db.commit()
            return True

    # ===== Cost Records (Feature: cost-attribution) =====

    async def create_cost_record(self, record) -> dict:
        """Store a cost record."""
        await self._ensure_initialized()
        data_dict = record if isinstance(record, dict) else record.model_dump(mode='json')
        data_json = json.dumps(data_dict)
        async with self._conn() as db:
            await db.execute(
                "INSERT INTO cost_records (id, data) VALUES (?, ?)",
                (data_dict['id'], data_json)
            )
            await db.commit()
        return data_dict

    async def list_cost_records(self, evaluation_id: str = None, agent_id: str = None, limit: int = 500) -> list:
        """List cost records, optionally filtered."""
        await self._ensure_initialized()
        async with self._conn() as db:
            if evaluation_id:
                cursor = await db.execute(
                    "SELECT data FROM cost_records WHERE json_extract(data, '$.evaluation_id') = ? ORDER BY json_extract(data, '$.created_at') DESC LIMIT ?",
                    (evaluation_id, limit)
                )
            elif agent_id:
                cursor = await db.execute(
                    "SELECT data FROM cost_records WHERE json_extract(data, '$.agent_id') = ? ORDER BY json_extract(data, '$.created_at') DESC LIMIT ?",
                    (agent_id, limit)
                )
            else:
                cursor = await db.execute(
                    "SELECT data FROM cost_records ORDER BY json_extract(data, '$.created_at') DESC LIMIT ?",
                    (limit,)
                )
            rows = await cursor.fetchall()
            return [json.loads(r[0]) for r in rows]

    async def get_cost_summary(self) -> dict:
        """Aggregate cost totals across all records."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM cost_records")
            rows = await cursor.fetchall()

        total_cost = 0.0
        total_tokens_in = 0
        total_tokens_out = 0
        by_call_type = {}
        by_model = {}

        for row in rows:
            rec = json.loads(row[0])
            cost = rec.get('cost_usd', 0)
            t_in = rec.get('tokens_in', 0)
            t_out = rec.get('tokens_out', 0)
            total_cost += cost
            total_tokens_in += t_in
            total_tokens_out += t_out

            ct = rec.get('call_type', 'unknown')
            if ct not in by_call_type:
                by_call_type[ct] = {"cost_usd": 0.0, "count": 0}
            by_call_type[ct]["cost_usd"] += cost
            by_call_type[ct]["count"] += 1

            model = rec.get('model', 'unknown')
            if model not in by_model:
                by_model[model] = {"cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0, "count": 0}
            by_model[model]["cost_usd"] += cost
            by_model[model]["tokens_in"] += t_in
            by_model[model]["tokens_out"] += t_out
            by_model[model]["count"] += 1

        return {
            "total_cost_usd": round(total_cost, 6),
            "total_tokens_in": total_tokens_in,
            "total_tokens_out": total_tokens_out,
            "total_records": len(rows),
            "by_call_type": by_call_type,
            "by_model": by_model,
        }

    async def get_cost_by_agent(self) -> list:
        """Cost breakdown per agent."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM cost_records")
            rows = await cursor.fetchall()

        agents = {}
        for row in rows:
            rec = json.loads(row[0])
            aid = rec.get('agent_id') or 'unknown'
            if aid not in agents:
                agents[aid] = {"agent_id": aid, "cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0, "count": 0}
            agents[aid]["cost_usd"] += rec.get('cost_usd', 0)
            agents[aid]["tokens_in"] += rec.get('tokens_in', 0)
            agents[aid]["tokens_out"] += rec.get('tokens_out', 0)
            agents[aid]["count"] += 1

        result = sorted(agents.values(), key=lambda x: x["cost_usd"], reverse=True)
        for r in result:
            r["cost_usd"] = round(r["cost_usd"], 6)
        return result

    async def get_cost_trends(self, days: int = 30) -> list:
        """Daily cost aggregation for trend charting."""
        await self._ensure_initialized()
        async with self._conn() as db:
            cursor = await db.execute("SELECT data FROM cost_records")
            rows = await cursor.fetchall()

        daily = {}
        for row in rows:
            rec = json.loads(row[0])
            created = rec.get('created_at', '')[:10]  # YYYY-MM-DD
            if not created:
                continue
            if created not in daily:
                daily[created] = {"date": created, "cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0, "count": 0}
            daily[created]["cost_usd"] += rec.get('cost_usd', 0)
            daily[created]["tokens_in"] += rec.get('tokens_in', 0)
            daily[created]["tokens_out"] += rec.get('tokens_out', 0)
            daily[created]["count"] += 1

        result = sorted(daily.values(), key=lambda x: x["date"])[-days:]
        for r in result:
            r["cost_usd"] = round(r["cost_usd"], 6)
        return result

    # ===== Admin =====

    async def reset_all_data(self) -> dict:
        """Delete ALL rows from ALL tables. Returns counts of deleted rows per table."""
        await self._ensure_initialized()
        KNOWN_TABLES = {"datasets", "testcases", "evaluations", "agent_prompts", "prompt_proposals",
                        "judge_configs", "cost_records",
                        "run_annotations", "action_annotations", "agents",
                        "production_traces", "trace_annotations", "trace_to_testcase_conversions"}
        tables = [
            "cost_records",
            "judge_configs",
            "trace_to_testcase_conversions", "trace_annotations", "production_traces",
            "prompt_proposals", "action_annotations", "run_annotations",
            "evaluations", "agent_prompts", "testcases", "datasets", "agents",
        ]
        counts = {}
        async with self._conn() as db:
            for table in tables:
                assert table in KNOWN_TABLES, f"Table {table} not in whitelist"
                cursor = await db.execute(f"SELECT COUNT(*) FROM {table}")
                row = await cursor.fetchone()
                counts[table] = row[0] if row else 0
                await db.execute(f"DELETE FROM {table}")
            await db.commit()
        return counts


# Singleton
_service: Optional[SQLiteService] = None


def get_db_service() -> SQLiteService:
    global _service
    if not _service:
        _service = SQLiteService()
    return _service


async def log_mcp_tool_call(correlation_id: str, testcase_id: str, tool_name: str, parameters: dict, response: "ToolCallResult") -> None:
    service = get_db_service()
    await service._ensure_initialized()
