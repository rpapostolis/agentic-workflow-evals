from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Union, Annotated, Literal
import uuid
from pydantic import BaseModel, Field, ConfigDict, field_serializer, field_validator, model_validator
from enum import Enum

class Metadata(BaseModel):
    generator_id: str = Field(default_factory=lambda: f"gen_{uuid.uuid4().hex[:16]}", description="ID of the generator/pipeline")
    suite_id: str = Field(default_factory=lambda: f"suite_{uuid.uuid4().hex[:16]}", description="Logical ID for this suite/collection")
    created_at: Optional[str] = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat(), description="Auto-generated timestamp")
    version: str = Field(default="1.0", description="Schema version")
    schema_hash: str = Field(default="", description="Canonical JSON hash of the payload")


class SeedScenario(BaseModel):
    name: str = Field(default="", description="Human-friendly name for the scenario")
    goal: str = Field(..., description="Goal outlined by the user")
    synthetic_domain: str = Field(default="", description="Synthetic domain or industry context for the scenario")
    input: Dict[str, Any] = Field(
        default_factory=dict
    )




class ArgumentAssertion(BaseModel):
    """Natural-language assertion for an argument."""
    name: str = Field(..., description="Argument name")
    assertion: List[str] = Field(..., description="Natural language assertion for LLM-judge")


class ToolExpectation(BaseModel):
    """Expected tool call and per-argument assertions."""
    name: str = Field(..., description="Tool name")
    arguments: List[ArgumentAssertion] = Field(default_factory=list, description="Per-argument checks")


class ResponseQualityAssertion(BaseModel):
    assertion: str = Field(..., description="Quality claim about the response to be LLM-judged")


class BehaviorAssertion(BaseModel):
    """Natural-language assertion describing expected agent behavior including tool usage.

    Used in 'hybrid' assertion mode. The assertion can reference specific tools
    and parameters without the rigid ToolExpectation structure.
    Example: "Agent should call sendMail with a valid recipient and subject containing 'Report'"
    """
    assertion: str = Field(..., description="NL description of expected behavior (tools + response)")


class MockStatus(str, Enum):
    ok = "ok"


class MockDocxResponse(BaseModel):
    """Response from the document mock."""
    title: str = Field(description="Document title", min_length=1, max_length=200)
    content_md: str = Field(description="Document content in Markdown format", min_length=10)
    status: MockStatus = Field(description="Status of mock")
    metadata: Dict[str, Any] | None = Field(default=None, description="Optional document metadata")
    sections: List[str] | None = Field(default=None, description="Optional list of section headings")


class MockEmailResponse(BaseModel):
    """Response from the email mock."""
    to: List[str] = Field(description="List of recipient email addresses", min_length=1)
    subject: str = Field(description="Email subject line", min_length=1, max_length=200)
    body_md: str = Field(description="Email body in Markdown format", min_length=10)
    status: MockStatus = Field(description="Status of mock")
    cc: List[str] | None = Field(default=None, description="Optional CC recipients")
    bcc: List[str] | None = Field(default=None, description="Optional BCC recipients")


class MockTeamsResponse(BaseModel):
    """Response from the Teams mock."""
    channel: str = Field(description="Teams channel name or identifier", min_length=1)
    message_md: str = Field(description="Message content in Markdown format", min_length=10)
    status: MockStatus = Field(description="Status of mock")
    mentions: List[str] | None = Field(default=None, description="Optional list of @mentions")
    attachments: List[str] | None = Field(default=None, description="Optional list of attachment names")


class EmailMock(MockEmailResponse):
    kind: Literal["email"] = "email"


class TeamsMock(MockTeamsResponse):
    kind: Literal["teams"] = "teams"


ReferenceSeedItem = Annotated[
    Union[EmailMock, TeamsMock],
    Field(discriminator="kind")
]


class TestCase(BaseModel):
    id: str = Field(default_factory=lambda: f"tc_{uuid.uuid4().hex[:16]}", description="Id of the test case")
    dataset_id: str = Field(..., description="Id linking the test case to its parent dataset")
    name: Optional[str] = Field(default=None, description="Optional human-readable name for the test case")
    description: str
    input: str
    minimal_tool_set: List[str] = Field(default_factory=list)
    tool_expectations: List[ToolExpectation] = Field(default_factory=list)
    expected_response: str = Field(..., description="Expected response text for evaluation")
    response_quality_expectation: Optional[ResponseQualityAssertion] = None
    # ==== ASSERTION MODE (Feature: 3-tier-assertions) ====
    assertion_mode: Optional[Literal["response_only", "tool_level", "hybrid"]] = Field(
        default=None,
        description="Assertion evaluation mode. None = auto-detect from populated fields."
    )
    behavior_assertions: List[BehaviorAssertion] = Field(
        default_factory=list,
        description="NL behavior assertions (used in hybrid mode)"
    )
    references_seed: Dict[str, Union[ReferenceSeedItem, List[ReferenceSeedItem]]] = Field(
        default_factory=dict,
        description="Inline mocks (docx/email/teams). Keys are logical names; values are mock(s) with 'kind' discriminator."
    )
    is_holdout: bool = Field(default=False, description="If true, excluded from annotation-driven improvement but included in evaluation for overfitting detection")

    @model_validator(mode='after')
    def _auto_detect_assertion_mode(self) -> 'TestCase':
        """Auto-detect assertion_mode from populated fields when not explicitly set."""
        if self.assertion_mode is None:
            if self.tool_expectations:
                self.assertion_mode = "tool_level"
            elif self.behavior_assertions:
                self.assertion_mode = "hybrid"
            else:
                self.assertion_mode = "response_only"
        return self


# ========== Dataset Models ==========


class Dataset(BaseModel):
    """Internal model for storing datasets (without inline test_cases)"""
    id: str = Field(default_factory=lambda: f"dataset_{uuid.uuid4().hex[:16]}")
    metadata: Metadata
    seed: SeedScenario
    test_case_ids: List[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    risk_tier: Optional[str] = Field(default=None, description="Risk tier: tier_1_critical, tier_2_important, tier_3_routine")


class EvaluatorContract(BaseModel):
    """Complete evaluation dataset contract with inline test cases.
    Used for loading evaluation datasets from JSON files."""
    id: str
    metadata: Metadata
    seed: SeedScenario
    test_cases: List[TestCase]
    created_at: Optional[str] = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


# ========== API Response Models (Separated Storage) ==========

class DatasetResponse(BaseModel):
    """API response model for datasets (without inline test_cases)"""
    id: str
    metadata: Metadata
    seed: SeedScenario
    test_case_ids: List[str] = Field(default_factory=list)
    created_at: str


class TestCaseResponse(BaseModel):
    """API response model for test cases"""
    id: str
    dataset_id: str
    name: Optional[str] = None
    description: str
    input: str
    minimal_tool_set: List[str] = Field(default_factory=list)
    tool_expectations: List[ToolExpectation] = Field(default_factory=list)
    expected_response: str
    response_quality_expectation: Optional[ResponseQualityAssertion] = None
    assertion_mode: Optional[str] = Field(default="response_only", description="Assertion evaluation mode")
    behavior_assertions: List[BehaviorAssertion] = Field(default_factory=list)
    references_seed: Dict[str, Any] = Field(default_factory=dict)
    is_holdout: bool = Field(default=False, description="If true, excluded from annotation-driven improvement but included in evaluation for overfitting detection")


# ========== Request Models ==========

class CreateDatasetRequest(BaseModel):
    """Simplified request model for creating a new evaluation dataset"""
    name: str = Field(..., description="Human-friendly name for the dataset")
    goal: str = Field(..., description="Goal/description of what this dataset evaluates")
    input: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Optional input parameters")
    schema_hash: str = Field(default="", description="Optional schema hash")


class TestCaseCreate(BaseModel):
    """Request model for creating a test case (seed_id is taken from URL path)"""
    name: Optional[str] = None
    description: str = Field(default="", description="Description of the test case; auto-generated from input if omitted")
    input: str
    minimal_tool_set: List[str] = Field(default_factory=list)
    tool_expectations: List[ToolExpectation] = Field(default_factory=list)
    expected_response: str = Field(default="Agent completes the task correctly.", description="Expected response; defaults to generic expectation if omitted")
    response_quality_expectation: Optional[ResponseQualityAssertion] = None
    assertion_mode: Optional[Literal["response_only", "tool_level", "hybrid"]] = Field(
        default="response_only",
        description="Assertion evaluation mode"
    )
    behavior_assertions: List[BehaviorAssertion] = Field(
        default_factory=list,
        description="NL behavior assertions (used in hybrid mode)"
    )
    references_seed: Dict[str, Any] = Field(default_factory=dict)
    is_holdout: bool = Field(default=False, description="If true, excluded from annotation-driven improvement but included in evaluation for overfitting detection")


class Agent(BaseModel):
    """Agent model for storing agent configurations"""

    id: str = Field(default_factory=lambda: f"agent_{datetime.now(timezone.utc).timestamp()}")
    name: str
    description: str = ""
    model: str = ""
    agent_invocation_url: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # ==== HUB EXTENSIONS (Feature: analytics-hub) ====
    team: Optional[str] = Field(default=None, description="Team owning this agent")
    tags: List[str] = Field(default_factory=list, description="Tags for filtering/grouping")
    default_risk_tier: Optional[str] = Field(default=None, description="Default risk tier for evaluations")
    sampling_rate: Optional[float] = Field(default=None, description="Telemetry sampling rate (0.0-1.0)")

    @field_validator('sampling_rate')
    @classmethod
    def validate_sampling_rate(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError('sampling_rate must be between 0.0 and 1.0')
        return v


class AgentCreate(BaseModel):
    """Request model for creating an agent"""
    id: Optional[str] = None
    name: str
    description: str = ""
    model: str = ""
    agent_invocation_url: str
    team: Optional[str] = None
    tags: List[str] = []
    default_risk_tier: Optional[str] = None
    sampling_rate: Optional[float] = None

    @field_validator('sampling_rate')
    @classmethod
    def validate_sampling_rate(cls, v):
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError('sampling_rate must be between 0.0 and 1.0')
        return v


# Evaluation Models
# New structured evaluation output models
class AssertionResult(BaseModel):
    """Result of evaluating a single assertion."""
    passed: bool
    llm_judge_output: str  # Combined feedback + reasoning


class ArgumentAssertionResult(BaseModel):
    """Results for assertions on a tool argument."""
    name_of_argument: str
    assertions: List[AssertionResult]


class ToolExpectationResult(BaseModel):
    """Results for tool expectations with argument assertions."""
    name_of_tool: str
    arguments: List[ArgumentAssertionResult]


class ExpectedToolResult(BaseModel):
    """Expected tool usage result."""
    name_of_tool: str
    was_called: bool


class ResponseQualityResult(BaseModel):
    """Result of response quality assertion."""
    passed: bool
    llm_judge_output: str


class BehaviorAssertionResult(BaseModel):
    """Result of evaluating a behavior assertion."""
    assertion: str  # The assertion text that was evaluated
    passed: bool
    llm_judge_output: str


# ==============================================================================
# RUBRIC SCORE RESULT (Feature: rubric-evaluation)
# ==============================================================================
class RubricScoreResult(BaseModel):
    """Result of scoring a single rubric criterion for a test case."""
    criterion: str  # Name of the rubric criterion
    score: int  # 1-5 score assigned by judge
    reasoning: str  # LLM explanation for the score

# ==============================================================================
# TEST CASE RESULT MODEL (Features: timing-metrics, rate-limit-retry)
# ==============================================================================
# This model captures the complete result of executing a single test case.
# It includes both the evaluation results AND operational metadata like:
# - Timing information for performance analysis
# - Retry counts for rate limit visibility
# - Actual tool calls for debugging agent behavior
# ==============================================================================
class TestCaseResult(BaseModel):
    """Structured result for a single test case.
    
    This model is persisted as part of the EvaluationRun document.
    It contains everything needed to understand what happened during the test.
    """
    testcase_id: str
    passed: bool  # Overall pass/fail based on all assertions and expected tools
    response_from_agent: str
    expected_tools: List[ExpectedToolResult]
    tool_expectations: List[ToolExpectationResult]
    behavior_assertions: List[BehaviorAssertionResult] = Field(
        default_factory=list, description="Results for behavior assertions (hybrid mode)"
    )
    response_quality_assertion: Optional[ResponseQualityResult] = None
    assertion_mode: Optional[str] = Field(default=None, description="Assertion mode used for this evaluation")

    # Capture what the agent actually did for UI display
    # This includes the full tool call data with arguments and responses
    actual_tool_calls: List[Dict[str, Any]] = Field(default_factory=list)
    execution_error: Optional[str] = None  # Error message if execution failed
    
    # ==== COST TRACKING (Feature: cost-attribution) ====
    agent_cost_usd: float = Field(default=0.0, ge=0.0, description="Cost of agent LLM calls for this test case")
    judge_cost_usd: float = Field(default=0.0, ge=0.0, description="Cost of LLM judge calls for this test case")
    agent_tokens_in: int = Field(default=0, description="Input tokens consumed by agent calls")
    agent_tokens_out: int = Field(default=0, description="Output tokens consumed by agent calls")
    judge_tokens_in: int = Field(default=0, description="Input tokens consumed by judge calls")
    judge_tokens_out: int = Field(default=0, description="Output tokens consumed by judge calls")

    failure_mode: Optional[str] = Field(default=None, description="Classified failure mode: tool_not_called, wrong_tool, wrong_args, hallucination, timeout, partial_match")

    # ==== RUBRIC SCORING (Feature: rubric-evaluation) ====
    rubric_scores: Optional[List[RubricScoreResult]] = Field(default=None, description="Per-criterion rubric scores (only set when scoring_mode=rubric)")
    rubric_average_score: Optional[float] = Field(default=None, description="Average of all rubric criterion scores (1-5 scale)")

    # ==== RATE LIMIT TRACKING (Feature: rate-limit-retry) ====
    # This field tracks how many retries were needed due to LLM rate limits.
    # A non-zero value here indicates the test encountered capacity issues.
    retry_count: int = Field(default=0, description="Number of retries due to rate limits")
    
    # ==== TIMING INFORMATION (Feature: timing-metrics) ====
    # These fields enable performance analysis of individual tests.
    # - agent_call_duration: Time spent calling the agent (including retries)
    # - judge_call_duration: Time spent on LLM judge calls (including retries)
    # - total_duration: End-to-end time including all phases
    completed_at: Optional[datetime] = Field(default=None, description="When this test case completed")
    agent_call_duration_seconds: Optional[float] = Field(default=None, description="Time taken for agent call including retries")
    judge_call_duration_seconds: Optional[float] = Field(default=None, description="Time taken for LLM judge calls including retries")
    total_duration_seconds: Optional[float] = Field(default=None, description="Total time for this test case")
    
    @field_serializer('completed_at')
    def serialize_completed_at(self, dt: Optional[datetime], _info) -> Optional[str]:
        if dt is None:
            return None
        return dt.isoformat()


# ==============================================================================
# EVALUATION RUN STATUS ENUM (Feature: cancel-evaluation, orphan-cleanup)
# ==============================================================================
# Added 'cancelled' status to support manual cancellation and automatic
# cleanup of orphaned evaluations after server restarts.
# ==============================================================================
class EvaluationRunStatus(str, Enum):
    pending = "pending"      # Created but not yet started
    running = "running"      # Currently executing tests
    completed = "completed"  # All tests finished successfully
    failed = "failed"        # Evaluation failed with error
    cancelled = "cancelled"  # Manually cancelled OR orphaned after restart (Feature: cancel-evaluation)


# ==============================================================================
# STATUS HISTORY ENTRY (Features: status-updates, rate-limit-retry)
# ==============================================================================
# This model tracks the chronological history of status changes during
# evaluation execution. It enables:
# - Real-time progress visibility in the UI
# - Post-mortem analysis of what happened during an evaluation
# - Rate limit tracking with specific retry details
# ==============================================================================
class StatusHistoryEntry(BaseModel):
    """A timestamped status message for evaluation progress tracking.
    
    Each entry represents a notable event during evaluation execution.
    The UI uses this to show an activity log and highlight rate limit events.
    """
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    message: str
    
    # ==== RATE LIMIT DETAILS (Feature: rate-limit-retry) ====
    # These fields provide granular visibility into rate limit events.
    # When is_rate_limit=True, the other fields show retry details.
    is_rate_limit: bool = Field(default=False, description="Whether this entry is a rate limit event")
    retry_attempt: Optional[int] = Field(default=None, description="Which retry attempt (1-based)")
    max_attempts: Optional[int] = Field(default=None, description="Maximum retry attempts configured")
    wait_seconds: Optional[float] = Field(default=None, description="Seconds waiting before retry")
    
    @field_serializer('timestamp')
    def serialize_timestamp(self, dt: datetime, _info):
        return dt.isoformat()


# ==============================================================================
# EVALUATION RUN MODEL (Features: verbose-logging, status-updates, rate-limit-retry)
# ==============================================================================
# This is the main document stored for each evaluation.
# It contains:
# - Configuration (agent endpoint, timeout, verbose logging flag)
# - Progress tracking (completed/failed/passed counts)
# - Timestamps (created, started, completed)
# - Test case results (nested TestCaseResult objects)
# - Status history for real-time visibility (Feature: status-updates)
# - Rate limit statistics (Feature: rate-limit-retry)
# ==============================================================================
class EvaluationRun(BaseModel):
    """Evaluation run with structured test case results.

    This is the main evaluation document. It tracks the entire lifecycle
    of an evaluation from creation through completion.
    """

    id: str = Field(default_factory=lambda: f"eval_{datetime.now(timezone.utc).timestamp()}")
    name: str
    dataset_id: str
    agent_id: str
    status: EvaluationRunStatus = EvaluationRunStatus.pending

    # ==== CONFIGURATION ====
    agent_endpoint: str
    agent_auth_required: bool = True
    timeout_seconds: int = 300
    # Feature: verbose-logging - When True, logs each assertion being evaluated
    verbose_logging: bool = Field(default=False, description="Enable detailed assertion-level status updates")
    # Feature: demo-mode - When True, generates synthetic agent responses instead of making HTTP calls
    demo_mode: bool = Field(default=False, description="Use synthetic mock responses instead of calling the agent endpoint")

    # ==== PROMPT TRACEABILITY ====
    # Links this evaluation to the exact prompt version that produced the results.
    # None for evaluations created before prompt tracking was added.
    prompt_version: Optional[int] = Field(default=None, description="Prompt version used for this evaluation")
    prompt_id: Optional[str] = Field(default=None, description="AgentPrompt ID used for this evaluation")

    # ==== JUDGE CONFIG TRACEABILITY ====
    judge_config_id: Optional[str] = Field(default=None, description="JudgeConfig ID used for this evaluation")
    judge_config_version: Optional[int] = Field(default=None, description="JudgeConfig version used for this evaluation")

    # ==== MODEL TRACEABILITY ====
    # Captures which model was used for this evaluation run.
    # Critical for comparing performance across model changes.
    agent_model: Optional[str] = Field(default=None, description="Model identifier used by the agent for this evaluation")

    # ==== SELECTIVE RERUN ====
    test_case_ids: Optional[List[str]] = Field(default=None, description="If set, only these test cases were run (selective rerun)")

    # ==== PROGRESS TRACKING ====
    total_tests: int = 0
    completed_tests: int = 0
    in_progress_tests: int = Field(default=0, description="Tests currently executing or being judged")
    failed_tests: int = 0
    passed_count: int = 0

    # ==== TIMESTAMPS ====
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    # ==== RESULTS ====
    test_cases: List[TestCaseResult] = []

    # ==== REGRESSIONS (Feature: regression-detection) ====
    # Test cases that regressed vs previous evaluation (passed before, failed now)
    regressions: List[Dict[str, Any]] = Field(default_factory=list, description="Test cases that regressed vs previous evaluation")

    # ==== WARNINGS (Feature: rate-limit-retry) ====
    # Collects warning messages, primarily about rate limit retries.
    # These are displayed prominently in the UI.
    warnings: List[str] = Field(default_factory=list, description="Warnings encountered during evaluation")

    # ==== REAL-TIME STATUS (Feature: status-updates) ====
    # status_message: Current activity, polled by the UI for live updates
    # status_history: Complete chronological log for post-mortem analysis
    status_message: Optional[str] = Field(default=None, description="Current activity message for UI display")
    status_history: List[StatusHistoryEntry] = Field(default_factory=list, description="Chronological list of status messages")

    # ==== COST TRACKING (Feature: cost-attribution) ====
    total_cost_usd: float = Field(default=0.0, description="Total cost (agent + judge) for the entire evaluation")
    total_tokens_in: int = Field(default=0, description="Total input tokens across all calls")
    total_tokens_out: int = Field(default=0, description="Total output tokens across all calls")

    # Rate limit statistics
    total_rate_limit_hits: int = Field(default=0, description="Total number of rate limit errors encountered")
    total_retry_wait_seconds: float = Field(default=0.0, description="Total time spent waiting on retries")

    @field_serializer('created_at', 'started_at', 'completed_at')
    def serialize_datetime(self, dt: Optional[datetime], _info):
        return dt.isoformat() if dt else None


class EvaluationRunCreate(BaseModel):
    name: str
    dataset_id: str
    agent_id: str
    agent_endpoint: str
    agent_auth_required: bool = True
    timeout_seconds: int = 300
    verbose_logging: bool = False
    demo_mode: bool = False
    prompt_version: Optional[int] = None
    prompt_id: Optional[str] = None
    judge_config_id: Optional[str] = None
    judge_config_version: Optional[int] = None
    agent_model: Optional[str] = None
    test_case_ids: Optional[List[str]] = None  # If set, only run these test cases (selective rerun)
    total_cost_usd: float = 0.0
    total_tokens_in: int = 0
    total_tokens_out: int = 0


# ---------- MCP stuff ----------
class ToolCallResult(BaseModel):
    """Generic result model for tool calls"""
    success: bool = Field(..., description="Operation success status")
    tool_result_data: Optional[Dict[str, Any]] = Field(None, description="Response data")
    error: Optional[str] = Field(None, description="Error message if operation failed")
    

class McpToolLogEntry(BaseModel):
    """Log entry for MCP tool calls"""
    tool_name: str = Field(..., description="Name of the tool called")
    input_parameters: Dict[str, Any] = Field(..., description="Input parameters provided to the tool")
    result: ToolCallResult = Field(..., description="Result of the tool call")
    timestamp: Optional[str] = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat(), description="Auto-generated timestamp")


# ========== Exports ==========

__all__ = [
    'Dataset',
    'EvaluatorContract',
    'DatasetResponse',
    'TestCaseResponse',
    'CreateDatasetRequest',
    'TestCaseCreate',
    'Agent',
    'AgentCreate',
    'EvaluationRun',
    'EvaluationRunStatus',
    'EvaluationRunCreate',
    'TestCaseResult',
    'AssertionResult',
    'ArgumentAssertionResult',
    'ToolExpectationResult',
    'ExpectedToolResult',
    'ResponseQualityResult',
    'Metadata',
    'SeedScenario',
    'TestCase',
    'ToolExpectation',
    'ArgumentAssertion',
    'ResponseQualityAssertion',
    'BehaviorAssertion',
    'BehaviorAssertionResult',
    'ReferenceSeedItem',
    'MockStatus',
    'EmailMock',
    'TeamsMock',
    'AgentPrompt',
    'CreatePromptRequest',
    'PromptProposal',
    'GenerateProposalsRequest',
    'ReEvaluateRequest',
]

# ============================================================================
# Annotation Models (2-layer: Run-level + Action-level)
# ============================================================================

class RunAnnotation(BaseModel):
    """Run-level annotation — quick triage of an entire evaluation run."""
    evaluation_id: str
    run_id: str  # testcase_id within the evaluation
    outcome: Optional[int] = None  # 1-5 scale: Failed..Yes
    efficiency: Optional[str] = None  # "efficient", "acceptable", "wasteful"
    issues: List[str] = []  # Issue tags from ISSUE_TAGS
    notes: Optional[str] = None
    annotated_by: Optional[str] = None
    annotated_at: Optional[datetime] = None


class ActionAnnotation(BaseModel):
    """Action-level annotation — drill into a specific tool call / step."""
    evaluation_id: str
    run_id: str
    action_index: int  # Index of the action/tool call within the run
    correctness: Optional[str] = None  # "correct", "acceptable", "incorrect"
    parameter_quality: Optional[str] = None  # "good", "suboptimal", "wrong"
    info_utilization: Optional[str] = None  # "good", "partial", "ignored"
    error_contributor: bool = False
    correction: Optional[str] = None  # What should it have done instead?
    annotated_by: Optional[str] = None
    annotated_at: Optional[datetime] = None


class AnnotationSummary(BaseModel):
    """Summary stats for annotations on an evaluation run."""
    evaluation_id: str
    total_runs: int = 0
    annotated_runs: int = 0
    total_actions: int = 0
    annotated_actions: int = 0
    issue_counts: Dict[str, int] = {}
    outcome_distribution: Dict[int, int] = {}


class CreateRunAnnotation(BaseModel):
    outcome: Optional[int] = None
    efficiency: Optional[str] = None
    issues: List[str] = []
    notes: Optional[str] = None


class CreateActionAnnotation(BaseModel):
    correctness: Optional[str] = None
    parameter_quality: Optional[str] = None
    info_utilization: Optional[str] = None
    error_contributor: bool = False
    correction: Optional[str] = None


# ====== Agent Prompts ======
class AgentPrompt(BaseModel):
    id: str = Field(default_factory=lambda: f"prompt_{uuid.uuid4().hex[:16]}")
    agent_id: str
    system_prompt: str
    version: int
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    notes: Optional[str] = None
    is_active: bool = False

class CreatePromptRequest(BaseModel):
    system_prompt: str
    notes: Optional[str] = None


# ====== Judge Configuration (versioned, global) ======
class RubricLevel(BaseModel):
    """A single level on a rubric scoring scale."""
    score: int  # e.g. 1–5
    description: str  # What this score means

class RubricCriterion(BaseModel):
    """One scoring criterion in the rubric."""
    name: str  # e.g. "tool_selection", "parameter_quality"
    description: str  # What this criterion evaluates
    levels: List[RubricLevel]  # Scale definitions

class JudgeConfig(BaseModel):
    """Global judge configuration with versioning.

    Stores the system prompt, user prompt templates, and optional rubric
    for the LLM judge.  Each config is identified by (id, version) and
    exactly one version across all configs may be marked ``is_active``.
    """
    id: str = Field(default_factory=lambda: f"jcfg_{uuid.uuid4().hex[:12]}")
    name: str
    version: int = 1
    is_active: bool = False

    # Prompt templates — use {{variable}} placeholders
    system_prompt: str
    user_prompt_template_batched: str  # For batched assertion evaluation
    user_prompt_template_single: str   # For single assertion evaluation

    # Rubric / scoring
    rubric: List[RubricCriterion] = Field(default_factory=list)
    scoring_mode: Literal["binary", "rubric"] = "binary"
    pass_threshold: Optional[float] = Field(default=None, description="Min avg score to pass (rubric mode only)")

    # Metadata
    notes: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class JudgeConfigCreate(BaseModel):
    """Request model for creating / versioning a judge config."""
    name: str
    system_prompt: str
    user_prompt_template_batched: str
    user_prompt_template_single: str
    rubric: List[RubricCriterion] = Field(default_factory=list)
    scoring_mode: Literal["binary", "rubric"] = "binary"
    pass_threshold: Optional[float] = None
    notes: Optional[str] = None


# ====== Prompt Proposals ======
class PromptProposal(BaseModel):
    id: str = Field(default_factory=lambda: f"proposal_{uuid.uuid4().hex[:16]}")
    agent_id: str
    prompt_version: int
    title: str
    category: str
    confidence: float = 0.0
    priority: str = "medium"  # high, medium, low
    pattern_source: str = ""
    impact: str = ""
    impact_detail: str = ""
    diff: Dict[str, Any] = Field(default_factory=dict)  # {file, removed: [], added: []}
    status: str = "pending"  # pending, applied, dismissed
    evidence: List[Dict[str, Any]] = Field(default_factory=list, description="Evidence linking to specific test case failures")
    reasoning: Optional[str] = Field(default=None, description="LLM reasoning chain for this proposal")
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class GenerateProposalsRequest(BaseModel):
    evaluation_ids: Optional[List[str]] = None
    judge_rubric: Optional[str] = None  # Custom rubric/criteria for the LLM judge
    include_reasoning: bool = False  # Whether to include LLM reasoning chain in proposals

# ====== Re-evaluation ======
class ReEvaluateRequest(BaseModel):
    dataset_id: str
    agent_id: str
    custom_system_prompt: Optional[str] = None
    name: Optional[str] = None
    verbose_logging: bool = False


# ============================================================================
# Cost Tracking Models (Feature: cost-attribution)
# ============================================================================

class CostRecord(BaseModel):
    """Individual cost record for a single LLM call."""
    id: str = Field(default_factory=lambda: f"cost_{uuid.uuid4().hex[:12]}")
    evaluation_id: Optional[str] = None
    test_case_id: Optional[str] = None
    agent_id: Optional[str] = None
    call_type: str = Field(..., description="Type of call: agent_invocation, judge_llm, prompt_proposal")
    model: str
    tokens_in: int
    tokens_out: int
    cost_usd: float
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


# ============================================================================
# Alert & Notification Models (Feature: monitoring-agent)
# ============================================================================



# ============================================================================
# Telemetry Models (Feature: online-evals)
# ============================================================================

class TelemetryPayload(BaseModel):
    """Payload accepted at the telemetry ingestion endpoint."""
    agent_id: str
    trace_id: Optional[str] = None
    input: str
    output: str
    tool_calls: Optional[List[Dict[str, Any]]] = None
    latency_ms: Optional[float] = None
    model: Optional[str] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    timestamp: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    source: str = "production"  # production, staging, dev
    environment: Optional[str] = None


# ============================================================================
# Production Trace Models (Feature: production-trace-support)
# ============================================================================

class ProductionTrace(BaseModel):
    """Represents a sampled production trace."""
    id: str
    agent_id: str
    trace_id: Optional[str]
    input: str
    output: str
    tool_calls: Optional[List[Dict[str, Any]]]
    latency_ms: Optional[float]
    model: Optional[str]
    tokens_in: Optional[int]
    tokens_out: Optional[int]
    timestamp: str
    metadata: Optional[Dict[str, Any]]
    status: str = "pending"  # pending, annotated, converted_to_testcase, archived
    pii_detected: bool = False
    pii_flags: List[str] = []
    pii_scan_completed: bool = False
    created_at: str
    expires_at: Optional[str] = None
    testcase_id: Optional[str] = None
    dataset_id: Optional[str] = None


class TraceAnnotation(BaseModel):
    """Annotation for a production trace."""
    trace_id: str
    outcome: Optional[int] = None  # 1-5 scale
    efficiency: Optional[str] = None  # efficient, acceptable, wasteful
    issues: List[str] = []
    notes: Optional[str] = None
    action_count: int = 0
    action_annotations: List[Dict[str, Any]] = []
    pii_detected: Optional[bool] = None
    sensitive_content: str = "none"  # none, pii, secrets, custom
    testcase_candidate: bool = False
    conversion_notes: Optional[str] = None
    annotated_by: Optional[str] = None
    annotated_at: Optional[str] = None


class TraceToTestcaseConversion(BaseModel):
    """Audit record for converting a trace to a test case."""
    trace_id: str
    testcase_id: str
    dataset_id: str
    conversion_type: str  # manual, auto_approved, auto_pending_review
    reason: Optional[str] = None
    extracted_fields: Dict[str, Any] = {}
    pii_redacted: List[str] = []
    converted_by: str
    converted_at: str
    approved_by: Optional[str] = None
    approved_at: Optional[str] = None


