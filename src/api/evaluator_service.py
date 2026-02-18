"""
Evaluator Service for running async evaluations against agents.

==============================================================================
FEATURES IMPLEMENTED IN THIS MODULE:
==============================================================================

1. RATE LIMIT HANDLING WITH EXPONENTIAL BACKOFF (Feature: rate-limit-retry)
   - Automatic retry with exponential backoff when the LLM endpoint returns 429 errors
   - Configurable max attempts, base delay, and max delay via config.py
   - Jitter added to prevent thundering herd on retries
   - Status history tracks all rate limit events with timestamps
   - UI displays warnings and total retry wait time

2. VERBOSE LOGGING MODE (Feature: verbose-logging)
   - Optional per-evaluation flag to enable detailed assertion-level progress
   - When enabled, shows each tool and assertion being evaluated
   - Collapsed tool-level logging (Option D) to reduce noise
   - Pass/fail results displayed after each tool evaluation

3. REAL-TIME STATUS UPDATES (Feature: status-updates)
   - status_message field provides current activity for UI display
   - status_history maintains chronological log of all status changes
   - Test completion messages include percentage and failed items summary

4. ORPHAN EVALUATION CLEANUP (Feature: orphan-cleanup)
   - cleanup_orphaned_evaluations() cancels stuck evaluations on server restart
   - Adds status history entry explaining why evaluation was cancelled
   - Prevents accumulation of "running" evaluations that will never complete

5. EVALUATION CANCELLATION (Feature: cancel-evaluation)
   - cancel_evaluation_run() API endpoint to manually cancel evaluations
   - Properly marks evaluation as "cancelled" with completion timestamp
   - Cleans up associated locks to prevent resource leaks

6. TIMING TRACKING (Feature: timing-metrics)
   - Tracks agent_call_duration, judge_call_duration, total_duration per test
   - completed_at timestamp for each test case
   - Enables performance analysis and debugging slow tests

7. ASSERTION BATCHING (Feature: assertion-batching)
   - Groups all assertions for a single tool call into one LLM prompt
   - Parses structured JSON response with per-assertion results
   - Reduces LLM calls by 3-5x compared to evaluating each assertion individually
   - Falls back to single-assertion evaluation on parse failure

==============================================================================
"""

import asyncio
import json
import os
import random
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
import httpx

from .models import (
    EvaluationRun, EvaluationRunStatus, Agent,
    ToolExpectation, TestCaseResult, ExpectedToolResult,
    ToolExpectationResult, ArgumentAssertionResult, AssertionResult,
    ResponseQualityResult, BehaviorAssertionResult, BehaviorAssertion,
    ResponseQualityAssertion, ArgumentAssertion,
    PromptProposal, CostRecord
)
from .sqlite_service import SQLiteService
from . import config

import logging
import re
logger = logging.getLogger(__name__)


def _to_bool(value) -> bool:
    """Safely convert LLM judge 'passed' field to bool.

    LLM judges sometimes return "passed": "false" (string) instead of
    "passed": false (boolean).  Python's bool("false") returns True because
    any non-empty string is truthy.  This helper handles both forms correctly.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "pass", "passed", "1")
    return bool(value)


# Global OpenAI client instance (singleton pattern to reuse connection)
_openai_client = None


# ==============================================================================
# Template rendering utilities for judge configs
# ==============================================================================

def _render_template(template_str: str, context: Dict[str, Any]) -> str:
    """Render a judge prompt template by replacing {{variable}} placeholders.

    Uses simple string replacement (no Jinja2 dependency). Unrecognised
    placeholders are left as-is so the template still makes sense if a
    variable is not provided for a given assertion type.
    """
    result = template_str
    for key, value in context.items():
        result = result.replace("{{" + key + "}}", str(value) if value is not None else "")
    return result


def _try_deterministic_assertion(assertion_text: str, argument_name: str, tool_name: str, tool_calls: list) -> Optional[dict]:
    """Try to evaluate a tool-argument assertion deterministically (no LLM).

    Handles common patterns like:
      - "X should contain Y"
      - "X should contain Y and Z"
      - "URL should contain example.com and /path"

    Returns {"passed": bool, "reasoning": str} if it could evaluate deterministically,
    or None if the assertion needs LLM evaluation.
    """
    text = assertion_text.strip().lower()

    # Pattern: "[arg] should contain X [and Y [and Z]]"
    # Match: "should contain", "must contain", "contains"
    contain_match = re.match(
        r'^(?:(?:the\s+)?(?:\w+)\s+)?(?:should|must|needs to)\s+contain\s+(.+)$',
        text,
    )
    if not contain_match:
        return None  # can't handle this assertion deterministically

    # Extract the required substrings (split on " and ")
    required_part = contain_match.group(1).strip()
    required_items = [item.strip().strip("'\"") for item in re.split(r'\s+and\s+', required_part)]

    if not required_items:
        return None

    # Detect qualitative / semantic assertions that need LLM evaluation.
    # If a required item looks like a description rather than a concrete value,
    # fall through to LLM.  Heuristics:
    #   - Starts with an article ("a ", "an ", "some ", "any ")
    #   - Contains parenthetical qualifiers like "(not empty ...)"
    #   - Contains negation words ("not", "non-empty", "at least")
    _QUALITATIVE_PREFIXES = ("a ", "an ", "some ", "any ", "at least ")
    _QUALITATIVE_MARKERS = ("(", "not ", "non-", "at least", "should", "must")
    for item in required_items:
        item_lower = item.lower()
        if any(item_lower.startswith(p) for p in _QUALITATIVE_PREFIXES):
            return None  # qualitative — needs LLM
        if any(m in item_lower for m in _QUALITATIVE_MARKERS):
            return None  # qualitative — needs LLM

    # Find the actual argument value from tool calls
    actual_value = None
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        if tc.get("name") == tool_name:
            args = tc.get("arguments") or tc.get("input_parameters") or {}
            if isinstance(args, dict) and argument_name in args:
                actual_value = str(args[argument_name])
                break

    if actual_value is None:
        return None  # can't find the argument value — fall back to LLM

    # Check each required substring (case-insensitive)
    actual_lower = actual_value.lower()
    missing = [item for item in required_items if item.lower() not in actual_lower]

    if not missing:
        return {
            "passed": True,
            "reasoning": f"Deterministic check: '{actual_value}' contains all required substrings: {required_items}."
        }
    else:
        return {
            "passed": False,
            "reasoning": f"Deterministic check: '{actual_value}' is missing: {missing}."
        }


def _get_evaluation_mode_behavior(assertion_mode: str) -> Dict[str, bool]:
    """Return which evaluation checks to perform based on assertion mode.

    Each mode activates a different subset of the evaluation pipeline:
    - response_only: Only evaluate response quality assertion
    - tool_level: Full evaluation (expected tools + tool assertions + response quality)
    - hybrid: Evaluate behavior assertions + response quality
    """
    _MODE_MAP = {
        "response_only": {
            "eval_expected_tools": False,
            "eval_tool_assertions": False,
            "eval_behavior_assertions": False,
            "eval_response_quality": True,
        },
        "tool_level": {
            "eval_expected_tools": True,
            "eval_tool_assertions": True,
            "eval_behavior_assertions": False,
            "eval_response_quality": True,
        },
        "hybrid": {
            "eval_expected_tools": False,
            "eval_tool_assertions": False,
            "eval_behavior_assertions": True,
            "eval_response_quality": True,
        },
    }
    return _MODE_MAP.get(assertion_mode, _MODE_MAP["response_only"])


def _build_template_context(
    test_case,
    test_exec,
    tool_exp=None,
    argument_name: str = None,
    assertion_text: str = None,
    assertions_block: str = None,
    rubric_text: str = None,
) -> Dict[str, Any]:
    """Build the variable context dict for template rendering."""
    return {
        "test_input": getattr(test_case, 'input', ''),
        "test_description": getattr(test_case, 'description', ''),
        "tool_name": tool_exp.name if tool_exp else "",
        "argument_name": argument_name or "",
        "assertion_text": assertion_text or "",
        "tool_calls_json": json.dumps(test_exec.tool_calls, indent=2) if hasattr(test_exec, 'tool_calls') else "[]",
        "actual_tools": ", ".join(test_exec.actual_tools) if hasattr(test_exec, 'actual_tools') else "",
        "agent_response": test_exec.agent_response if hasattr(test_exec, 'agent_response') else "",
        "expected_response": getattr(test_case, 'expected_response', '') or "",
        "assertions_block": assertions_block or "",
        "rubric": rubric_text or "",
    }


# Default judge config — matches the original hard-coded prompts exactly
_DEFAULT_JUDGE_CONFIG = {
    "id": "_builtin_default",
    "name": "Built-in Default",
    "version": 0,
    "is_active": False,
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
    "rubric": [],
    "scoring_mode": "binary",
    "pass_threshold": None,
}


def _extract_json(text: str) -> dict:
    """Extract JSON from LLM output that may contain extra text.

    Handles:
    - Clean JSON (just returns parsed)
    - Markdown code fences (```json ... ```)
    - Reasoning model output with <think>...</think> tags
    - Leading/trailing prose around a JSON object
    """
    text = text.strip()

    # Strip <think>...</think> blocks (deepseek-r1 / qwen3 style)
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
    # Also strip unclosed <think> tags (model didn't emit closing tag)
    text = re.sub(r'<think>.*', '', text, flags=re.DOTALL).strip()

    # Try direct parse first (fast path)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code fence
    fence_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?\s*```', text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding the first { ... } block (greedy from first { to last })
    brace_match = re.search(r'\{.*\}', text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    # Nothing worked — raise with the original text for debugging
    raise json.JSONDecodeError(f"No valid JSON found in LLM output", text, 0)


# ==============================================================================
# RETRY CONFIGURATION (Feature: rate-limit-retry)
# ==============================================================================
# These values can be overridden via environment variables in config.py:
# - RETRY_MAX_ATTEMPTS: Maximum number of retry attempts before giving up
# - RETRY_BASE_DELAY: Initial delay in seconds (doubles each attempt)
# - RETRY_MAX_DELAY: Maximum delay cap to prevent extremely long waits
# ==============================================================================
RETRY_MAX_ATTEMPTS = getattr(config, 'RETRY_MAX_ATTEMPTS', 5)
RETRY_BASE_DELAY = getattr(config, 'RETRY_BASE_DELAY', 2.0)
RETRY_MAX_DELAY = getattr(config, 'RETRY_MAX_DELAY', 60.0)


from dataclasses import dataclass
from typing import TypeVar, Generic

T = TypeVar('T')


# ==============================================================================
# RETRY RESULT WRAPPER (Feature: rate-limit-retry)
# ==============================================================================
# This dataclass captures both the result of a retried operation AND metadata
# about how many retries occurred. This enables the UI to show users when
# their evaluations encountered rate limits and how long they had to wait.
# ==============================================================================
@dataclass
class RetryResult(Generic[T]):
    """Result from retry_with_backoff including retry statistics.
    
    Attributes:
        result: The actual return value from the wrapped function
        retry_count: Number of retries that occurred (0 = success on first try)
        had_rate_limit: True if any rate limit error was encountered
    """
    result: T
    retry_count: int
    had_rate_limit: bool


# ==============================================================================
# EXPONENTIAL BACKOFF RETRY WRAPPER (Feature: rate-limit-retry)
# ==============================================================================
# This is a reusable utility function that wraps any async function with
# automatic retry logic for rate limit errors. Key design decisions:
#
# 1. ONLY retries on rate limit errors (429, "too many requests", etc.)
#    - Other errors are raised immediately without retry
# 2. Uses exponential backoff: delay doubles each attempt (2s -> 4s -> 8s...)
# 3. Adds random jitter (0-10%) to prevent synchronized retries
# 4. Provides callback hook for status updates during retry waits
# 5. Returns metadata about retries for visibility in UI
# ==============================================================================
async def retry_with_backoff(func, *args, max_attempts=RETRY_MAX_ATTEMPTS, base_delay=RETRY_BASE_DELAY, on_retry=None, **kwargs) -> RetryResult:
    """
    Retry an async function with exponential backoff for rate limit errors.

    This function is designed to handle LLM rate limits gracefully.
    It detects 429 errors (and similar rate limit messages) and automatically
    retries with increasing delays.
    
    Args:
        func: The async function to call
        max_attempts: Maximum number of retry attempts (default from config)
        base_delay: Base delay in seconds (will be doubled each retry)
        on_retry: Optional async callback(attempt, max_attempts, wait_time, error)
                  Called before each retry wait to allow status updates
        *args, **kwargs: Arguments to pass to the function
    
    Returns:
        RetryResult containing:
        - result: The function's return value
        - retry_count: How many retries occurred (0 = first attempt succeeded)
        - had_rate_limit: True if any rate limit was encountered
    
    Raises:
        The last exception if all retries fail or if a non-rate-limit error occurs
    
    Example:
        async def call_openai():
            return await client.chat.completions.create(...)
        
        result = await retry_with_backoff(call_openai, on_retry=update_status)
        if result.had_rate_limit:
            logger.warning(f"Completed with {result.retry_count} retries")
    """
    last_exception = None
    retry_count = 0
    
    for attempt in range(max_attempts):
        try:
            result = await func(*args, **kwargs)
            return RetryResult(result=result, retry_count=retry_count, had_rate_limit=retry_count > 0)
        except Exception as e:
            error_str = str(e).lower()
            
            # Check if this is a rate limit error (429)
            # We check multiple patterns because different LLM services report this differently
            is_rate_limit = (
                '429' in error_str or 
                'rate' in error_str and 'limit' in error_str or
                'ratelimitreached' in error_str or
                'too many requests' in error_str
            )
            
            if not is_rate_limit:
                # Not a rate limit error, don't retry - raise immediately
                raise
            
            last_exception = e
            retry_count += 1
            
            if attempt < max_attempts - 1:
                # Calculate delay with exponential backoff + jitter
                delay = min(base_delay * (2 ** attempt), RETRY_MAX_DELAY)
                jitter = random.uniform(0, delay * 0.1)  # Add 0-10% jitter
                wait_time = delay + jitter
                
                logger.warning(
                    f"Rate limit hit (attempt {attempt + 1}/{max_attempts}). "
                    f"Retrying in {wait_time:.1f}s... Error: {str(e)[:100]}"
                )
                
                # Call the optional retry callback before waiting
                if on_retry:
                    try:
                        await on_retry(attempt + 1, max_attempts, wait_time, str(e)[:100])
                    except Exception as cb_err:
                        logger.warning(f"on_retry callback failed: {cb_err}")
                
                await asyncio.sleep(wait_time)
            else:
                logger.error(f"Max retries ({max_attempts}) exceeded for rate limit error: {str(e)[:200]}")
    
    raise last_exception


# ==============================================================================
# INTERNAL TEST EXECUTION TRACKER (NOT PERSISTED)
# ==============================================================================
# This is a temporary in-memory object used during test execution to track:
# - Current status (pending/running/completed/failed)
# - Tool calls made by the agent
# - Agent's response text
# - Timing information for performance analysis (Feature: timing-metrics)
# - Retry counts for rate limit visibility (Feature: rate-limit-retry)
#
# IMPORTANT: This is NOT the same as TestCaseResult (which IS persisted).
# After a test completes, we build a TestCaseResult from this data.
# ==============================================================================
class _TestExecution:
    """Temporary tracking object for test execution state.
    
    This class holds ephemeral data during test execution. It is NOT persisted
    to the database. After the test completes, the data is used to construct
    a TestCaseResult which IS persisted.
    
    Attributes:
        test_case_id: ID of the test case being executed
        evaluation_run_id: ID of the parent evaluation run
        status: Current status (pending, running, completed, failed)
        agent_response: The text response from the agent
        tool_calls: Full tool call data from the agent (for UI display)
        actual_tools: List of tool names that were called
        error_message: Error details if execution failed
        test_case_result: Final result (built after execution completes)
        retry_count: Number of rate limit retries encountered
        had_rate_limit: Whether any rate limit was hit
        agent_call_start: Start time of agent HTTP call
        agent_call_duration: Time for agent HTTP call (including retries)
        judge_call_start: Start time of LLM judge phase
        judge_call_duration: Time for LLM judge calls (including retries)
        test_start: Start time of entire test
        total_duration: End-to-end time for this test
    """
    def __init__(self, test_case_id: str, evaluation_run_id: str):
        self.test_case_id = test_case_id
        self.evaluation_run_id = evaluation_run_id
        self.status = "pending"  # pending, running, completed, failed
        self.agent_response = ""
        self.tool_calls: List[Dict[str, Any]] = []
        self.actual_tools: List[str] = []
        self.error_message: Optional[str] = None
        # Result will be built here
        self.test_case_result: Optional[TestCaseResult] = None
        # Retry tracking (Feature: rate-limit-retry)
        self.retry_count: int = 0
        self.had_rate_limit: bool = False
        # Timing tracking
        self.agent_call_start: Optional[float] = None
        self.agent_call_duration: float = 0.0
        self.judge_call_start: Optional[float] = None
        self.judge_call_duration: float = 0.0
        self.test_start: Optional[float] = None
        self.total_duration: float = 0.0
        # Cost tracking (Feature: cost-attribution)
        self.eval_run_id: str = evaluation_run_id
        self.agent_id: Optional[str] = None  # set by caller
        self.agent_cost_usd: float = 0.0
        self.judge_cost_usd: float = 0.0
        self.agent_tokens_in: int = 0
        self.agent_tokens_out: int = 0
        self.judge_tokens_in: int = 0
        self.judge_tokens_out: int = 0


class EvaluatorService:
    def __init__(self, db_service: SQLiteService, max_concurrent_tests: int = None):

        logger.info("Initializing EvaluatorService")
        logger.info(f"LLM_BASE_URL: {config.LLM_BASE_URL}")
        logger.info(f"LLM_MODEL: {config.LLM_MODEL}")

        self.db = db_service
        self.openai_client = None
    
        # Use config default if not specified
        if max_concurrent_tests is None:
            max_concurrent_tests = config.MAX_CONCURRENT_TESTS
        self.max_concurrent_tests = max_concurrent_tests
        self._semaphore = asyncio.Semaphore(max_concurrent_tests)
        
        # Lock for protecting concurrent updates to evaluation runs
        self._eval_run_locks: Dict[str, asyncio.Lock] = {}
        self._locks_lock = asyncio.Lock()  # Lock to protect the locks dictionary
        self._cancelled_evals: set = set()  # eval IDs that have been cancelled
        self._running_tasks: Dict[str, list] = {}  # eval_id → list of asyncio.Task objects
        self._status_cache: Dict[str, str] = {}  # eval_run_id → live status_message (in-memory)

        logger.info("EvaluatorService initialized successfully")

    # ==== SYSTEM PROMPT HELPERS (Feature: configurable-prompts) ====

    async def _get_system_prompt(self, key: str, default: str) -> str:
        """Retrieve a system prompt from the DB, falling back to default.

        Appends /no_think to suppress Qwen3-style thinking mode, which
        can cause empty content or <think> blocks that break JSON parsing.
        """
        try:
            prompt = await self.db.get_system_prompt(key)
            if prompt and prompt.get("content"):
                content = prompt["content"]
                if "/no_think" not in content:
                    content += " /no_think"
                return content
        except Exception as e:
            logger.warning(f"Failed to load system prompt '{key}': {e}")
        if "/no_think" not in default:
            default += " /no_think"
        return default

    async def _render_proposal_prompt(self, variables: dict, hardcoded_fallback: str) -> str:
        """Render the proposal user prompt from the DB template.

        Loads the user template from DB (key=proposal_generation_user),
        substitutes {{variable}} placeholders with the supplied dict,
        and falls back to the hardcoded prompt if the template is missing
        or rendering fails.
        """
        try:
            prompt_record = await self.db.get_system_prompt("proposal_generation_user")
            if prompt_record and prompt_record.get("content"):
                template = prompt_record["content"]
                # Replace {{var}} placeholders with values from the dict
                for key, value in variables.items():
                    template = template.replace("{{" + key + "}}", str(value))
                return template
        except Exception as e:
            logger.warning(f"Failed to render proposal user template from DB: {e}")
        return hardcoded_fallback

    # ==== COST ATTRIBUTION HELPERS (Feature: cost-attribution) ====

    def _compute_cost(self, model: str, tokens_in: int, tokens_out: int) -> float:
        """Compute USD cost from token counts using the pricing table."""
        pricing = config.PRICING_TABLE.get(model, config.PRICING_TABLE.get("_default", {"input_per_1k": 0, "output_per_1k": 0}))
        return (tokens_in / 1000 * pricing["input_per_1k"]) + (tokens_out / 1000 * pricing["output_per_1k"])

    async def _record_cost(
        self, call_type: str, model: str, tokens_in: int, tokens_out: int,
        evaluation_id: str = None, test_case_id: str = None, agent_id: str = None
    ) -> float:
        """Record a cost entry and return the computed cost USD."""
        import uuid as _uuid
        cost_usd = self._compute_cost(model, tokens_in, tokens_out)
        record = CostRecord(
            id=f"cost_{_uuid.uuid4().hex[:12]}",
            evaluation_id=evaluation_id,
            test_case_id=test_case_id,
            agent_id=agent_id,
            call_type=call_type,
            model=model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost_usd,
        )
        try:
            await self.db.create_cost_record(record)
        except Exception as e:
            logger.warning(f"Failed to persist cost record: {e}")
        return cost_usd

    # ==== FAILURE MODE CLASSIFICATION (Feature: hitl-intelligence) ====

    @staticmethod
    def _classify_failure_mode(tc_result: TestCaseResult) -> Optional[str]:
        """Classify the failure mode of a test case result.

        Returns None for passing tests, or one of:
        tool_not_called, wrong_tool, wrong_args, hallucination, timeout, partial_match
        """
        if tc_result.passed:
            return None

        if tc_result.execution_error and "timeout" in tc_result.execution_error.lower():
            return "timeout"

        # Check expected tools
        expected_not_called = [et for et in tc_result.expected_tools if not et.was_called]
        if expected_not_called and not tc_result.actual_tool_calls:
            return "tool_not_called"

        if expected_not_called:
            return "wrong_tool"

        # Check tool argument assertions
        any_arg_failed = False
        any_arg_passed = False
        for tool_exp in tc_result.tool_expectations:
            for arg in tool_exp.arguments:
                for a in arg.assertions:
                    if a.passed:
                        any_arg_passed = True
                    else:
                        any_arg_failed = True

        if any_arg_failed and not any_arg_passed:
            return "wrong_args"
        if any_arg_failed and any_arg_passed:
            return "partial_match"

        # Response quality failed but tools were OK
        if tc_result.response_quality_assertion and not tc_result.response_quality_assertion.passed:
            return "hallucination"

        return "partial_match"  # generic failure

    async def _update_status_message(
        self,
        eval_run_id: str,
        message: str,
        is_rate_limit: bool = False,
        retry_attempt: int = None,
        max_attempts: int = None,
        wait_seconds: float = None,
        persist: bool = False,
    ):
        """Update the status message for real-time UI visibility.

        By default, only updates the in-memory cache (fast, no DB I/O).
        Set persist=True for significant events that should be saved to DB
        and added to the status history (test start/finish, rate limits).

        The countdown ticker calls this every ~3 seconds with persist=False.
        """
        from .models import StatusHistoryEntry

        # Always update in-memory cache (used by the GET endpoint)
        self._status_cache[eval_run_id] = message

        # Only write to DB on significant events (not every countdown tick)
        should_persist = persist or is_rate_limit
        if not should_persist:
            return

        try:
            lock = await self._get_eval_run_lock(eval_run_id)
            async with lock:
                latest = await self.db.get_evaluation_run(eval_run_id)
                if latest and latest.status == EvaluationRunStatus.running:
                    latest.status_message = message
                    # Append to status history — cap at 100 entries to prevent unbounded growth
                    latest.status_history.append(StatusHistoryEntry(
                        message=message,
                        is_rate_limit=is_rate_limit,
                        retry_attempt=retry_attempt,
                        max_attempts=max_attempts,
                        wait_seconds=wait_seconds
                    ))
                    if len(latest.status_history) > 100:
                        latest.status_history = latest.status_history[-100:]

                    # Update aggregate rate limit stats
                    if is_rate_limit and wait_seconds:
                        latest.total_rate_limit_hits += 1
                        latest.total_retry_wait_seconds += wait_seconds

                    await self.db.update_evaluation_run(latest)
                    logger.debug(f"Status message persisted: {message}")
        except Exception as e:
            logger.warning(f"Failed to persist status message: {e}")
    
    def OpenAIClientInitialization(self):
        """Initialize the OpenAI client globally if not already initialized.

        Uses the standard OpenAI client pointing to a local LLM endpoint
        (Ollama or any OpenAI-compatible server).
        Validates connectivity on first init so failures are loud, not silent.
        """
        global _openai_client

        if _openai_client is not None:
            self.openai_client = _openai_client
            return

        logger.info("Initializing OpenAI-compatible client for local LLM")
        logger.info(f"  base_url: {config.LLM_BASE_URL}")
        logger.info(f"  model:    {config.LLM_MODEL}")

        # Pre-flight: verify the LLM endpoint is reachable.
        # Cloud APIs (Anthropic, OpenAI) don't expose Ollama's /api/tags —
        # skip the Ollama-specific probe for those and trust the network is up.
        # Auth failures will surface on the first actual call with a clear error.
        import httpx as _hx
        base = config.LLM_BASE_URL.rstrip("/")
        is_cloud_api = any(h in base for h in ("anthropic.com", "openai.com"))
        if is_cloud_api:
            logger.info(f"  LLM endpoint is a cloud API ({base}) — skipping Ollama connectivity probe")
            if config.LLM_API_KEY in ("ollama", "", None):
                logger.warning(
                    f"  ⚠ No API key detected for {base}. "
                    f"Set LLM_API_KEY or ANTHROPIC_API_KEY in your .env — "
                    f"judge calls will fail with 401 without a valid key."
                )
        else:
            try:
                # Ollama exposes /api/tags; use that for local connectivity check
                ollama_base = base.replace("/v1", "")
                r = _hx.get(f"{ollama_base}/api/tags", timeout=5.0)
                r.raise_for_status()
                logger.info(f"  LLM endpoint reachable: {ollama_base}")
            except Exception as e:
                logger.error(
                    f"LLM judge endpoint NOT reachable at {config.LLM_BASE_URL}: {e}\n"
                    f"  Evaluations will fail during the judge phase.\n"
                    f"  Make sure Ollama is running (ollama serve) and the model is pulled.\n"
                    f"  Set LLM_BASE_URL / LLM_MODEL env vars if using a different endpoint."
                )
                raise ConnectionError(
                    f"LLM judge endpoint not reachable at {config.LLM_BASE_URL}. "
                    f"Start Ollama with 'ollama serve' or set LLM_BASE_URL to the correct endpoint."
                ) from e

        from openai import OpenAI  # Lazy import to speed up server startup
        _openai_client = OpenAI(
            base_url=config.LLM_BASE_URL,
            api_key=config.LLM_API_KEY,
        )

        self.openai_client = _openai_client
        logger.info("OpenAI-compatible client initialized successfully")
        
    async def create_evaluation_run(self, run_request) -> EvaluationRun:
        """Create a new evaluation run and initialize test results."""
        
        # Get the dataset and its test cases
        dataset = await self.db.get_dataset(run_request.dataset_id)
        if not dataset:
            raise ValueError(f"Dataset {run_request.dataset_id} not found")
            
        # Get test cases for this dataset
        test_cases = await self.db.list_testcases_by_dataset(run_request.dataset_id)
        
        agent = await self.db.get_agent(run_request.agent_id)
        if not agent:
            raise ValueError(f"Agent {run_request.agent_id} not found")

        # Resolve prompt version: explicit > active > None
        prompt_version = getattr(run_request, 'prompt_version', None)
        prompt_id = getattr(run_request, 'prompt_id', None)
        if prompt_version is None:
            active_prompt = await self.db.get_active_prompt(run_request.agent_id)
            if active_prompt:
                prompt_version = active_prompt.get('version')
                prompt_id = active_prompt.get('id')
                logger.info(f"Auto-stamping evaluation with prompt v{prompt_version} ({prompt_id})")

        # Capture agent's current model for traceability (explicit > agent's current model)
        agent_model = getattr(run_request, 'agent_model', None)
        if agent_model is None and agent:
            agent_model = agent.model
            if agent_model:
                logger.info(f"Auto-stamping evaluation with agent model '{agent_model}'")

        # Selective rerun: if specific test case IDs were requested, count only those
        selected_ids = getattr(run_request, 'test_case_ids', None)
        if selected_ids:
            total = len(selected_ids)
            logger.info(f"Selective rerun: {total} of {len(test_cases)} test cases")
        else:
            total = len(test_cases)

        # Create evaluation run
        eval_run = EvaluationRun(
            name=run_request.name,
            dataset_id=run_request.dataset_id,
            agent_id=run_request.agent_id,
            agent_endpoint=run_request.agent_endpoint,
            agent_auth_required=run_request.agent_auth_required,
            timeout_seconds=run_request.timeout_seconds,
            total_tests=total,
            test_cases=[],  # Will be populated as tests complete
            verbose_logging=run_request.verbose_logging,  # Pass through verbose logging flag
            demo_mode=getattr(run_request, 'demo_mode', False),
            prompt_version=prompt_version,
            prompt_id=prompt_id,
            agent_model=agent_model,
            test_case_ids=selected_ids,
        )
        
        # Save to database
        saved_run = await self.db.create_evaluation_run(eval_run)
        return saved_run
    
    async def start_evaluation(self, evaluation_id: str):
        """Start the evaluation process asynchronously."""
        logger.info(f"Starting evaluation {evaluation_id}")

        eval_run = await self.db.get_evaluation_run(evaluation_id)
        if not eval_run:
            raise ValueError(f"Evaluation run {evaluation_id} not found")

        # Get test cases from dataset
        test_cases = await self.db.list_testcases_by_dataset(eval_run.dataset_id)
        if not test_cases:
            raise ValueError(f"No test cases found for dataset {eval_run.dataset_id}")

        # Selective rerun: filter to only the requested test cases
        if eval_run.test_case_ids:
            selected = set(eval_run.test_case_ids)
            test_cases = [tc for tc in test_cases if tc.id in selected]
            logger.info(f"Selective rerun: running {len(test_cases)} of {len(selected)} requested test cases")
            if not test_cases:
                raise ValueError(f"None of the requested test case IDs matched dataset {eval_run.dataset_id}")
        
        # Cache system prompt text for this evaluation (avoids N+1 queries in _execute_test)
        eval_run._cached_prompt_text = None
        if eval_run.prompt_id:
            try:
                prompt_data = await self.db.get_active_prompt(eval_run.agent_id)
                if prompt_data and prompt_data.get('id') == eval_run.prompt_id:
                    eval_run._cached_prompt_text = prompt_data.get('system_prompt')
                    logger.info(f"Cached system prompt v{eval_run.prompt_version} for eval {evaluation_id}")
                else:
                    # Prompt might not be active anymore — look up by iterating versions
                    all_prompts = await self.db.list_agent_prompts(eval_run.agent_id)
                    for p in all_prompts:
                        if p.get('id') == eval_run.prompt_id:
                            eval_run._cached_prompt_text = p.get('system_prompt')
                            logger.info(f"Cached system prompt v{eval_run.prompt_version} (non-active) for eval {evaluation_id}")
                            break
            except Exception as e:
                logger.warning(f"Failed to cache prompt text for eval {evaluation_id}: {e}")

        # Load judge config for this evaluation (with backward-compat fallback)
        judge_config = None
        if eval_run.judge_config_id and eval_run.judge_config_version:
            judge_config = await self.db.get_judge_config(
                eval_run.judge_config_id, eval_run.judge_config_version
            )
        if not judge_config:
            # Try the globally active config
            judge_config = await self.db.get_active_judge_config()
        if not judge_config:
            # Fall back to built-in default (identical to original hard-coded prompts)
            judge_config = _DEFAULT_JUDGE_CONFIG
        # Store resolved config on the eval run for traceability
        eval_run.judge_config_id = judge_config.get('id')
        eval_run.judge_config_version = judge_config.get('version')
        eval_run._cached_judge_config = judge_config
        logger.info(f"Using judge config '{judge_config.get('name')}' v{judge_config.get('version')} for eval {evaluation_id}")

        # Update status to running
        eval_run.status = EvaluationRunStatus.running
        eval_run.started_at = datetime.now(timezone.utc)
        await self.db.update_evaluation_run(eval_run)

        try:
            # Warmup: Give the agent a moment to be fully ready before first test
            # This prevents race conditions where the first test hits an agent that's still initializing
            logger.info(f"Waiting 500ms for agent warmup...")
            await asyncio.sleep(0.5)

            # Create test execution trackers for each test case
            test_executions = [
                _TestExecution(test_case.id, eval_run.id)
                for test_case in test_cases
            ]
            # Set agent_id for cost tracking
            for te in test_executions:
                te.agent_id = eval_run.agent_id

            # Process all test cases in parallel with controlled concurrency
            logger.info(f"Starting parallel execution of {len(test_executions)} test cases (max concurrent: {self.max_concurrent_tests})")
            
            # Create asyncio.Task objects so we can cancel them on demand
            tasks = []
            for i, (test_exec, test_case) in enumerate(zip(test_executions, test_cases)):
                logger.info(f"Queuing test {i+1}/{len(test_executions)}: {test_case.id}")
                task = asyncio.create_task(
                    self._process_single_test_with_semaphore(eval_run, test_exec, test_case, i+1, len(test_executions)),
                    name=f"eval-{evaluation_id}-test-{i+1}"
                )
                tasks.append(task)

            # Store task references so cancel_evaluation_run() can kill them
            self._running_tasks[evaluation_id] = tasks

            # Execute all tests in parallel with controlled concurrency
            logger.info(f"Waiting for all {len(tasks)} parallel tasks to complete...")
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            except asyncio.CancelledError:
                logger.info(f"Evaluation {evaluation_id} tasks were cancelled")
            finally:
                self._running_tasks.pop(evaluation_id, None)

            logger.info(f"All parallel test execution completed.")

            # If evaluation was cancelled while tests were running, don't finalize
            if evaluation_id in self._cancelled_evals:
                logger.info(f"Evaluation {evaluation_id} was cancelled — skipping finalization")
                self._cancelled_evals.discard(evaluation_id)
                return

            # Fetch the latest evaluation run from DB to get all test results
            eval_run = await self.db.get_evaluation_run(eval_run.id)
            if not eval_run:
                raise ValueError(f"Evaluation run {eval_run.id} not found after test completion")

            # Double-check: if cancel was processed between gather and here
            if eval_run.status == EvaluationRunStatus.cancelled:
                logger.info(f"Evaluation {evaluation_id} status is cancelled — skipping finalization")
                self._cancelled_evals.discard(evaluation_id)
                return

            # Calculate pass percentage
            pass_percentage = (eval_run.passed_count / eval_run.total_tests * 100) if eval_run.total_tests > 0 else 0

            logger.info(f"📊 Evaluation Results:")
            logger.info(f"   Total test cases: {eval_run.total_tests}")
            logger.info(f"   Passed: {eval_run.passed_count}")
            logger.info(f"   Failed: {eval_run.failed_tests}")
            logger.info(f"   Pass rate: {pass_percentage:.1f}%")

            # Calculate final results
            await self._finalize_evaluation(eval_run)
            self._status_cache.pop(evaluation_id, None)

        except asyncio.CancelledError:
            logger.info(f"Evaluation {evaluation_id} run_evaluation cancelled")
            # Status already set to cancelled by cancel_evaluation_run — just clean up
            self._cancelled_evals.discard(evaluation_id)
            self._running_tasks.pop(evaluation_id, None)
        except Exception as e:
            logger.error(f"Evaluation {evaluation_id} failed: {str(e)}")
            eval_run.status = EvaluationRunStatus.failed
            eval_run.completed_at = datetime.now(timezone.utc)
            await self.db.update_evaluation_run(eval_run)
            raise

    async def _process_single_test_with_semaphore(self, eval_run: EvaluationRun, test_exec: _TestExecution, test_case, test_num: int, total_tests: int):
        """Process a single test case with semaphore-controlled concurrency."""
        try:
            async with self._semaphore:
                await self._process_single_test(eval_run, test_exec, test_case, test_num, total_tests)
        except asyncio.CancelledError:
            logger.info(f"Test {test_num}/{total_tests} task cancelled for eval {eval_run.id}")
            test_exec.status = "skipped"
            return
    
    async def _process_single_test(self, eval_run: EvaluationRun, test_exec: _TestExecution, test_case, test_num: int, total_tests: int):
        """Process a single test case (execute + judge) in parallel."""
        try:
            # Bail out early if this evaluation was cancelled
            if eval_run.id in self._cancelled_evals:
                logger.info(f"Skipping test {test_num}/{total_tests} — evaluation {eval_run.id} was cancelled")
                test_exec.status = "skipped"
                return

            logger.info(f"Starting test {test_num}/{total_tests}: {test_case.id}")

            # Start timing the entire test
            test_exec.test_start = time.time()

            # Mark this test as in-progress in the DB for UI visibility
            await self._mark_test_in_progress(eval_run.id)

            # Update status message for UI visibility (persist — test start is significant)
            await self._update_status_message(
                eval_run.id,
                f"Running test {test_num}/{total_tests}: {test_case.name or test_case.id}",
                persist=True,
            )

            # Update test execution status
            test_exec.status = "running"
            
            # Execute the test
            await self._execute_test(eval_run, test_exec, test_case)

            # Check cancellation AFTER agent execution returns (may have been cancelled while running)
            if eval_run.id in self._cancelled_evals:
                logger.info(f"Test {test_num}/{total_tests} cancelled after agent execution — skipping judge")
                test_exec.status = "skipped"
                await self._decrement_in_progress(eval_run.id)
                return

            # Update status for judging phase with agent call timing (persist — phase transition)
            await self._update_status_message(
                eval_run.id,
                f"Judging test {test_num}/{total_tests}: {test_case.name or test_case.id} (agent: {test_exec.agent_call_duration:.1f}s)",
                persist=True,
            )

            # Unload agent model from GPU before judge runs (Feature: rubric-evaluation)
            # Prevents OOM when large vision model (e.g. qwen3-vl:8b ~8GB) is still
            # resident and judge model needs to load on the same GPU.
            agent_ollama_model = os.getenv("OLLAMA_MODEL", "")
            if agent_ollama_model:
                await self._unload_ollama_model(agent_ollama_model)

            # Run LLM judge and build result (only if execution was successful)
            if test_exec.status == "completed":
                await self._judge_and_build_result(eval_run, test_exec, test_case)
            else:
                # Execution failed - create a failed TestCaseResult
                logger.warning(f"Test {test_case.id} execution failed: {test_exec.error_message}")
                test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0
                test_exec.test_case_result = TestCaseResult(
                    testcase_id=test_case.id,
                    passed=False,
                    response_from_agent=test_exec.agent_response or "",
                    expected_tools=[],
                    tool_expectations=[],
                    response_quality_assertion=None,
                    actual_tool_calls=test_exec.tool_calls,
                    execution_error=test_exec.error_message or "Execution failed",
                    retry_count=test_exec.retry_count,
                    completed_at=datetime.now(timezone.utc),
                    agent_call_duration_seconds=test_exec.agent_call_duration,
                    judge_call_duration_seconds=0.0,
                    total_duration_seconds=test_exec.total_duration
                )
            
            logger.info(f"Completed test {test_num}/{total_tests}: {test_case.id} - Status: {test_exec.status}, Passed: {test_exec.test_case_result.passed if test_exec.test_case_result else 'N/A'}")
            
            # Update status with completion, timing, and summary
            result_emoji = "✅" if test_exec.test_case_result and test_exec.test_case_result.passed else "❌"
            
            # Build summary with percentage and failed items
            summary = ""
            if test_exec.test_case_result:
                tc_result = test_exec.test_case_result
                
                # Track what passed and what failed
                passed_count = 0
                total_count = 0
                failed_items = []
                
                # Check tools called
                for tool in (tc_result.expected_tools or []):
                    total_count += 1
                    if tool.was_called:
                        passed_count += 1
                    else:
                        failed_items.append(f"{tool.name_of_tool} (not called)")
                
                # Check argument assertions
                for tool_exp in (tc_result.tool_expectations or []):
                    for arg in tool_exp.arguments:
                        total_count += 1
                        if all(a.passed for a in arg.assertions):
                            passed_count += 1
                        else:
                            failed_items.append(f"{tool_exp.name_of_tool}.{arg.name_of_argument}")
                
                # Check response quality
                if tc_result.response_quality_assertion:
                    total_count += 1
                    if tc_result.response_quality_assertion.passed:
                        passed_count += 1
                    else:
                        failed_items.append("Response Quality")
                
                # Calculate percentage
                pct = int((passed_count / total_count * 100)) if total_count > 0 else 0
                
                # Build summary string
                if failed_items:
                    # Limit to first 3 failed items to avoid very long messages
                    failed_str = ", ".join(failed_items[:3])
                    if len(failed_items) > 3:
                        failed_str += f" +{len(failed_items) - 3} more"
                    summary = f" | {pct}% | Failed: {failed_str}"
                else:
                    summary = f" | {pct}%"
            
            await self._update_status_message(
                eval_run.id,
                f"{result_emoji} Test {test_num}/{total_tests} done: {test_case.name or test_case.id} ({test_exec.agent_call_duration:.1f}s + {test_exec.judge_call_duration:.1f}s){summary}",
                persist=True,
            )
            
            # Transfer cost tracking from test_exec to test_case_result
            if test_exec.test_case_result:
                test_exec.test_case_result.agent_cost_usd = test_exec.agent_cost_usd
                test_exec.test_case_result.judge_cost_usd = test_exec.judge_cost_usd
                test_exec.test_case_result.agent_tokens_in = test_exec.agent_tokens_in
                test_exec.test_case_result.agent_tokens_out = test_exec.agent_tokens_out
                test_exec.test_case_result.judge_tokens_in = test_exec.judge_tokens_in
                test_exec.test_case_result.judge_tokens_out = test_exec.judge_tokens_out
                # Update database with this test result immediately
                await self._update_eval_run_with_test_result(eval_run, test_exec.test_case_result)
            
        except asyncio.CancelledError:
            logger.info(f"Test {test_case.id} cancelled via task cancellation")
            test_exec.status = "skipped"
            await self._decrement_in_progress(eval_run.id)
            raise  # Re-raise so the semaphore wrapper can catch it too
        except Exception as e:
            logger.error(f"Error processing test {test_case.id}: {str(e)}")
            test_exec.status = "failed"
            test_exec.error_message = f"Test processing failed: {str(e)}"
            await self._decrement_in_progress(eval_run.id)

    async def _decrement_in_progress(self, eval_run_id: str):
        """Safely decrement in_progress_tests counter."""
        lock = await self._get_eval_run_lock(eval_run_id)
        async with lock:
            try:
                latest = await self.db.get_evaluation_run(eval_run_id)
                if latest:
                    latest.in_progress_tests = max(0, (latest.in_progress_tests or 0) - 1)
                    await self.db.update_evaluation_run(latest)
            except Exception:
                pass

    async def _get_eval_run_lock(self, eval_run_id: str) -> asyncio.Lock:
        """Get or create a lock for a specific evaluation run."""
        async with self._locks_lock:
            if eval_run_id not in self._eval_run_locks:
                self._eval_run_locks[eval_run_id] = asyncio.Lock()
            return self._eval_run_locks[eval_run_id]
    
    async def _mark_test_in_progress(self, eval_run_id: str):
        """Increment in_progress_tests counter when a test starts executing."""
        lock = await self._get_eval_run_lock(eval_run_id)
        async with lock:
            try:
                latest = await self.db.get_evaluation_run(eval_run_id)
                if latest:
                    latest.in_progress_tests = (latest.in_progress_tests or 0) + 1
                    await self.db.update_evaluation_run(latest)
            except Exception as e:
                logger.error(f"Error marking test in progress: {str(e)}")

    async def _update_eval_run_with_test_result(self, eval_run: EvaluationRun, test_result: TestCaseResult):
        """Update the evaluation run in the database with a single test result.

        Uses a per-evaluation-run lock to prevent race conditions when multiple
        test threads try to update the same evaluation run simultaneously.
        """
        # Get the lock for this specific evaluation run
        lock = await self._get_eval_run_lock(eval_run.id)

        async with lock:
            try:
                # Fetch the latest eval run from DB
                latest_eval_run = await self.db.get_evaluation_run(eval_run.id)
                if not latest_eval_run:
                    logger.error(f"Could not find evaluation run {eval_run.id} to update")
                    return

                # Add the new test result
                latest_eval_run.test_cases.append(test_result)

                # Update counts
                latest_eval_run.completed_tests = len(latest_eval_run.test_cases)
                latest_eval_run.in_progress_tests = max(0, (latest_eval_run.in_progress_tests or 0) - 1)
                latest_eval_run.passed_count = sum(1 for tc in latest_eval_run.test_cases if tc.passed)
                latest_eval_run.failed_tests = latest_eval_run.completed_tests - latest_eval_run.passed_count
                
                # Add warning if rate limit retries occurred
                if test_result.retry_count > 0:
                    warning_msg = f"Test {test_result.testcase_id} required {test_result.retry_count} retry(ies) due to rate limits"
                    if warning_msg not in latest_eval_run.warnings:
                        latest_eval_run.warnings.append(warning_msg)
                        logger.info(f"Added rate limit warning for test {test_result.testcase_id}")
                
                # Save back to database
                await self.db.update_evaluation_run(latest_eval_run)
                
                logger.debug(f"Updated eval run {eval_run.id} with test result for {test_result.testcase_id} - Progress: {latest_eval_run.completed_tests}/{latest_eval_run.total_tests}")
                
            except Exception as e:
                logger.error(f"Error updating eval run with test result: {str(e)}")
    
    def _generate_mock_response(self, test_case, eval_run: EvaluationRun):
        """Generate a synthetic agent response for demo mode.

        Uses the test case's expected tools and response to produce a
        realistic-looking mock output so the LLM judge can evaluate it.
        """
        # Decide if this mock "passes" — weighted by tool count (harder tests fail more)
        tool_count = len(test_case.minimal_tool_set)
        pass_prob = max(0.35, 0.85 - tool_count * 0.08)
        will_pass = random.random() < pass_prob

        # Build synthetic tool calls from the test case's expected tool set
        tool_calls = []
        for tool_name in test_case.minimal_tool_set:
            # Sometimes skip a tool on failure
            if not will_pass and random.random() > 0.7:
                continue
            tool_calls.append({
                "name": tool_name,
                "input_parameters": {"input": test_case.input[:80]},
                "result": "success" if (will_pass or random.random() > 0.3) else "error",
            })
        # On failure, occasionally call a wrong tool
        if not will_pass and random.random() > 0.6:
            tool_calls.append({
                "name": "unknown_action",
                "input_parameters": {"error": "wrong_tool_selected"},
                "result": "error",
            })

        # Build a synthetic response text
        if will_pass:
            response_text = (
                f"I have completed the requested task: {test_case.name}. "
                f"{test_case.expected_response or 'All steps executed successfully.'}"
            )
        else:
            failure_reasons = [
                f"I attempted to handle '{test_case.name}' but encountered issues. ",
                f"Partial completion of '{test_case.name}'. ",
                f"I processed the request for '{test_case.name}' but missed some steps. ",
            ]
            response_text = random.choice(failure_reasons)
            if test_case.expected_response:
                # Include a partial/garbled version of the expected response
                words = test_case.expected_response.split()
                partial = " ".join(words[:len(words)//2])
                response_text += f"Attempted: {partial}..."

        return {
            "response": response_text,
            "tool_calls": tool_calls,
        }

    async def _unload_ollama_model(self, model_name: str):
        """Tell Ollama to immediately unload a model from GPU memory.

        Feature: rubric-evaluation
        When the CUA agent model (e.g. qwen3-vl:8b ~8GB) is still resident in GPU
        memory and the judge model needs to load, Ollama can OOM and crash. This
        sends a keep_alive=0 request to force-unload the agent model before judging.
        """
        try:
            ollama_host = os.getenv("OLLAMA_HOST", "http://localhost:11434")
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{ollama_host}/api/generate",
                    json={"model": model_name, "keep_alive": 0},
                )
                if resp.status_code == 200:
                    logger.info(f"Unloaded Ollama model '{model_name}' from GPU memory")
                else:
                    logger.warning(f"Failed to unload model '{model_name}': HTTP {resp.status_code}")
        except Exception as e:
            logger.warning(f"Could not unload Ollama model '{model_name}': {e}")

    async def _execute_test(self, eval_run: EvaluationRun, test_exec: _TestExecution, test_case):
        """Execute a single test against the agent endpoint with retry logic for rate limits."""
        test_exec.agent_call_start = time.time()

        # ── Demo mode: generate synthetic response instead of HTTP call ──
        if getattr(eval_run, 'demo_mode', False):
            await asyncio.sleep(random.uniform(0.3, 1.5))  # simulate latency
            mock = self._generate_mock_response(test_case, eval_run)
            test_exec.agent_response = mock["response"]
            test_exec.tool_calls = mock["tool_calls"]
            test_exec.actual_tools = [
                t.get("name") if isinstance(t, dict) else str(t)
                for t in mock["tool_calls"]
            ]
            test_exec.status = "completed"
            test_exec.agent_call_duration = time.time() - test_exec.agent_call_start
            logger.info(f"[demo-mode] Mock response generated for test {test_case.id}")
            return

        async def _make_agent_call():
            """Inner function to make the agent HTTP call (for retry wrapper)."""
            # Use a generous timeout for browser automation agents — vision model
            # inference + multi-step browser tasks can easily exceed 5 minutes.
            # The timeout covers the entire agent execution (all steps).
            agent_timeout = max(eval_run.timeout_seconds, 600)  # at least 10 minutes
            async with httpx.AsyncClient(timeout=httpx.Timeout(agent_timeout, connect=30.0)) as client:
                headers = {
                    "Content-Type": "application/json",
                    "X-CorrelationId": eval_run.id,
                    "X-TestCaseId": test_case.id
                }

                # Prepare request payload
                payload = {
                    "dataset_id": eval_run.dataset_id,
                    "test_case_id": test_case.id,
                    "agent_id": eval_run.agent_id,
                    "evaluation_run_id": eval_run.id,
                    "input": test_case.input
                }

                # Include system prompt if this eval is bound to a prompt version
                cached_prompt = getattr(eval_run, '_cached_prompt_text', None)
                if cached_prompt:
                    payload["system_prompt"] = cached_prompt

                # Call agent endpoint
                response = await client.post(
                    eval_run.agent_endpoint,
                    json=payload,
                    headers=headers
                )
                
                # Check for rate limit in response
                if response.status_code == 429:
                    raise Exception(f"HTTP 429: Rate limit reached - {response.text}")
                
                # Check for 500 errors that contain rate limit info
                if response.status_code == 500:
                    response_text = response.text
                    if '429' in response_text or 'RateLimitReached' in response_text:
                        raise Exception(f"HTTP 500 (rate limit): {response_text}")
                
                return response
        
        async def _on_agent_retry(attempt: int, max_attempts: int, wait_time: float, error: str):
            """Callback to log retry attempts to status history."""
            await self._update_status_message(
                eval_run.id,
                f"⚠️ Agent call rate limit (attempt {attempt}/{max_attempts}). Waiting {wait_time:.1f}s before retry...",
                is_rate_limit=True,
                retry_attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait_time
            )
        
        # ── Countdown ticker — polls agent /progress and updates UI ────
        _countdown_done = asyncio.Event()

        async def _countdown_ticker():
            """Background task: poll agent's /progress endpoint and update status."""
            from urllib.parse import urlparse
            parsed = urlparse(eval_run.agent_endpoint)
            progress_url = f"{parsed.scheme}://{parsed.netloc}/progress"
            test_name = test_case.name or test_case.id

            await asyncio.sleep(2)  # let the agent spin up before first poll
            while not _countdown_done.is_set():
                # Stop polling if evaluation was cancelled
                if eval_run.id in self._cancelled_evals:
                    break
                try:
                    async with httpx.AsyncClient(timeout=3.0) as pc:
                        pr = await pc.get(progress_url)
                        if pr.status_code == 200:
                            d = pr.json()
                            step = d.get("current_step", 0)
                            max_steps = d.get("max_steps", 15)
                            phase = d.get("phase", "?")
                            remaining = d.get("step_remaining_seconds", 0)
                            timeout_val = d.get("action_timeout", 30)
                            elapsed_total = time.time() - test_exec.agent_call_start

                            # Build a progress bar: ████░░░░ 15s / 30s
                            bar_len = 10
                            filled = int(bar_len * (1 - remaining / timeout_val)) if timeout_val else 0
                            bar = "█" * filled + "░" * (bar_len - filled)

                            msg = (
                                f"🤖 {test_name}  •  "
                                f"Step {step}/{max_steps} ({phase})  "
                                f"{bar} {remaining:.0f}s left  •  "
                                f"Total: {elapsed_total:.0f}s"
                            )
                            await self._update_status_message(eval_run.id, msg)
                except Exception:
                    pass  # progress endpoint unavailable — skip silently
                try:
                    await asyncio.wait_for(_countdown_done.wait(), timeout=3.0)
                    break
                except asyncio.TimeoutError:
                    pass  # loop again

        countdown_task = asyncio.create_task(_countdown_ticker())

        try:
            # Use retry wrapper for the agent call
            retry_result = await retry_with_backoff(_make_agent_call, on_retry=_on_agent_retry)
            response = retry_result.result

            # Track retries for visibility
            test_exec.retry_count += retry_result.retry_count
            if retry_result.had_rate_limit:
                test_exec.had_rate_limit = True

            if response.status_code == 200:
                result_data = response.json()
                test_exec.agent_response = result_data.get("response", "")

                # Extract tool calls
                tool_call_data = result_data.get("tool_calls", [])
                test_exec.tool_calls = tool_call_data
                test_exec.actual_tools = [
                    tool.get("name") if isinstance(tool, dict) else str(tool)
                    for tool in tool_call_data
                ]

                # Check if the agent was cancelled
                metadata = result_data.get("metadata", {})
                if metadata.get("cancelled"):
                    test_exec.status = "skipped"
                    test_exec.error_message = "Task cancelled"
                    logger.info(f"Agent reported task cancelled for test {test_case.id}")
                    test_exec.agent_call_duration = time.time() - test_exec.agent_call_start
                    return

                # Check if the agent aborted early (stuck detection)
                failure_reason = metadata.get("failure_reason")
                if failure_reason:
                    test_exec.status = "failed"
                    test_exec.error_message = f"Agent aborted: {failure_reason}"
                    steps_taken = metadata.get("steps_taken", "?")
                    duration = metadata.get("duration_seconds", "?")
                    logger.warning(
                        f"Agent aborted for test {test_case.id}: {failure_reason} "
                        f"(steps={steps_taken}, duration={duration}s)"
                    )
                else:
                    test_exec.status = "completed"
                    logger.info(f"Agent call successful for test {test_case.id}")

            else:
                test_exec.status = "failed"
                detail = response.text[:500] if response.text else "No response body"
                test_exec.error_message = (
                    f"HTTP {response.status_code} from {eval_run.agent_endpoint}: {detail}"
                )
                logger.error(
                    f"Agent call failed for test {test_case.id}: "
                    f"POST {eval_run.agent_endpoint} → {response.status_code}"
                )

        except httpx.TimeoutException as e:
            test_exec.status = "failed"
            elapsed = time.time() - test_exec.agent_call_start
            test_exec.error_message = (
                f"Timeout after {elapsed:.0f}s waiting for agent at {eval_run.agent_endpoint}. "
                f"The agent may still be running a browser task. "
                f"Try increasing EVALUATION_TIMEOUT_SECONDS (currently {eval_run.timeout_seconds}s)."
            )
            logger.error(
                f"Timeout during test {test_case.id}: {type(e).__name__} after {elapsed:.0f}s "
                f"(limit: {eval_run.timeout_seconds}s)"
            )
        except httpx.ConnectError:
            test_exec.status = "failed"
            test_exec.error_message = (
                f"Could not connect to agent at {eval_run.agent_endpoint}. "
                f"Make sure the agent server is running."
            )
            logger.error(f"Connection refused for test {test_case.id}: {eval_run.agent_endpoint}")
        except Exception as e:
            test_exec.status = "failed"
            error_detail = f"{type(e).__name__}: {str(e)}" if str(e) else type(e).__name__
            test_exec.error_message = f"POST {eval_run.agent_endpoint}: {error_detail}"
            logger.error(f"Exception during test execution {test_case.id}: POST {eval_run.agent_endpoint}: {error_detail}")
        finally:
            # Stop the countdown ticker
            _countdown_done.set()
            countdown_task.cancel()
            try:
                await countdown_task
            except (Exception, asyncio.CancelledError):
                pass
            # Record agent call duration
            test_exec.agent_call_duration = time.time() - test_exec.agent_call_start
    
    async def _judge_and_build_result(self, eval_run: EvaluationRun, test_exec: _TestExecution, test_case):
        """Judge test execution and build TestCaseResult directly."""
        # Skip if execution failed
        if test_exec.status != "completed":
            logger.warning(f"Skipping judge for test {test_case.id} - execution status: {test_exec.status}")
            return
        
        # Start timing the judge phase
        test_exec.judge_call_start = time.time()
        
        # Initialize OpenAI client if needed
        self.OpenAIClientInitialization()
        
        try:
            # Get agent output as string
            response_from_agent = test_exec.agent_response

            # ==============================================================
            # ASSERTION MODE RESOLUTION (Feature: 3-tier-assertions)
            # ==============================================================
            assertion_mode = getattr(test_case, 'assertion_mode', None) or "response_only"
            mode_behavior = _get_evaluation_mode_behavior(assertion_mode)

            if eval_run.verbose_logging:
                await self._update_status_message(
                    eval_run.id,
                    f"  📋 Assertion mode: {assertion_mode}"
                )

            # ----------------------------------------------------------
            # RUBRIC MODE SHORT-CIRCUIT (Feature: rubric-evaluation)
            # ----------------------------------------------------------
            judge_cfg = getattr(eval_run, '_cached_judge_config', None) or _DEFAULT_JUDGE_CONFIG
            scoring_mode = judge_cfg.get('scoring_mode', 'binary')

            if scoring_mode == 'rubric' and judge_cfg.get('rubric'):
                if eval_run.verbose_logging:
                    await self._update_status_message(
                        eval_run.id,
                        f"  📋 Using rubric scoring mode ({len(judge_cfg['rubric'])} criteria)"
                    )

                rubric_result = await self._evaluate_test_case_with_rubric(
                    eval_run, test_exec, test_case
                )

                if rubric_result is not None:
                    # Record judge call duration
                    test_exec.judge_call_duration = time.time() - test_exec.judge_call_start if test_exec.judge_call_start else 0
                    test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0

                    # Build TestCaseResult with rubric scores
                    test_exec.test_case_result = TestCaseResult(
                        testcase_id=test_case.id,
                        passed=rubric_result["passed"],
                        response_from_agent=response_from_agent,
                        expected_tools=[],
                        tool_expectations=[],
                        behavior_assertions=[],
                        response_quality_assertion=None,
                        assertion_mode=assertion_mode,
                        actual_tool_calls=test_exec.tool_calls,
                        execution_error=None,
                        rubric_scores=rubric_result["rubric_scores"],
                        rubric_average_score=rubric_result["rubric_average_score"],
                        retry_count=test_exec.retry_count,
                        completed_at=datetime.now(timezone.utc),
                        agent_call_duration_seconds=test_exec.agent_call_duration,
                        judge_call_duration_seconds=test_exec.judge_call_duration,
                        total_duration_seconds=test_exec.total_duration
                    )

                    logger.info(
                        f"Test case {test_case.id} judged (rubric): passed={rubric_result['passed']}, "
                        f"avg_score={rubric_result['rubric_average_score']}"
                    )
                    return  # Done — skip binary evaluation below

                # rubric_result is None → fall through to binary evaluation
                logger.warning(f"Rubric evaluation failed for {test_case.id} — falling back to binary mode")

            # ----------------------------------------------------------
            # 1. Check expected tools (tool_level mode only)
            # ----------------------------------------------------------
            expected_tools = []
            all_tools_called = True

            if mode_behavior["eval_expected_tools"]:
                for tool_name in test_case.minimal_tool_set:
                    was_called = tool_name in test_exec.actual_tools
                    expected_tools.append(ExpectedToolResult(
                        name_of_tool=tool_name,
                        was_called=was_called
                    ))
                all_tools_called = all(tool.was_called for tool in expected_tools) if expected_tools else True

            # ----------------------------------------------------------
            # 2. Evaluate tool-level assertions (tool_level mode only)
            # ----------------------------------------------------------
            tool_expectations = []
            all_tool_assertions_passed = True

            if mode_behavior["eval_tool_assertions"]:
                # Pre-compute tool summary for verbose logging
                if eval_run.verbose_logging:
                    from collections import defaultdict
                    tool_summary = defaultdict(lambda: {'calls': 0, 'assertions': 0})
                    for tool_exp in test_case.tool_expectations:
                        total_assertions = sum(len(arg.assertion) for arg in tool_exp.arguments)
                        tool_summary[tool_exp.name]['calls'] += 1
                        tool_summary[tool_exp.name]['assertions'] += total_assertions

                    for tool_name, stats in tool_summary.items():
                        calls_text = f"{stats['calls']} call" + ("s" if stats['calls'] > 1 else "")
                        await self._update_status_message(
                            eval_run.id,
                            f"  📋 Evaluating {tool_name} ({calls_text}, {stats['assertions']} assertions)"
                        )

                for tool_idx, tool_exp in enumerate(test_case.tool_expectations):
                    tool_was_called = tool_exp.name in test_exec.actual_tools

                    if not tool_was_called:
                        arg_results = []
                        for arg_assertion in tool_exp.arguments:
                            assertions = [
                                AssertionResult(
                                    passed=False,
                                    llm_judge_output=f"Tool '{tool_exp.name}' was not called; cannot evaluate argument assertions."
                                )
                                for _ in arg_assertion.assertion
                            ]
                            arg_results.append(ArgumentAssertionResult(
                                name_of_argument=arg_assertion.name,
                                assertions=assertions
                            ))
                        all_tool_assertions_passed = False
                    else:
                        batched_result = await self._evaluate_tool_assertions_batched(
                            eval_run=eval_run,
                            tool_exp=tool_exp,
                            test_case=test_case,
                            test_exec=test_exec
                        )

                        if batched_result is not None:
                            arg_results = batched_result
                            for arg_result in arg_results:
                                for assertion in arg_result.assertions:
                                    if not assertion.passed:
                                        all_tool_assertions_passed = False
                        else:
                            arg_results = []
                            for arg_assertion in tool_exp.arguments:
                                assertions = []
                                for assertion_text in arg_assertion.assertion:
                                    result = _try_deterministic_assertion(
                                        assertion_text, arg_assertion.name,
                                        tool_exp.name, test_exec.tool_calls
                                    )
                                    if result is None:
                                        result = await self._evaluate_single_assertion(
                                            eval_run=eval_run,
                                            assertion_text=assertion_text,
                                            tool_name=tool_exp.name,
                                            argument_name=arg_assertion.name,
                                            test_case=test_case,
                                            test_exec=test_exec,
                                            assertion_type="tool_argument"
                                        )
                                    else:
                                        logger.info(f"Deterministic assertion: '{assertion_text}' → {result['passed']}")
                                    assertions.append(AssertionResult(
                                        passed=result['passed'],
                                        llm_judge_output=result['reasoning']
                                    ))
                                    if not result['passed']:
                                        all_tool_assertions_passed = False
                                arg_results.append(ArgumentAssertionResult(
                                    name_of_argument=arg_assertion.name,
                                    assertions=assertions
                                ))

                    tool_expectations.append(ToolExpectationResult(
                        name_of_tool=tool_exp.name,
                        arguments=arg_results
                    ))

                # Log aggregated tool results in verbose mode
                if eval_run.verbose_logging and tool_expectations:
                    for tool_result in tool_expectations:
                        passed_args = sum(1 for arg in tool_result.arguments
                                         if all(a.passed for a in arg.assertions))
                        total_args = len(tool_result.arguments)
                        icon = "✓" if passed_args == total_args else "✗"
                        await self._update_status_message(
                            eval_run.id,
                            f"  {icon} {tool_result.name_of_tool}: {passed_args}/{total_args} arguments passed"
                        )

            # ----------------------------------------------------------
            # 3. Evaluate behavior assertions (hybrid mode only)
            # ----------------------------------------------------------
            behavior_assertions_result = []
            behavior_assertions_passed = True

            if mode_behavior["eval_behavior_assertions"]:
                behavior_assertions_result, behavior_assertions_passed = \
                    await self._evaluate_behavior_assertions(
                        eval_run, test_case.behavior_assertions, test_case, test_exec
                    )

            # ----------------------------------------------------------
            # 4. Evaluate response quality assertion (all modes)
            # ----------------------------------------------------------
            response_quality = None
            response_quality_passed = True

            if mode_behavior["eval_response_quality"] and \
               test_case.response_quality_expectation and \
               hasattr(test_case.response_quality_expectation, 'assertion'):
                if eval_run.verbose_logging:
                    await self._update_status_message(
                        eval_run.id,
                        f"  📋 Evaluating response quality assertion"
                    )

                result = await self._evaluate_single_assertion(
                    eval_run=eval_run,
                    assertion_text=test_case.response_quality_expectation.assertion,
                    tool_name=None,
                    argument_name=None,
                    test_case=test_case,
                    test_exec=test_exec,
                    assertion_type="response_quality"
                )

                response_quality = ResponseQualityResult(
                    passed=result['passed'],
                    llm_judge_output=result['reasoning']
                )
                response_quality_passed = result['passed']

                if eval_run.verbose_logging:
                    icon = "✓" if response_quality_passed else "✗"
                    await self._update_status_message(
                        eval_run.id,
                        f"  {icon} Response quality: {'passed' if response_quality_passed else 'failed'}"
                    )

            # ----------------------------------------------------------
            # 5. Calculate overall passed status (mode-dependent)
            # ----------------------------------------------------------
            if assertion_mode == "response_only":
                overall_passed = response_quality_passed
            elif assertion_mode == "tool_level":
                overall_passed = all_tools_called and all_tool_assertions_passed and response_quality_passed
            elif assertion_mode == "hybrid":
                overall_passed = behavior_assertions_passed and response_quality_passed
            else:
                overall_passed = response_quality_passed  # safe fallback

            # Record judge call duration
            test_exec.judge_call_duration = time.time() - test_exec.judge_call_start if test_exec.judge_call_start else 0
            test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0

            # ----------------------------------------------------------
            # 6. Build final TestCaseResult
            # ----------------------------------------------------------
            test_exec.test_case_result = TestCaseResult(
                testcase_id=test_case.id,
                passed=overall_passed,
                response_from_agent=response_from_agent,
                expected_tools=expected_tools,
                tool_expectations=tool_expectations,
                behavior_assertions=behavior_assertions_result,
                response_quality_assertion=response_quality,
                assertion_mode=assertion_mode,
                actual_tool_calls=test_exec.tool_calls,
                execution_error=None,
                retry_count=test_exec.retry_count,
                completed_at=datetime.now(timezone.utc),
                agent_call_duration_seconds=test_exec.agent_call_duration,
                judge_call_duration_seconds=test_exec.judge_call_duration,
                total_duration_seconds=test_exec.total_duration
            )

            logger.info(f"Test case {test_case.id} judged: mode={assertion_mode}, passed={overall_passed} "
                       f"(tools: {all_tools_called}, tool_assertions: {all_tool_assertions_passed}, "
                       f"behavior: {behavior_assertions_passed}, quality: {response_quality_passed})")
            
        except ConnectionError as e:
            # LLM judge is unreachable — this is an infrastructure error, not a test failure
            logger.error(f"JUDGE UNREACHABLE for test {test_case.id}: {str(e)}")
            test_exec.judge_call_duration = time.time() - test_exec.judge_call_start if test_exec.judge_call_start else 0
            test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0
            test_exec.test_case_result = TestCaseResult(
                testcase_id=test_case.id,
                passed=False,
                response_from_agent=test_exec.agent_response or "",
                expected_tools=[],
                tool_expectations=[],
                response_quality_assertion=None,
                actual_tool_calls=test_exec.tool_calls,
                execution_error=f"JUDGE UNREACHABLE: {str(e)} — Check LLM_BASE_URL / LLM_API_KEY in .env.",
                retry_count=test_exec.retry_count,
                completed_at=datetime.now(timezone.utc),
                agent_call_duration_seconds=test_exec.agent_call_duration,
                judge_call_duration_seconds=test_exec.judge_call_duration,
                total_duration_seconds=test_exec.total_duration
            )
            # Update eval run status to make the problem visible
            await self._update_status_message(
                eval_run.id,
                f"⚠ JUDGE ERROR: LLM endpoint not reachable. Check LLM_BASE_URL / LLM_API_KEY in .env."
            )
        except Exception as e:
            logger.error(f"Error judging test {test_case.id}: {str(e)}")
            test_exec.judge_call_duration = time.time() - test_exec.judge_call_start if test_exec.judge_call_start else 0
            test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0
            test_exec.test_case_result = TestCaseResult(
                testcase_id=test_case.id,
                passed=False,
                response_from_agent=test_exec.agent_response or "",
                expected_tools=[],
                tool_expectations=[],
                response_quality_assertion=None,
                actual_tool_calls=test_exec.tool_calls,
                execution_error=f"Judge error: {str(e)}",
                retry_count=test_exec.retry_count,
                completed_at=datetime.now(timezone.utc),
                agent_call_duration_seconds=test_exec.agent_call_duration,
                judge_call_duration_seconds=test_exec.judge_call_duration,
                total_duration_seconds=test_exec.total_duration
            )
    
    async def _evaluate_test_case_with_rubric(
        self, eval_run: EvaluationRun, test_exec, test_case
    ) -> dict:
        """Evaluate an entire test case holistically using rubric scoring.

        Feature: rubric-evaluation
        Instead of per-assertion binary pass/fail, this evaluates the full test
        case against all rubric criteria in a single LLM call. Returns scored
        criteria (1-5 each) and derives overall pass/fail from the average.

        Returns dict with keys: rubric_scores, rubric_average_score, passed
        """
        judge_cfg = getattr(eval_run, '_cached_judge_config', None) or _DEFAULT_JUDGE_CONFIG
        rubric_criteria = judge_cfg.get('rubric', [])
        pass_threshold = judge_cfg.get('pass_threshold') or 3.0

        if not rubric_criteria:
            logger.warning(f"Rubric mode but no criteria defined — falling back to binary")
            return None  # caller should fall back to binary

        # Build rubric description block for the prompt
        rubric_lines = []
        for criterion in rubric_criteria:
            c_name = criterion.get('name', 'unnamed')
            c_desc = criterion.get('description', '')
            rubric_lines.append(f"\n### {c_name}")
            if c_desc:
                rubric_lines.append(f"{c_desc}")
            for level in criterion.get('levels', []):
                rubric_lines.append(f"  - Score {level['score']}: {level['description']}")
        rubric_text = "\n".join(rubric_lines)

        # Build the assertions summary for context
        assertions_summary = []
        if hasattr(test_case, 'tool_expectations'):
            for tool_exp in test_case.tool_expectations:
                for arg in tool_exp.arguments:
                    for a in arg.assertion:
                        assertions_summary.append(f"- [{tool_exp.name}.{arg.name}] {a}")
        if hasattr(test_case, 'behavior_assertions'):
            for ba in (test_case.behavior_assertions or []):
                assertions_summary.append(f"- [behavior] {ba.assertion}")
        if hasattr(test_case, 'response_quality_expectation') and test_case.response_quality_expectation:
            assertions_summary.append(f"- [response_quality] {test_case.response_quality_expectation.assertion}")

        assertions_block = "\n".join(assertions_summary) if assertions_summary else "No specific assertions defined."

        # Build the rubric evaluation prompt
        system_prompt = judge_cfg['system_prompt']
        criteria_names = [c.get('name', 'unnamed') for c in rubric_criteria]

        user_prompt = (
            f"You are evaluating an AI agent's performance on a test case using a rubric scoring system.\n"
            f"\n"
            f"**Test Context:**\n"
            f"- Input: {getattr(test_case, 'input', '')}\n"
            f"- Description: {getattr(test_case, 'description', '')}\n"
            f"- Expected Response: {getattr(test_case, 'expected_response', '') or 'N/A'}\n"
            f"\n"
            f"**Agent's Actual Performance:**\n"
            f"- Tool Calls: {json.dumps(test_exec.tool_calls, indent=2) if hasattr(test_exec, 'tool_calls') else '[]'}\n"
            f"- Tools Used: {', '.join(test_exec.actual_tools) if hasattr(test_exec, 'actual_tools') else 'none'}\n"
            f"- Agent Response: {test_exec.agent_response if hasattr(test_exec, 'agent_response') else 'No output'}\n"
            f"\n"
            f"**Assertions (for reference):**\n"
            f"{assertions_block}\n"
            f"\n"
            f"**Rubric Criteria (score each 1-5):**\n"
            f"{rubric_text}\n"
            f"\n"
            f"**Task:** Score the agent's performance on EACH criterion above using the provided scale.\n"
            f"For each criterion, assign a score (1-5) and provide a one-sentence reasoning.\n"
            f"\n"
            f"Respond with ONLY a JSON object:\n"
            f"{{\n"
            f"    \"scores\": [\n"
            f"        {{\"criterion\": \"{criteria_names[0] if criteria_names else 'example'}\", \"score\": 4, \"reasoning\": \"One sentence explanation.\"}}"
        )
        if len(criteria_names) > 1:
            user_prompt += f",\n        {{\"criterion\": \"{criteria_names[1]}\", \"score\": 3, \"reasoning\": \"One sentence explanation.\"}}"
        user_prompt += (
            f"\n    ]\n"
            f"}}"
        )

        async def _on_judge_retry(attempt: int, max_attempts: int, wait_time: float, error: str):
            await self._update_status_message(
                eval_run.id,
                f"⚠️ LLM judge rate limit (rubric, attempt {attempt}/{max_attempts}). Waiting {wait_time:.1f}s...",
                is_rate_limit=True,
                retry_attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait_time
            )

        async def _call_llm_judge():
            response = await asyncio.to_thread(
                self.openai_client.chat.completions.create,
                model=config.LLM_MODEL,
                messages=messages,
            )
            return response

        try:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]

            retry_result = await retry_with_backoff(_call_llm_judge, on_retry=_on_judge_retry)
            response = retry_result.result

            test_exec.retry_count += retry_result.retry_count
            if retry_result.had_rate_limit:
                test_exec.had_rate_limit = True

            # Token tracking
            try:
                usage = getattr(response, 'usage', None)
                if usage:
                    _j_in = getattr(usage, 'prompt_tokens', 0) or 0
                    _j_out = getattr(usage, 'completion_tokens', 0) or 0
                    test_exec.judge_tokens_in += _j_in
                    test_exec.judge_tokens_out += _j_out
                    _j_cost = await self._record_cost(
                        "judge_llm", config.LLM_MODEL, _j_in, _j_out,
                        evaluation_id=test_exec.eval_run_id,
                        test_case_id=test_exec.test_case_id,
                        agent_id=test_exec.agent_id,
                    )
                    test_exec.judge_cost_usd += _j_cost
            except Exception as _e:
                logger.debug(f"Token capture (rubric) failed: {_e}")

            content = response.choices[0].message.content.strip()
            logger.debug(f"LLM rubric response: {content[:300]}...")

            try:
                result = _extract_json(content)
            except json.JSONDecodeError as je:
                logger.error(f"Failed to parse rubric LLM response as JSON: {content[:500]}")
                return None  # fall back to binary

            scores_raw = result.get("scores", [])
            if not scores_raw:
                logger.error(f"Rubric response missing 'scores' array")
                return None

            from .models import RubricScoreResult
            rubric_scores = []
            for s in scores_raw:
                try:
                    rubric_scores.append(RubricScoreResult(
                        criterion=str(s.get("criterion", "unknown")),
                        score=max(1, min(5, int(s.get("score", 1)))),
                        reasoning=str(s.get("reasoning", "No reasoning provided"))
                    ))
                except (ValueError, TypeError) as e:
                    logger.warning(f"Skipping malformed rubric score: {s} — {e}")

            if not rubric_scores:
                logger.error(f"No valid rubric scores parsed from LLM response")
                return None

            avg_score = sum(s.score for s in rubric_scores) / len(rubric_scores)
            passed = avg_score >= pass_threshold

            logger.info(
                f"Rubric evaluation for {test_case.id}: avg={avg_score:.2f}, "
                f"threshold={pass_threshold}, passed={passed}, "
                f"scores={[(s.criterion, s.score) for s in rubric_scores]}"
            )

            return {
                "rubric_scores": rubric_scores,
                "rubric_average_score": round(avg_score, 2),
                "passed": passed,
            }

        except Exception as e:
            logger.error(f"Error in rubric evaluation for test {test_case.id}: {str(e)}", exc_info=True)
            return None  # fall back to binary

    async def _evaluate_tool_assertions_batched(self, eval_run: EvaluationRun, tool_exp, test_case, test_exec):
        """Evaluate ALL assertions for a single tool call in one LLM request.

        Feature: assertion-batching
        Instead of making one LLM call per assertion, this method batches all
        argument assertions for a tool into a single prompt. The LLM returns
        a structured JSON array with per-assertion results.

        Returns:
            List[ArgumentAssertionResult] ready to use, or None if batching
            failed and caller should fall back to single-assertion evaluation.
        """
        # Build the assertion list for the prompt
        assertion_items = []
        assertion_index = 0
        for arg_assertion in tool_exp.arguments:
            for assertion_text in arg_assertion.assertion:
                assertion_items.append({
                    "index": assertion_index,
                    "argument": arg_assertion.name,
                    "assertion": assertion_text
                })
                assertion_index += 1

        # Not worth batching if only 1 assertion
        if len(assertion_items) <= 1:
            return None

        # Try deterministic evaluation for all assertions first
        deterministic_results = {}
        for item in assertion_items:
            det_result = _try_deterministic_assertion(
                item["assertion"], item["argument"],
                tool_exp.name, test_exec.tool_calls
            )
            if det_result is not None:
                deterministic_results[item["index"]] = det_result
                logger.info(f"Deterministic assertion [{item['index']}]: '{item['assertion']}' → {det_result['passed']}")

        # If ALL assertions were resolved deterministically, skip the LLM entirely
        if len(deterministic_results) == len(assertion_items):
            logger.info(f"All {len(assertion_items)} assertions for '{tool_exp.name}' resolved deterministically — skipping LLM")
            arg_results = []
            result_idx = 0
            for arg_assertion in tool_exp.arguments:
                assertions = []
                for _ in arg_assertion.assertion:
                    r = deterministic_results[result_idx]
                    assertions.append(AssertionResult(
                        passed=r["passed"],
                        llm_judge_output=r["reasoning"]
                    ))
                    result_idx += 1
                arg_results.append(ArgumentAssertionResult(
                    name_of_argument=arg_assertion.name,
                    assertions=assertions
                ))
            return arg_results

        logger.info(f"Batching {len(assertion_items)} assertions for tool '{tool_exp.name}' into single LLM call")

        # Build the assertions block text
        assertions_block = "\n".join(
            f"  [{item['index']}] Argument: {item['argument']} — Assertion: {item['assertion']}"
            for item in assertion_items
        )

        # Render prompt from judge config template
        judge_cfg = getattr(eval_run, '_cached_judge_config', None) or _DEFAULT_JUDGE_CONFIG
        ctx = _build_template_context(
            test_case, test_exec, tool_exp=tool_exp,
            assertions_block=assertions_block,
        )
        batch_prompt = _render_template(judge_cfg['user_prompt_template_batched'], ctx)
        system_prompt = judge_cfg['system_prompt']

        async def _on_judge_retry(attempt: int, max_attempts: int, wait_time: float, error: str):
            await self._update_status_message(
                eval_run.id,
                f"⚠️ LLM judge rate limit (attempt {attempt}/{max_attempts}). Waiting {wait_time:.1f}s...",
                is_rate_limit=True,
                retry_attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait_time
            )

        async def _call_llm_batch():
            response = await asyncio.to_thread(
                self.openai_client.chat.completions.create,
                model=config.LLM_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": batch_prompt}
                ],
            )
            return response

        try:
            retry_result = await retry_with_backoff(_call_llm_batch, on_retry=_on_judge_retry)
            response = retry_result.result

            test_exec.retry_count += retry_result.retry_count
            if retry_result.had_rate_limit:
                test_exec.had_rate_limit = True

            # ==== TOKEN CAPTURE (Feature: cost-attribution) ====
            try:
                usage = getattr(response, 'usage', None)
                if usage:
                    _j_in = getattr(usage, 'prompt_tokens', 0) or 0
                    _j_out = getattr(usage, 'completion_tokens', 0) or 0
                    test_exec.judge_tokens_in += _j_in
                    test_exec.judge_tokens_out += _j_out
                    _j_cost = await self._record_cost(
                        "judge_llm", config.LLM_MODEL, _j_in, _j_out,
                        evaluation_id=test_exec.eval_run_id,
                        test_case_id=test_exec.test_case_id,
                        agent_id=test_exec.agent_id,
                    )
                    test_exec.judge_cost_usd += _j_cost
            except Exception as _e:
                logger.debug(f"Token capture (batch) failed: {_e}")

            content = response.choices[0].message.content.strip()
            logger.debug(f"Batched LLM response: {content[:500]}...")

            parsed = _extract_json(content)
            results_list = parsed.get("results", [])

            # Validate we got the right number of results
            if len(results_list) != len(assertion_items):
                logger.warning(
                    f"Batched response returned {len(results_list)} results, "
                    f"expected {len(assertion_items)}. Falling back to single-assertion evaluation."
                )
                return None

            # Build ArgumentAssertionResult list from the batched response
            arg_results = []
            result_idx = 0
            for arg_assertion in tool_exp.arguments:
                assertions = []
                for _ in arg_assertion.assertion:
                    r = results_list[result_idx]
                    assertions.append(AssertionResult(
                        passed=_to_bool(r.get("passed", False)),
                        llm_judge_output=r.get("reasoning", "No reasoning provided")
                    ))
                    result_idx += 1
                arg_results.append(ArgumentAssertionResult(
                    name_of_argument=arg_assertion.name,
                    assertions=assertions
                ))

            logger.info(f"Batched evaluation for '{tool_exp.name}' complete: "
                       f"{sum(1 for r in results_list if r.get('passed'))} passed, "
                       f"{sum(1 for r in results_list if not r.get('passed'))} failed")
            return arg_results

        except json.JSONDecodeError as je:
            logger.warning(f"Failed to parse batched LLM response as JSON: {je}. Falling back to single evaluation.")
            return None
        except Exception as e:
            logger.warning(f"Batched assertion evaluation failed: {e}. Falling back to single evaluation.")
            return None

    async def _evaluate_single_assertion(self, eval_run: EvaluationRun, assertion_text, tool_name, argument_name, test_case, test_exec, assertion_type):
        """Evaluate a single assertion and return pass/fail result.

        Uses the judge config template stored on the eval run (or the built-in
        default).  For tool_argument assertions the {{assertion_context}} is
        filled with tool/arg details; for response_quality it gets the agent
        output and expected response.
        """

        async def _on_judge_retry(attempt: int, max_attempts: int, wait_time: float, error: str):
            """Callback to log LLM judge retry attempts to status history."""
            await self._update_status_message(
                eval_run.id,
                f"⚠️ LLM judge rate limit (attempt {attempt}/{max_attempts}). Waiting {wait_time:.1f}s...",
                is_rate_limit=True,
                retry_attempt=attempt,
                max_attempts=max_attempts,
                wait_seconds=wait_time
            )

        # Build assertion-type-specific context block
        if assertion_type == "tool_argument":
            assertion_context = (
                f"**Tool:** {tool_name}\n"
                f"**Argument:** {argument_name}\n"
                f"**Assertion:** {assertion_text}\n"
                f"\n"
                f"**Agent's Tool Calls:** {json.dumps(test_exec.tool_calls, indent=2)}\n"
                f"**Actual Tools Used:** {', '.join(test_exec.actual_tools)}\n"
                f"\n"
                f"Evaluate if the agent's tool usage satisfies this specific assertion."
            )
        elif assertion_type == "behavior":
            # Behavior assertions get full trace context (tools + response)
            assertion_context = (
                f"**Behavior Assertion:** {assertion_text}\n"
                f"\n"
                f"**Agent's Tool Calls:** {json.dumps(test_exec.tool_calls, indent=2)}\n"
                f"**Agent Output:** {test_exec.agent_response if test_exec.agent_response else 'No output'}\n"
                f"**Expected Response:** {test_case.expected_response}\n"
                f"\n"
                f"Evaluate if the agent's overall behavior (tool calls AND response) satisfies this assertion."
            )
        else:  # response_quality
            assertion_context = (
                f"**Response Quality Assertion:** {assertion_text}\n"
                f"\n"
                f"**Agent Output:** {test_exec.agent_response if test_exec.agent_response else 'No output'}\n"
                f"**Expected Response:** {test_case.expected_response}\n"
                f"\n"
                f"Evaluate if the agent's response satisfies this quality assertion."
            )

        # Render from judge config template
        judge_cfg = getattr(eval_run, '_cached_judge_config', None) or _DEFAULT_JUDGE_CONFIG
        ctx = _build_template_context(
            test_case, test_exec,
            argument_name=argument_name,
            assertion_text=assertion_text,
        )
        # Add assertion_context as a special variable for the single template
        ctx["assertion_context"] = assertion_context
        judge_prompt = _render_template(judge_cfg['user_prompt_template_single'], ctx)
        system_prompt = judge_cfg['system_prompt']

        async def _call_llm_judge():
            """Inner function to call the LLM judge (for retry wrapper)."""
            response = await asyncio.to_thread(
                self.openai_client.chat.completions.create,
                model=config.LLM_MODEL,
                messages=messages,
            )
            return response

        try:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": judge_prompt}
            ]

            # Use retry wrapper for the LLM call with status updates
            retry_result = await retry_with_backoff(_call_llm_judge, on_retry=_on_judge_retry)
            response = retry_result.result

            # Track retries for visibility
            test_exec.retry_count += retry_result.retry_count
            if retry_result.had_rate_limit:
                test_exec.had_rate_limit = True

            # ==== TOKEN CAPTURE (Feature: cost-attribution) ====
            try:
                usage = getattr(response, 'usage', None)
                if usage:
                    _j_in = getattr(usage, 'prompt_tokens', 0) or 0
                    _j_out = getattr(usage, 'completion_tokens', 0) or 0
                    test_exec.judge_tokens_in += _j_in
                    test_exec.judge_tokens_out += _j_out
                    _j_cost = await self._record_cost(
                        "judge_llm", config.LLM_MODEL, _j_in, _j_out,
                        evaluation_id=test_exec.eval_run_id,
                        test_case_id=test_exec.test_case_id,
                        agent_id=test_exec.agent_id,
                    )
                    test_exec.judge_cost_usd += _j_cost
            except Exception as _e:
                logger.debug(f"Token capture (single) failed: {_e}")

            content = response.choices[0].message.content.strip()
            logger.debug(f"LLM response for assertion: {content[:200]}...")

            # Try to parse JSON (handles markdown fences, thinking tags, etc.)
            try:
                result = _extract_json(content)
            except json.JSONDecodeError as je:
                logger.error(f"Failed to parse LLM response as JSON: {content[:500]}")
                logger.error(f"JSON decode error: {str(je)}")
                # Return a failed result with the raw content as reasoning
                return {
                    "passed": False,
                    "reasoning": f"LLM returned invalid JSON. Raw response: {content[:200]}"
                }

            return {
                "passed": _to_bool(result.get("passed", False)),
                "reasoning": result.get("reasoning", "No reasoning provided")
            }

        except Exception as e:
            logger.error(f"Error evaluating assertion '{assertion_text}': {str(e)}", exc_info=True)
            return {
                "passed": False,
                "reasoning": f"Evaluation failed: {str(e)}"
            }
    
    # ==================================================================
    # ASSERTION AUTO-GENERATION (Feature: 3-tier-assertions)
    # ==================================================================
    async def generate_assertions_from_trace(
        self,
        test_case,
        test_case_result: TestCaseResult,
    ) -> Dict[str, Any]:
        """Use LLM to analyse a completed test run and propose assertions.

        Analyses the actual tool calls and agent response from a completed
        evaluation and generates proposed assertions for all three modes:
        - tool_expectations (for tool_level mode)
        - behavior_assertions (for hybrid mode)
        - response_quality_expectation (always)

        The caller should present these to the user for review before applying.
        """
        self.OpenAIClientInitialization()

        trace_context = json.dumps({
            "input": test_case.input,
            "expected_response": test_case.expected_response,
            "actual_response": test_case_result.response_from_agent,
            "tool_calls": test_case_result.actual_tool_calls,
        }, indent=2)

        generation_prompt = (
            "You are an expert at writing test assertions for AI agent evaluations.\n"
            "Analyse this test case execution trace and propose assertions.\n\n"
            f"TRACE:\n{trace_context}\n\n"
            "Generate assertions for THREE evaluation modes.\n\n"
            "1. TOOL-LEVEL: ToolExpectation entries checking which tools should be "
            "called and what argument values are expected.\n"
            "2. HYBRID (behavior): Natural-language BehaviorAssertion entries that "
            "describe expected agent behaviour including tool usage and response "
            "characteristics in a single sentence each.\n"
            "3. RESPONSE QUALITY: One ResponseQualityAssertion checking overall "
            "response appropriateness.\n\n"
            "Return ONLY a JSON object with this exact schema:\n"
            "{\n"
            '  "tool_expectations": [\n'
            '    {"name": "tool_name", "arguments": [\n'
            '      {"name": "arg_name", "assertion": ["assertion 1", "assertion 2"]}\n'
            "    ]}\n"
            "  ],\n"
            '  "behavior_assertions": [\n'
            '    {"assertion": "natural language description"}\n'
            "  ],\n"
            '  "response_quality_expectation": {\n'
            '    "assertion": "quality expectation"\n'
            "  }\n"
            "}"
        )

        try:
            response = await asyncio.to_thread(
                self.openai_client.chat.completions.create,
                model=config.LLM_MODEL,
                messages=[
                    {"role": "system", "content": "You write concise, testable assertions for AI agent evaluation."},
                    {"role": "user", "content": generation_prompt},
                ],
                temperature=0.3,
            )

            content = response.choices[0].message.content.strip()
            parsed = _extract_json(content)

            # Validate and structure tool_expectations
            tool_expectations = []
            for te in parsed.get("tool_expectations", []):
                try:
                    tool_expectations.append(ToolExpectation(
                        name=te.get("name", ""),
                        arguments=[
                            ArgumentAssertion(name=a.get("name", ""), assertion=a.get("assertion", []))
                            for a in te.get("arguments", [])
                        ],
                    ).model_dump())
                except Exception as e:
                    logger.warning(f"Skipping invalid tool expectation: {e}")

            # Validate behavior_assertions
            behavior_assertions = []
            for ba in parsed.get("behavior_assertions", []):
                try:
                    behavior_assertions.append(
                        BehaviorAssertion(assertion=ba.get("assertion", "")).model_dump()
                    )
                except Exception as e:
                    logger.warning(f"Skipping invalid behavior assertion: {e}")

            # Validate response quality
            rq = parsed.get("response_quality_expectation")
            response_quality = None
            if rq and rq.get("assertion"):
                try:
                    response_quality = ResponseQualityAssertion(assertion=rq["assertion"]).model_dump()
                except Exception as e:
                    logger.warning(f"Skipping invalid response quality: {e}")

            return {
                "tool_expectations": tool_expectations,
                "behavior_assertions": behavior_assertions,
                "response_quality_expectation": response_quality,
            }

        except Exception as e:
            logger.error(f"Error generating assertions: {e}", exc_info=True)
            return {
                "tool_expectations": [],
                "behavior_assertions": [],
                "response_quality_expectation": None,
                "error": str(e),
            }

    # ==================================================================
    # BEHAVIOR ASSERTION EVALUATION (Feature: 3-tier-assertions)
    # ==================================================================
    async def _evaluate_behavior_assertions(
        self,
        eval_run: EvaluationRun,
        behavior_assertions: list,
        test_case,
        test_exec,
    ) -> tuple:
        """Evaluate all behavior assertions using the LLM judge.

        Each behavior assertion receives the full trace context (tool calls +
        agent response + expected response) so the judge can reason about both
        tool usage and output quality in a single natural-language assertion.

        Returns:
            (results: List[BehaviorAssertionResult], all_passed: bool)
        """
        if not behavior_assertions:
            return [], True

        results = []
        all_passed = True

        if eval_run.verbose_logging:
            await self._update_status_message(
                eval_run.id,
                f"  📋 Evaluating {len(behavior_assertions)} behavior assertion(s)"
            )

        for ba in behavior_assertions:
            result = await self._evaluate_single_assertion(
                eval_run=eval_run,
                assertion_text=ba.assertion,
                tool_name=None,
                argument_name=None,
                test_case=test_case,
                test_exec=test_exec,
                assertion_type="behavior",
            )

            behavior_result = BehaviorAssertionResult(
                assertion=ba.assertion,
                passed=result["passed"],
                llm_judge_output=result["reasoning"],
            )
            results.append(behavior_result)

            if not result["passed"]:
                all_passed = False

            if eval_run.verbose_logging:
                icon = "✓" if result["passed"] else "✗"
                truncated = ba.assertion[:60] + ("..." if len(ba.assertion) > 60 else "")
                await self._update_status_message(
                    eval_run.id,
                    f"  {icon} Behavior: {truncated}"
                )

        return results, all_passed

    async def _finalize_evaluation(self, eval_run: EvaluationRun):
        """Calculate final results and update evaluation status.

        Also performs regression detection (Feature: regression-detection):
        Compares current evaluation results with the most recent completed evaluation
        for the same agent/dataset combination to identify tests that regressed.
        """

        # Don't overwrite a cancelled status
        if eval_run.status == EvaluationRunStatus.cancelled:
            logger.info(f"Evaluation {eval_run.id} already cancelled — skipping finalization")
            self._cancelled_evals.discard(eval_run.id)
            return

        # Update final status
        eval_run.status = EvaluationRunStatus.completed
        eval_run.completed_at = datetime.now(timezone.utc)

        # ==== COST AGGREGATION (Feature: cost-attribution) ====
        total_cost = 0.0
        total_in = 0
        total_out = 0
        for tc in eval_run.test_cases:
            total_cost += tc.agent_cost_usd + tc.judge_cost_usd
            total_in += tc.agent_tokens_in + tc.judge_tokens_in
            total_out += tc.agent_tokens_out + tc.judge_tokens_out
        eval_run.total_cost_usd = round(total_cost, 6)
        eval_run.total_tokens_in = total_in
        eval_run.total_tokens_out = total_out

        # ==== FAILURE MODE CLASSIFICATION (Feature: hitl-intelligence) ====
        for tc in eval_run.test_cases:
            if tc.failure_mode is None and not tc.passed:
                tc.failure_mode = self._classify_failure_mode(tc)

        # ==== REGRESSION DETECTION (Feature: regression-detection) ====
        try:
            # Get recent evaluations for same agent (limit=10)
            recent_evals = await self.db.list_evaluation_runs(agent_id=eval_run.agent_id, limit=10)

            # Find most recent COMPLETED evaluation for same dataset (exclude current)
            previous_eval = None
            for e in recent_evals:
                if (e.id != eval_run.id and
                    e.dataset_id == eval_run.dataset_id and
                    e.status == EvaluationRunStatus.completed):
                    previous_eval = e
                    break

            # If found, compare per-test-case results
            if previous_eval:
                # Build result maps: testcase_id -> passed (bool)
                current_results = {tc.testcase_id: tc.passed for tc in eval_run.test_cases}
                previous_results = {tc.testcase_id: tc.passed for tc in previous_eval.test_cases}

                # Find regressions: tests that were passed in previous but failed now
                regressions = []
                for testcase_id, passed_in_previous in previous_results.items():
                    passed_in_current = current_results.get(testcase_id)

                    # Regression: was passed before, failed now
                    if passed_in_previous and not passed_in_current:
                        regressions.append({
                            "testcase_id": testcase_id,
                            "previous_result": "passed",
                            "current_result": "failed",
                            "previous_eval_id": previous_eval.id
                        })

                # Store regressions in eval_run
                eval_run.regressions = regressions

                # Log regression info (shown via dedicated regressions banner, not warnings)
                if regressions:
                    logger.warning(f"Evaluation {eval_run.id}: {len(regressions)} regression(s) detected")
        except Exception as e:
            logger.warning(f"Regression detection failed for evaluation {eval_run.id}: {str(e)}")

        await self.db.update_evaluation_run(eval_run)

        pass_percentage = (eval_run.passed_count / eval_run.total_tests * 100) if eval_run.total_tests > 0 else 0
        logger.info(f"Evaluation {eval_run.id} completed: {eval_run.passed_count}/{eval_run.total_tests} passed ({pass_percentage:.1f}%)")

        # Clean up the lock and cancel flag for this evaluation run
        self._cancelled_evals.discard(eval_run.id)
        async with self._locks_lock:
            self._eval_run_locks.pop(eval_run.id, None)

    async def generate_prompt_proposals(self, agent_id: str, evaluation_ids: Optional[List[str]] = None) -> list:
        """Generate AI-powered prompt improvement proposals from annotation patterns.

        Enhanced algorithm with action-level annotation data:
        1. Fetch all run + action annotations for the agent's recent evals
        2. Count issue tag frequencies, group by failure pattern
        3. For each incorrect action annotation:
           - Match action_index to actual_tool_calls[action_index] from evaluation's test_cases
           - Group by tool name and collect tool-level failure statistics
           - Collect correction notes with test case context
        4. For each significant pattern, ask LLM with:
           - Current system prompt
           - Issue tag patterns
           - Per-tool failure summaries with counts
           - Specific correction notes with context
           - 2-3 concrete failed test case examples (input + response + annotations)
        5. Store proposals with evidence field linking to specific test cases
        """
        # Initialize OpenAI client
        self.OpenAIClientInitialization()

        # Get the active prompt for this agent
        active_prompt = await self.db.get_active_prompt(agent_id)
        current_prompt_text = active_prompt.get("system_prompt", "No system prompt configured.") if active_prompt else "No system prompt configured."
        current_version = active_prompt.get("version", 0) if active_prompt else 0

        # Get evaluations to analyze
        if evaluation_ids:
            evals_to_analyze = []
            for eid in evaluation_ids:
                e = await self.db.get_evaluation_run(eid)
                if e and e.agent_id == agent_id:
                    evals_to_analyze.append(e)
        else:
            all_evals = await self.db.list_evaluation_runs(agent_id=agent_id, limit=20)
            evals_to_analyze = [e for e in all_evals if e.status.value == "completed"]

        if not evals_to_analyze:
            logger.info(f"No completed evaluations found for agent {agent_id}")
            return []

        # Collect annotation data with enhanced tool-level grouping
        from collections import Counter
        issue_counter = Counter()
        issue_samples = {}
        action_issues = []
        correction_samples = []

        # Tool-level failure grouping
        tool_failure_counts = Counter()  # tool_name -> count of failures
        tool_failure_examples = {}  # tool_name -> list of failure examples
        correction_with_context = []  # (testcase_id, tool_name, agent_response, correction)

        for eval_run in evals_to_analyze:
            # Build set of holdout test case IDs for this evaluation
            holdout_testcase_ids = set()
            test_cases_by_id = {}
            try:
                test_cases = await self.db.list_testcases_by_dataset(eval_run.dataset_id)
                for tc in test_cases:
                    test_cases_by_id[tc.id] = tc
                    if getattr(tc, 'is_holdout', False):
                        holdout_testcase_ids.add(tc.id)
            except Exception as e:
                logger.warning(f"Failed to load test cases for holdout filtering in eval {eval_run.id}: {e}")

            # Process run-level annotations, skipping holdout test cases
            run_anns = await self.db.list_run_annotations(eval_run.id)
            for ann in run_anns:
                run_id = ann.get("run_id", "") if isinstance(ann, dict) else getattr(ann, 'run_id', "")
                if run_id in holdout_testcase_ids:
                    continue

                issues = ann.get("issues", []) if isinstance(ann, dict) else getattr(ann, 'issues', [])
                notes = ann.get("notes", "") if isinstance(ann, dict) else getattr(ann, 'notes', "")
                outcome = ann.get("outcome") if isinstance(ann, dict) else getattr(ann, 'outcome', None)
                efficiency = ann.get("efficiency") if isinstance(ann, dict) else getattr(ann, 'efficiency', None)

                for issue in issues:
                    issue_counter[issue] += 1
                    if issue not in issue_samples:
                        issue_samples[issue] = {"notes": notes or "", "run_id": run_id}

                # Collect low-outcome runs as additional signal
                if outcome is not None and outcome <= 2 and not issues:
                    issue_counter["Low quality outcome"] += 1
                    if "Low quality outcome" not in issue_samples:
                        issue_samples["Low quality outcome"] = {"notes": notes or f"Outcome rated {outcome}/5", "run_id": run_id}

                if efficiency == "wasteful" and not issues:
                    issue_counter["Wasteful execution"] += 1
                    if "Wasteful execution" not in issue_samples:
                        issue_samples["Wasteful execution"] = {"notes": notes or "Marked as wasteful", "run_id": run_id}

            # Process action-level annotations with enhanced data collection
            action_anns = await self.db.list_action_annotations(eval_run.id)
            for ann in action_anns:
                run_id = ann.get("run_id") if isinstance(ann, dict) else getattr(ann, 'run_id', None)
                if run_id in holdout_testcase_ids:
                    continue

                correctness = ann.get("correctness") if isinstance(ann, dict) else getattr(ann, 'correctness', None)
                parameter_quality = ann.get("parameter_quality") if isinstance(ann, dict) else getattr(ann, 'parameter_quality', None)
                correction = ann.get("correction") if isinstance(ann, dict) else getattr(ann, 'correction', None)
                action_index = ann.get("action_index") if isinstance(ann, dict) else getattr(ann, 'action_index', None)

                # Include suboptimal actions too (not just incorrect/wrong)
                if correctness in ("incorrect", "acceptable") or parameter_quality in ("wrong", "suboptimal"):
                    action_issues.append(ann)

                    if action_index is not None and run_id:
                        test_case_result = None
                        for tc_result in eval_run.test_cases:
                            if tc_result.testcase_id == run_id:
                                test_case_result = tc_result
                                break

                        if test_case_result and action_index < len(test_case_result.actual_tool_calls):
                            tool_call = test_case_result.actual_tool_calls[action_index]
                            tool_name = tool_call.get("name", "unknown")
                            tool_failure_counts[tool_name] += 1

                            if tool_name not in tool_failure_examples:
                                tool_failure_examples[tool_name] = []
                            if len(tool_failure_examples[tool_name]) < 3:
                                tool_failure_examples[tool_name].append({
                                    "testcase_id": run_id,
                                    "tool_call": tool_call,
                                    "agent_response": test_case_result.response_from_agent[:300] if test_case_result.response_from_agent else "",
                                    "correction": correction or "N/A"
                                })

                # Collect all corrections with context
                if correction:
                    correction_samples.append(correction)
                    if action_index is not None and run_id:
                        for tc_result in eval_run.test_cases:
                            if tc_result.testcase_id == run_id:
                                if action_index < len(tc_result.actual_tool_calls):
                                    tool_name = tc_result.actual_tool_calls[action_index].get("name", "unknown")
                                    correction_with_context.append({
                                        "testcase_id": run_id,
                                        "tool_name": tool_name,
                                        "agent_response": tc_result.response_from_agent[:200] if tc_result.response_from_agent else "",
                                        "correction": correction
                                    })
                                break

        # Also consider failed test cases even without annotations
        if not issue_counter and not action_issues:
            for eval_run in evals_to_analyze:
                for tc_result in eval_run.test_cases:
                    if hasattr(tc_result, 'pass_fail') and tc_result.pass_fail == "fail":
                        issue_counter["Test case failure"] += 1
                        if "Test case failure" not in issue_samples:
                            issue_samples["Test case failure"] = {
                                "notes": f"Test case failed: {tc_result.testcase_id}",
                                "run_id": tc_result.testcase_id
                            }

        logger.info(f"Proposal generation: {len(issue_counter)} issue patterns, {len(action_issues)} action issues for agent {agent_id}")

        if not issue_counter and not action_issues:
            logger.info(f"No annotation patterns found for agent {agent_id}")
            return []

        # Delegate to the streaming generator and collect all results
        proposals = []
        async for proposal in self._generate_proposals_stream(
            agent_id, current_prompt_text, current_version,
            issue_counter, issue_samples, action_issues,
            tool_failure_counts, tool_failure_examples,
            correction_samples, correction_with_context,
            evals_to_analyze,
            judge_rubric=None,
            include_reasoning=False
        ):
            # Skip error reports from failed LLM calls
            if isinstance(proposal, dict) and proposal.get("_error"):
                continue
            proposals.append(proposal)

        return proposals

    async def _generate_proposals_stream(
        self,
        agent_id: str,
        current_prompt_text: str,
        current_version: int,
        issue_counter,
        issue_samples: dict,
        action_issues: list,
        tool_failure_counts,
        tool_failure_examples: dict,
        correction_samples: list,
        correction_with_context: list,
        evals_to_analyze: list,
        judge_rubric: Optional[str] = None,
        include_reasoning: bool = False,
    ):
        """Async generator that yields each proposal as it's generated by the LLM.

        This powers both the batch endpoint (collect all) and the SSE streaming endpoint.
        """
        significant_patterns = [(tag, count) for tag, count in issue_counter.most_common(5) if count >= 1]
        total_runs = sum(e.total_tests for e in evals_to_analyze)

        logger.info(f"Generating proposals for {len(significant_patterns)} patterns: {[t for t, _ in significant_patterns]}")

        # Track previously generated proposal titles for deduplication
        generated_titles: List[str] = []

        for tag, count in significant_patterns:
            logger.info(f"Processing pattern '{tag}' (count={count})...")
            sample = issue_samples.get(tag, {})

            # Build tool failure summary
            tool_failure_summary = ""
            if tool_failure_counts:
                tool_lines = []
                for tool_name, failure_count in tool_failure_counts.most_common(3):
                    tool_lines.append(f"  - Tool '{tool_name}': {failure_count} failures")
                if tool_lines:
                    tool_failure_summary = "PER-TOOL FAILURE PATTERNS:\n" + "\n".join(tool_lines)

            # Build correction examples with context
            correction_examples_text = ""
            if correction_with_context:
                example_lines = ["SPECIFIC CORRECTION EXAMPLES:"]
                for i, ctx in enumerate(correction_with_context[:3], 1):
                    example_lines.append(f"\nExample {i} (Tool: {ctx['tool_name']}, Test: {ctx['testcase_id']}):")
                    example_lines.append(f"  Agent response: {ctx['agent_response']}")
                    example_lines.append(f"  Correction: {ctx['correction']}")
                correction_examples_text = "\n".join(example_lines)

            # Build concrete test case examples from tool failure examples
            concrete_examples_text = ""
            if tool_failure_examples:
                example_lines = ["CONCRETE FAILED TEST CASES:"]
                example_count = 0
                for tool_name, examples in tool_failure_examples.items():
                    for example in examples:
                        if example_count >= 3:
                            break
                        example_lines.append(f"\nTest: {example['testcase_id']} | Tool: {tool_name}")
                        example_lines.append(f"  Agent response: {example['agent_response']}")
                        example_lines.append(f"  Annotation: {example['correction']}")
                        example_count += 1
                    if example_count >= 3:
                        break
                concrete_examples_text = "\n".join(example_lines)

            rubric_section = ""
            if judge_rubric:
                rubric_section = f"""
JUDGE RUBRIC / EVALUATION CRITERIA:
{judge_rubric}

Use the above rubric criteria to guide your analysis and proposal. Focus on changes that would improve performance against these criteria.
"""

            # Build JSON response schema based on include_reasoning flag
            json_fields = """{{
  "title": "short descriptive title (under 60 chars)",
  "category": "which aspect this improves (e.g., Tool Selection, Error Handling, Data Validation)",
  "confidence": <number between 0.0 and 1.0 — calibrate based on evidence strength: 0.3-0.5 for speculative changes with weak evidence, 0.5-0.7 for probable improvements with moderate evidence, 0.7-0.9 for high-confidence changes with strong evidence, 0.9+ only for near-certain fixes>,
  "priority": "high" or "medium" or "low",
  "reasoning": "2-3 sentences: why this pattern happens (reference specific tools if applicable) and how the change fixes it",
  "expected_impact": "+X% estimated improvement description",
  "lines_to_remove": ["exact line(s) from current prompt to replace, or empty if adding new"],
  "lines_to_add": ["replacement/new line(s) with improvements"]"""

            if include_reasoning:
                json_fields += """,
  "detailed_reasoning": "Step-by-step analysis of the pattern, root cause, and why the proposed change should work (only if reasoning requested)\""""

            json_fields += "\n}}"

            # Build deduplication context from previously generated proposals
            dedup_section = ""
            if generated_titles:
                dedup_section = f"""
IMPORTANT — AVOID DUPLICATION:
The following proposals have ALREADY been generated in this session. Do NOT propose something that overlaps with or is essentially the same as any of these:
{chr(10).join(f'  - "{t}"' for t in generated_titles)}

If the failure pattern you are analyzing points to the same root cause as an existing proposal above, either:
1. Propose a DIFFERENT, complementary fix that addresses a distinct aspect, OR
2. Return {{"skip": true}} to indicate this pattern is already covered.
"""

            llm_prompt = f"""You are a prompt engineering expert. Analyze this agent failure pattern and suggest ONE specific system prompt improvement.

CURRENT SYSTEM PROMPT:
{current_prompt_text}

FAILURE PATTERN FROM HUMAN ANNOTATIONS:
- Issue "{tag}" occurred {count} times across {total_runs} test runs
- Sample annotator notes: {sample.get('notes', 'N/A')}
- Number of incorrect action annotations: {len(action_issues)}

{tool_failure_summary if tool_failure_summary else ""}

- Sample corrections suggested: {'; '.join(correction_samples[:3]) if correction_samples else 'N/A'}

{correction_examples_text if correction_examples_text else ""}

{concrete_examples_text if concrete_examples_text else ""}
{dedup_section}
Based on these specific failures and tool-level patterns, provide a targeted improvement that addresses the root cause.
{rubric_section}
Respond as JSON with these exact fields:
{json_fields}"""

            try:
                logger.info(f"Calling LLM ({config.LLM_MODEL}) for pattern '{tag}'...")
                response = await asyncio.to_thread(
                    self.openai_client.chat.completions.create,
                    model=config.LLM_MODEL,
                    messages=[
                        {"role": "system", "content": await self._get_system_prompt("proposal_generation_system", "You are a precise prompt engineering expert. Return ONLY valid JSON with no additional text.")},
                        {"role": "user", "content": await self._render_proposal_prompt(
                            variables={
                                "current_prompt": current_prompt_text,
                                "tag": tag,
                                "count": str(count),
                                "total_runs": str(total_runs),
                                "sample_notes": sample.get('notes', 'N/A'),
                                "action_issues_count": str(len(action_issues)),
                                "tool_failure_summary": tool_failure_summary or "",
                                "correction_samples": '; '.join(correction_samples[:3]) if correction_samples else 'N/A',
                                "correction_examples": correction_examples_text or "",
                                "concrete_examples": concrete_examples_text or "",
                                "dedup_section": dedup_section,
                                "rubric_section": rubric_section,
                                "json_fields": json_fields,
                            },
                            hardcoded_fallback=llm_prompt,
                        )}
                    ],
                )

                # ==== TOKEN CAPTURE (Feature: cost-attribution) ====
                try:
                    usage = getattr(response, 'usage', None)
                    if usage:
                        _p_in = getattr(usage, 'prompt_tokens', 0) or 0
                        _p_out = getattr(usage, 'completion_tokens', 0) or 0
                        await self._record_cost(
                            "prompt_proposal", config.LLM_MODEL, _p_in, _p_out,
                            agent_id=agent_id,
                        )
                except Exception as _e:
                    logger.debug(f"Token capture (proposal) failed: {_e}")

                raw_content = response.choices[0].message.content or ""
                # Qwen3 models may put response in 'thinking' field instead
                if not raw_content.strip():
                    thinking = getattr(response.choices[0].message, 'thinking', None)
                    if thinking:
                        logger.warning(f"Proposal LLM returned empty content but has thinking field — using thinking content")
                        raw_content = thinking
                content = raw_content.strip()
                if not content:
                    logger.error(f"Proposal LLM returned completely empty content for pattern '{tag}'")
                    yield {"_error": True, "pattern": tag, "message": "LLM returned empty content"}
                    continue
                logger.debug(f"Proposal LLM raw output for '{tag}': {content[:200]}...")
                result = _extract_json(content)

                # Check if the LLM indicated this pattern is already covered
                if result.get("skip"):
                    logger.info(f"LLM indicated pattern '{tag}' is already covered by previous proposals — skipping")
                    continue

                # Build evidence from action annotations
                evidence = []
                for ctx in correction_with_context[:5]:  # Include up to 5 pieces of evidence
                    evidence.append({
                        "testcase_id": ctx["testcase_id"],
                        "tool_name": ctx["tool_name"],
                        "correction": ctx["correction"]
                    })

                # Clamp confidence to valid range
                raw_confidence = result.get("confidence", 0.5)
                try:
                    confidence_val = max(0.0, min(1.0, float(raw_confidence)))
                except (TypeError, ValueError):
                    confidence_val = 0.5

                # Always include basic reasoning; prefer detailed_reasoning when available
                basic_reasoning = result.get("reasoning")
                detailed_reasoning = result.get("detailed_reasoning")
                proposal_reasoning = detailed_reasoning or basic_reasoning

                proposal = PromptProposal(
                    agent_id=agent_id,
                    prompt_version=current_version,
                    title=result.get("title", f"Fix: {tag}"),
                    category=result.get("category", "General"),
                    confidence=confidence_val,
                    priority=result.get("priority", "medium"),
                    pattern_source=f'Issue "{tag}" occurred {count}/{total_runs} runs. {basic_reasoning or ""}',
                    impact=result.get("expected_impact", ""),
                    impact_detail=basic_reasoning or "",
                    diff={
                        "removed": result.get("lines_to_remove", []),
                        "added": result.get("lines_to_add", [])
                    },
                    status="pending",
                    evidence=evidence,
                    reasoning=proposal_reasoning
                )

                saved = await self.db.create_proposal(proposal)
                generated_titles.append(result.get("title", f"Fix: {tag}"))
                logger.info(f"Generated proposal: {proposal.title} with {len(evidence)} evidence items")
                yield saved

            except Exception as e:
                logger.error(f"Failed to generate proposal for pattern '{tag}': {e}", exc_info=True)
                # Yield error info so the SSE stream can report it to the frontend
                yield {"_error": True, "pattern": tag, "message": str(e)}
                continue

    async def generate_prompt_proposals_stream(self, agent_id: str, evaluation_ids: Optional[List[str]] = None, judge_rubric: Optional[str] = None, include_reasoning: bool = False):
        """Async generator version of generate_prompt_proposals for SSE streaming.

        Yields each proposal dict as it's generated, allowing the frontend to
        display proposals incrementally rather than waiting for all to complete.
        Also yields status messages (dicts with 'status' key) for progress tracking.
        """
        # Initialize OpenAI client
        try:
            self.OpenAIClientInitialization()
        except Exception as e:
            logger.error(f"Failed to initialize LLM client: {e}")
            raise

        # Get the active prompt for this agent
        active_prompt = await self.db.get_active_prompt(agent_id)
        current_prompt_text = active_prompt.get("system_prompt", "No system prompt configured.") if active_prompt else "No system prompt configured."
        current_version = active_prompt.get("version", 0) if active_prompt else 0

        # Get evaluations to analyze
        if evaluation_ids:
            evals_to_analyze = []
            for eid in evaluation_ids:
                e = await self.db.get_evaluation_run(eid)
                if e and e.agent_id == agent_id:
                    evals_to_analyze.append(e)
        else:
            all_evals = await self.db.list_evaluation_runs(agent_id=agent_id, limit=20)
            evals_to_analyze = [e for e in all_evals if e.status.value == "completed"]

        if not evals_to_analyze:
            logger.info(f"No completed evaluations found for agent {agent_id}")
            return

        logger.info(f"Analyzing {len(evals_to_analyze)} completed evaluations for agent {agent_id}")

        # Collect annotation data
        from collections import Counter
        issue_counter = Counter()
        issue_samples = {}
        action_issues = []
        correction_samples = []
        tool_failure_counts = Counter()
        tool_failure_examples = {}
        correction_with_context = []

        # Also collect run-level quality signals (outcome, efficiency)
        low_outcome_runs = []  # runs with outcome <= 2 (failed/poor)
        inefficient_runs = []  # runs marked as "wasteful"

        for eval_run in evals_to_analyze:
            holdout_testcase_ids = set()
            test_cases_by_id = {}
            try:
                test_cases = await self.db.list_testcases_by_dataset(eval_run.dataset_id)
                for tc in test_cases:
                    test_cases_by_id[tc.id] = tc
                    if getattr(tc, 'is_holdout', False):
                        holdout_testcase_ids.add(tc.id)
            except Exception as e:
                logger.warning(f"Failed to load test cases for holdout filtering in eval {eval_run.id}: {e}")

            run_anns = await self.db.list_run_annotations(eval_run.id)
            for ann in run_anns:
                run_id = ann.get("run_id", "") if isinstance(ann, dict) else getattr(ann, 'run_id', "")
                if run_id in holdout_testcase_ids:
                    continue
                issues = ann.get("issues", []) if isinstance(ann, dict) else getattr(ann, 'issues', [])
                notes = ann.get("notes", "") if isinstance(ann, dict) else getattr(ann, 'notes', "")
                outcome = ann.get("outcome") if isinstance(ann, dict) else getattr(ann, 'outcome', None)
                efficiency = ann.get("efficiency") if isinstance(ann, dict) else getattr(ann, 'efficiency', None)

                for issue in issues:
                    issue_counter[issue] += 1
                    if issue not in issue_samples:
                        issue_samples[issue] = {"notes": notes or "", "run_id": run_id}

                # Collect low-outcome runs as additional signal
                if outcome is not None and outcome <= 2:
                    low_outcome_runs.append({"run_id": run_id, "outcome": outcome, "notes": notes or ""})
                    # If no issue tags but poor outcome, create synthetic issue
                    if not issues:
                        issue_counter["Low quality outcome"] += 1
                        if "Low quality outcome" not in issue_samples:
                            issue_samples["Low quality outcome"] = {"notes": notes or f"Outcome rated {outcome}/5", "run_id": run_id}

                if efficiency == "wasteful":
                    inefficient_runs.append({"run_id": run_id, "notes": notes or ""})
                    if not issues:
                        issue_counter["Wasteful execution"] += 1
                        if "Wasteful execution" not in issue_samples:
                            issue_samples["Wasteful execution"] = {"notes": notes or "Marked as wasteful", "run_id": run_id}

            action_anns = await self.db.list_action_annotations(eval_run.id)
            for ann in action_anns:
                run_id = ann.get("run_id") if isinstance(ann, dict) else getattr(ann, 'run_id', None)
                if run_id in holdout_testcase_ids:
                    continue
                correctness = ann.get("correctness") if isinstance(ann, dict) else getattr(ann, 'correctness', None)
                parameter_quality = ann.get("parameter_quality") if isinstance(ann, dict) else getattr(ann, 'parameter_quality', None)
                correction = ann.get("correction") if isinstance(ann, dict) else getattr(ann, 'correction', None)
                action_index = ann.get("action_index") if isinstance(ann, dict) else getattr(ann, 'action_index', None)

                # Include suboptimal actions too (not just incorrect/wrong)
                if correctness in ("incorrect", "acceptable") or parameter_quality in ("wrong", "suboptimal"):
                    action_issues.append(ann)
                    if action_index is not None and run_id:
                        test_case_result = None
                        for tc_result in eval_run.test_cases:
                            if tc_result.testcase_id == run_id:
                                test_case_result = tc_result
                                break
                        if test_case_result and action_index < len(test_case_result.actual_tool_calls):
                            tool_call = test_case_result.actual_tool_calls[action_index]
                            tool_name = tool_call.get("name", "unknown")
                            tool_failure_counts[tool_name] += 1
                            if tool_name not in tool_failure_examples:
                                tool_failure_examples[tool_name] = []
                            if len(tool_failure_examples[tool_name]) < 3:
                                tool_failure_examples[tool_name].append({
                                    "testcase_id": run_id,
                                    "tool_call": tool_call,
                                    "agent_response": test_case_result.response_from_agent[:300] if test_case_result.response_from_agent else "",
                                    "correction": correction or "N/A"
                                })

                if correction:
                    correction_samples.append(correction)
                    if action_index is not None and run_id:
                        for tc_result in eval_run.test_cases:
                            if tc_result.testcase_id == run_id:
                                if action_index < len(tc_result.actual_tool_calls):
                                    tool_name = tc_result.actual_tool_calls[action_index].get("name", "unknown")
                                    correction_with_context.append({
                                        "testcase_id": run_id,
                                        "tool_name": tool_name,
                                        "agent_response": tc_result.response_from_agent[:200] if tc_result.response_from_agent else "",
                                        "correction": correction
                                    })
                                break

        # Also consider failed test cases (pass_fail == "fail") even without annotations
        if not issue_counter and not action_issues:
            for eval_run in evals_to_analyze:
                for tc_result in eval_run.test_cases:
                    if hasattr(tc_result, 'pass_fail') and tc_result.pass_fail == "fail":
                        issue_counter["Test case failure"] += 1
                        if "Test case failure" not in issue_samples:
                            issue_samples["Test case failure"] = {
                                "notes": f"Test case failed: {tc_result.testcase_id}",
                                "run_id": tc_result.testcase_id
                            }

        logger.info(f"Annotation analysis: {len(issue_counter)} issue patterns, {len(action_issues)} action issues, {len(low_outcome_runs)} low-outcome runs")

        if not issue_counter and not action_issues:
            logger.info(f"No annotation patterns found for agent {agent_id}")
            return

        # Stream each proposal as it's generated
        async for proposal in self._generate_proposals_stream(
            agent_id, current_prompt_text, current_version,
            issue_counter, issue_samples, action_issues,
            tool_failure_counts, tool_failure_examples,
            correction_samples, correction_with_context,
            evals_to_analyze,
            judge_rubric=judge_rubric,
            include_reasoning=include_reasoning
        ):
            yield proposal

    async def start_evaluation_with_prompt(self, evaluation_id: str, custom_system_prompt: str):
        """Start evaluation with a custom system prompt override.

        This modifies the agent invocation to include the custom_system_prompt
        field, which the agent server will use instead of its default prompt.
        """
        logger.info(f"Starting evaluation {evaluation_id} with custom system prompt")

        eval_run = await self.db.get_evaluation_run(evaluation_id)
        if not eval_run:
            raise ValueError(f"Evaluation run {evaluation_id} not found")

        # Get test cases from dataset
        test_cases = await self.db.list_testcases_by_dataset(eval_run.dataset_id)
        if not test_cases:
            raise ValueError(f"No test cases found for dataset {eval_run.dataset_id}")

        # Update status to running
        eval_run.status = EvaluationRunStatus.running
        eval_run.started_at = datetime.now(timezone.utc)
        await self.db.update_evaluation_run(eval_run)

        try:
            test_executions = [
                _TestExecution(test_case.id, eval_run.id)
                for test_case in test_cases
            ]

            tasks = []
            for i, (test_exec, test_case) in enumerate(zip(test_executions, test_cases)):
                task = asyncio.create_task(
                    self._process_single_test_with_prompt(eval_run, test_exec, test_case, i+1, len(test_executions), custom_system_prompt),
                    name=f"eval-{evaluation_id}-prompt-test-{i+1}"
                )
                tasks.append(task)

            self._running_tasks[evaluation_id] = tasks
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            except asyncio.CancelledError:
                logger.info(f"Evaluation {evaluation_id} (custom prompt) tasks were cancelled")
            finally:
                self._running_tasks.pop(evaluation_id, None)

            # If evaluation was cancelled, don't finalize
            if evaluation_id in self._cancelled_evals:
                logger.info(f"Evaluation {evaluation_id} was cancelled — skipping finalization")
                self._cancelled_evals.discard(evaluation_id)
                return

            eval_run = await self.db.get_evaluation_run(eval_run.id)
            if not eval_run:
                raise ValueError(f"Evaluation run {eval_run.id} not found after test completion")

            if eval_run.status == EvaluationRunStatus.cancelled:
                logger.info(f"Evaluation {evaluation_id} status is cancelled — skipping finalization")
                self._cancelled_evals.discard(evaluation_id)
                return

            await self._finalize_evaluation(eval_run)

        except Exception as e:
            logger.error(f"Evaluation {evaluation_id} with custom prompt failed: {str(e)}")
            eval_run.status = EvaluationRunStatus.failed
            eval_run.completed_at = datetime.now(timezone.utc)
            await self.db.update_evaluation_run(eval_run)
            raise

    async def _process_single_test_with_prompt(self, eval_run, test_exec, test_case, test_num, total_tests, custom_system_prompt):
        """Process a single test with custom system prompt."""
        async with self._semaphore:
            # Bail out early if this evaluation was cancelled
            if eval_run.id in self._cancelled_evals:
                logger.info(f"Skipping test {test_num}/{total_tests} — evaluation {eval_run.id} was cancelled")
                test_exec.status = "skipped"
                return

            try:
                test_exec.test_start = time.time()
                await self._update_status_message(eval_run.id, f"Running test {test_num}/{total_tests}: {test_case.name or test_case.id}")
                test_exec.status = "running"

                # Execute with custom prompt
                await self._execute_test_with_prompt(eval_run, test_exec, test_case, custom_system_prompt)

                # Check cancellation after agent execution
                if eval_run.id in self._cancelled_evals:
                    logger.info(f"Test {test_num}/{total_tests} cancelled after agent execution — skipping judge")
                    test_exec.status = "skipped"
                    return

                await self._update_status_message(eval_run.id, f"Judging test {test_num}/{total_tests}")

                if test_exec.status == "completed":
                    await self._judge_and_build_result(eval_run, test_exec, test_case)
                else:
                    test_exec.total_duration = time.time() - test_exec.test_start if test_exec.test_start else 0
                    test_exec.test_case_result = TestCaseResult(
                        testcase_id=test_case.id, passed=False,
                        response_from_agent=test_exec.agent_response or "", expected_tools=[], tool_expectations=[],
                        response_quality_assertion=None, actual_tool_calls=test_exec.tool_calls,
                        execution_error=test_exec.error_message or "Execution failed",
                        retry_count=test_exec.retry_count,
                        completed_at=datetime.now(timezone.utc),
                        agent_call_duration_seconds=test_exec.agent_call_duration,
                        judge_call_duration_seconds=0.0,
                        total_duration_seconds=test_exec.total_duration
                    )

                if test_exec.test_case_result:
                    await self._update_eval_run_with_test_result(eval_run, test_exec.test_case_result)

            except asyncio.CancelledError:
                logger.info(f"Test {test_case.id} (custom prompt) cancelled via task cancellation")
                test_exec.status = "skipped"
                return
            except Exception as e:
                logger.error(f"Error processing test {test_case.id} with custom prompt: {str(e)}")
                test_exec.status = "failed"
                test_exec.error_message = str(e)

    async def _execute_test_with_prompt(self, eval_run, test_exec, test_case, custom_system_prompt):
        """Execute a test against agent endpoint with custom system prompt."""
        test_exec.agent_call_start = time.time()

        try:
            agent_timeout = max(eval_run.timeout_seconds, 600)
            async with httpx.AsyncClient(timeout=httpx.Timeout(agent_timeout, connect=30.0)) as client:
                payload = {
                    "dataset_id": eval_run.dataset_id,
                    "test_case_id": test_case.id,
                    "agent_id": eval_run.agent_id,
                    "evaluation_run_id": eval_run.id,
                    "input": test_case.input,
                    "system_prompt": custom_system_prompt
                }

                response = await client.post(
                    eval_run.agent_endpoint,
                    json=payload,
                    headers={"Content-Type": "application/json"}
                )

                if response.status_code == 200:
                    result_data = response.json()
                    test_exec.agent_response = result_data.get("response", "")
                    tool_call_data = result_data.get("tool_calls", [])
                    test_exec.tool_calls = tool_call_data
                    test_exec.actual_tools = [
                        tool.get("name") if isinstance(tool, dict) else str(tool)
                        for tool in tool_call_data
                    ]
                    test_exec.status = "completed"
                else:
                    test_exec.status = "failed"
                    test_exec.error_message = f"HTTP {response.status_code}: {response.text[:500]}"
        except httpx.TimeoutException as e:
            test_exec.status = "failed"
            elapsed = time.time() - test_exec.agent_call_start
            test_exec.error_message = (
                f"Timeout after {elapsed:.0f}s waiting for agent. "
                f"Try increasing EVALUATION_TIMEOUT_SECONDS (currently {eval_run.timeout_seconds}s)."
            )
        except httpx.ConnectError:
            test_exec.status = "failed"
            test_exec.error_message = (
                f"Could not connect to agent at {eval_run.agent_endpoint}. "
                f"Make sure the agent server is running."
            )
        except Exception as e:
            test_exec.status = "failed"
            error_detail = f"{type(e).__name__}: {str(e)}" if str(e) else type(e).__name__
            test_exec.error_message = error_detail
        finally:
            test_exec.agent_call_duration = time.time() - test_exec.agent_call_start

    async def cancel_evaluation_run(self, evaluation_id: str) -> Optional[EvaluationRun]:
        """Cancel a running or stuck evaluation.

        Marks the evaluation as cancelled, sets completion time, and sends
        a cancel signal to the agent server to close open browsers.

        Args:
            evaluation_id: The ID of the evaluation to cancel

        Returns:
            The updated EvaluationRun, or None if not found

        Raises:
            ValueError: If the evaluation is already completed
        """
        eval_run = await self.db.get_evaluation_run(evaluation_id)
        if not eval_run:
            return None

        # Check if already in a terminal state
        if eval_run.status in [EvaluationRunStatus.completed, EvaluationRunStatus.failed]:
            raise ValueError(f"Cannot cancel evaluation in '{eval_run.status}' state")

        # Mark as cancelled (in-memory flag + DB)
        self._cancelled_evals.add(evaluation_id)
        eval_run.status = EvaluationRunStatus.cancelled
        eval_run.completed_at = datetime.now(timezone.utc)

        await self.db.update_evaluation_run(eval_run)

        logger.info(f"Evaluation {evaluation_id} cancelled. Progress: {eval_run.completed_tests}/{eval_run.total_tests}")

        # Tell the agent server to kill open browsers / abort running tasks
        if eval_run.agent_endpoint:
            await self._send_agent_cancel(eval_run.agent_endpoint)

        # Cancel all running asyncio tasks for this evaluation
        running_tasks = self._running_tasks.pop(evaluation_id, [])
        if running_tasks:
            cancelled_count = 0
            for task in running_tasks:
                if not task.done():
                    task.cancel()
                    cancelled_count += 1
            logger.info(f"Cancelled {cancelled_count} running task(s) for evaluation {evaluation_id}")

        # Clean up any locks for this evaluation
        async with self._locks_lock:
            self._eval_run_locks.pop(evaluation_id, None)

        return eval_run

    async def _send_agent_cancel(self, agent_endpoint: str):
        """Send a cancel signal to the agent server to close browsers."""
        from urllib.parse import urlparse
        try:
            parsed = urlparse(agent_endpoint)
            cancel_url = f"{parsed.scheme}://{parsed.netloc}/cancel"
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.post(cancel_url)
                if r.status_code == 200:
                    data = r.json()
                    logger.info(f"Agent cancel OK: closed {data.get('browsers_closed', '?')} browser(s)")
                else:
                    logger.warning(f"Agent cancel returned {r.status_code}: {r.text[:200]}")
        except Exception as e:
            # Agent might not support /cancel — that's fine, just log it
            logger.warning(f"Could not send cancel to agent: {e}")
    
    async def cleanup_orphaned_evaluations(self):
        """Mark any 'running' or 'pending' evaluations as cancelled.
        
        This should be called at startup to clean up evaluations that were
        interrupted by a server restart.
        """
        from .models import StatusHistoryEntry
        try:
            # Get all evaluations
            all_evals = await self.db.list_evaluation_runs(limit=1000)
            
            orphaned_count = 0
            for eval_run in all_evals:
                if eval_run.status in [EvaluationRunStatus.running, EvaluationRunStatus.pending]:
                    eval_run.status = EvaluationRunStatus.cancelled
                    eval_run.completed_at = datetime.now(timezone.utc)
                    # Add status history entry explaining the cancellation
                    eval_run.status_history.append(StatusHistoryEntry(
                        message="⚠️ Cancelled: Server restarted while evaluation was running"
                    ))
                    await self.db.update_evaluation_run(eval_run)
                    orphaned_count += 1
                    print(f"[STARTUP] Marked orphaned evaluation {eval_run.id} ({eval_run.name}) as cancelled", flush=True)
            
            if orphaned_count > 0:
                print(f"[STARTUP] Cleaned up {orphaned_count} orphaned evaluation(s)", flush=True)
            else:
                print("[STARTUP] No orphaned evaluations found", flush=True)
                
        except Exception as e:
            print(f"[STARTUP ERROR] Orphaned evaluation cleanup failed: {str(e)}", flush=True)

    async def explain_comparison(self, eval_id_a: str, eval_id_b: str) -> str:
        """Generate an LLM-powered explanation of differences between two evaluation runs."""
        # Ensure LLM client is ready
        if not self.openai_client:
            self.OpenAIClientInitialization()

        # Fetch both evaluations
        eval_a = await self.db.get_evaluation_run(eval_id_a)
        eval_b = await self.db.get_evaluation_run(eval_id_b)
        if not eval_a or not eval_b:
            raise ValueError("One or both evaluations not found")

        # Normalize: A = older (baseline), B = newer
        if eval_a.created_at > eval_b.created_at:
            eval_a, eval_b = eval_b, eval_a

        # Build test result maps
        results_a = {}
        details_a = {}
        for tc in eval_a.test_cases:
            results_a[tc.testcase_id] = tc.passed
            details_a[tc.testcase_id] = tc

        results_b = {}
        details_b = {}
        for tc in eval_b.test_cases:
            results_b[tc.testcase_id] = tc.passed
            details_b[tc.testcase_id] = tc

        # Classify test cases (considers both binary pass/fail AND rubric score changes)
        RUBRIC_CHANGE_THRESHOLD = 0.3
        improved, regressed, unchanged = [], [], []
        all_ids = set(results_a.keys()) | set(results_b.keys())

        for tc_id in all_ids:
            r_a = results_a.get(tc_id)
            r_b = results_b.get(tc_id)
            tc_detail_a = details_a.get(tc_id)
            tc_detail_b = details_b.get(tc_id)
            name = "Unknown"
            if tc_detail_b and hasattr(tc_detail_b, 'test_case_name'):
                name = tc_detail_b.test_case_name or tc_id
            elif tc_detail_a and hasattr(tc_detail_a, 'test_case_name'):
                name = tc_detail_a.test_case_name or tc_id

            # Rubric scores
            score_a = getattr(tc_detail_a, 'rubric_average_score', None) if tc_detail_a else None
            score_b = getattr(tc_detail_b, 'rubric_average_score', None) if tc_detail_b else None
            score_delta = (score_b - score_a) if score_a is not None and score_b is not None else None

            entry = {
                "name": name, "id": tc_id,
                "detail_a": tc_detail_a, "detail_b": tc_detail_b,
                "score_a": score_a, "score_b": score_b, "score_delta": score_delta,
            }

            if r_a == False and r_b == True:
                improved.append(entry)
            elif r_a == True and r_b == False:
                regressed.append(entry)
            elif score_delta is not None and score_delta >= RUBRIC_CHANGE_THRESHOLD:
                improved.append(entry)
            elif score_delta is not None and score_delta <= -RUBRIC_CHANGE_THRESHOLD:
                regressed.append(entry)
            else:
                unchanged.append(entry)

        # ── Build rich per-test-case context ────────────────────────────
        def _tc_trace(tc_result) -> str:
            """Extract a detailed execution trace from a test case result."""
            if tc_result is None:
                return "  (not present in this evaluation)"
            lines = []

            # Execution error (most important signal for failures)
            err = getattr(tc_result, 'execution_error', None)
            if err:
                lines.append(f"  ERROR: {err[:300]}")

            # Step-by-step trace from tool calls
            tool_calls = getattr(tc_result, 'actual_tool_calls', []) or []
            if tool_calls:
                steps = []
                for i, tc in enumerate(tool_calls[:10], 1):
                    name = tc.get('name', '?')
                    args = tc.get('arguments', {})
                    result = tc.get('result', '')
                    success = tc.get('success', None)
                    duration = tc.get('duration_seconds', 0)
                    # Format step concisely
                    arg_str = ""
                    if name == "navigate":
                        arg_str = f" → {args.get('url', '?')[:80]}"
                    elif name == "click":
                        arg_str = f" at ({args.get('x', '?')},{args.get('y', '?')})"
                    elif name in ("type_text", "click_and_type"):
                        arg_str = f" \"{args.get('text', '?')[:50]}\""
                    elif name == "done":
                        arg_str = f" result=\"{args.get('result', '?')[:80]}\""
                    elif name == "scroll":
                        arg_str = f" {args.get('direction', '?')}"

                    status = "✓" if success else "✗"
                    result_preview = str(result)[:80] if result else ""
                    step_line = f"  {i}. [{status}] {name}{arg_str}"
                    if duration:
                        step_line += f" ({duration:.1f}s)"
                    if not success and result_preview:
                        step_line += f" — {result_preview}"
                    steps.append(step_line)
                lines.append("  Steps:\n" + "\n".join(steps))

            # Agent's final response
            resp = getattr(tc_result, 'response_from_agent', '') or ''
            if resp:
                lines.append(f"  Final response: {resp[:250]}{'...' if len(resp) > 250 else ''}")

            # Assertion verdicts with reasons
            tool_expectations = getattr(tc_result, 'tool_expectations', []) or []
            assertion_lines = []
            for te in tool_expectations[:4]:
                if hasattr(te, 'assertions'):
                    for a in (te.assertions or [])[:4]:
                        passed = getattr(a, 'passed', False)
                        reasoning = getattr(a, 'reasoning', '') or ''
                        assertion_text = getattr(a, 'assertion', '') or ''
                        tag = "PASS" if passed else "FAIL"
                        desc = assertion_text[:100] if assertion_text else reasoning[:100]
                        assertion_lines.append(f"  [{tag}] {desc}")
            if assertion_lines:
                lines.append("  Assertions:\n" + "\n".join(assertion_lines))

            # Timing
            duration = getattr(tc_result, 'total_duration_seconds', None)
            if duration:
                lines.append(f"  Total duration: {duration:.1f}s")

            return "\n".join(lines) if lines else "  (no details available)"

        # ── Build the prompt ─────────────────────────────────────────────
        sections = []

        # Metadata
        pass_a = eval_a.passed_count / max(eval_a.total_tests, 1) * 100
        pass_b = eval_b.passed_count / max(eval_b.total_tests, 1) * 100

        # Aggregate rubric stats
        scored_a = [getattr(tc, 'rubric_average_score', None) for tc in eval_a.test_cases]
        scored_b = [getattr(tc, 'rubric_average_score', None) for tc in eval_b.test_cases]
        scored_a = [s for s in scored_a if s is not None]
        scored_b = [s for s in scored_b if s is not None]
        rubric_line = ""
        if scored_a or scored_b:
            avg_a = sum(scored_a) / len(scored_a) if scored_a else None
            avg_b = sum(scored_b) / len(scored_b) if scored_b else None
            rubric_line = f"\n- Rubric avg: baseline={avg_a:.2f}/5, latest={avg_b:.2f}/5" if avg_a and avg_b else ""
            if avg_a and avg_b:
                rubric_line += f" (delta: {avg_b - avg_a:+.2f})"

        sections.append(f"""## Evaluation Comparison
- Baseline: "{eval_a.name}" — {eval_a.passed_count}/{eval_a.total_tests} passed ({pass_a:.0f}%)
- Latest: "{eval_b.name}" — {eval_b.passed_count}/{eval_b.total_tests} passed ({pass_b:.0f}%)
- Pass rate delta: {pass_b - pass_a:+.1f}%{rubric_line}
- {len(improved)} improved, {len(regressed)} regressed, {len(unchanged)} unchanged
- NOTE: "improved" and "regressed" include rubric score changes ≥{RUBRIC_CHANGE_THRESHOLD} even when binary pass/fail is the same""")

        if improved:
            section = "## IMPROVED\n"
            for entry in improved:
                r_a = results_a.get(entry['id'])
                r_b = results_b.get(entry['id'])
                label_a = "failed" if not r_a else "passed"
                label_b = "passed" if r_b else "failed"
                score_info = ""
                if entry.get('score_a') is not None and entry.get('score_b') is not None:
                    score_info = f" | rubric: {entry['score_a']:.1f} → {entry['score_b']:.1f} ({entry['score_delta']:+.1f})"
                section += f"\n### {entry['name']} ({label_a} → {label_b}{score_info})\n"
                section += f"BASELINE ({label_a}):\n{_tc_trace(entry['detail_a'])}\n\n"
                section += f"LATEST ({label_b}):\n{_tc_trace(entry['detail_b'])}\n"
            sections.append(section)

        if regressed:
            section = "## REGRESSED\n"
            for entry in regressed:
                r_a = results_a.get(entry['id'])
                r_b = results_b.get(entry['id'])
                label_a = "passed" if r_a else "failed"
                label_b = "failed" if not r_b else "passed"
                score_info = ""
                if entry.get('score_a') is not None and entry.get('score_b') is not None:
                    score_info = f" | rubric: {entry['score_a']:.1f} → {entry['score_b']:.1f} ({entry['score_delta']:+.1f})"
                section += f"\n### {entry['name']} ({label_a} → {label_b}{score_info})\n"
                section += f"BASELINE ({label_a}):\n{_tc_trace(entry['detail_a'])}\n\n"
                section += f"LATEST ({label_b}):\n{_tc_trace(entry['detail_b'])}\n"
            sections.append(section)

        if unchanged:
            passed_unchanged = [e for e in unchanged if results_b.get(e['id']) == True]
            section = f"## UNCHANGED\n- {len(passed_unchanged)} still passing, {len(failed_unchanged)} still failing"
            if failed_unchanged:
                section += "\n\nStill-failing tests (investigate these next):"
                for entry in failed_unchanged[:3]:
                    section += f"\n\n### {entry['name']}\n{_tc_trace(entry['detail_b'])}"
            sections.append(section)

        user_prompt = "\n\n".join(sections)

        # Build dynamic structure instructions based on what sections exist
        failed_unchanged = [e for e in unchanged if results_b.get(e['id']) == False]

        structure_parts = []
        if improved:
            structure_parts.append(
                "## What Improved\n"
                "For each improved test, explain specifically what the agent did differently in the latest run "
                "(e.g., 'used navigate instead of click', 'correctly called done with result instead of looping'). "
                "Reference step numbers."
            )
        if regressed:
            structure_parts.append(
                "## What Regressed\n"
                "For each regressed test, pinpoint the exact step where things went wrong "
                "(e.g., 'got stuck repeating click at (53,604)', 'timed out at step 3'). Reference the error message."
            )
        if failed_unchanged:
            structure_parts.append(
                "## Still Failing\n"
                "For tests that failed in both runs, identify what's blocking them and whether there's progress."
            )
        structure_parts.append(
            "## Recommendations\n"
            "Give 2-3 SPECIFIC, ACTIONABLE fixes (e.g., 'add auto-rescue for click loops on form submit buttons', "
            "'increase timeout for Wikipedia pages', 'add explicit form-filling guidance to system prompt'). "
            "Do NOT give generic advice like 'add more tests' or 'monitor performance'."
        )

        # Load comparison prompt from DB (falls back to default)
        _default_comparison = (
            "You are a senior QA engineer analyzing an AI agent's evaluation results. "
            "You are given step-by-step execution traces for each test case across two runs (Baseline and Latest).\n\n"
            "Your job is to identify SPECIFIC, CONCRETE root causes — not generic observations. "
            "Compare the actual step sequences between runs to explain what the agent did differently.\n\n"
            "IMPORTANT RULES:\n"
            "- ONLY include sections that have relevant data. Do NOT include empty sections.\n"
            "- If there are no regressions, do NOT include a 'What Regressed' section.\n"
            "- If there are no still-failing tests, do NOT include a 'Still Failing' section.\n"
            "- If there are no improvements, do NOT include a 'What Improved' section.\n"
            "- Always include the Recommendations section.\n\n"
            "Structure your analysis using ONLY these applicable sections:\n\n"
            + "\n\n".join(structure_parts) + "\n\n"
            "Keep it under 400 words. Be direct."
        )
        system_prompt = await self._get_system_prompt("comparison_explanation", _default_comparison)

        # Call LLM
        response = await asyncio.to_thread(
            self.openai_client.chat.completions.create,
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )

        return response.choices[0].message.content.strip()

    async def get_evaluation_run(self, evaluation_id: str) -> Optional[EvaluationRun]:
        return await self.db.get_evaluation_run(evaluation_id)
    
    async def list_evaluation_runs(self, skip: int = 0, limit: int = 100, agent_id: Optional[str] = None) -> List[EvaluationRun]:
        return await self.db.list_evaluation_runs(skip=skip, limit=limit, agent_id=agent_id)
    
    async def delete_evaluation_run(self, evaluation_id: str) -> bool:
        return await self.db.delete_evaluation_run(evaluation_id)


# Service instance
_evaluator_service: Optional[EvaluatorService] = None


def get_evaluator_service(db_service: SQLiteService, max_concurrent_tests: int = None) -> EvaluatorService:
    """Get or create the evaluator service instance."""
    global _evaluator_service
    if _evaluator_service is None:
        _evaluator_service = EvaluatorService(db_service, max_concurrent_tests)
    return _evaluator_service