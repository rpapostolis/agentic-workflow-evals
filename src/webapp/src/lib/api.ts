/**
 * API Client for the Agent Evaluations Backend
 * 
 * ==============================================================================
 * FEATURES IMPLEMENTED IN THIS MODULE:
 * ==============================================================================
 * 
 * 1. RATE LIMIT TRACKING (Feature: rate-limit-retry)
 *    - TestCaseResult.retry_count: Shows how many retries were needed
 *    - EvaluationRun.warnings: Collects rate limit warning messages
 *    - EvaluationRun.total_rate_limit_hits: Aggregate count
 *    - EvaluationRun.total_retry_wait_seconds: Total time spent waiting
 * 
 * 2. TIMING METRICS (Feature: timing-metrics)
 *    - TestCaseResult.completed_at: When each test finished
 *    - TestCaseResult.agent_call_duration_seconds: Agent call time
 *    - TestCaseResult.judge_call_duration_seconds: LLM judge time
 *    - TestCaseResult.total_duration_seconds: End-to-end time
 * 
 * 3. VERBOSE LOGGING (Feature: verbose-logging)
 *    - CreateEvaluationRequest.verbose_logging: Enable detailed logging
 *    - EvaluationRun.verbose_logging: Flag stored on evaluation
 * 
 * 4. STATUS UPDATES (Feature: status-updates)
 *    - EvaluationRun.status_message: Current activity for live updates
 *    - EvaluationRun.status_history: Chronological activity log
 *    - StatusHistoryEntry: Timestamped status with rate limit details
 * 
 * 5. CANCEL EVALUATION (Feature: cancel-evaluation)
 *    - cancelEvaluation(): API method to cancel running evaluations
 * 
 * ==============================================================================
 */

import { API_BASE_URL } from "./config";

// Backend types from the API matching models2.py schema

export interface ResponseQualityAssertion {
	assertion: string;
}

// Feature: 3-tier-assertions
export interface BehaviorAssertion {
	assertion: string;
}

export type AssertionMode = "response_only" | "tool_level" | "hybrid";

export interface BackendTestCase {
	id: string;
	dataset_id: string;
	name?: string | null;
	description: string;
	input: string;
	expected_response: string;
	response_quality_expectation?: ResponseQualityAssertion | null;
	assertion_mode?: AssertionMode;
	behavior_assertions?: BehaviorAssertion[];
	references_seed: Record<string, any>;
}

export interface Metadata {
	generator_id: string;
	suite_id: string;
	created_at: string;
	version: string;
	schema_hash: string;
}

export interface SeedDataset {
	name: string;
	goal: string;
	input: Record<string, any>;
}

// DatasetResponse from API (without inline test_cases)
export interface DatasetResponse {
	id: string;
	metadata: Metadata;
	seed: SeedDataset;
	test_case_ids: string[];
	created_at: string;
}

// Combined type for frontend use (dataset + test cases)
export interface BackendDataset {
	id: string;
	metadata: Metadata;
	seed: SeedDataset;
	test_case_ids: string[];
	test_cases: BackendTestCase[];
	created_at: string;
}

export interface BackendAgent {
	id: string;
	name: string;
	description: string;
	model: string;
	agent_invocation_url: string;
	createdAt: string;
}

export interface CreateDatasetRequest {
	seed: string;
	metadata?: Record<string, any>;
}

export interface CreateAgentRequest {
	name: string;
	description?: string;
	model?: string;
	agent_invocation_url: string;
}

export interface CreateTestCaseRequest {
	input: string;
	expectedTools: string[];
	evaluationCriteria: string;
}

// Feature: cancel-evaluation - Added "cancelled" status
export type EvaluationRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

// Structured evaluation result types
export interface AssertionResult {
	passed: boolean;
	llm_judge_output: string;
}

export interface ResponseQualityResult {
	passed: boolean;
	llm_judge_output: string;
}

// Feature: 3-tier-assertions
export interface BehaviorAssertionResult {
	assertion: string;
	passed: boolean;
	llm_judge_output: string;
}

/**
 * Result of a single test case execution.
 *
 * Features included:
 * - retry_count (Feature: rate-limit-retry): Number of retries due to rate limits
 * - completed_at, agent_call_duration_seconds, etc. (Feature: timing-metrics): Performance data
 * - behavior_assertions, assertion_mode (Feature: 3-tier-assertions): Flexible assertion modes
 */
export interface RubricScoreResult {
	criterion: string;
	score: number;  // 1-5
	reasoning: string;
}

export interface TestCaseResult {
	testcase_id: string;
	passed: boolean;
	response_from_agent: string;
	behavior_assertions?: BehaviorAssertionResult[];
	response_quality_assertion?: ResponseQualityResult;
	assertion_mode?: AssertionMode | null;
	actual_tool_calls: Array<{
		name: string;
		arguments: Array<{ name: string; value: any }>;
		response?: any;  // MCP tool response
	}>;
	execution_error?: string | null;
	retry_count?: number;  // Number of retries due to rate limits
	// Rubric scoring (Feature: rubric-evaluation)
	rubric_scores?: RubricScoreResult[] | null;
	rubric_average_score?: number | null;
	// Timing information
	completed_at?: string | null;
	agent_call_duration_seconds?: number | null;
	judge_call_duration_seconds?: number | null;
	total_duration_seconds?: number | null;
}

export interface EvaluationRun {
	id: string;
	name: string;
	dataset_id: string;
	agent_id: string;
	status: EvaluationRunStatus;
	agent_endpoint: string;
	agent_auth_required: boolean;
	timeout_seconds: number;
	verbose_logging?: boolean;  // Enable detailed assertion-level status updates
	total_tests: number;
	completed_tests: number;
	in_progress_tests: number;
	failed_tests: number;
	passed_count: number;
	created_at: string;
	started_at?: string | null;
	completed_at?: string | null;
	test_cases: TestCaseResult[];
	warnings?: string[];  // Warnings like rate limit retries
	status_message?: string | null;  // Current activity message
	status_history?: StatusHistoryEntry[];  // Chronological list of status messages
	total_rate_limit_hits?: number;  // Total number of rate limit errors encountered
	total_retry_wait_seconds?: number;  // Total time spent waiting on retries
	// Prompt traceability
	prompt_version?: number | null;  // Which prompt version was used
	prompt_id?: string | null;  // AgentPrompt ID used
	// Regression detection
	regressions?: Array<{ testcase_id: string; previous_eval_id: string }>;
}

export interface StatusHistoryEntry {
	timestamp: string;
	message: string;
	is_rate_limit?: boolean;  // Whether this entry is a rate limit event
	retry_attempt?: number | null;  // Which retry attempt (1-based)
	max_attempts?: number | null;  // Maximum retry attempts configured
	wait_seconds?: number | null;  // Seconds waiting before retry
}

export interface CreateEvaluationRequest {
	name: string;
	dataset_id: string;
	agent_id: string;
	agent_endpoint: string;
	agent_auth_required?: boolean;
	timeout_seconds?: number;
	verbose_logging?: boolean;  // Enable detailed assertion-level status updates
}

// ============================================================================
// Annotation Types (2-layer: Run-level + Action-level)
// ============================================================================

export interface RunAnnotation {
	evaluation_id: string;
	run_id: string;
	outcome?: number | null;        // 1-5: Failed..Yes
	efficiency?: string | null;     // "efficient" | "acceptable" | "wasteful"
	issues: string[];               // Issue tags
	notes?: string | null;
	annotated_by?: string | null;
	annotated_at?: string | null;
}

export interface ActionAnnotation {
	evaluation_id: string;
	run_id: string;
	action_index: number;
	correctness?: string | null;        // "correct" | "acceptable" | "incorrect"
	parameter_quality?: string | null;  // "good" | "suboptimal" | "wrong"
	info_utilization?: string | null;   // "good" | "partial" | "ignored"
	error_contributor: boolean;
	correction?: string | null;
	annotated_by?: string | null;
	annotated_at?: string | null;
}

export interface AnnotationSummary {
	evaluation_id: string;
	total_runs: number;
	annotated_runs: number;
	total_actions: number;
	annotated_actions: number;
	issue_counts: Record<string, number>;
	outcome_distribution: Record<number, number>;
}

// ============================================================================
// Prompt Management Types
// ============================================================================

export interface AgentPrompt {
	id: string;
	agent_id: string;
	system_prompt: string;
	version: number;
	created_at: string;
	notes?: string | null;
	is_active: boolean;
}

export interface CreatePromptRequest {
	system_prompt: string;
	notes?: string | null;
}

export interface PromptProposal {
	id: string;
	agent_id: string;
	prompt_version: number;
	title: string;
	category: string;
	confidence: number;
	priority: string;
	pattern_source: string;
	impact: string;
	impact_detail: string;
	diff: {
		removed: string[];
		added: string[];
	};
	status: string;
	created_at: string;
}

export interface GenerateProposalsRequest {
	evaluation_ids?: string[];
}

export interface DashboardStats {
	total_evaluations: number;
	completed_evaluations: number;
	total_agents: number;
	avg_pass_rate: number;
	annotation_coverage: number;
	agent_leaderboard: Array<{
		agent_id: string;
		agent_name: string;
		eval_count: number;
		avg_pass_rate: number;
		latest_pass_rate: number;
	}>;
	recent_evaluations: Array<{
		id: string;
		name: string;
		agent_name: string;
		status: string;
		pass_rate: number;
		total_tests: number;
		created_at: string;
	}>;
}

export interface TrendDataPoint {
	date: string;
	avg_pass_rate: number;
	eval_count: number;
	min_pass_rate: number;
	max_pass_rate: number;
}

export interface FailurePatterns {
	issue_tags: Array<{ tag: string; count: number }>;
	correctness_distribution: Record<string, number>;
	total_annotations: number;
}

export interface ReEvaluateRequest {
	dataset_id: string;
	agent_id: string;
	custom_system_prompt?: string;
	name?: string;
	verbose_logging?: boolean;
}

// ====== Judge Configuration types ======
export interface RubricLevel {
	score: number;
	description: string;
}

export interface RubricCriterion {
	name: string;
	description: string;
	levels: RubricLevel[];
}

export interface JudgeConfig {
	id: string;
	name: string;
	version: number;
	is_active: boolean;
	system_prompt: string;
	user_prompt_template_batched: string;
	user_prompt_template_single: string;
	rubric: RubricCriterion[];
	scoring_mode: "binary" | "rubric";
	pass_threshold?: number | null;
	notes?: string | null;
	created_at: string;
}

export interface JudgeConfigCreate {
	name: string;
	system_prompt: string;
	user_prompt_template_batched: string;
	user_prompt_template_single: string;
	rubric?: RubricCriterion[];
	scoring_mode?: "binary" | "rubric";
	pass_threshold?: number | null;
	notes?: string | null;
}





export interface ModelComparisonResult {
	models: Array<{
		model: string;
		eval_count: number;
		avg_pass_rate: number;
		avg_latency: number;
		avg_cost: number;
		total_cost: number;
		agent_count: number;
	}>;
	comparisons: Array<{
		model_a: string;
		model_b: string;
		quality_diff_pct: number;
		cost_diff_pct: number;
		insight: string;
	}>;
}


class ApiClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	// Datasets (Evaluation Datasets)
	async getRawDatasets(skip = 0, limit = 100): Promise<DatasetResponse[]> {
		try {
			const response = await fetch(`${this.baseUrl}/datasets?skip=${skip}&limit=${limit}`);
			if (!response.ok) {
				const errorText = await response.text();
				console.error("API Error:", response.status, errorText);
				throw new Error(`Failed to fetch datasets: ${response.statusText}`);
			}
			const data = await response.json();
			return data;
		} catch (error) {
			console.error("Network error fetching datasets:", error);
			throw error;
		}
	}

	async getRawDataset(datasetId: string): Promise<DatasetResponse> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch dataset: ${response.statusText}`);
		}
		return response.json();
	}

	// Combined methods for frontend convenience
	async getDatasets(skip = 0, limit = 100): Promise<BackendDataset[]> {
		const rawDatasets = await this.getRawDatasets(skip, limit);
		// For list view, don't fetch test cases - just use empty array
		// The UI can show count from test_case_ids.length
		const datasets = rawDatasets.map((dataset) => ({
			...dataset,
			test_cases: [], // Empty array for list view - count comes from test_case_ids.length
		}));
		return datasets;
	}

	async getDataset(datasetId: string): Promise<BackendDataset> {
		const dataset = await this.getRawDataset(datasetId);
		const testCases = await this.getTestCases(datasetId);
		return {
			...dataset,
			test_cases: testCases,
		};
	}

	async createDataset(data: CreateDatasetRequest): Promise<DatasetResponse> {
		const response = await fetch(`${this.baseUrl}/datasets`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to create dataset: ${response.statusText}`);
		}
		return response.json();
	}

	async deleteDataset(datasetId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Failed to delete dataset: ${response.statusText}`);
		}
	}

	// Feature: Dataset Creation UI - createDataset with name, goal, and domain
	async createDatasetUI(data: { name: string; goal: string; synthetic_domain?: string }): Promise<DatasetResponse> {
		const response = await fetch(`${this.baseUrl}/datasets`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to create dataset: ${response.statusText}`);
		}
		return response.json();
	}

	// Feature: Dataset Import UI
	async importDataset(data: any): Promise<DatasetResponse> {
		const response = await fetch(`${this.baseUrl}/datasets/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to import dataset: ${response.statusText}`);
		}
		return response.json();
	}

	// Test Cases
	async getTestCases(datasetId: string): Promise<BackendTestCase[]> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases`);
		if (!response.ok) {
			throw new Error(`Failed to fetch test cases: ${response.statusText}`);
		}
		return response.json();
	}

	async getTestCase(datasetId: string, testCaseId: string): Promise<BackendTestCase> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases/${testCaseId}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch test case: ${response.statusText}`);
		}
		return response.json();
	}

	async createTestCase(datasetId: string, data: CreateTestCaseRequest): Promise<BackendTestCase> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to create test case: ${response.statusText}`);
		}
		return response.json();
	}

	// Feature: Test Case Creation UI
	async createTestCaseUI(datasetId: string, data: any): Promise<BackendTestCase> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to create test case: ${response.statusText}`);
		}
		return response.json();
	}

	async updateTestCase(datasetId: string, testCaseId: string, data: BackendTestCase): Promise<BackendTestCase> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases/${testCaseId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to update test case: ${response.statusText}`);
		}
		return response.json();
	}

	async deleteTestCase(datasetId: string, testCaseId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/testcases/${testCaseId}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Failed to delete test case: ${response.statusText}`);
		}
	}

	// Agents
	async getAgents(skip = 0, limit = 100): Promise<BackendAgent[]> {
		try {
			const response = await fetch(`${this.baseUrl}/agents?skip=${skip}&limit=${limit}`);
			if (!response.ok) {
				const errorText = await response.text();
				console.error("API Error:", response.status, errorText);
				throw new Error(`Failed to fetch agents: ${response.statusText}`);
			}
			const data = await response.json();
			return data;
		} catch (error) {
			console.error("Network error fetching agents:", error);
			throw error;
		}
	}

	async getAgent(agentId: string): Promise<BackendAgent> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch agent: ${response.statusText}`);
		}
		return response.json();
	}

	async createAgent(data: CreateAgentRequest): Promise<BackendAgent> {
		const response = await fetch(`${this.baseUrl}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to create agent: ${response.statusText}`);
		}
		return response.json();
	}

	async updateAgent(agentId: string, data: CreateAgentRequest): Promise<BackendAgent> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			throw new Error(`Failed to update agent: ${response.statusText}`);
		}
		return response.json();
	}

	async deleteAgent(agentId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Failed to delete agent: ${response.statusText}`);
		}
	}

	async listAgents(skip = 0, limit = 100): Promise<BackendAgent[]> {
		const response = await fetch(`${this.baseUrl}/agents?skip=${skip}&limit=${limit}`);
		if (!response.ok) {
			throw new Error(`Failed to list agents: ${response.statusText}`);
		}
		return response.json();
	}

	// Evaluations
	async createEvaluation(data: {
		name: string;
		dataset_id: string;
		agent_id: string;
		agent_endpoint: string;
		agent_auth_required?: boolean;
		timeout_seconds?: number;
		verbose_logging?: boolean;
		demo_mode?: boolean;
	}): Promise<EvaluationRun> {
		const response = await fetch(`${this.baseUrl}/evaluations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Failed to create evaluation: ${response.statusText} - ${errorText}`);
		}
		return response.json();
	}

	async getEvaluations(skip = 0, limit = 100, agentId?: string): Promise<EvaluationRun[]> {
		const params = new URLSearchParams({
			skip: skip.toString(),
			limit: limit.toString(),
		});
		if (agentId) {
			params.append("agent_id", agentId);
		}
		const response = await fetch(`${this.baseUrl}/evaluations?${params}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch evaluations: ${response.statusText}`);
		}
		return response.json();
	}

	async getEvaluation(evaluationId: string): Promise<EvaluationRun> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch evaluation: ${response.statusText}`);
		}
		return response.json();
	}

	async cancelEvaluation(evaluationId: string): Promise<EvaluationRun> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/cancel`, {
			method: "POST",
		});
		if (!response.ok) {
			throw new Error(`Failed to cancel evaluation: ${response.statusText}`);
		}
		return response.json();
	}

	async deleteEvaluation(evaluationId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Failed to delete evaluation: ${response.statusText}`);
		}
	}

	// ================================================================
	// Assertion Generation (Feature: 3-tier-assertions)
	// ================================================================

	async generateAssertions(
		evaluationId: string,
		testcaseId: string
	): Promise<{
		behavior_assertions: BehaviorAssertion[];
		response_quality_expectation: ResponseQualityAssertion | null;
		error?: string;
	}> {
		const response = await fetch(
			`${this.baseUrl}/evaluations/${evaluationId}/results/${testcaseId}/generate-assertions`,
			{ method: "POST" }
		);
		if (!response.ok) {
			throw new Error(`Failed to generate assertions: ${response.statusText}`);
		}
		return response.json();
	}

	// ================================================================
	// Annotations
	// ================================================================

	async getIssueTags(): Promise<string[]> {
		const response = await fetch(`${this.baseUrl}/annotations/issue-tags`);
		if (!response.ok) throw new Error("Failed to fetch issue tags");
		return response.json();
	}

	async upsertRunAnnotation(evaluationId: string, runId: string, data: Partial<RunAnnotation>): Promise<RunAnnotation> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs/${runId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error("Failed to save run annotation");
		return response.json();
	}

	async getRunAnnotation(evaluationId: string, runId: string): Promise<RunAnnotation | null> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs/${runId}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error("Failed to fetch run annotation");
		return response.json();
	}

	async listRunAnnotations(evaluationId: string): Promise<RunAnnotation[]> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs`);
		if (!response.ok) throw new Error("Failed to fetch run annotations");
		return response.json();
	}

	async upsertActionAnnotation(evaluationId: string, runId: string, actionIndex: number, data: Partial<ActionAnnotation>): Promise<ActionAnnotation> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs/${runId}/actions/${actionIndex}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error("Failed to save action annotation");
		return response.json();
	}

	async listActionAnnotations(evaluationId: string, runId?: string): Promise<ActionAnnotation[]> {
		const params = runId ? `?run_id=${runId}` : "";
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/actions${params}`);
		if (!response.ok) throw new Error("Failed to fetch action annotations");
		return response.json();
	}

	async getAnnotationSummary(evaluationId: string): Promise<AnnotationSummary> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/summary`);
		if (!response.ok) throw new Error("Failed to fetch annotation summary");
		return response.json();
	}

	async deleteRunAnnotation(evaluationId: string, runId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs/${runId}`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error("Failed to delete run annotation");
	}

	async deleteActionAnnotation(evaluationId: string, runId: string, actionIndex: number): Promise<void> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/runs/${runId}/actions/${actionIndex}`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error("Failed to delete action annotation");
	}

	async clearAllAnnotations(evaluationId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/annotations/all`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error("Failed to clear annotations");
	}

	// ================================================================
	// Prompt Management
	// ================================================================

	async getAgentPrompts(agentId: string): Promise<AgentPrompt[]> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/prompts`);
		if (!response.ok) throw new Error("Failed to fetch agent prompts");
		return response.json();
	}

	async getActivePrompt(agentId: string): Promise<AgentPrompt | null> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/prompts/active`);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error("Failed to fetch active prompt");
		return response.json();
	}

	async createPrompt(agentId: string, data: CreatePromptRequest): Promise<AgentPrompt> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/prompts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error("Failed to create prompt");
		return response.json();
	}

	async activatePrompt(agentId: string, version: number): Promise<AgentPrompt> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/prompts/${version}/activate`, {
			method: "PUT",
		});
		if (!response.ok) throw new Error("Failed to activate prompt");
		return response.json();
	}

	// ================================================================
	// Prompt Proposals
	// ================================================================

	async generateProposals(agentId: string, evaluationIds?: string[]): Promise<PromptProposal[]> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/proposals/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ evaluation_ids: evaluationIds || null }),
		});
		if (!response.ok) throw new Error("Failed to generate proposals");
		return response.json();
	}

	async listProposals(agentId: string, status?: string): Promise<PromptProposal[]> {
		const params = status ? `?status=${status}` : "";
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/proposals${params}`);
		if (!response.ok) throw new Error("Failed to fetch proposals");
		return response.json();
	}

	async applyProposal(agentId: string, proposalId: string): Promise<AgentPrompt> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/proposals/${proposalId}/apply`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("Failed to apply proposal");
		return response.json();
	}

	async testProposal(agentId: string, proposalId: string): Promise<{ evaluation_id: string; proposal_id: string }> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/proposals/${proposalId}/test`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("Failed to test proposal");
		return response.json();
	}

	async dismissProposal(agentId: string, proposalId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/agents/${agentId}/proposals/${proposalId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "dismissed" }),
		});
		if (!response.ok) throw new Error("Failed to dismiss proposal");
	}

	// ================================================================
	// Analytics
	// ================================================================

	async getDashboardStats(): Promise<DashboardStats> {
		const response = await fetch(`${this.baseUrl}/analytics/dashboard`);
		if (!response.ok) throw new Error("Failed to fetch dashboard stats");
		return response.json();
	}

	async getPassRateTrends(agentId?: string, days?: number): Promise<TrendDataPoint[]> {
		const params = new URLSearchParams();
		if (agentId) params.append("agent_id", agentId);
		if (days) params.append("days", days.toString());
		const query = params.toString() ? `?${params}` : "";
		const response = await fetch(`${this.baseUrl}/analytics/trends${query}`);
		if (!response.ok) throw new Error("Failed to fetch trends");
		return response.json();
	}

	async getFailurePatterns(agentId?: string): Promise<FailurePatterns> {
		const params = agentId ? `?agent_id=${agentId}` : "";
		const response = await fetch(`${this.baseUrl}/analytics/failure-patterns${params}`);
		if (!response.ok) throw new Error("Failed to fetch failure patterns");
		return response.json();
	}



	// ================================================================
	// Re-evaluation
	// ================================================================

	async rerunEvaluation(evaluationId: string): Promise<EvaluationRun> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/rerun`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("Failed to rerun evaluation");
		return response.json();
	}

	async rerunSelectedTestCases(evaluationId: string, testCaseIds: string[]): Promise<EvaluationRun> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evaluationId}/rerun-selected`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ test_case_ids: testCaseIds }),
		});
		if (!response.ok) throw new Error("Failed to rerun selected tests");
		return response.json();
	}

	async runWithPrompt(request: ReEvaluateRequest): Promise<{ evaluation_id: string }> {
		const response = await fetch(`${this.baseUrl}/evaluations/run-with-prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
		if (!response.ok) throw new Error("Failed to run evaluation with custom prompt");
		return response.json();
	}

	async compareEvaluations(evalIdA: string, evalIdB: string): Promise<any> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evalIdA}/compare/${evalIdB}`);
		if (!response.ok) {
			let detail = "Failed to compare evaluations";
			try {
				const err = await response.json();
				if (err.detail) detail = err.detail;
			} catch {}
			throw new Error(detail);
		}
		return response.json();
	}

	async explainComparison(evalIdA: string, evalIdB: string): Promise<{ explanation: string }> {
		const response = await fetch(`${this.baseUrl}/evaluations/${evalIdA}/explain/${evalIdB}`, {
			method: "POST",
		});
		if (!response.ok) {
			let detail = "Failed to generate explanation";
			try {
				const err = await response.json();
				if (err.detail) detail = err.detail;
			} catch {}
			throw new Error(detail);
		}
		return response.json();
	}

	// ====== System Prompts (Feature: configurable-prompts) ======

	async listSystemPrompts(): Promise<{ key: string; name: string; description: string; content: string; updated_at: string }[]> {
		const response = await fetch(`${this.baseUrl}/system-prompts`);
		if (!response.ok) throw new Error("Failed to fetch system prompts");
		return response.json();
	}

	async getSystemPrompt(key: string): Promise<{ key: string; name: string; description: string; content: string; updated_at: string }> {
		const response = await fetch(`${this.baseUrl}/system-prompts/${key}`);
		if (!response.ok) throw new Error("Failed to fetch system prompt");
		return response.json();
	}

	async updateSystemPrompt(key: string, data: { name?: string; description?: string; content?: string }): Promise<{ key: string; name: string; description: string; content: string; updated_at: string }> {
		const response = await fetch(`${this.baseUrl}/system-prompts/${key}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error("Failed to update system prompt");
		return response.json();
	}

	// ====== Judge Configs ======

	async listJudgeConfigs(): Promise<JudgeConfig[]> {
		const response = await fetch(`${this.baseUrl}/judge-configs`);
		if (!response.ok) throw new Error("Failed to fetch judge configs");
		return response.json();
	}

	async getActiveJudgeConfig(): Promise<JudgeConfig | null> {
		const response = await fetch(`${this.baseUrl}/judge-configs/active`);
		if (!response.ok) throw new Error("Failed to fetch active judge config");
		return response.json();
	}

	async listJudgeConfigVersions(configId: string): Promise<JudgeConfig[]> {
		const response = await fetch(`${this.baseUrl}/judge-configs/${configId}/versions`);
		if (!response.ok) throw new Error("Failed to fetch judge config versions");
		return response.json();
	}

	async getJudgeConfig(configId: string, version: number): Promise<JudgeConfig> {
		const response = await fetch(`${this.baseUrl}/judge-configs/${configId}/${version}`);
		if (!response.ok) throw new Error("Failed to fetch judge config");
		return response.json();
	}

	async createJudgeConfig(data: JudgeConfigCreate): Promise<JudgeConfig> {
		const response = await fetch(`${this.baseUrl}/judge-configs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error("Failed to create judge config");
		return response.json();
	}

	async activateJudgeConfig(configId: string, version: number): Promise<JudgeConfig> {
		const response = await fetch(`${this.baseUrl}/judge-configs/${configId}/${version}/activate`, {
			method: "PUT",
		});
		if (!response.ok) throw new Error("Failed to activate judge config");
		return response.json();
	}

	async deleteJudgeConfig(configId: string, version: number): Promise<void> {
		const response = await fetch(`${this.baseUrl}/judge-configs/${configId}/${version}`, {
			method: "DELETE",
		});
		if (!response.ok) throw new Error("Failed to delete judge config");
	}

	// ===== Production Traces (Feature: production-trace-support) =====

	async listProductionTraces(agentId?: string, status?: string, skip = 0, limit = 100): Promise<any[]> {
		const params = new URLSearchParams();
		if (agentId) params.append("agent_id", agentId);
		if (status) params.append("status", status);
		params.append("skip", skip.toString());
		params.append("limit", limit.toString());

		const response = await fetch(`${this.baseUrl}/production-traces?${params}`);
		if (!response.ok) throw new Error("Failed to fetch production traces");
		return response.json();
	}

	async getProductionTrace(traceId: string): Promise<any> {
		const response = await fetch(`${this.baseUrl}/production-traces/${traceId}`);
		if (!response.ok) throw new Error("Failed to fetch production trace");
		return response.json();
	}

	async upsertTraceAnnotation(traceId: string, annotation: any): Promise<any> {
		const response = await fetch(`${this.baseUrl}/production-traces/${traceId}/annotations`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(annotation),
		});
		if (!response.ok) throw new Error("Failed to save trace annotation");
		return response.json();
	}

	async getTraceAnnotation(traceId: string): Promise<any> {
		const response = await fetch(`${this.baseUrl}/production-traces/${traceId}/annotations`);
		if (!response.ok) {
			if (response.status === 404) return null;
			throw new Error("Failed to fetch trace annotation");
		}
		return response.json();
	}

	async convertTraceToTestcase(traceId: string, datasetId: string, options?: any): Promise<any> {
		const response = await fetch(
			`${this.baseUrl}/production-traces/${traceId}/convert-to-testcase?dataset_id=${datasetId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(options || {}),
			}
		);
		if (!response.ok) throw new Error("Failed to convert trace to test case");
		return response.json();
	}

	async runTaskInProduction(agentId: string, input: string): Promise<any> {
		const response = await fetch(`${this.baseUrl}/production-traces/run`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agent_id: agentId, input }),
		});
		if (!response.ok) {
			let msg = "Failed to run task";
			try {
				const body = await response.json();
				msg = body.detail || JSON.stringify(body);
			} catch {
				msg = await response.text().catch(() => msg);
			}
			throw new Error(msg);
		}
		return response.json();
	}

	async listTraceConversions(datasetId?: string, skip = 0, limit = 100): Promise<any[]> {
		const params = new URLSearchParams();
		if (datasetId) params.append("dataset_id", datasetId);
		params.append("skip", skip.toString());
		params.append("limit", limit.toString());

		const response = await fetch(`${this.baseUrl}/trace-conversions?${params}`);
		if (!response.ok) throw new Error("Failed to fetch trace conversions");
		return response.json();
	}

}

export const apiClient = new ApiClient(API_BASE_URL);
