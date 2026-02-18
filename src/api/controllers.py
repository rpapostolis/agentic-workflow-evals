from typing import List, Optional, Dict
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, status, Query, BackgroundTasks, Body, UploadFile, File
from fastapi.responses import StreamingResponse
from datetime import datetime, timezone, timedelta
import io
import csv
import json
import logging
import asyncio
import uuid

logger = logging.getLogger(__name__)

from . import config

from .models import (
    Dataset,
    DatasetResponse,
    TestCaseResponse,
    Metadata,
    SeedScenario,
    TestCase,
    TestCaseCreate,
    CreateDatasetRequest,
    Agent,
    AgentCreate,
    EvaluationRun,
    EvaluationRunCreate,
    EvaluationRunStatus,
    EvaluatorContract,
    TestCaseResult,
    AgentPrompt,
    CreatePromptRequest,
    PromptProposal,
    GenerateProposalsRequest,
    ReEvaluateRequest,
    JudgeConfig,
    JudgeConfigCreate,
    TelemetryPayload,
)
from .sqlite_service import get_db_service
from .evaluator_service import get_evaluator_service

router = APIRouter(prefix="/api")
db = get_db_service()
evaluator = get_evaluator_service(db)

# ===========================================================================
# Proposal Generation Job Tracking
# ===========================================================================
# Generation runs as a background asyncio.Task so it survives page refreshes.
# The SSE stream is just a consumer that observes the task's output queue.
# On page reload the frontend checks the status endpoint and polls for
# new proposals via the normal GET /proposals endpoint.
# ===========================================================================
from dataclasses import dataclass, field as dc_field

@dataclass
class _GenerationJob:
    agent_id: str
    cancel_event: asyncio.Event
    started_at: str  # ISO timestamp
    proposals_generated: int = 0
    errors: list = dc_field(default_factory=list)
    completed: bool = False
    task: asyncio.Task = None  # type: ignore[assignment]
    # Queue for SSE consumers — proposals are pushed here AND saved to DB
    queue: asyncio.Queue = dc_field(default_factory=asyncio.Queue)

_active_proposal_generations: Dict[str, _GenerationJob] = {}


# Evaluation Datasets
@router.post("/datasets", response_model=DatasetResponse, status_code=201)
async def create_dataset(request: CreateDatasetRequest):
    """Create a new evaluation dataset with auto-generated IDs and timestamps
    
    Only requires: name, goal, and optionally input/schema_hash
    All IDs (generator_id, suite_id) and timestamps are auto-generated
    """
    try:
        # Create dataset (without test cases)
        dataset = Dataset(
            metadata=Metadata(schema_hash=request.schema_hash),
            seed=SeedScenario(
                name=request.name,
                goal=request.goal,
                input=request.input
            ),
            test_case_ids=[]
        )
        saved_dataset = await db.create_dataset(dataset)
        
        # Return as DatasetResponse
        return DatasetResponse(
            id=saved_dataset.id,
            metadata=saved_dataset.metadata,
            seed=saved_dataset.seed,
            test_case_ids=saved_dataset.test_case_ids,
            created_at=saved_dataset.created_at
        )
    except Exception as e:
        raise HTTPException(500, f"Failed to create dataset: {str(e)}")


@router.post("/datasets/import", response_model=DatasetResponse, status_code=201)
async def import_dataset(contract: EvaluatorContract):
    """Import a full dataset with test cases from an EvaluatorContract JSON.

    Accepts the same schema as the JSON files in data/eval/.
    Creates the dataset and all its test cases in one call.
    """
    try:
        existing = await db.get_dataset(contract.id)
        if existing:
            raise HTTPException(409, f"Dataset '{contract.id}' already exists")
        dataset = await db.create_dataset_from_contract(contract)
        return DatasetResponse(
            id=dataset.id,
            metadata=dataset.metadata,
            seed=dataset.seed,
            test_case_ids=dataset.test_case_ids,
            created_at=dataset.created_at
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to import dataset: {str(e)}")


@router.get("/datasets", response_model=List[DatasetResponse])
async def list_datasets(skip: int = 0, limit: int = 100):
    datasets = await db.list_datasets(skip=skip, limit=limit)
    return [DatasetResponse(
        id=d.id,
        metadata=d.metadata,
        seed=d.seed,
        test_case_ids=d.test_case_ids,
        created_at=d.created_at
    ) for d in datasets]


@router.get("/datasets/{dataset_id}", response_model=DatasetResponse)
async def get_dataset(dataset_id: str):
    dataset = await db.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")
    return DatasetResponse(
        id=dataset.id,
        metadata=dataset.metadata,
        seed=dataset.seed,
        test_case_ids=dataset.test_case_ids,
        created_at=dataset.created_at
    )


@router.delete("/datasets/{dataset_id}", status_code=204)
async def delete_dataset(dataset_id: str):
    if not await db.delete_dataset(dataset_id):
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")


# Test Cases
@router.post("/datasets/{dataset_id}/testcases", response_model=TestCaseResponse, status_code=201)
async def add_testcase(dataset_id: str, testcase: TestCaseCreate):
    """Add a new test case to an existing dataset

    The test case ID is auto-generated and dataset_id is automatically set from the URL.
    Name and description are auto-generated from input if not provided.
    """
    # Verify dataset exists
    dataset = await db.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")

    # Auto-generate name/description from input if not provided
    auto_name = testcase.name or testcase.input[:80].strip()
    auto_desc = testcase.description or testcase.input[:200].strip()
    auto_expected = testcase.expected_response or "Agent completes the task correctly."

    try:
        # Create TestCase with auto-generated ID and dataset_id from URL
        new_tc = TestCase(
            dataset_id=dataset_id,
            name=auto_name,
            description=auto_desc,
            input=testcase.input,
            minimal_tool_set=testcase.minimal_tool_set,
            tool_expectations=testcase.tool_expectations,
            expected_response=auto_expected,
            response_quality_expectation=testcase.response_quality_expectation,
            assertion_mode=testcase.assertion_mode,
            behavior_assertions=testcase.behavior_assertions,
            references_seed=testcase.references_seed,
            is_holdout=testcase.is_holdout
        )

        # Create test case in testcases container (auto-updates dataset.test_case_ids)
        created_tc = await db.create_testcase(new_tc)
    except Exception as e:
        raise HTTPException(500, f"Failed to create test case: {str(e)}")

    # Return the created test case
    return TestCaseResponse(
        id=created_tc.id,
        dataset_id=created_tc.dataset_id,
        name=created_tc.name,
        description=created_tc.description,
        input=created_tc.input,
        minimal_tool_set=created_tc.minimal_tool_set,
        tool_expectations=created_tc.tool_expectations,
        expected_response=created_tc.expected_response,
        response_quality_expectation=created_tc.response_quality_expectation,
        assertion_mode=created_tc.assertion_mode,
        behavior_assertions=created_tc.behavior_assertions,
        references_seed=created_tc.references_seed,
        is_holdout=created_tc.is_holdout
    )


@router.get("/datasets/{dataset_id}/testcases", response_model=List[TestCaseResponse])
async def list_testcases(dataset_id: str):
    dataset = await db.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")
    testcases = await db.list_testcases_by_dataset(dataset_id)
    return [TestCaseResponse(
        id=tc.id,
        dataset_id=tc.dataset_id,
        name=tc.name or tc.id,
        description=tc.description,
        input=tc.input,
        minimal_tool_set=tc.minimal_tool_set,
        tool_expectations=tc.tool_expectations,
        expected_response=tc.expected_response,
        response_quality_expectation=tc.response_quality_expectation,
        assertion_mode=getattr(tc, 'assertion_mode', 'response_only'),
        behavior_assertions=getattr(tc, 'behavior_assertions', []),
        references_seed=tc.references_seed,
        is_holdout=tc.is_holdout
    ) for tc in testcases]


@router.get("/datasets/{dataset_id}/testcases/{tc_id}", response_model=TestCaseResponse)
async def get_testcase(dataset_id: str, tc_id: str):
    tc = await db.get_testcase(tc_id, dataset_id)
    if not tc:
        raise HTTPException(404, f"Test case '{tc_id}' not found")
    return TestCaseResponse(
        id=tc.id,
        dataset_id=tc.dataset_id,
        name=tc.name,
        description=tc.description,
        input=tc.input,
        minimal_tool_set=tc.minimal_tool_set,
        tool_expectations=tc.tool_expectations,
        expected_response=tc.expected_response,
        response_quality_expectation=tc.response_quality_expectation,
        assertion_mode=getattr(tc, 'assertion_mode', 'response_only'),
        behavior_assertions=getattr(tc, 'behavior_assertions', []),
        references_seed=tc.references_seed,
        is_holdout=tc.is_holdout
    )


@router.put("/datasets/{dataset_id}/testcases/{tc_id}", response_model=TestCaseResponse)
async def update_testcase(dataset_id: str, tc_id: str, testcase_data: TestCaseCreate):
    """Update an existing test case
    
    Updates all fields of an existing test case. The test case ID and dataset_id cannot be changed.
    """
    dataset = await db.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")
    
    existing_tc = await db.get_testcase(tc_id, dataset_id)
    if not existing_tc:
        raise HTTPException(404, f"Test case '{tc_id}' not found")
    
    updated_tc = TestCase(
        id=tc_id,
        dataset_id=dataset_id,
        name=testcase_data.name,
        description=testcase_data.description,
        input=testcase_data.input,
        minimal_tool_set=testcase_data.minimal_tool_set,
        tool_expectations=testcase_data.tool_expectations,
        expected_response=testcase_data.expected_response,
        response_quality_expectation=testcase_data.response_quality_expectation,
        assertion_mode=testcase_data.assertion_mode,
        behavior_assertions=testcase_data.behavior_assertions,
        references_seed=testcase_data.references_seed,
        is_holdout=testcase_data.is_holdout
    )

    updated_tc = await db.update_testcase(updated_tc)

    return TestCaseResponse(
        id=updated_tc.id,
        dataset_id=updated_tc.dataset_id,
        name=updated_tc.name,
        description=updated_tc.description,
        input=updated_tc.input,
        minimal_tool_set=updated_tc.minimal_tool_set,
        tool_expectations=updated_tc.tool_expectations,
        expected_response=updated_tc.expected_response,
        response_quality_expectation=updated_tc.response_quality_expectation,
        assertion_mode=updated_tc.assertion_mode,
        behavior_assertions=updated_tc.behavior_assertions,
        references_seed=updated_tc.references_seed,
        is_holdout=updated_tc.is_holdout
    )


@router.delete("/datasets/{dataset_id}/testcases/{tc_id}", status_code=204)
async def delete_testcase(dataset_id: str, tc_id: str):
    if not await db.delete_testcase(tc_id, dataset_id):
        raise HTTPException(404, f"Test case '{tc_id}' not found")

    
# Agents
@router.post("/agents", response_model=Agent, status_code=201)
async def create_agent(agent: AgentCreate):
    # Create Agent with all fields from request
    agent_dict = agent.model_dump(exclude_none=True)
    new_agent = Agent(**agent_dict)
    return await db.create_agent(new_agent)


@router.get("/agents", response_model=List[Agent])
async def list_agents(skip: int = 0, limit: int = 100):
    return await db.list_agents(skip=skip, limit=limit)


@router.get("/agents/{agent_id}", response_model=Agent)
async def get_agent(agent_id: str):
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")
    return agent

@router.put("/agents/{agent_id}", response_model=Agent)
async def update_agent(agent_id: str, agent: AgentCreate):
    existing_agent = await db.get_agent(agent_id)
    if not existing_agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")

    # Update with all fields from request, preserving id and created_at
    agent_dict = agent.model_dump(exclude_none=True)
    updated_agent = Agent(
        id=existing_agent.id,
        created_at=existing_agent.created_at,
        **agent_dict
    )
    return await db.update_agent(agent_id, updated_agent)

@router.delete("/agents/{agent_id}", status_code=204)
async def delete_agent(agent_id: str):
    if not await db.delete_agent(agent_id):
        raise HTTPException(404, f"Agent '{agent_id}' not found")


# Evaluations
@router.post("/evaluations", response_model=EvaluationRun, status_code=201)
async def create_evaluation(eval_request: EvaluationRunCreate, background_tasks: BackgroundTasks):

    # Pre-flight: verify agent endpoint is reachable (skip for demo_mode
    # and skip for mock-agent which is served by this backend itself)
    agent_ep = eval_request.agent_endpoint or ""
    is_mock = "/mock-agent/" in agent_ep
    if agent_ep and not getattr(eval_request, 'demo_mode', False) and not is_mock:
        import httpx as _hx
        from urllib.parse import urlparse
        try:
            parsed = urlparse(agent_ep)
            base_url = f"{parsed.scheme}://{parsed.netloc}"
            health_url = f"{base_url}/health"
            async with _hx.AsyncClient(timeout=5.0) as c:
                r = await c.get(health_url)
                if r.status_code < 300:
                    logger.info(f"Pre-flight OK: {health_url} → {r.status_code}")
                else:
                    logger.warning(
                        f"Pre-flight: {health_url} returned {r.status_code} — "
                        f"proceeding anyway (agent may still work)"
                    )
        except _hx.ConnectError:
            raise HTTPException(
                503,
                f"Agent server unreachable at {base_url}. "
                f"Start the agent server first.\n\n"
                f"For the Computer Use Agent run:\n"
                f"  cd src && python -m agents.computer_use.server"
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.warning(f"Agent pre-flight check failed: {e} — proceeding anyway")

    try:
        # Create the evaluation run
        eval_run = await evaluator.create_evaluation_run(eval_request)

        # Start evaluation in background
        background_tasks.add_task(evaluator.start_evaluation, eval_run.id)

        return eval_run
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to create evaluation: {str(e)}")


@router.get("/evaluations", response_model=List[EvaluationRun])
async def list_evaluations(skip: int = 0, limit: int = 100, agent_id: Optional[str] = None):
    eval_runs = await evaluator.list_evaluation_runs(skip=skip, limit=limit, agent_id=agent_id)
    return eval_runs


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationRun)
async def get_evaluation(evaluation_id: str):
    eval_run = await evaluator.get_evaluation_run(evaluation_id)
    if not eval_run:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")
    # Overlay in-memory status_message (updated every 3s by countdown ticker
    # without hitting DB — see _update_status_message with persist=False).
    cached_msg = evaluator._status_cache.get(evaluation_id)
    if cached_msg and eval_run.status == EvaluationRunStatus.running:
        eval_run.status_message = cached_msg
    return eval_run


@router.get("/evaluations/{evaluation_id}/results", response_model=List[TestCaseResult])
async def get_evaluation_results(evaluation_id: str):
    eval_run = await evaluator.get_evaluation_run(evaluation_id)
    if not eval_run:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")
    return eval_run.test_cases


@router.get("/evaluations/{evaluation_id}/results/{testcase_id}", response_model=TestCaseResult)
async def get_test_result(evaluation_id: str, testcase_id: str):
    eval_run = await evaluator.get_evaluation_run(evaluation_id)
    if not eval_run:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")

    # Find the specific test result
    test_result = next((tc for tc in eval_run.test_cases if tc.testcase_id == testcase_id), None)
    if not test_result:
        raise HTTPException(404, f"Test result for '{testcase_id}' not found")

    return test_result


# ==============================================================================
# FEATURE: Generate Assertions from Reference Run (3-tier-assertions)
# ==============================================================================
@router.post("/evaluations/{evaluation_id}/results/{testcase_id}/generate-assertions")
async def generate_assertions(evaluation_id: str, testcase_id: str):
    """Auto-generate assertion proposals from a completed test case run.

    Analyses the actual tool calls and agent response from a completed
    evaluation result and uses an LLM to propose assertions for all three
    assertion modes (tool_level, hybrid, response_only).

    Returns proposed assertions that the user can review and selectively
    apply to the test case via the PUT test case endpoint.
    """
    eval_run = await evaluator.get_evaluation_run(evaluation_id)
    if not eval_run:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")

    test_case_result = next(
        (tc for tc in eval_run.test_cases if tc.testcase_id == testcase_id), None
    )
    if not test_case_result:
        raise HTTPException(404, f"Test result for '{testcase_id}' not found in evaluation")

    test_case = await db.get_testcase(testcase_id, eval_run.dataset_id)
    if not test_case:
        raise HTTPException(404, f"Test case '{testcase_id}' not found")

    proposed = await evaluator.generate_assertions_from_trace(
        test_case=test_case,
        test_case_result=test_case_result,
    )
    return proposed


# ==============================================================================
# FEATURE: Evaluation Comparison Endpoint
# ==============================================================================
@router.get("/evaluations/{eval_id_a}/compare/{eval_id_b}")
async def compare_evaluations(eval_id_a: str, eval_id_b: str):
    """Compare two evaluations side-by-side.

    For each unique test case across both evaluations, shows:
    - result_a: "passed"/"failed"/None (if not in eval_a)
    - result_b: "passed"/"failed"/None (if not in eval_b)
    - delta: "improved", "regressed", "unchanged", or "new"

    Returns aggregated summary with counts and pass rate delta.
    """
    try:
        # Fetch both evaluations
        fetched_a = await evaluator.get_evaluation_run(eval_id_a)
        fetched_b = await evaluator.get_evaluation_run(eval_id_b)

        # Validate both exist
        if not fetched_a:
            raise HTTPException(404, f"Evaluation '{eval_id_a}' not found")
        if not fetched_b:
            raise HTTPException(404, f"Evaluation '{eval_id_b}' not found")

        # Validate both are completed
        from .models import EvaluationRunStatus
        if fetched_a.status != EvaluationRunStatus.completed:
            raise HTTPException(400, f"Evaluation '{eval_id_a}' is not completed (status: {fetched_a.status.value})")
        if fetched_b.status != EvaluationRunStatus.completed:
            raise HTTPException(400, f"Evaluation '{eval_id_b}' is not completed (status: {fetched_b.status.value})")

        # Normalize ordering: A = older (baseline), B = newer (candidate)
        # This ensures the delta always shows "did the newer eval improve?"
        if fetched_a.created_at <= fetched_b.created_at:
            eval_a, eval_b = fetched_a, fetched_b
        else:
            eval_a, eval_b = fetched_b, fetched_a

        # Build result maps: testcase_id -> passed (bool)
        results_a = {tc.testcase_id: tc.passed for tc in eval_a.test_cases}
        results_b = {tc.testcase_id: tc.passed for tc in eval_b.test_cases}

        # Build rubric score maps: testcase_id -> rubric_average_score (float | None)
        rubric_a = {tc.testcase_id: tc.rubric_average_score for tc in eval_a.test_cases}
        rubric_b = {tc.testcase_id: tc.rubric_average_score for tc in eval_b.test_cases}

        # Build per-criterion rubric maps: testcase_id -> {criterion: score}
        rubric_detail_a: dict[str, dict[str, int]] = {}
        rubric_detail_b: dict[str, dict[str, int]] = {}
        for tc in eval_a.test_cases:
            if tc.rubric_scores:
                rubric_detail_a[tc.testcase_id] = {s.criterion: s.score for s in tc.rubric_scores}
        for tc in eval_b.test_cases:
            if tc.rubric_scores:
                rubric_detail_b[tc.testcase_id] = {s.criterion: s.score for s in tc.rubric_scores}

        # Get all unique testcase IDs across both evals
        all_testcase_ids = set(results_a.keys()) | set(results_b.keys())

        # Build holdout set and name map from evaluation's dataset
        holdout_testcase_ids = set()
        testcase_name_map: dict[str, str] = {}
        try:
            test_cases = await db.list_testcases_by_dataset(eval_a.dataset_id)
            for tc in test_cases:
                if getattr(tc, 'is_holdout', False):
                    holdout_testcase_ids.add(tc.id)
                if getattr(tc, 'name', None):
                    testcase_name_map[tc.id] = tc.name
        except Exception as e:
            logger.warning(f"Failed to load test case metadata: {e}")
        # Also try eval_b's dataset if different
        if eval_b.dataset_id != eval_a.dataset_id:
            try:
                test_cases_b = await db.list_testcases_by_dataset(eval_b.dataset_id)
                for tc in test_cases_b:
                    if tc.id not in testcase_name_map and getattr(tc, 'name', None):
                        testcase_name_map[tc.id] = tc.name
            except Exception:
                pass

        # Build comparison
        comparisons = []
        improved_count = 0
        improved_count_holdout = 0
        regressed_count = 0
        regressed_count_holdout = 0
        unchanged_count = 0
        unchanged_count_holdout = 0

        # Minimum rubric score change to count as improved/regressed (on 1-5 scale)
        RUBRIC_CHANGE_THRESHOLD = 0.3

        for testcase_id in sorted(all_testcase_ids):
            result_a = results_a.get(testcase_id)
            result_b = results_b.get(testcase_id)
            score_a = rubric_a.get(testcase_id)
            score_b = rubric_b.get(testcase_id)
            is_holdout = testcase_id in holdout_testcase_ids

            # Determine delta — considers both binary pass/fail AND rubric score changes.
            # Binary flip always wins; when binary result is the same, rubric score
            # change above threshold counts as improved/regressed.
            if result_a is None:
                delta = "new"  # Only in eval_b
            elif result_b is None:
                delta = "removed"  # Only in eval_a
            elif not result_a and result_b:
                delta = "improved"  # Binary flip: fail → pass
            elif result_a and not result_b:
                delta = "regressed"  # Binary flip: pass → fail
            elif score_a is not None and score_b is not None:
                # Same binary result — check rubric score change
                score_diff = score_b - score_a
                if score_diff >= RUBRIC_CHANGE_THRESHOLD:
                    delta = "improved"
                elif score_diff <= -RUBRIC_CHANGE_THRESHOLD:
                    delta = "regressed"
                else:
                    delta = "unchanged"
            else:
                delta = "unchanged"

            # Count for summary (skip new/removed)
            if delta == "improved":
                if is_holdout:
                    improved_count_holdout += 1
                else:
                    improved_count += 1
            elif delta == "regressed":
                if is_holdout:
                    regressed_count_holdout += 1
                else:
                    regressed_count += 1
            elif delta == "unchanged":
                if is_holdout:
                    unchanged_count_holdout += 1
                else:
                    unchanged_count += 1

            # Resolve test case name from dataset metadata
            tc_name = testcase_name_map.get(testcase_id, testcase_id)

            comparisons.append({
                "testcase_id": testcase_id,
                "name": tc_name,
                "result_a": "passed" if result_a else ("failed" if result_a is False else None),
                "result_b": "passed" if result_b else ("failed" if result_b is False else None),
                "score_a": score_a,
                "score_b": score_b,
                "rubric_detail_a": rubric_detail_a.get(testcase_id),
                "rubric_detail_b": rubric_detail_b.get(testcase_id),
                "delta": delta,
                "is_holdout": is_holdout
            })

        # Calculate summary statistics
        pass_rate_a = (eval_a.passed_count / eval_a.total_tests * 100) if eval_a.total_tests > 0 else 0
        pass_rate_b = (eval_b.passed_count / eval_b.total_tests * 100) if eval_b.total_tests > 0 else 0
        pass_rate_delta = pass_rate_b - pass_rate_a

        # Aggregate rubric scores (Feature: rubric-evaluation)
        scored_a = [s for s in rubric_a.values() if s is not None]
        scored_b = [s for s in rubric_b.values() if s is not None]
        rubric_avg_a = round(sum(scored_a) / len(scored_a), 2) if scored_a else None
        rubric_avg_b = round(sum(scored_b) / len(scored_b), 2) if scored_b else None
        rubric_delta = round(rubric_avg_b - rubric_avg_a, 2) if rubric_avg_a is not None and rubric_avg_b is not None else None

        # Aggregate per-criterion averages across all test cases
        criteria_scores_a: dict[str, list[int]] = {}
        criteria_scores_b: dict[str, list[int]] = {}
        for scores in rubric_detail_a.values():
            for crit, score in scores.items():
                criteria_scores_a.setdefault(crit, []).append(score)
        for scores in rubric_detail_b.values():
            for crit, score in scores.items():
                criteria_scores_b.setdefault(crit, []).append(score)

        all_criteria = sorted(set(criteria_scores_a.keys()) | set(criteria_scores_b.keys()))
        criteria_comparison = None
        if all_criteria:
            criteria_comparison = []
            for crit in all_criteria:
                vals_a = criteria_scores_a.get(crit, [])
                vals_b = criteria_scores_b.get(crit, [])
                avg_a = round(sum(vals_a) / len(vals_a), 2) if vals_a else None
                avg_b = round(sum(vals_b) / len(vals_b), 2) if vals_b else None
                criteria_comparison.append({
                    "criterion": crit,
                    "avg_a": avg_a,
                    "avg_b": avg_b,
                    "delta": round(avg_b - avg_a, 2) if avg_a is not None and avg_b is not None else None,
                })

        # Build delta summary with optional holdout breakdown if any exist
        delta_summary = {
            "improved_count": improved_count,
            "regressed_count": regressed_count,
            "unchanged_count": unchanged_count,
        }

        # Add holdout breakdown if any holdout test cases exist
        if holdout_testcase_ids:
            delta_summary["holdout_breakdown"] = {
                "improved_count_holdout": improved_count_holdout,
                "regressed_count_holdout": regressed_count_holdout,
                "unchanged_count_holdout": unchanged_count_holdout,
                "total_holdout": len(holdout_testcase_ids)
            }

        return {
            "evaluation_a": {
                "id": eval_a.id,
                "name": eval_a.name,
                "prompt_version": getattr(eval_a, 'prompt_version', None),
                "pass_rate": round(pass_rate_a, 1),
                "created_at": eval_a.created_at,
                "total_tests": eval_a.total_tests,
                "passed_count": eval_a.passed_count,
                "rubric_avg": rubric_avg_a,
            },
            "evaluation_b": {
                "id": eval_b.id,
                "name": eval_b.name,
                "prompt_version": getattr(eval_b, 'prompt_version', None),
                "pass_rate": round(pass_rate_b, 1),
                "created_at": eval_b.created_at,
                "total_tests": eval_b.total_tests,
                "passed_count": eval_b.passed_count,
                "rubric_avg": rubric_avg_b,
            },
            "delta_summary": {
                "improved": improved_count,
                "regressed": regressed_count,
                "unchanged": unchanged_count,
                "pass_rate_delta": round(pass_rate_delta, 1),
                "rubric_delta": rubric_delta,
                **({"holdout_breakdown": {
                    "improved_holdout": improved_count_holdout,
                    "regressed_holdout": regressed_count_holdout,
                    "unchanged_holdout": unchanged_count_holdout,
                    "total_holdout": len(holdout_testcase_ids)
                }} if holdout_testcase_ids else {})
            },
            "test_cases": comparisons,
            **({"criteria_comparison": criteria_comparison} if criteria_comparison else {})
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to compare evaluations: {str(e)}")


@router.post("/evaluations/{eval_id_a}/explain/{eval_id_b}")
async def explain_comparison(eval_id_a: str, eval_id_b: str):
    """Generate an LLM-powered explanation of differences between two evaluation runs."""
    try:
        explanation = await evaluator.explain_comparison(eval_id_a, eval_id_b)
        return {"explanation": explanation}
    except ValueError as e:
        raise HTTPException(404, str(e))
    except ConnectionError as e:
        raise HTTPException(503, f"LLM service unavailable: {str(e)}")
    except Exception as e:
        logger.error(f"Failed to explain comparison: {e}")
        raise HTTPException(500, f"Failed to generate explanation: {str(e)}")


# ==============================================================================
# FEATURE: Annotation Export Endpoint
# ==============================================================================
@router.get("/evaluations/{evaluation_id}/annotations/export")
async def export_annotations(evaluation_id: str, format: str = "json"):
    """Export evaluation data with annotations in JSON or CSV format.

    For each test case, includes:
    - input, response, pass/fail status
    - run-level annotations
    - action-level annotations

    Supports:
    - format=json: Returns JSON structure
    - format=csv: Returns CSV file for spreadsheet import
    """
    try:
        # Fetch evaluation
        eval_run = await evaluator.get_evaluation_run(evaluation_id)
        if not eval_run:
            raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")

        # Get all test cases for this evaluation's dataset
        test_cases_map = {}
        test_cases = await db.list_testcases_by_dataset(eval_run.dataset_id)
        for tc in test_cases:
            test_cases_map[tc.id] = tc

        # Get annotations
        run_annotations = await db.list_run_annotations(evaluation_id)
        action_annotations = await db.list_action_annotations(evaluation_id)

        # Build run annotation map for quick lookup
        run_ann_map = {}
        for ann in run_annotations:
            run_id = ann.get("run_id") if isinstance(ann, dict) else getattr(ann, 'run_id', '')
            run_ann_map[run_id] = ann

        # Build action annotation map: (run_id, action_index) -> annotation
        action_ann_map = {}
        for ann in action_annotations:
            run_id = ann.get("run_id") if isinstance(ann, dict) else getattr(ann, 'run_id', '')
            action_idx = ann.get("action_index") if isinstance(ann, dict) else getattr(ann, 'action_index', -1)
            key = (run_id, action_idx)
            if key not in action_ann_map:
                action_ann_map[key] = []
            action_ann_map[key].append(ann)

        # Build export data structure
        export_data = []
        for test_result in eval_run.test_cases:
            testcase_id = test_result.testcase_id
            test_case = test_cases_map.get(testcase_id)

            # Get annotations for this test case
            run_ann = run_ann_map.get(testcase_id, {})
            action_anns = action_ann_map.get((testcase_id,), [])

            # Build record
            record = {
                "testcase_id": testcase_id,
                "testcase_name": test_case.name if test_case else testcase_id,
                "input": test_case.input if test_case else "",
                "expected_response": test_case.expected_response if test_case else "",
                "agent_response": test_result.response_from_agent,
                "result": "passed" if test_result.passed else "failed",
                "run_annotation": run_ann if isinstance(run_ann, dict) else (
                    {
                        "outcome": getattr(run_ann, 'outcome', None),
                        "efficiency": getattr(run_ann, 'efficiency', None),
                        "issues": getattr(run_ann, 'issues', []),
                        "notes": getattr(run_ann, 'notes', "")
                    } if run_ann else {}
                ),
                "action_annotations": [
                    ann if isinstance(ann, dict) else {
                        "action_index": getattr(ann, 'action_index', -1),
                        "correctness": getattr(ann, 'correctness', None),
                        "correction": getattr(ann, 'correction', None)
                    }
                    for ann in action_anns
                ]
            }
            export_data.append(record)

        # Return based on format
        if format.lower() == "csv":
            # Build CSV
            output = io.StringIO()
            if export_data:
                fieldnames = [
                    "testcase_id", "testcase_name", "result", "input", "expected_response", "agent_response",
                    "run_annotation_outcome", "run_annotation_efficiency", "run_annotation_issues", "run_annotation_notes",
                    "action_annotations_count"
                ]
                writer = csv.DictWriter(output, fieldnames=fieldnames)
                writer.writeheader()

                for record in export_data:
                    run_ann = record["run_annotation"]
                    csv_record = {
                        "testcase_id": record["testcase_id"],
                        "testcase_name": record["testcase_name"],
                        "result": record["result"],
                        "input": record["input"][:100],  # Truncate long inputs
                        "expected_response": record["expected_response"][:100],
                        "agent_response": record["agent_response"][:100],
                        "run_annotation_outcome": run_ann.get("outcome", "") if run_ann else "",
                        "run_annotation_efficiency": run_ann.get("efficiency", "") if run_ann else "",
                        "run_annotation_issues": "; ".join(run_ann.get("issues", [])) if run_ann else "",
                        "run_annotation_notes": run_ann.get("notes", "") if run_ann else "",
                        "action_annotations_count": len(record["action_annotations"])
                    }
                    writer.writerow(csv_record)

            # Return as streaming response
            csv_bytes = output.getvalue().encode("utf-8")
            return StreamingResponse(
                iter([csv_bytes]),
                media_type="text/csv",
                headers={"Content-Disposition": f"attachment; filename=eval_{evaluation_id}_annotations.csv"}
            )
        else:
            # Default to JSON
            return {
                "evaluation_id": evaluation_id,
                "evaluation_name": eval_run.name,
                "evaluation_status": eval_run.status.value if hasattr(eval_run.status, 'value') else eval_run.status,
                "total_tests": eval_run.total_tests,
                "passed_count": eval_run.passed_count,
                "failed_count": eval_run.failed_tests,
                "data": export_data
            }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to export annotations: {str(e)}")


# ==============================================================================
# CANCEL EVALUATION ENDPOINT (Feature: cancel-evaluation)
# ==============================================================================
# This endpoint allows users to manually cancel a running or stuck evaluation.
# Use cases:
# - Evaluation is taking too long and user wants to abort
# - Something went wrong and evaluation is stuck
# - User started wrong evaluation by mistake
#
# The cancelled evaluation is preserved with its partial results for review.
# ==============================================================================
@router.post("/evaluations/{evaluation_id}/cancel", response_model=EvaluationRun)
async def cancel_evaluation(evaluation_id: str):
    """Cancel a running or stuck evaluation.
    
    Marks the evaluation as cancelled. Use this to clean up stuck evaluations
    that are no longer making progress. The evaluation is preserved with any
    partial results that were collected before cancellation.
    
    Args:
        evaluation_id: ID of the evaluation to cancel
        
    Returns:
        The updated EvaluationRun with status='cancelled'
        
    Raises:
        404: Evaluation not found
        400: Evaluation already completed (cannot cancel)
        500: Internal error during cancellation
    """
    try:
        eval_run = await evaluator.cancel_evaluation_run(evaluation_id)
        if not eval_run:
            raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")
        return eval_run
    except HTTPException:
        raise  # Re-raise HTTP exceptions as-is
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to cancel evaluation: {str(e)}")


@router.delete("/evaluations/{evaluation_id}", status_code=204)
async def delete_evaluation(evaluation_id: str):
    try:
        success = await evaluator.delete_evaluation_run(evaluation_id)
        if not success:
            raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")
    except HTTPException:
        raise  # Re-raise HTTP exceptions as-is
    except Exception as e:
        raise HTTPException(500, f"Failed to delete evaluation: {str(e)}")

# ============================================================================
# Annotations (2-layer: Run-level + Action-level)
# ============================================================================

ISSUE_TAGS = [
    "Skipped required check", "Repeated work", "Stopped too early",
    "Ignored information", "Wrong tool used", "Bad parameters",
    "Missed escalation", "Made something up", "Security oversight",
    "Used stale data", "Slow / inefficient", "Poor error handling",
]


@router.get("/annotations/issue-tags")
async def get_issue_tags():
    return ISSUE_TAGS


@router.put("/evaluations/{evaluation_id}/annotations/runs/{run_id}")
async def upsert_run_annotation(evaluation_id: str, run_id: str, body: dict = Body(...), background_tasks: BackgroundTasks = None):
    body["evaluation_id"] = evaluation_id
    body["run_id"] = run_id
    result = await db.upsert_run_annotation(body)

    # Feature 2: Automated Proposal Trigger
    # After annotation is saved, check if we should auto-trigger proposals
    if background_tasks:
        try:
            # Get annotation summary for this evaluation
            summary = await db.get_annotation_summary(evaluation_id)
            total_runs = summary.get("total_runs", 0) if isinstance(summary, dict) else getattr(summary, 'total_runs', 0)
            annotated_runs = summary.get("annotated_runs", 0) if isinstance(summary, dict) else getattr(summary, 'annotated_runs', 0)

            # Calculate coverage
            coverage = (annotated_runs / total_runs * 100) if total_runs > 0 else 0

            # If coverage >= 80%, trigger proposal generation
            if coverage >= 80.0:
                # Get the evaluation to find agent_id and prompt_version
                eval_run = await evaluator.get_evaluation_run(evaluation_id)
                if eval_run:
                    agent_id = eval_run.agent_id
                    prompt_version = eval_run.prompt_version

                    # Check if proposals already exist for this agent and prompt version
                    existing_proposals = await db.list_proposals(agent_id, status="pending")
                    has_pending_proposals_for_version = any(
                        p.get("prompt_version") == prompt_version
                        for p in existing_proposals
                    )

                    # If no pending proposals for this version, trigger generation in background
                    if not has_pending_proposals_for_version:
                        logger.info(f"Auto-triggering proposal generation for agent {agent_id} (coverage: {coverage:.1f}%)")
                        background_tasks.add_task(evaluator.generate_prompt_proposals, agent_id, [evaluation_id])
                        # Add a note to the result indicating proposals were triggered
                        result["_proposals_triggered"] = True
                    else:
                        logger.debug(f"Pending proposals already exist for agent {agent_id} version {prompt_version}, skipping auto-trigger")
                        result["_proposals_triggered"] = False
        except Exception as e:
            # Don't fail the annotation save if auto-trigger fails
            logger.warning(f"Failed to auto-trigger proposals for evaluation {evaluation_id}: {e}")
            result["_proposals_trigger_error"] = str(e)

    return result


@router.get("/evaluations/{evaluation_id}/annotations/runs/{run_id}")
async def get_run_annotation(evaluation_id: str, run_id: str):
    ann = await db.get_run_annotation(evaluation_id, run_id)
    if not ann:
        raise HTTPException(404, "Run annotation not found")
    return ann


@router.get("/evaluations/{evaluation_id}/annotations/runs")
async def list_run_annotations(evaluation_id: str):
    return await db.list_run_annotations(evaluation_id)


@router.delete("/evaluations/{evaluation_id}/annotations/runs/{run_id}", status_code=204)
async def delete_run_annotation(evaluation_id: str, run_id: str):
    if not await db.delete_run_annotation(evaluation_id, run_id):
        raise HTTPException(404, "Run annotation not found")


@router.put("/evaluations/{evaluation_id}/annotations/runs/{run_id}/actions/{action_index}")
async def upsert_action_annotation(evaluation_id: str, run_id: str, action_index: int, body: dict = Body(...)):
    body["evaluation_id"] = evaluation_id
    body["run_id"] = run_id
    body["action_index"] = action_index
    result = await db.upsert_action_annotation(body)
    return result


@router.get("/evaluations/{evaluation_id}/annotations/runs/{run_id}/actions/{action_index}")
async def get_action_annotation(evaluation_id: str, run_id: str, action_index: int):
    ann = await db.get_action_annotation(evaluation_id, run_id, action_index)
    if not ann:
        raise HTTPException(404, "Action annotation not found")
    return ann


@router.get("/evaluations/{evaluation_id}/annotations/actions")
async def list_action_annotations(evaluation_id: str, run_id: Optional[str] = None):
    return await db.list_action_annotations(evaluation_id, run_id)


@router.delete("/evaluations/{evaluation_id}/annotations/runs/{run_id}/actions/{action_index}", status_code=204)
async def delete_action_annotation(evaluation_id: str, run_id: str, action_index: int):
    if not await db.delete_action_annotation(evaluation_id, run_id, action_index):
        raise HTTPException(404, "Action annotation not found")


@router.delete("/evaluations/{evaluation_id}/annotations/all", status_code=204)
async def clear_all_annotations(evaluation_id: str):
    """Delete ALL run and action annotations for an evaluation."""
    await db.clear_all_annotations(evaluation_id)


@router.get("/evaluations/{evaluation_id}/annotations/summary")
async def get_annotation_summary(evaluation_id: str):
    return await db.get_annotation_summary(evaluation_id)


# ============================================================================
# Prompt Management
# ============================================================================

@router.post("/agents/{agent_id}/prompts", response_model=AgentPrompt, status_code=201)
async def create_agent_prompt(agent_id: str, request: CreatePromptRequest):
    """Create a new prompt version for an agent."""
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")

    next_version = await db.get_next_prompt_version(agent_id)
    prompt = AgentPrompt(
        agent_id=agent_id,
        system_prompt=request.system_prompt,
        version=next_version,
        notes=request.notes,
        is_active=(next_version == 1)  # First prompt is auto-active
    )
    saved = await db.create_agent_prompt(prompt)
    if next_version == 1:
        await db.set_active_prompt(agent_id, 1)
    return saved


@router.get("/agents/{agent_id}/prompts", response_model=List[AgentPrompt])
async def list_agent_prompts(agent_id: str):
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")
    return await db.list_agent_prompts(agent_id)


@router.get("/agents/{agent_id}/prompts/active", response_model=AgentPrompt)
async def get_active_prompt(agent_id: str):
    prompt = await db.get_active_prompt(agent_id)
    if not prompt:
        raise HTTPException(404, f"No active prompt for agent '{agent_id}'")
    return prompt


@router.put("/agents/{agent_id}/prompts/{version}/activate", response_model=AgentPrompt)
async def activate_prompt(agent_id: str, version: int):
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")
    success = await db.set_active_prompt(agent_id, version)
    if not success:
        raise HTTPException(404, f"Prompt version {version} not found for agent '{agent_id}'")
    return await db.get_agent_prompt(agent_id, version)


# ============================================================================
# LLM Configuration
# ============================================================================

@router.get("/config/llm")
async def get_llm_config():
    """Return current LLM configuration for display in the UI."""
    from . import config as cfg
    return {
        "model": cfg.LLM_MODEL,
        "base_url": cfg.LLM_BASE_URL,
        "agent_model": cfg.AGENT_LLM_MODEL,
        "agent_base_url": cfg.AGENT_LLM_BASE_URL,
    }


# ============================================================================
# System Prompts (Feature: configurable-prompts)
# ============================================================================

@router.get("/system-prompts")
async def list_system_prompts():
    """List all configurable system prompts."""
    return await db.list_system_prompts()

@router.get("/system-prompts/{key}")
async def get_system_prompt(key: str):
    """Get a specific system prompt by key."""
    result = await db.get_system_prompt(key)
    if not result:
        raise HTTPException(status_code=404, detail=f"System prompt '{key}' not found")
    return result

@router.put("/system-prompts/{key}")
async def update_system_prompt(key: str, body: dict = Body(...)):
    """Update a system prompt's content (and optionally name/description)."""
    existing = await db.get_system_prompt(key)
    if not existing:
        raise HTTPException(status_code=404, detail=f"System prompt '{key}' not found")
    name = body.get("name", existing["name"])
    description = body.get("description", existing["description"])
    content = body.get("content", existing["content"])
    return await db.upsert_system_prompt(key, name, description, content)


# ============================================================================
# Judge Configurations
# ============================================================================

@router.post("/judge-configs", status_code=201)
async def create_judge_config(request: JudgeConfigCreate):
    """Create a new judge config (or new version of an existing one, keyed by name)."""
    try:
        # Use name-based ID so repeated saves of same name create new versions
        config_id = request.name.lower().replace(" ", "_")
        next_version = await db.get_next_judge_config_version(config_id)
        config = JudgeConfig(
            id=config_id,
            name=request.name,
            version=next_version,
            system_prompt=request.system_prompt,
            user_prompt_template_batched=request.user_prompt_template_batched,
            user_prompt_template_single=request.user_prompt_template_single,
            rubric=request.rubric,
            scoring_mode=request.scoring_mode,
            pass_threshold=request.pass_threshold,
            notes=request.notes,
            is_active=(next_version == 1),  # Auto-activate first version
        )
        saved = await db.create_judge_config(config)
        if next_version == 1:
            await db.set_active_judge_config(config_id, 1)
            saved['is_active'] = True
        return saved
    except Exception as e:
        logger.error(f"Failed to create judge config: {e}")
        raise HTTPException(500, f"Failed to create judge config: {str(e)}")


@router.get("/judge-configs")
async def list_judge_configs():
    """List all judge configs (all versions), newest first."""
    return await db.list_judge_configs()


@router.get("/judge-configs/active")
async def get_active_judge_config():
    """Get the currently active judge config, or null if none."""
    return await db.get_active_judge_config()


@router.get("/judge-configs/{config_id}/versions")
async def list_judge_config_versions(config_id: str):
    """List all versions of a specific judge config."""
    versions = await db.list_judge_config_versions(config_id)
    if not versions:
        raise HTTPException(404, f"Judge config '{config_id}' not found")
    return versions


@router.get("/judge-configs/{config_id}/{version}")
async def get_judge_config(config_id: str, version: int):
    """Get a specific judge config version."""
    config = await db.get_judge_config(config_id, version)
    if not config:
        raise HTTPException(404, f"Judge config '{config_id}' v{version} not found")
    return config


@router.put("/judge-configs/{config_id}/{version}/activate")
async def activate_judge_config(config_id: str, version: int):
    """Activate a specific judge config version (deactivates all others globally)."""
    success = await db.set_active_judge_config(config_id, version)
    if not success:
        raise HTTPException(404, f"Judge config '{config_id}' v{version} not found")
    return await db.get_judge_config(config_id, version)


@router.delete("/judge-configs/{config_id}/{version}", status_code=204)
async def delete_judge_config(config_id: str, version: int):
    """Delete a specific judge config version. Cannot delete the active version."""
    success = await db.delete_judge_config(config_id, version)
    if not success:
        raise HTTPException(404, "Judge config not found or is currently active")
    return None


# ============================================================================
# Prompt Proposals
# ============================================================================

@router.post("/agents/{agent_id}/proposals/generate", response_model=List[PromptProposal])
async def generate_proposals(agent_id: str, request: GenerateProposalsRequest = None):
    """Generate AI-powered prompt improvement proposals from annotation data."""
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")
    try:
        proposals = await evaluator.generate_prompt_proposals(agent_id, request.evaluation_ids if request else None)
        return proposals
    except Exception as e:
        raise HTTPException(500, f"Failed to generate proposals: {str(e)}")


async def _run_generation_task(job: _GenerationJob, evaluation_ids, judge_rubric, include_reasoning):
    """Background task that runs the LLM proposal generation.

    Pushes each proposal (or error/done sentinel) onto job.queue so that
    any connected SSE consumer can read them. Also saves proposals to DB
    (handled by the evaluator).  Survives SSE disconnects — the task keeps
    running even if no client is listening.
    """
    try:
        async for proposal in evaluator.generate_prompt_proposals_stream(
            job.agent_id,
            evaluation_ids,
            judge_rubric=judge_rubric,
            include_reasoning=include_reasoning,
        ):
            # Check cancellation
            if job.cancel_event.is_set():
                logger.info(f"Generation task cancelled for agent {job.agent_id} after {job.proposals_generated} proposals")
                break

            if isinstance(proposal, dict) and proposal.get("_error"):
                job.errors.append(proposal.get("message", "Unknown error"))
                await job.queue.put({"_type": "error", "pattern": proposal.get("pattern"), "message": proposal.get("message")})
            else:
                proposal_data = proposal if isinstance(proposal, dict) else proposal.dict() if hasattr(proposal, 'dict') else proposal
                job.proposals_generated += 1
                logger.info(f"Generation task: proposal {job.proposals_generated} for agent {job.agent_id}: {proposal_data.get('title', '?')}")
                await job.queue.put({"_type": "proposal", "data": proposal_data})

    except Exception as e:
        logger.error(f"Generation task error for agent {job.agent_id}: {e}", exc_info=True)
        await job.queue.put({"_type": "fatal_error", "message": str(e)})
    finally:
        job.completed = True
        await job.queue.put({"_type": "done", "total": job.proposals_generated, "errors": job.errors,
                             "cancelled": job.cancel_event.is_set()})
        _active_proposal_generations.pop(job.agent_id, None)
        logger.info(f"Generation task finished for agent {job.agent_id}: {job.proposals_generated} proposals, {len(job.errors)} errors")


@router.post("/agents/{agent_id}/proposals/generate/stream")
async def generate_proposals_stream(agent_id: str, request: GenerateProposalsRequest = None):
    """Stream AI-powered prompt improvement proposals via SSE.

    The actual generation runs as a background asyncio.Task so it survives
    page refreshes. The SSE stream reads from a shared queue. Multiple calls
    while a job is already running will attach to the existing job's queue.
    """
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")

    # If a job is already running for this agent, attach to it
    existing = _active_proposal_generations.get(agent_id)
    if existing and not existing.completed:
        job = existing
    else:
        # Start a new background generation task
        job = _GenerationJob(
            agent_id=agent_id,
            cancel_event=asyncio.Event(),
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        _active_proposal_generations[agent_id] = job
        job.task = asyncio.create_task(_run_generation_task(
            job,
            evaluation_ids=request.evaluation_ids if request else None,
            judge_rubric=request.judge_rubric if request else None,
            include_reasoning=request.include_reasoning if request else False,
        ))

    async def event_generator():
        try:
            yield f"data: {json.dumps({'status': 'analyzing', 'message': 'Analyzing annotation patterns...'})}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(job.queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    # Send keepalive so the connection doesn't drop
                    yield f"data: {json.dumps({'status': 'keepalive', 'proposals_so_far': job.proposals_generated})}\n\n"
                    continue

                if msg["_type"] == "proposal":
                    yield f"data: {json.dumps(msg['data'], default=str)}\n\n"
                elif msg["_type"] == "error":
                    yield f"data: {json.dumps({'status': 'llm_error', 'pattern': msg.get('pattern'), 'message': msg.get('message')})}\n\n"
                elif msg["_type"] == "fatal_error":
                    yield f"data: {json.dumps({'error': msg['message']})}\n\n"
                elif msg["_type"] == "done":
                    yield f"data: {json.dumps({'done': True, 'total': msg['total'], 'errors': msg.get('errors', []), 'cancelled': msg.get('cancelled', False)})}\n\n"
                    return
        except asyncio.CancelledError:
            logger.info(f"SSE consumer disconnected for agent {agent_id} — background task continues")
        except Exception as e:
            logger.error(f"SSE event_generator error for agent {agent_id}: {e}", exc_info=True)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/agents/{agent_id}/proposals/generate/status")
async def get_generation_status(agent_id: str):
    """Check if proposal generation is running for this agent.

    Returns the job state so the frontend can show progress after a page
    refresh and offer the cancel button.
    """
    job = _active_proposal_generations.get(agent_id)
    if job and not job.completed:
        return {
            "active": True,
            "agent_id": agent_id,
            "started_at": job.started_at,
            "proposals_generated": job.proposals_generated,
            "errors": job.errors,
        }
    return {"active": False, "agent_id": agent_id}


@router.delete("/agents/{agent_id}/proposals/generate")
async def cancel_proposal_generation(agent_id: str):
    """Cancel an active proposal generation for the given agent."""
    job = _active_proposal_generations.get(agent_id)
    if job and not job.completed:
        job.cancel_event.set()
        logger.info(f"Cancelled proposal generation for agent {agent_id}")
        return {"cancelled": True, "agent_id": agent_id}
    return {"cancelled": False, "agent_id": agent_id, "message": "No active generation found"}


@router.get("/agents/{agent_id}/proposals", response_model=List[PromptProposal])
async def list_proposals(agent_id: str, status: Optional[str] = None):
    return await db.list_proposals(agent_id, status)


@router.post("/agents/{agent_id}/proposals/{proposal_id}/apply", response_model=AgentPrompt)
async def apply_proposal(agent_id: str, proposal_id: str):
    """Apply a proposal — creates a new prompt version with the proposed changes."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal or proposal.get("agent_id") != agent_id:
        raise HTTPException(404, "Proposal not found")
    if proposal.get("status") != "pending":
        raise HTTPException(400, f"Proposal is already '{proposal.get('status')}'")

    # Get the current active prompt
    active_prompt = await db.get_active_prompt(agent_id)
    if not active_prompt:
        raise HTTPException(400, "No active prompt to apply changes to")

    # Build new prompt text from diff
    new_prompt_text = active_prompt.get("system_prompt", "")
    diff = proposal.get("diff", {})
    if diff:
        for line in diff.get("removed", []):
            new_prompt_text = new_prompt_text.replace(line, "")
        for line in diff.get("added", []):
            new_prompt_text = new_prompt_text.rstrip() + "\n" + line

    # Create new prompt version
    next_version = await db.get_next_prompt_version(agent_id)
    new_prompt = AgentPrompt(
        agent_id=agent_id,
        system_prompt=new_prompt_text.strip(),
        version=next_version,
        notes=f"Applied proposal: {proposal.get('title', 'Unknown')}",
        is_active=True
    )
    saved = await db.create_agent_prompt(new_prompt)
    await db.set_active_prompt(agent_id, next_version)

    # Mark proposal as applied
    await db.update_proposal_status(proposal_id, "applied")
    return saved


@router.post("/agents/{agent_id}/proposals/{proposal_id}/test", status_code=201)
async def test_proposal(agent_id: str, proposal_id: str, background_tasks: BackgroundTasks):
    """Test a proposal by running an evaluation with the proposed prompt changes."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal or proposal.get("agent_id") != agent_id:
        raise HTTPException(404, "Proposal not found")

    active_prompt = await db.get_active_prompt(agent_id)
    if not active_prompt:
        raise HTTPException(400, "No active prompt found")

    # Build test prompt
    test_prompt_text = active_prompt.get("system_prompt", "")
    diff = proposal.get("diff", {})
    if diff:
        for line in diff.get("removed", []):
            test_prompt_text = test_prompt_text.replace(line, "")
        for line in diff.get("added", []):
            test_prompt_text = test_prompt_text.rstrip() + "\n" + line

    # Find the most recent evaluation for this agent to get dataset/endpoint
    evals = await evaluator.list_evaluation_runs(agent_id=agent_id, limit=1)
    if not evals:
        raise HTTPException(400, "No previous evaluations found to base test on")

    last_eval = evals[0]
    agent = await db.get_agent(agent_id)

    eval_request = EvaluationRunCreate(
        name=f"Proposal Test: {proposal.get('title', 'Unknown')}",
        dataset_id=last_eval.dataset_id,
        agent_id=agent_id,
        agent_endpoint=agent.agent_invocation_url,
    )
    eval_run = await evaluator.create_evaluation_run(eval_request)

    # Store the custom prompt info for use during execution
    eval_run.status_message = f"Testing proposal: {proposal.get('title', 'Unknown')}"
    await db.update_evaluation_run(eval_run)

    background_tasks.add_task(evaluator.start_evaluation_with_prompt, eval_run.id, test_prompt_text)

    return {"evaluation_id": eval_run.id, "proposal_id": proposal_id}


@router.patch("/agents/{agent_id}/proposals/{proposal_id}")
async def update_proposal(agent_id: str, proposal_id: str, body: dict = Body(...)):
    """Update proposal status (dismiss/reject)."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal or proposal.get("agent_id") != agent_id:
        raise HTTPException(404, "Proposal not found")
    new_status = body.get("status", "dismissed")
    await db.update_proposal_status(proposal_id, new_status)
    return {"status": new_status}


@router.delete("/agents/{agent_id}/proposals/{proposal_id}")
async def delete_proposal(agent_id: str, proposal_id: str):
    """Delete a proposal permanently."""
    proposal = await db.get_proposal(proposal_id)
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    await db.delete_proposal(proposal_id)
    return {"deleted": True}


@router.delete("/agents/{agent_id}/proposals")
async def delete_all_proposals(agent_id: str, prompt_version: Optional[int] = None):
    """Delete all proposals for an agent, optionally filtered by prompt version."""
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{agent_id}' not found")
    deleted_count = await db.delete_proposals_bulk(agent_id, prompt_version)
    return {"deleted": deleted_count}


# ============================================================================
# Analytics
# ============================================================================

def _filter_evals_by_time(evals, days: int = 0, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Shared time-window filter for evaluation lists."""
    from datetime import datetime, timedelta

    def _parse_dt(val):
        if isinstance(val, str):
            try:
                return datetime.fromisoformat(val.replace("Z", "+00:00")).replace(tzinfo=None)
            except Exception:
                return None
        elif hasattr(val, 'replace'):
            return val.replace(tzinfo=None)
        return None

    if from_date or to_date:
        fd = _parse_dt(from_date) if from_date else None
        td = _parse_dt(to_date) if to_date else None
        return [e for e in evals if (
            (fd is None or (_parse_dt(e.created_at) or datetime.min) >= fd) and
            (td is None or (_parse_dt(e.created_at) or datetime.max) <= td)
        )]
    elif hours > 0:
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        return [e for e in evals if (_parse_dt(e.created_at) or datetime.min) >= cutoff]
    elif days > 0:
        cutoff = datetime.utcnow() - timedelta(days=days)
        return [e for e in evals if (_parse_dt(e.created_at) or datetime.min) >= cutoff]
    return evals


@router.get("/analytics/dashboard")
async def get_dashboard_stats(agent_id: Optional[str] = None, days: int = 0, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Get aggregated dashboard statistics."""
    agents = await db.list_agents(limit=1000)
    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)

    completed_evals = [e for e in evals if e.status.value == "completed"]

    total_pass_rate = 0
    if completed_evals:
        rates = [(e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0 for e in completed_evals]
        total_pass_rate = sum(rates) / len(rates)

    # Annotation coverage
    total_annotated = 0
    total_runs = 0
    for e in completed_evals:
        summary = await db.get_annotation_summary(e.id)
        total_annotated += summary.get("annotated_runs", 0) if isinstance(summary, dict) else summary.annotated_runs
        total_runs += summary.get("total_runs", 0) if isinstance(summary, dict) else summary.total_runs

    annotation_coverage = (total_annotated / total_runs * 100) if total_runs > 0 else 0

    # Agent leaderboard
    agent_stats = []
    for agent in agents:
        agent_evals = [e for e in completed_evals if e.agent_id == agent.id]
        if agent_evals:
            avg_pass = sum((e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0 for e in agent_evals) / len(agent_evals)
            agent_stats.append({
                "agent_id": agent.id,
                "agent_name": agent.name,
                "eval_count": len(agent_evals),
                "avg_pass_rate": round(avg_pass, 1),
                "latest_pass_rate": round((agent_evals[-1].passed_count / agent_evals[-1].total_tests * 100) if agent_evals[-1].total_tests > 0 else 0, 1)
            })

    agent_stats.sort(key=lambda x: x["avg_pass_rate"], reverse=True)

    # Recent evaluations
    recent = sorted(evals, key=lambda e: e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat(), reverse=True)[:10]
    recent_data = []
    for e in recent:
        agent = next((a for a in agents if a.id == e.agent_id), None)
        recent_data.append({
            "id": e.id,
            "name": e.name,
            "agent_name": agent.name if agent else "Unknown",
            "status": e.status.value if hasattr(e.status, 'value') else e.status,
            "pass_rate": round((e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0, 1),
            "total_tests": e.total_tests,
            "created_at": e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat()
        })

    return {
        "total_evaluations": len(evals),
        "completed_evaluations": len(completed_evals),
        "total_agents": len(agents),
        "avg_pass_rate": round(total_pass_rate, 1),
        "annotation_coverage": round(annotation_coverage, 1),
        "agent_leaderboard": agent_stats,
        "recent_evaluations": recent_data
    }


@router.get("/analytics/trends")
async def get_pass_rate_trends(agent_id: Optional[str] = None, days: int = 30, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Get pass rate trends over time."""
    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)
    completed_evals = [e for e in evals if e.status.value == "completed"]

    # Group by date
    from collections import defaultdict
    daily = defaultdict(list)
    for e in completed_evals:
        created = e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat()
        date_str = created[:10]  # YYYY-MM-DD
        pass_rate = (e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0
        daily[date_str].append(pass_rate)

    trends = []
    for date_str in sorted(daily.keys()):
        rates = daily[date_str]
        trends.append({
            "date": date_str,
            "avg_pass_rate": round(sum(rates) / len(rates), 1),
            "eval_count": len(rates),
            "min_pass_rate": round(min(rates), 1),
            "max_pass_rate": round(max(rates), 1)
        })

    return trends


@router.get("/analytics/failure-patterns")
async def get_failure_patterns(agent_id: Optional[str] = None):
    """Get failure pattern analysis from annotations."""
    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    completed_evals = [e for e in evals if e.status.value == "completed"]

    from collections import Counter
    issue_counter = Counter()
    correctness_counter = Counter()
    total_annotations = 0

    for e in completed_evals:
        run_anns = await db.list_run_annotations(e.id)
        for ann in run_anns:
            total_annotations += 1
            issues = ann.get("issues", []) if isinstance(ann, dict) else ann.issues
            for issue in issues:
                issue_counter[issue] += 1

        action_anns = await db.list_action_annotations(e.id)
        for ann in action_anns:
            correctness = ann.get("correctness") if isinstance(ann, dict) else ann.correctness
            if correctness:
                correctness_counter[correctness] += 1

    return {
        "issue_tags": [{"tag": tag, "count": count} for tag, count in issue_counter.most_common(20)],
        "correctness_distribution": dict(correctness_counter),
        "total_annotations": total_annotations
    }


@router.get("/analytics/latency")
async def get_latency_stats(agent_id: Optional[str] = None):
    """Get latency / duration breakdown across evaluations."""
    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    completed = [e for e in evals if e.status.value == "completed"]

    agent_durations = []   # (agent_call_sec, judge_call_sec, total_sec)
    per_eval = []

    for e in completed:
        for tc in (e.test_cases or []):
            agent_d = getattr(tc, 'agent_call_duration_seconds', None) or (tc.get('agent_call_duration_seconds') if isinstance(tc, dict) else None)
            judge_d = getattr(tc, 'judge_call_duration_seconds', None) or (tc.get('judge_call_duration_seconds') if isinstance(tc, dict) else None)
            total_d = getattr(tc, 'total_duration_seconds', None) or (tc.get('total_duration_seconds') if isinstance(tc, dict) else None)
            if total_d is not None:
                agent_durations.append({
                    "agent": agent_d or 0,
                    "judge": judge_d or 0,
                    "total": total_d
                })

        # Per-eval summary
        started = getattr(e, 'started_at', None)
        completed_at = getattr(e, 'completed_at', None)
        if started and completed_at:
            from datetime import datetime
            try:
                s = datetime.fromisoformat(started if isinstance(started, str) else started.isoformat())
                c = datetime.fromisoformat(completed_at if isinstance(completed_at, str) else completed_at.isoformat())
                wall = (c - s).total_seconds()
            except Exception:
                wall = None
        else:
            wall = None

        agents_list = await db.list_agents(limit=1000)
        agent_obj = next((a for a in agents_list if a.id == e.agent_id), None)
        per_eval.append({
            "eval_id": e.id,
            "eval_name": e.name,
            "agent_name": agent_obj.name if agent_obj else "Unknown",
            "total_tests": e.total_tests,
            "wall_seconds": round(wall, 1) if wall else None,
            "rate_limit_hits": getattr(e, 'total_rate_limit_hits', 0) or 0,
            "retry_wait_seconds": round(getattr(e, 'total_retry_wait_seconds', 0) or 0, 1),
        })

    # Compute percentiles
    totals = sorted([d["total"] for d in agent_durations]) if agent_durations else []

    def percentile(arr, p):
        if not arr:
            return 0
        k = (len(arr) - 1) * p / 100
        f = int(k)
        c = f + 1 if f + 1 < len(arr) else f
        return round(arr[f] + (arr[c] - arr[f]) * (k - f), 2)

    return {
        "test_count": len(agent_durations),
        "p50": percentile(totals, 50),
        "p95": percentile(totals, 95),
        "p99": percentile(totals, 99),
        "avg_agent_call": round(sum(d["agent"] for d in agent_durations) / len(agent_durations), 2) if agent_durations else 0,
        "avg_judge_call": round(sum(d["judge"] for d in agent_durations) / len(agent_durations), 2) if agent_durations else 0,
        "per_eval": per_eval
    }


@router.get("/analytics/tool-usage")
async def get_tool_usage_stats(agent_id: Optional[str] = None):
    """Analyse tool call patterns across evaluations."""
    from collections import Counter, defaultdict
    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    completed = [e for e in evals if e.status.value == "completed"]

    tool_calls_counter = Counter()     # tool_name → total calls
    tool_success = defaultdict(lambda: {"pass": 0, "fail": 0})  # tool → pass/fail of owning test
    calls_per_test = {"passed": [], "failed": []}
    tests_with_errors = 0
    total_tests = 0

    for e in completed:
        for tc in (e.test_cases or []):
            passed = tc.get("passed") if isinstance(tc, dict) else getattr(tc, 'passed', False)
            actual_calls = tc.get("actual_tool_calls") if isinstance(tc, dict) else getattr(tc, 'actual_tool_calls', [])
            exec_error = tc.get("execution_error") if isinstance(tc, dict) else getattr(tc, 'execution_error', None)
            total_tests += 1
            if exec_error:
                tests_with_errors += 1

            num_calls = len(actual_calls) if actual_calls else 0
            bucket = "passed" if passed else "failed"
            calls_per_test[bucket].append(num_calls)

            for call in (actual_calls or []):
                name = call.get("name") if isinstance(call, dict) else getattr(call, 'name', 'unknown')
                tool_calls_counter[name] += 1
                if passed:
                    tool_success[name]["pass"] += 1
                else:
                    tool_success[name]["fail"] += 1

    # Build tool table
    tool_table = []
    for name, count in tool_calls_counter.most_common(20):
        s = tool_success[name]
        total = s["pass"] + s["fail"]
        tool_table.append({
            "tool": name,
            "total_calls": count,
            "in_passing_tests": s["pass"],
            "in_failing_tests": s["fail"],
            "success_rate": round(s["pass"] / total * 100, 1) if total > 0 else 0,
        })

    avg_calls_pass = round(sum(calls_per_test["passed"]) / len(calls_per_test["passed"]), 1) if calls_per_test["passed"] else 0
    avg_calls_fail = round(sum(calls_per_test["failed"]) / len(calls_per_test["failed"]), 1) if calls_per_test["failed"] else 0

    return {
        "tools": tool_table,
        "avg_calls_passing": avg_calls_pass,
        "avg_calls_failing": avg_calls_fail,
        "total_tests": total_tests,
        "tests_with_errors": tests_with_errors,
        "error_rate": round(tests_with_errors / total_tests * 100, 1) if total_tests > 0 else 0,
    }


@router.get("/analytics/per-agent")
async def get_per_agent_stats():
    """Get detailed per-agent metrics for comparison."""
    agents = await db.list_agents(limit=1000)
    evals = await evaluator.list_evaluation_runs(limit=1000)
    completed = [e for e in evals if e.status.value == "completed"]

    result = []
    for agent in agents:
        agent_evals = [e for e in completed if e.agent_id == agent.id]
        if not agent_evals:
            continue

        rates = [(e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0 for e in agent_evals]
        total_tests = sum(e.total_tests for e in agent_evals)
        total_passed = sum(e.passed_count for e in agent_evals)

        # Regression count
        total_regressions = 0
        for e in agent_evals:
            regs = getattr(e, 'regressions', None) or (e.get('regressions') if isinstance(e, dict) else None)
            if regs:
                total_regressions += len(regs)

        # Latest trend (last 3 evals)
        sorted_evals = sorted(agent_evals, key=lambda x: x.created_at if isinstance(x.created_at, str) else x.created_at.isoformat())
        recent_rates = [(e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0 for e in sorted_evals[-3:]]
        if len(recent_rates) >= 2:
            trend = "improving" if recent_rates[-1] > recent_rates[0] else ("declining" if recent_rates[-1] < recent_rates[0] else "stable")
        else:
            trend = "stable"

        result.append({
            "agent_id": agent.id,
            "agent_name": agent.name,
            "model": getattr(agent, 'model', None) or "unknown",
            "eval_count": len(agent_evals),
            "total_tests_run": total_tests,
            "total_passed": total_passed,
            "avg_pass_rate": round(sum(rates) / len(rates), 1),
            "best_pass_rate": round(max(rates), 1),
            "worst_pass_rate": round(min(rates), 1),
            "latest_pass_rate": round(rates[-1], 1) if rates else 0,
            "trend": trend,
            "regressions": total_regressions,
            "recent_rates": [round(r, 1) for r in recent_rates],
        })

    result.sort(key=lambda x: x["avg_pass_rate"], reverse=True)
    return result


@router.get("/analytics/prompt-performance")
async def get_prompt_performance(agent_id: Optional[str] = None, days: int = 0, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Get pass-rate per prompt version over time, for each agent.

    Returns a structure optimised for multi-series line charts:
    {
        agents: [
            {
                agent_id, agent_name,
                versions: [
                    {
                        version, notes, is_active,
                        evals: [ { eval_id, date, pass_rate, total_tests, passed } ]
                    }
                ]
            }
        ]
    }
    """
    from collections import defaultdict

    agents_list = await db.list_agents(limit=1000)
    target_agents = [a for a in agents_list if agent_id is None or a.id == agent_id]

    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)
    completed = [e for e in evals if e.status.value == "completed"]

    out = []
    for agent in target_agents:
        agent_evals = sorted(
            [e for e in completed if e.agent_id == agent.id],
            key=lambda x: x.created_at if isinstance(x.created_at, str) else x.created_at.isoformat()
        )
        if not agent_evals:
            continue

        prompts = await db.list_agent_prompts(agent.id)
        prompt_map = {p.get("version", p.get("prompt_version")): p for p in prompts}

        # Group evals by prompt_version
        version_evals = defaultdict(list)
        for e in agent_evals:
            pv = getattr(e, 'prompt_version', None) or (e.get('prompt_version') if isinstance(e, dict) else None)
            if pv is None:
                pv = 0  # legacy evals without prompt tracking
            pass_rate = round((e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0, 1)
            created = e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat()
            version_evals[pv].append({
                "eval_id": e.id,
                "date": created[:10],
                "datetime": created,
                "pass_rate": pass_rate,
                "total_tests": e.total_tests,
                "passed": e.passed_count,
            })

        versions_out = []
        for v in sorted(version_evals.keys()):
            p = prompt_map.get(v, {})
            versions_out.append({
                "version": v,
                "notes": p.get("notes", ""),
                "is_active": p.get("is_active", False),
                "evals": version_evals[v],
            })

        out.append({
            "agent_id": agent.id,
            "agent_name": agent.name,
            "versions": versions_out,
        })

    return {"agents": out}


@router.get("/analytics/model-performance")
async def get_model_performance(agent_id: Optional[str] = None, days: int = 0, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Get pass-rate per model over time, for each agent.

    Returns a structure optimized for model comparison:
    {
        agents: [
            {
                agent_id, agent_name,
                models: [
                    {
                        model,
                        evals: [ { eval_id, date, pass_rate, total_tests, passed, prompt_version } ]
                    }
                ]
            }
        ]
    }
    """
    from collections import defaultdict

    agents_list = await db.list_agents(limit=1000)
    target_agents = [a for a in agents_list if agent_id is None or a.id == agent_id]

    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)
    completed = [e for e in evals if e.status.value == "completed"]

    out = []
    for agent in target_agents:
        agent_evals = sorted(
            [e for e in completed if e.agent_id == agent.id],
            key=lambda x: x.created_at if isinstance(x.created_at, str) else x.created_at.isoformat()
        )
        if not agent_evals:
            continue

        # Group evals by model
        model_evals = defaultdict(list)
        for e in agent_evals:
            model = getattr(e, 'agent_model', None) or (e.get('agent_model') if isinstance(e, dict) else None)
            if model is None:
                model = "unknown"  # legacy evals without model tracking
            pass_rate = round((e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0, 1)
            created = e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat()
            prompt_version = getattr(e, 'prompt_version', None) or (e.get('prompt_version') if isinstance(e, dict) else None)
            model_evals[model].append({
                "eval_id": e.id,
                "date": created[:10],
                "datetime": created,
                "pass_rate": pass_rate,
                "total_tests": e.total_tests,
                "passed": e.passed_count,
                "prompt_version": prompt_version,
            })

        models_out = []
        for model in sorted(model_evals.keys()):
            models_out.append({
                "model": model,
                "evals": model_evals[model],
            })

        out.append({
            "agent_id": agent.id,
            "agent_name": agent.name,
            "models": models_out,
        })

    return {"agents": out}


@router.get("/analytics/test-stability")
async def get_test_stability(agent_id: Optional[str] = None, days: int = 0, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Compute per-test-case stability across evaluations.

    Returns:
    {
        tests: [
            {
                testcase_id, testcase_name, dataset_name,
                total_runs, pass_count, fail_count,
                pass_rate, stability (solid|flaky|broken),
                history: [ { eval_id, eval_name, date, passed } ]  (last N)
            }
        ],
        eval_columns: [ { eval_id, eval_name, date } ]  (for heatmap columns)
    }
    """
    from collections import defaultdict

    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)
    completed = sorted(
        [e for e in evals if e.status.value == "completed"],
        key=lambda x: x.created_at if isinstance(x.created_at, str) else x.created_at.isoformat()
    )

    # Collect all test case results
    tc_results = defaultdict(list)   # testcase_id → list of {eval_id, passed, date}
    eval_columns = []
    datasets_cache = {}

    for e in completed:
        created = e.created_at if isinstance(e.created_at, str) else e.created_at.isoformat()
        eval_columns.append({
            "eval_id": e.id,
            "eval_name": e.name,
            "date": created[:10],
        })
        for tc in (e.test_cases or []):
            tc_id = tc.get("testcase_id") if isinstance(tc, dict) else getattr(tc, 'testcase_id', None)
            passed = tc.get("passed") if isinstance(tc, dict) else getattr(tc, 'passed', None)
            if tc_id:
                tc_results[tc_id].append({
                    "eval_id": e.id,
                    "eval_name": e.name,
                    "date": created[:10],
                    "passed": bool(passed) if passed is not None else None,
                })

    # Resolve test case names
    tests_out = []
    for tc_id, results in tc_results.items():
        total = len(results)
        passes = sum(1 for r in results if r["passed"] is True)
        fails = sum(1 for r in results if r["passed"] is False)
        rate = round(passes / total * 100, 1) if total > 0 else 0

        # Classify stability
        if rate >= 90:
            stability = "solid"
        elif rate <= 20:
            stability = "broken"
        else:
            stability = "flaky"

        # Try to get a name
        tc_name = tc_id
        try:
            tc_obj = await db.get_testcase_by_id(tc_id)
            if tc_obj:
                tc_name = tc_obj.name if hasattr(tc_obj, 'name') else tc_id
                ds_id = tc_obj.dataset_id if hasattr(tc_obj, 'dataset_id') else None
                if ds_id and ds_id not in datasets_cache:
                    ds = await db.get_dataset(ds_id)
                    if ds:
                        ds_name = ds.seed.name if hasattr(ds, 'seed') else ds_id
                        datasets_cache[ds_id] = ds_name
        except Exception:
            pass

        tests_out.append({
            "testcase_id": tc_id,
            "testcase_name": tc_name,
            "total_runs": total,
            "pass_count": passes,
            "fail_count": fails,
            "pass_rate": rate,
            "stability": stability,
            "history": results[-20:],  # cap at last 20 for the heatmap
        })

    # Sort: broken first, then flaky, then solid
    order = {"broken": 0, "flaky": 1, "solid": 2}
    tests_out.sort(key=lambda t: (order.get(t["stability"], 3), t["pass_rate"]))

    return {
        "tests": tests_out,
        "eval_columns": eval_columns[-20:],  # last 20 evals for the heatmap
    }


@router.get("/analytics/eval-velocity")
async def get_eval_velocity(agent_id: Optional[str] = None, days: int = 90, hours: int = 0, from_date: Optional[str] = None, to_date: Optional[str] = None):
    """Get evaluation velocity: how many evals per week + quality trajectory.

    Returns weekly buckets with eval count, avg pass rate, cumulative tests run.
    """
    from collections import defaultdict
    from datetime import datetime as _dt, timedelta

    evals = await evaluator.list_evaluation_runs(limit=1000, agent_id=agent_id)
    evals = _filter_evals_by_time(evals, days=days, hours=hours, from_date=from_date, to_date=to_date)
    completed = [e for e in evals if e.status.value == "completed"]

    def _to_week(created):
        dt_str = created if isinstance(created, str) else created.isoformat()
        try:
            dt = _dt.fromisoformat(dt_str.replace("Z", "+00:00")).replace(tzinfo=None)
        except Exception:
            return None
        # ISO week start (Monday)
        start = dt - timedelta(days=dt.weekday())
        return start.strftime("%Y-%m-%d")

    weekly = defaultdict(lambda: {"eval_count": 0, "pass_rates": [], "tests_run": 0, "rate_limit_hits": 0})
    for e in completed:
        wk = _to_week(e.created_at)
        if wk is None:
            continue
        weekly[wk]["eval_count"] += 1
        weekly[wk]["tests_run"] += e.total_tests
        weekly[wk]["rate_limit_hits"] += getattr(e, 'total_rate_limit_hits', 0) or 0
        rate = (e.passed_count / e.total_tests * 100) if e.total_tests > 0 else 0
        weekly[wk]["pass_rates"].append(rate)

    # Fill in missing weeks to show continuous timeline
    if weekly:
        all_weeks = sorted(weekly.keys())
        start_week = _dt.strptime(all_weeks[0], "%Y-%m-%d")
        end_week = _dt.strptime(all_weeks[-1], "%Y-%m-%d")

        # Generate all weeks in the range
        current = start_week
        while current <= end_week:
            week_str = current.strftime("%Y-%m-%d")
            if week_str not in weekly:
                weekly[week_str] = {"eval_count": 0, "pass_rates": [], "tests_run": 0, "rate_limit_hits": 0}
            current += timedelta(days=7)

    result = []
    cumulative_tests = 0
    for wk in sorted(weekly.keys()):
        d = weekly[wk]
        cumulative_tests += d["tests_run"]
        result.append({
            "week": wk,
            "eval_count": d["eval_count"],
            "avg_pass_rate": round(sum(d["pass_rates"]) / len(d["pass_rates"]), 1) if d["pass_rates"] else 0,
            "tests_run": d["tests_run"],
            "cumulative_tests": cumulative_tests,
            "rate_limit_hits": d["rate_limit_hits"],
        })

    return result


# ============================================================================
# Admin: Reset All Data
# ============================================================================

@router.delete("/admin/reset", status_code=200)
async def reset_all_data():
    """Delete ALL data from ALL tables. Used before re-seeding demo data.

    Returns counts of deleted rows per table for confirmation.
    """
    try:
        counts = await db.reset_all_data()
        return {"reset": True, "deleted": counts}
    except Exception as e:
        raise HTTPException(500, f"Failed to reset data: {str(e)}")


@router.post("/admin/seed-demo", status_code=200)
async def seed_demo_data():
    """Populate the database with realistic supply-chain demo data.

    Called by the frontend Demo Mode toggle after clearing existing data.
    """
    try:
        from .seed_service import seed_demo_data as _seed
        summary = _seed()
        return {"seeded": True, "summary": summary}
    except Exception as e:
        raise HTTPException(500, f"Failed to seed demo data: {str(e)}")


# ============================================================================
# Re-evaluation
# ============================================================================

@router.post("/evaluations/{evaluation_id}/rerun", response_model=EvaluationRun, status_code=201)
async def rerun_evaluation(evaluation_id: str, background_tasks: BackgroundTasks):
    """Re-run an evaluation with the same configuration."""
    original = await evaluator.get_evaluation_run(evaluation_id)
    if not original:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")

    agent = await db.get_agent(original.agent_id)
    if not agent:
        raise HTTPException(400, "Original agent no longer exists")

    eval_request = EvaluationRunCreate(
        name=f"Rerun: {original.name}",
        dataset_id=original.dataset_id,
        agent_id=original.agent_id,
        agent_endpoint=agent.agent_invocation_url,
        timeout_seconds=original.timeout_seconds,
        verbose_logging=original.verbose_logging,
    )
    eval_run = await evaluator.create_evaluation_run(eval_request)
    background_tasks.add_task(evaluator.start_evaluation, eval_run.id)
    return eval_run


class RerunSelectedRequest(BaseModel):
    test_case_ids: List[str]


@router.post("/evaluations/{evaluation_id}/rerun-selected", response_model=EvaluationRun, status_code=201)
async def rerun_selected(evaluation_id: str, body: RerunSelectedRequest, background_tasks: BackgroundTasks):
    """Re-run specific test cases from a previous evaluation."""
    original = await evaluator.get_evaluation_run(evaluation_id)
    if not original:
        raise HTTPException(404, f"Evaluation '{evaluation_id}' not found")

    agent = await db.get_agent(original.agent_id)
    if not agent:
        raise HTTPException(400, "Original agent no longer exists")

    if not body.test_case_ids:
        raise HTTPException(400, "test_case_ids must not be empty")

    n = len(body.test_case_ids)
    eval_request = EvaluationRunCreate(
        name=f"Rerun ({n} test{'s' if n != 1 else ''}): {original.name}",
        dataset_id=original.dataset_id,
        agent_id=original.agent_id,
        agent_endpoint=agent.agent_invocation_url,
        timeout_seconds=original.timeout_seconds,
        verbose_logging=original.verbose_logging,
        prompt_version=original.prompt_version,
        prompt_id=original.prompt_id,
        judge_config_id=original.judge_config_id,
        judge_config_version=original.judge_config_version,
        agent_model=original.agent_model,
        test_case_ids=body.test_case_ids,
    )
    eval_run = await evaluator.create_evaluation_run(eval_request)
    background_tasks.add_task(evaluator.start_evaluation, eval_run.id)
    return eval_run


@router.post("/evaluations/run-with-prompt", status_code=201)
async def run_with_prompt(request: ReEvaluateRequest, background_tasks: BackgroundTasks):
    """Run an evaluation with a custom system prompt."""
    agent = await db.get_agent(request.agent_id)
    if not agent:
        raise HTTPException(404, f"Agent '{request.agent_id}' not found")

    dataset = await db.get_dataset(request.dataset_id)
    if not dataset:
        raise HTTPException(404, f"Dataset '{request.dataset_id}' not found")

    eval_request = EvaluationRunCreate(
        name=request.name or f"Custom prompt eval — {agent.name}",
        dataset_id=request.dataset_id,
        agent_id=request.agent_id,
        agent_endpoint=agent.agent_invocation_url,
        verbose_logging=request.verbose_logging,
    )
    eval_run = await evaluator.create_evaluation_run(eval_request)

    if request.custom_system_prompt:
        background_tasks.add_task(evaluator.start_evaluation_with_prompt, eval_run.id, request.custom_system_prompt)
    else:
        background_tasks.add_task(evaluator.start_evaluation, eval_run.id)

    return {"evaluation_id": eval_run.id}


# ============================================================================
# Telemetry Ingestion (Feature: online-evals)
# ============================================================================

@router.post("/telemetry/ingest", status_code=202)
async def ingest_telemetry(payload: TelemetryPayload, background_tasks: BackgroundTasks):
    """Accept and persist production telemetry with PII scanning."""
    import random
    import uuid
    from datetime import datetime, timezone, timedelta
    from . import config as cfg
    from .pii_detector import pii_detector

    agent = await db.get_agent(payload.agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent {payload.agent_id} not found")

    # Determine sampling rate
    sampling_rate = agent.sampling_rate or cfg.DEFAULT_SAMPLING_RATE

    # Check if the agent's default risk tier forces higher sampling
    if agent.default_risk_tier == "tier_1_critical":
        sampling_rate = cfg.TIER_1_SAMPLING_RATE

    # Apply sampling
    sampled = random.random() < sampling_rate

    if not sampled:
        logger.info(f"Telemetry rejected for {payload.agent_id} by sampling filter")
        return {
            "sampled": False,
            "reason": "Filtered by sampling policy",
            "agent_id": payload.agent_id,
            "trace_id": payload.trace_id
        }

    # Generate trace IDs
    trace_id = payload.trace_id or f"trace_{uuid.uuid4().hex[:16]}"

    # CRITICAL: PII Detection
    if cfg.ENABLE_PII_DETECTION:
        trace_dict = payload.model_dump()
        pii_results = pii_detector.scan_trace(trace_dict)
    else:
        pii_results = {
            'pii_detected': False,
            'pii_flags': [],
            'pii_scan_completed': False
        }

    # Calculate retention
    retention_days = cfg.PRODUCTION_TRACE_RETENTION_DAYS
    expires_at = (datetime.now(timezone.utc) + timedelta(days=retention_days)).isoformat()

    # Persist to production_traces table
    trace_data = {
        "id": f"trace_{uuid.uuid4().hex[:16]}",
        "agent_id": payload.agent_id,
        "trace_id": trace_id,
        "input": payload.input,
        "output": payload.output,
        "tool_calls": json.dumps(payload.tool_calls or []),
        "latency_ms": payload.latency_ms,
        "model": payload.model,
        "tokens_in": payload.tokens_in,
        "tokens_out": payload.tokens_out,
        "timestamp": payload.timestamp or datetime.now(timezone.utc).isoformat(),
        "metadata": json.dumps(payload.metadata or {}),
        "sampled": True,
        "status": "pending",
        "expires_at": expires_at,
        "pii_detected": pii_results['pii_detected'],
        "pii_flags": json.dumps(pii_results.get('pii_flags', [])),
        "pii_scan_completed": pii_results['pii_scan_completed']
    }

    await db.create_production_trace(trace_data)

    logger.info(f"Trace persisted: {trace_id}, PII detected: {pii_results['pii_detected']}")

    return {
        "sampled": True,
        "agent_id": payload.agent_id,
        "trace_id": trace_id,
        "pii_detected": pii_results['pii_detected'],
        "pii_flags": pii_results.get('pii_flags', []),
        "message": "Telemetry persisted for annotation workflow"
    }


# ============================================================================
# Production Trace Management (Feature: production-trace-support)
# ============================================================================

@router.get("/production-traces")
async def list_production_traces(
    agent_id: Optional[str] = None,
    status: Optional[str] = None,
    skip: int = 0,
    limit: int = 100
):
    """List production traces with optional filtering."""
    return await db.list_production_traces(agent_id=agent_id, status=status, skip=skip, limit=limit)


@router.get("/production-traces/{trace_id}")
async def get_production_trace(trace_id: str):
    """Get a single production trace by ID."""
    trace = await db.get_production_trace(trace_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")
    return trace


@router.put("/production-traces/{trace_id}/annotations")
async def upsert_trace_annotation(trace_id: str, body: dict = Body(...)):
    """Create or update annotation for a production trace."""
    try:
        logger.info(f"Upserting annotation for trace {trace_id}")
        logger.debug(f"Annotation body: {body}")

        # Verify trace exists
        trace = await db.get_production_trace(trace_id)
        if not trace:
            raise HTTPException(status_code=404, detail="Trace not found")

        body["trace_id"] = trace_id
        result = await db.upsert_trace_annotation(body)
        logger.info(f"Successfully saved annotation for trace {trace_id}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving annotation for trace {trace_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save annotation: {str(e)}")


@router.get("/production-traces/{trace_id}/annotations")
async def get_trace_annotation(trace_id: str):
    """Get annotation for a production trace."""
    ann = await db.get_trace_annotation(trace_id)
    if not ann:
        raise HTTPException(status_code=404, detail="No annotation found for this trace")
    return ann


@router.post("/production-traces/{trace_id}/convert-to-testcase")
async def convert_trace_to_testcase(
    trace_id: str,
    dataset_id: str,
    body: Optional[dict] = Body(None)
):
    """Convert an annotated production trace to a test case."""
    from .pii_detector import pii_detector

    # Verify trace exists
    trace = await db.get_production_trace(trace_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Trace not found")

    # Verify trace is marked as candidate
    annotation = await db.get_trace_annotation(trace_id)
    if not annotation or not annotation.get("testcase_candidate"):
        raise HTTPException(
            status_code=400,
            detail="Trace must be annotated and marked as testcase_candidate before conversion"
        )

    # Verify dataset exists
    dataset = await db.get_dataset(dataset_id)
    if not dataset:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    # Redact PII if detected
    if trace.get("pii_detected"):
        redacted_trace = pii_detector.redact_trace(trace)
        input_text = redacted_trace["input"]
        output_text = redacted_trace["output"]
        pii_redacted = trace.get("pii_flags", [])
    else:
        input_text = trace["input"]
        output_text = trace["output"]
        pii_redacted = []

    # Create test case from trace
    testcase_id = f"tc_{uuid.uuid4().hex[:16]}"
    name = body.get("name") if body else None
    if not name:
        name = f"Trace {trace['trace_id'][:8]}" if trace.get('trace_id') else f"Trace {trace['id'][:8]}"

    description = body.get("description") if body else None
    if not description:
        description = f"Converted from production trace on {trace['timestamp']}"

    # Extract tool expectations from trace tool calls
    tool_expectations = []
    if trace.get("tool_calls"):
        tool_calls = trace["tool_calls"]
        if isinstance(tool_calls, str):
            tool_calls = json.loads(tool_calls)

        # Group by tool name
        tools_used = {}
        for call in tool_calls:
            tool_name = call.get("name") or call.get("tool")
            if tool_name:
                if tool_name not in tools_used:
                    tools_used[tool_name] = []
                tools_used[tool_name].append(call)

        # Create tool expectations
        for tool_name, calls in tools_used.items():
            tool_expectations.append({
                "name": tool_name,
                "arguments": []  # Could extract argument expectations here
            })

    # Create testcase using existing models
    from .models import TestCase, ToolExpectation

    tool_exp_objects = [ToolExpectation(name=te["name"], arguments=te.get("arguments", [])) for te in tool_expectations]

    testcase = TestCase(
        id=testcase_id,
        dataset_id=dataset_id,
        name=name,
        description=description,
        input=input_text,
        expected_response=output_text,
        tool_expectations=tool_exp_objects,
        references_seed={},
        is_holdout=body.get("is_holdout", False) if body else False
    )

    # Save testcase
    await db.create_testcase(testcase)

    # Record conversion
    conversion_record = {
        "trace_id": trace_id,
        "testcase_id": testcase_id,
        "dataset_id": dataset_id,
        "conversion_type": body.get("conversion_type", "manual") if body else "manual",
        "reason": body.get("reason", "") if body else "",
        "extracted_fields": {"tool_expectations": len(tool_expectations)},
        "pii_redacted": pii_redacted,
        "converted_by": body.get("converted_by", "system") if body else "system",
        "converted_at": datetime.now(timezone.utc).isoformat()
    }

    await db.create_trace_to_testcase_conversion(conversion_record)

    # Update trace status
    await db.update_production_trace(trace_id, {
        "status": "converted_to_testcase",
        "testcase_id": testcase_id,
        "dataset_id": dataset_id
    })

    return {
        "testcase": testcase.model_dump(mode='json'),
        "conversion": conversion_record,
        "pii_redacted": pii_redacted
    }


@router.get("/trace-conversions")
async def list_trace_conversions(
    dataset_id: Optional[str] = None,
    skip: int = 0,
    limit: int = 100
):
    """List trace-to-testcase conversions."""
    return await db.list_trace_conversions(dataset_id=dataset_id, skip=skip, limit=limit)


@router.post("/production-traces/bulk-upload")
async def bulk_upload_traces(file: UploadFile, agent_id: str = Query(...)):
    """Bulk upload production traces from CSV or JSON file."""
    import csv
    import io
    from .pii_detector import pii_detector

    # Verify agent exists
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")

    content = await file.read()
    traces_created = 0
    errors = []

    try:
        # Determine file type and parse
        if file.filename.endswith('.json'):
            traces_data = json.loads(content.decode('utf-8'))
            if not isinstance(traces_data, list):
                traces_data = [traces_data]
        elif file.filename.endswith('.csv'):
            csv_content = content.decode('utf-8')
            reader = csv.DictReader(io.StringIO(csv_content))
            traces_data = list(reader)
        else:
            raise HTTPException(status_code=400, detail="File must be .json or .csv")

        # Process each trace
        for idx, trace_data in enumerate(traces_data):
            try:
                if 'input' not in trace_data or 'output' not in trace_data:
                    errors.append(f"Row {idx + 1}: Missing input/output")
                    continue

                trace_id = trace_data.get('trace_id') or f"bulk_{uuid.uuid4().hex[:16]}"
                pii_results = pii_detector.scan_trace(trace_data)

                retention_days = config.PRODUCTION_TRACE_RETENTION_DAYS
                expires_at = (datetime.now(timezone.utc) + timedelta(days=retention_days)).isoformat()

                trace_record = {
                    "id": f"trace_{uuid.uuid4().hex[:16]}",
                    "agent_id": agent_id,
                    "trace_id": trace_id,
                    "input": trace_data['input'],
                    "output": trace_data['output'],
                    "tool_calls": json.dumps(trace_data.get('tool_calls', [])) if trace_data.get('tool_calls') else None,
                    "latency_ms": float(trace_data.get('latency_ms')) if trace_data.get('latency_ms') else None,
                    "model": trace_data.get('model'),
                    "tokens_in": int(trace_data.get('tokens_in')) if trace_data.get('tokens_in') else None,
                    "tokens_out": int(trace_data.get('tokens_out')) if trace_data.get('tokens_out') else None,
                    "timestamp": trace_data.get('timestamp') or datetime.now(timezone.utc).isoformat(),
                    "metadata": json.dumps(trace_data.get('metadata', {})),
                    "sampled": True,
                    "status": "pending",
                    "expires_at": expires_at,
                    "pii_detected": pii_results['pii_detected'],
                    "pii_flags": json.dumps(pii_results.get('pii_flags', [])),
                    "pii_scan_completed": pii_results['pii_scan_completed']
                }

                await db.create_production_trace(trace_record)
                traces_created += 1
            except Exception as e:
                errors.append(f"Row {idx + 1}: {str(e)}")

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {str(e)}")

    return {
        "success": True,
        "traces_created": traces_created,
        "errors": errors
    }


@router.post("/production-traces/run")
async def run_task_in_production(
    input: str = Body(...),
    agent_id: str = Body(...),
):
    """
    Execute a task against an agent and store the result as a production trace.

    This lets users create real production traces on-demand from the UI,
    making the full Eva Loop (Step 3 – Learn from Production) testable.
    """
    import httpx as _hx
    import time as _time

    try:
        from .pii_detector import pii_detector
    except Exception:
        pii_detector = None

    # 1. Look up agent
    agent = await db.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    agent_url = agent.agent_invocation_url
    if not agent_url:
        raise HTTPException(status_code=400, detail="Agent has no invocation URL configured")

    # Ensure we hit the /invoke path
    invoke_url = agent_url.rstrip("/")
    if not invoke_url.endswith("/invoke"):
        invoke_url = invoke_url + "/invoke"

    # 2. Look up active prompt (optional — agent may not have one)
    system_prompt = None
    try:
        active_prompt = await db.get_active_prompt(agent_id)
        if active_prompt:
            system_prompt = active_prompt.get("system_prompt")
    except Exception:
        pass  # No prompt configured — that's fine

    # 3. Call agent /invoke
    payload = {
        "input": input,
        "agent_id": agent_id,
    }
    if system_prompt:
        payload["system_prompt"] = system_prompt

    start_ts = _time.time()
    try:
        async with _hx.AsyncClient(timeout=_hx.Timeout(600.0, connect=30.0)) as client:
            resp = await client.post(invoke_url, json=payload)
            resp.raise_for_status()
            agent_response = resp.json()
    except _hx.TimeoutException:
        raise HTTPException(status_code=504, detail="Agent timed out (10 min limit)")
    except _hx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Agent returned {e.response.status_code}: {e.response.text[:500]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach agent: {str(e)}")

    elapsed_ms = int((_time.time() - start_ts) * 1000)

    # 4. Map agent response → production trace fields
    metadata_raw = agent_response.get("metadata", {})
    tool_calls = agent_response.get("tool_calls", [])

    trace_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(days=90)).isoformat()

    # 5. PII scan (graceful fallback if pii_detector unavailable)
    if pii_detector:
        try:
            pii_results = pii_detector.scan_trace({
                "input": input,
                "output": agent_response.get("response", ""),
                "tool_calls": tool_calls,
            })
        except Exception as e:
            logger.warning(f"PII scan failed: {e}")
            pii_results = {"pii_detected": False, "pii_flags": [], "pii_scan_completed": False}
    else:
        pii_results = {"pii_detected": False, "pii_flags": [], "pii_scan_completed": False}

    # Compute latency
    duration_s = metadata_raw.get("duration_seconds")
    if duration_s and isinstance(duration_s, (int, float)):
        latency_ms = int(duration_s * 1000)
    else:
        latency_ms = elapsed_ms

    try:
        trace_record = {
            "id": trace_id,
            "agent_id": agent_id,
            "trace_id": f"run-task-{trace_id[:8]}",
            "input": input,
            "output": agent_response.get("response", ""),
            "tool_calls": json.dumps(tool_calls) if tool_calls else None,
            "latency_ms": latency_ms,
            "model": metadata_raw.get("model"),
            "tokens_in": metadata_raw.get("tokens_in"),
            "tokens_out": metadata_raw.get("tokens_out"),
            "timestamp": now.isoformat(),
            "metadata": json.dumps({
                "source": "run_task",
                "steps_taken": metadata_raw.get("steps_taken"),
                "task_success": metadata_raw.get("task_success"),
            }),
            "sampled": True,
            "status": "pending",
            "expires_at": expires_at,
            "pii_detected": pii_results["pii_detected"],
            "pii_flags": json.dumps(pii_results.get("pii_flags", [])),
            "pii_scan_completed": pii_results["pii_scan_completed"],
        }

        await db.create_production_trace(trace_record)

        # Return the trace (with tool_calls parsed back for the frontend)
        trace_record["tool_calls"] = tool_calls
        trace_record["metadata"] = json.loads(trace_record["metadata"])
        trace_record["pii_flags"] = json.loads(trace_record["pii_flags"])

        return trace_record

    except Exception as e:
        logger.error(f"Failed to create production trace: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to store trace: {str(e)}")


# ============================================================================

# Mock Agent Endpoints (for demo and seeded agent evaluation)
# ============================================================================

import random
import time
from typing import Any


@router.get("/mock-agent/health")
async def mock_agent_health():
    """Health check endpoint for the mock agent."""
    return {
        "status": "ok",
        "agent": "mock-agent",
        "model": "mock/demo",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/mock-agent/invoke")
async def mock_agent_invoke(
    input: str = Body(...),
    dataset_id: Optional[str] = Body(None),
    test_case_id: Optional[str] = Body(None),
    agent_id: Optional[str] = Body(None),
    evaluation_run_id: Optional[str] = Body(None),
    system_prompt: Optional[str] = Body(None),
):
    """
    Mock agent endpoint that simulates a real agent.

    Generates plausible responses with tool calls based on the input.
    Includes random delay to simulate real agent latency.

    Args:
        input: The user input/query
        dataset_id: Optional dataset identifier
        test_case_id: Optional test case identifier
        agent_id: Optional agent identifier
        evaluation_run_id: Optional evaluation run identifier
        system_prompt: Optional system prompt

    Returns:
        JSON response with response text, tool calls, and metadata
    """
    # Simulate real agent latency (0.2-0.8 seconds)
    delay = random.uniform(0.2, 0.8)
    await asyncio.sleep(delay)

    start_time = time.time()

    # Generate deterministic but varying responses based on input
    input_lower = input.lower() if isinstance(input, str) else ""

    # Decide if this invocation should succeed or have partial issues
    success_chance = random.random()

    # Different response patterns based on input keywords
    response_text = ""
    tool_calls = []

    if "error" in input_lower or "fail" in input_lower:
        # Simulate failure scenario
        response_text = f"I attempted to process your request: '{input[:50]}...' but encountered an issue. Let me try a different approach."
        tool_calls = [
            {
                "tool_name": "search",
                "arguments": {"query": input[:30]},
                "call_id": f"call_{random.randint(10000, 99999)}",
                "status": "failed",
                "error": "Connection timeout",
            }
        ]
    elif "calculate" in input_lower or "math" in input_lower or "sum" in input_lower:
        # Simulate calculation scenario
        response_text = f"I'll help you with the calculation. Processing: {input[:60]}..."
        tool_calls = [
            {
                "tool_name": "calculator",
                "arguments": {"expression": "sum([1, 2, 3, 4, 5])"},
                "call_id": f"call_{random.randint(10000, 99999)}",
                "status": "success",
                "result": 15,
            }
        ]
    elif "search" in input_lower or "find" in input_lower or "look" in input_lower:
        # Simulate search scenario
        response_text = f"Searching for information about: {input[:50]}..."
        tool_calls = [
            {
                "tool_name": "search",
                "arguments": {"query": input[:40]},
                "call_id": f"call_{random.randint(10000, 99999)}",
                "status": "success",
                "result": {"pages": 5, "top_result": "Found relevant information"},
            },
            {
                "tool_name": "fetch_page",
                "arguments": {"url": "https://example.com/page1"},
                "call_id": f"call_{random.randint(10000, 99999)}",
                "status": "success",
                "result": {"title": "Example Page", "content": "..."},
            },
        ]
    elif "api" in input_lower or "request" in input_lower:
        # Simulate API call scenario
        response_text = f"Making an API request based on your query: {input[:50]}..."
        tool_calls = [
            {
                "tool_name": "http_request",
                "arguments": {"method": "GET", "url": "https://api.example.com/data"},
                "call_id": f"call_{random.randint(10000, 99999)}",
                "status": "success",
                "result": {"status_code": 200, "data": {"entries": 42}},
            }
        ]
    else:
        # Default response scenario
        response_text = f"I've processed your request: '{input}'. Here's my analysis and recommendations."

        # Vary tool calls based on random chance
        if success_chance > 0.6:
            tool_calls = [
                {
                    "tool_name": "summarize",
                    "arguments": {"text": input[:100]},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": "Summary generated successfully",
                }
            ]
        elif success_chance > 0.3:
            tool_calls = [
                {
                    "tool_name": "analyze",
                    "arguments": {"input": input[:80]},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": {"sentiment": "neutral", "topics": ["general"]},
                },
                {
                    "tool_name": "validate",
                    "arguments": {"data": input[:60]},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": {"valid": True},
                },
            ]
        else:
            tool_calls = [
                {
                    "tool_name": "extract_info",
                    "arguments": {"source": input[:70]},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": {"extracted": 3, "confidence": 0.92},
                },
                {
                    "tool_name": "format_output",
                    "arguments": {"format": "json"},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": {"formatted": True},
                },
                {
                    "tool_name": "validate_response",
                    "arguments": {"response": response_text[:100]},
                    "call_id": f"call_{random.randint(10000, 99999)}",
                    "status": "success",
                    "result": {"valid": True, "issues": []},
                },
            ]

    # Calculate actual elapsed time
    elapsed_time = time.time() - start_time

    # Construct response
    return {
        "response": response_text,
        "tool_calls": tool_calls,
        "metadata": {
            "duration": round(elapsed_time, 3),
            "model": "mock/demo",
            "agent_id": agent_id or "mock-agent",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "input_length": len(input) if isinstance(input, str) else 0,
            "tool_calls_count": len(tool_calls),
        },
    }
