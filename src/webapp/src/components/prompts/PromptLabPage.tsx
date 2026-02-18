import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Box, Card, Flex, Heading, Text, Badge, Button, ScrollArea, Separator, Tabs } from "@radix-ui/themes";
import { ArrowLeft, Sparkle, CaretDown, CaretRight, Check, X, Play, Clock, Lightning, Trash, Gear, Brain, ChatCircle, StopCircle, CircleNotch, Warning, ArrowCounterClockwise, ArrowUp, ArrowDown, TrendUp } from "@phosphor-icons/react";
import { PromptPerformanceChart } from "./PromptPerformanceChart";
import { API_BASE_URL } from "../../lib/config";

interface Proposal {
	id: string;
	title: string;
	category: string;
	confidence: number;
	priority: string;
	prompt_version: number;
	pattern_source: string;
	impact: string;
	impact_detail: string;
	diff: { removed: string[]; added: string[] };
	status: string;
	created_at: string;
	reasoning?: string | null;
}

interface LlmConfig {
	model: string;
	base_url: string;
	agent_model: string;
	agent_base_url: string;
}

interface PromptVersion {
	id: string;
	version: number;
	system_prompt: string;
	notes: string | null;
	is_active: boolean;
	created_at: string;
}

interface DatasetInfo {
	id: string;
	name: string;
	testCaseCount: number;
}

// ==============================================================================
// Diff Utilities
// ==============================================================================

function computeLineDiff(oldText: string, newText: string): Array<{ type: "same" | "removed" | "added"; line: string }> {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const m = oldLines.length;
	const n = newLines.length;

	// Build LCS table
	const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to produce diff
	const temp: Array<{ type: "same" | "removed" | "added"; line: string }> = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			temp.push({ type: "same", line: oldLines[i - 1] });
			i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			temp.push({ type: "added", line: newLines[j - 1] });
			j--;
		} else {
			temp.push({ type: "removed", line: oldLines[i - 1] });
			i--;
		}
	}
	return temp.reverse();
}

// ==============================================================================
// Components
// ==============================================================================

function DiffViewer({ diff }: { diff: { removed: string[]; added: string[] } }) {
	if (!diff || (!diff.removed?.length && !diff.added?.length)) {
		return <Text size="2" style={{ color: "var(--muted-foreground)" }}>No diff available</Text>;
	}
	return (
		<Box style={{ background: "var(--code-bg)", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", fontFamily: "monospace", fontSize: 12 }}>
			{diff.removed?.map((line, i) => (
				<Box key={`r-${i}`} px="3" py="1" style={{ background: "rgba(248, 81, 73, 0.15)", color: "var(--destructive)", borderBottom: "1px solid rgba(48, 54, 61, 0.5)" }}>
					- {line}
				</Box>
			))}
			{diff.added?.map((line, i) => (
				<Box key={`a-${i}`} px="3" py="1" style={{ background: "rgba(63, 185, 80, 0.15)", color: "var(--success)", borderBottom: "1px solid rgba(48, 54, 61, 0.5)" }}>
					+ {line}
				</Box>
			))}
		</Box>
	);
}

function VersionDiffViewer({ oldText, newText, oldVersion, newVersion }: { oldText: string; newText: string; oldVersion: number; newVersion: number }) {
	const diffLines = computeLineDiff(oldText, newText);
	const hasChanges = diffLines.some(l => l.type !== "same");

	if (!hasChanges) {
		return (
			<Box style={{ background: "var(--code-bg)", borderRadius: 8, border: "1px solid var(--border)", padding: 16 }}>
				<Text size="2" style={{ color: "var(--muted-foreground)" }}>No differences between v{oldVersion} and v{newVersion}</Text>
			</Box>
		);
	}

	return (
		<Box style={{ background: "var(--code-bg)", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", fontFamily: "monospace", fontSize: 12 }}>
			<Flex px="3" py="2" style={{ background: "rgba(139, 148, 158, 0.1)", borderBottom: "1px solid var(--border)" }}>
				<Text size="1" style={{ color: "var(--muted-foreground)" }}>
					Comparing v{oldVersion} → v{newVersion}
				</Text>
			</Flex>
			<Box style={{ maxHeight: 400, overflow: "auto" }}>
				{diffLines.map((line, i) => (
					<Box
						key={i}
						px="3"
						py="1"
						style={{
							background: line.type === "removed" ? "rgba(248, 81, 73, 0.15)" :
								line.type === "added" ? "rgba(63, 185, 80, 0.15)" :
								"transparent",
							color: line.type === "removed" ? "var(--destructive)" :
								line.type === "added" ? "var(--success)" :
								"var(--muted-foreground)",
							borderBottom: "1px solid rgba(48, 54, 61, 0.3)",
							whiteSpace: "pre-wrap",
						}}
					>
						{line.type === "removed" ? "- " : line.type === "added" ? "+ " : "  "}{line.line}
					</Box>
				))}
			</Box>
		</Box>
	);
}

function ProposalCard({ proposal, agentId, agent, datasets, versionDatasetMap, onRefresh }: {
	proposal: Proposal;
	agentId: string;
	agent: any;
	datasets: DatasetInfo[];
	versionDatasetMap: Record<number, string>;
	onRefresh: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [applying, setApplying] = useState(false);
	const [confirmApply, setConfirmApply] = useState(false);
	const [testing, setTesting] = useState(false);
	const [dismissing, setDismissing] = useState(false);
	const [reverting, setReverting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRunEval, setShowRunEval] = useState(false);
	const [postApplyEvalStarted, setPostApplyEvalStarted] = useState(false);
	// Pre-select dataset from the version this proposal targeted
	const defaultDatasetId = versionDatasetMap[proposal.prompt_version] || "";
	const [selectedDatasetId, setSelectedDatasetId] = useState<string>(defaultDatasetId);
	const [runningEval, setRunningEval] = useState(false);
	const navigate = useNavigate();

	const handleApplyConfirmed = async () => {
		setApplying(true);
		setConfirmApply(false);
		setError(null);
		try {
			const res = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/${proposal.id}/apply`, { method: "POST" });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to apply (${res.status})`);
			}

			// Auto-trigger evaluation if a dataset is available
			if (defaultDatasetId && agent) {
				try {
					const evalRes = await fetch(`${API_BASE_URL}/evaluations`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							name: `Regression check: ${proposal.title}`,
							dataset_id: defaultDatasetId,
							agent_id: agentId,
							agent_endpoint: agent.agent_invocation_url,
						}),
					});
					if (evalRes.ok) {
						setPostApplyEvalStarted(true);
					}
				} catch { /* non-critical — eval just won't auto-start */ }
			}

			onRefresh();
		} catch (e: any) {
			console.error(e);
			setError(e.message || "Failed to apply proposal");
		}
		finally { setApplying(false); }
	};

	const handleRevert = async () => {
		setReverting(true);
		setError(null);
		try {
			// Revert to the previous prompt version (the one the proposal was based on)
			const res = await fetch(`${API_BASE_URL}/agents/${agentId}/prompts/${proposal.prompt_version}/activate`, { method: "PUT" });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to revert (${res.status})`);
			}
			onRefresh();
		} catch (e: any) {
			console.error(e);
			setError(e.message || "Failed to revert");
		} finally { setReverting(false); }
	};

	const handleTest = async () => {
		setTesting(true);
		setError(null);
		try {
			const res = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/${proposal.id}/test`, { method: "POST" });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to start test (${res.status})`);
			}
			const data = await res.json();
			navigate(`/evaluations/${data.evaluation_id}`);
		} catch (e: any) {
			console.error(e);
			setError(e.message || "Failed to start test");
		}
		finally { setTesting(false); }
	};

	const handleDismiss = async () => {
		setDismissing(true);
		setError(null);
		try {
			const res = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/${proposal.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "dismissed" }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to dismiss (${res.status})`);
			}
			onRefresh();
		} catch (e: any) {
			console.error(e);
			setError(e.message || "Failed to dismiss proposal");
		}
		finally { setDismissing(false); }
	};

	const handleDelete = async () => {
		try {
			await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/${proposal.id}`, { method: "DELETE" });
			onRefresh();
		} catch (e) { console.error(e); }
	};

	const handleRunEvaluation = async () => {
		if (!selectedDatasetId || !agent) return;
		setRunningEval(true);
		setError(null);
		try {
			const res = await fetch(`${API_BASE_URL}/evaluations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `Post-apply: ${proposal.title}`,
					dataset_id: selectedDatasetId,
					agent_id: agentId,
					agent_endpoint: agent.agent_invocation_url,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to start evaluation (${res.status})`);
			}
			const data = await res.json();
			navigate(`/evaluations/${data.id}`);
		} catch (e: any) {
			console.error(e);
			setError(e.message || "Failed to start evaluation");
		} finally {
			setRunningEval(false);
		}
	};

	const priorityColor = proposal.priority === "high" ? "red" : proposal.priority === "medium" ? "yellow" : "gray";

	return (
		<div className="border-b border-border last:border-b-0">
			{/* Row header — matches grid list pattern */}
			<div
				className="grid items-center text-sm hover:bg-secondary/50 transition-colors"
				style={{ gridTemplateColumns: "1fr 80px", padding: "16px 8px", cursor: "pointer" }}
				onClick={() => setExpanded(!expanded)}
			>
				<div className="flex items-center gap-3 min-w-0">
					<span className="text-muted-foreground flex-shrink-0">
						{expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
					</span>
					<span className="font-medium truncate">{proposal.title}</span>
					<Badge variant="soft" color="blue">{proposal.category}</Badge>
					<Badge variant="soft" color={priorityColor}>{proposal.priority}</Badge>
					<Badge variant="outline" color="gray" size="1">v{proposal.prompt_version}</Badge>
				</div>
				<div className="flex items-center gap-2 justify-end">
					<div style={{ width: 60, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
						<div style={{ width: `${proposal.confidence * 100}%`, height: "100%", borderRadius: 3, background: proposal.confidence >= 0.7 ? "var(--success)" : "var(--warning)" }} />
					</div>
					<Text size="1" style={{ color: "var(--muted-foreground)" }}>{Math.round(proposal.confidence * 100)}%</Text>
				</div>
			</div>

			{expanded && (
				<div className="border-t border-border bg-black/5 px-4 pb-4 pt-3">
					<div className="space-y-3 mt-3">
							<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 4 }}>Pattern Source</Text>
							<Text size="2" style={{ color: "var(--muted-foreground)", display: "block", marginBottom: 12 }}>{proposal.pattern_source}</Text>

							<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 4 }}>Expected Impact</Text>
							<Text size="2" style={{ color: "var(--success)", display: "block", marginBottom: 12 }}>{proposal.impact}</Text>

							{proposal.impact_detail && (
								<>
									<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 4 }}>Details</Text>
									<Text size="2" style={{ color: "var(--muted-foreground)", display: "block", marginBottom: 12 }}>{proposal.impact_detail}</Text>
								</>
							)}

							{proposal.reasoning && (
								<Box mb="3" style={{ padding: "8px 12px", background: "rgba(88, 166, 255, 0.06)", border: "1px solid rgba(88, 166, 255, 0.15)", borderRadius: 6 }}>
									<Flex align="center" gap="2" mb="1">
										<Brain size={12} weight="fill" style={{ color: "var(--primary)" }} />
										<Text size="1" weight="bold" style={{ color: "var(--primary)" }}>LLM Reasoning</Text>
									</Flex>
									<Text size="1" style={{ color: "var(--muted-foreground)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{proposal.reasoning}</Text>
								</Box>
							)}

							<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 8 }}>Proposed Changes</Text>
							<DiffViewer diff={proposal.diff} />

							{error && (
								<Box mt="2" style={{ padding: "8px 12px", background: "rgba(248, 81, 73, 0.15)", border: "1px solid rgba(248, 81, 73, 0.3)", borderRadius: 6, color: "var(--destructive)", fontSize: 12 }}>
									{error}
								</Box>
							)}

							{proposal.status === "pending" && !confirmApply && (
								<Flex gap="2" mt="3" justify="end">
									<Button variant="ghost" color="red" size="1" onClick={handleDelete} style={{ cursor: "pointer" }}>
										<Trash size={12} /> Delete
									</Button>
									<Button variant="soft" color="gray" size="1" onClick={handleDismiss} disabled={dismissing} style={{ cursor: "pointer" }}>
										<X size={12} weight="bold" /> {dismissing ? "Dismissing..." : "Dismiss"}
									</Button>
									<Button variant="soft" color="blue" size="1" onClick={handleTest} disabled={testing} style={{ cursor: "pointer" }}>
										<Play size={12} weight="fill" /> {testing ? "Starting..." : "Test First"}
									</Button>
									<Button variant="solid" color="green" size="1" onClick={() => setConfirmApply(true)} disabled={applying} style={{ cursor: "pointer" }}>
										<Check size={12} weight="bold" /> {applying ? "Applying..." : "Apply to Prompt"}
									</Button>
								</Flex>
							)}

							{proposal.status === "pending" && confirmApply && (
								<Box mt="3" style={{
									padding: "12px 16px", borderRadius: 8,
									background: "rgba(210, 153, 34, 0.08)",
									border: "1px solid rgba(210, 153, 34, 0.2)",
								}}>
									<Flex align="start" gap="3">
										<Warning size={16} weight="fill" style={{ color: "#d29922", flexShrink: 0, marginTop: 2 }} />
										<Box style={{ flex: 1 }}>
											<Text size="2" weight="bold" style={{ color: "#d29922", display: "block", marginBottom: 4 }}>
												Apply without testing?
											</Text>
											<Text size="1" style={{ color: "var(--muted-foreground)", display: "block", marginBottom: 8 }}>
												Applying directly may cause regressions. We recommend using "Test First" to compare results before changing the prompt.
												{defaultDatasetId
													? " A regression check evaluation will start automatically after applying."
													: ""}
											</Text>
											<Flex gap="2" justify="end">
												<Button variant="soft" color="gray" size="1" onClick={() => setConfirmApply(false)} style={{ cursor: "pointer" }}>
													Cancel
												</Button>
												<Button variant="soft" color="blue" size="1" onClick={() => { setConfirmApply(false); handleTest(); }} disabled={testing} style={{ cursor: "pointer" }}>
													<Play size={12} weight="fill" /> Test First Instead
												</Button>
												<Button variant="solid" color="orange" size="1" onClick={handleApplyConfirmed} disabled={applying} style={{ cursor: "pointer" }}>
													<Warning size={12} weight="fill" /> {applying ? "Applying..." : "Apply Anyway"}
												</Button>
											</Flex>
										</Box>
									</Flex>
								</Box>
							)}
							{proposal.status === "applied" && (
								<Box mt="2">
									<Flex align="center" gap="2" wrap="wrap">
										<Badge color="green" variant="soft"><Check size={12} weight="bold" /> Applied</Badge>
										<Button variant="soft" color="orange" size="1" onClick={handleRevert} disabled={reverting} style={{ cursor: "pointer" }}>
											<ArrowCounterClockwise size={12} /> {reverting ? "Reverting..." : "Revert to v" + proposal.prompt_version}
										</Button>
										<Button variant="ghost" color="gray" size="1" onClick={handleDelete} style={{ cursor: "pointer" }}>
											<Trash size={12} /> Remove
										</Button>
									</Flex>

									{postApplyEvalStarted && (
										<Box mt="2" style={{
											padding: "6px 12px", borderRadius: 6,
											background: "rgba(63, 185, 80, 0.08)",
											border: "1px solid rgba(63, 185, 80, 0.15)",
											fontSize: 12, color: "var(--success)",
										}}>
											<Flex align="center" gap="2">
												<Play size={12} weight="fill" />
												<span>Regression check evaluation started automatically. Check the Evaluations tab for results.</span>
											</Flex>
										</Box>
									)}

									{/* Re-run evaluation after applying */}
									<Box mt="2" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
										{!showRunEval ? (
											<Button variant="soft" color="blue" size="1" onClick={() => { setShowRunEval(true); setSelectedDatasetId(defaultDatasetId); }} style={{ cursor: "pointer" }}>
												<Play size={12} weight="fill" /> Run Evaluation with New Prompt
											</Button>
										) : (
											<Flex align="center" gap="2" wrap="wrap">
												<Text size="1" style={{ color: "var(--muted-foreground)" }}>Dataset:</Text>
												<select
													value={selectedDatasetId}
													onChange={(e) => setSelectedDatasetId(e.target.value)}
													style={{
														padding: "4px 8px",
														fontSize: 12,
														borderRadius: 6,
														border: "1px solid var(--border)",
														background: "var(--card)",
														color: "var(--foreground)",
														cursor: "pointer",
														minWidth: 180,
													}}
												>
													<option value="">Select dataset...</option>
													{datasets.map(d => (
														<option key={d.id} value={d.id}>{d.name} ({d.testCaseCount} tests)</option>
													))}
												</select>
												<Button
													variant="solid"
													color="green"
													size="1"
													onClick={handleRunEvaluation}
													disabled={!selectedDatasetId || runningEval}
													style={{ cursor: "pointer" }}
												>
													<Play size={12} weight="fill" /> {runningEval ? "Starting..." : "Start"}
												</Button>
												<Button variant="ghost" color="gray" size="1" onClick={() => setShowRunEval(false)} style={{ cursor: "pointer" }}>
													Cancel
												</Button>
											</Flex>
										)}
									</Box>
								</Box>
							)}
							{proposal.status === "dismissed" && (
								<Flex align="center" gap="2" mt="2">
									<Badge color="gray" variant="soft"><X size={12} weight="bold" /> Dismissed</Badge>
									<Button variant="ghost" color="gray" size="1" onClick={handleDelete} style={{ cursor: "pointer" }}>
										<Trash size={12} /> Remove
									</Button>
								</Flex>
							)}
					</div>
				</div>
			)}
		</div>
	);
}

export function PromptLabPage() {
	const { id: agentId } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const initialTab = (["proposals", "current", "performance", "history"].includes(searchParams.get("tab") || "")) ? searchParams.get("tab")! : "proposals";
	const deepLinkVersion = searchParams.get("version") ? Number(searchParams.get("version")) : null;
	const [agent, setAgent] = useState<any>(null);
	const [activePrompt, setActivePrompt] = useState<PromptVersion | null>(null);
	const [prompts, setPrompts] = useState<PromptVersion[]>([]);
	const [proposals, setProposals] = useState<Proposal[]>([]);
	const [generating, setGenerating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [editMode, setEditMode] = useState(!activePrompt);
	const [editPromptText, setEditPromptText] = useState("");
	const [editPromptNotes, setEditPromptNotes] = useState("");
	const [savingPrompt, setSavingPrompt] = useState(false);
	const [evalStats, setEvalStats] = useState<Record<number, { count: number; passRate: number }>>({});
	const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
	const [evaluationsForChart, setEvaluationsForChart] = useState<any[]>([]);
	// History tab state — auto-expand if deep-linked via ?version=N
	const [expandedVersions, setExpandedVersions] = useState<Set<number>>(deepLinkVersion ? new Set([deepLinkVersion]) : new Set());
	const [compareVersions, setCompareVersions] = useState<Record<number, number | null>>({});
	// Run evaluation state (shared across tabs)
	const [runEvalForVersion, setRunEvalForVersion] = useState<number | null>(null);
	const [runEvalDatasetId, setRunEvalDatasetId] = useState<string>("");
	const [runningEval, setRunningEval] = useState(false);
	const [runEvalError, setRunEvalError] = useState<string | null>(null);
	// Maps prompt version → most recently used dataset_id (for pre-selection)
	const [versionDatasetMap, setVersionDatasetMap] = useState<Record<number, string>>({});
	// LLM config and proposal generation options
	const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
	const [judgeRubric, setJudgeRubric] = useState("");
	const [includeReasoning, setIncludeReasoning] = useState(false);
	const [showGenerateOptions, setShowGenerateOptions] = useState(false);

	const toggleVersionExpanded = (version: number) => {
		setExpandedVersions(prev => {
			const next = new Set(prev);
			if (next.has(version)) next.delete(version);
			else next.add(version);
			return next;
		});
	};

	const setCompareTarget = (fromVersion: number, toVersion: number | null) => {
		setCompareVersions(prev => ({ ...prev, [fromVersion]: toVersion }));
	};

	// Resolve best dataset for a given version: exact match → previous version → any recent
	const resolveDatasetForVersion = (version: number | null): string => {
		if (version != null) {
			// Exact match: dataset used for evaluations of this version
			if (versionDatasetMap[version]) return versionDatasetMap[version];
			// Fallback: dataset used for the previous version (common after applying a proposal)
			if (versionDatasetMap[version - 1]) return versionDatasetMap[version - 1];
		}
		// Last resort: most recently used dataset across any version
		const allVersions = Object.keys(versionDatasetMap).map(Number).sort((a, b) => b - a);
		if (allVersions.length > 0) return versionDatasetMap[allVersions[0]];
		return "";
	};

	const handleRunEvaluation = async () => {
		if (!runEvalDatasetId || !agent || !agentId) return;
		setRunningEval(true);
		setRunEvalError(null);
		try {
			const versionLabel = runEvalForVersion != null ? `v${runEvalForVersion}` : "current";
			const res = await fetch(`${API_BASE_URL}/evaluations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `Prompt ${versionLabel} evaluation`,
					dataset_id: runEvalDatasetId,
					agent_id: agentId,
					agent_endpoint: agent.agent_invocation_url,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.detail || `Failed to start evaluation (${res.status})`);
			}
			const data = await res.json();
			navigate(`/evaluations/${data.id}`);
		} catch (e: any) {
			console.error(e);
			setRunEvalError(e.message || "Failed to start evaluation");
		} finally {
			setRunningEval(false);
		}
	};

	const RunEvalInline = ({ version }: { version: number | null }) => {
		const isOpen = runEvalForVersion === version;
		if (!isOpen) {
			return (
				<Button
					variant="soft"
					color="blue"
					size="1"
					onClick={(e) => { e.stopPropagation(); setRunEvalForVersion(version); setRunEvalDatasetId(resolveDatasetForVersion(version)); setRunEvalError(null); }}
					style={{ cursor: "pointer" }}
				>
					<Play size={12} weight="fill" /> Run Evaluation
				</Button>
			);
		}
		const preSelectedId = resolveDatasetForVersion(version);
		return (
			<Box onClick={(e) => e.stopPropagation()}>
				<Flex align="center" gap="2" wrap="wrap">
					<Text size="1" style={{ color: "var(--muted-foreground)" }}>Dataset:</Text>
					<select
						value={runEvalDatasetId}
						onChange={(e) => setRunEvalDatasetId(e.target.value)}
						style={{
							padding: "4px 8px",
							fontSize: 12,
							borderRadius: 6,
							border: "1px solid var(--border)",
							background: "var(--card)",
							color: "var(--foreground)",
							cursor: "pointer",
							minWidth: 180,
						}}
					>
						<option value="">Select dataset...</option>
						{datasets.map(d => (
							<option key={d.id} value={d.id}>{d.name} ({d.testCaseCount} tests){d.id === preSelectedId ? " ★" : ""}</option>
						))}
					</select>
					<Button
						variant="solid"
						color="green"
						size="1"
						onClick={handleRunEvaluation}
						disabled={!runEvalDatasetId || runningEval}
						style={{ cursor: "pointer" }}
					>
						<Play size={12} weight="fill" /> {runningEval ? "Starting..." : "Start"}
					</Button>
					<Button variant="ghost" color="gray" size="1" onClick={() => setRunEvalForVersion(null)} style={{ cursor: "pointer" }}>
						Cancel
					</Button>
				</Flex>
				{runEvalError && (
					<Box mt="1" style={{ fontSize: 12, color: "var(--destructive)" }}>{runEvalError}</Box>
				)}
			</Box>
		);
	};

	const loadAll = async () => {
		if (!agentId) return;
		try {
			const [agentRes, activeRes, promptsRes, proposalsRes, datasetsRes, llmConfigRes] = await Promise.all([
				fetch(`${API_BASE_URL}/agents/${agentId}`),
				fetch(`${API_BASE_URL}/agents/${agentId}/prompts/active`),
				fetch(`${API_BASE_URL}/agents/${agentId}/prompts`),
				fetch(`${API_BASE_URL}/agents/${agentId}/proposals`),
				fetch(`${API_BASE_URL}/datasets?limit=100`),
				fetch(`${API_BASE_URL}/config/llm`),
			]);
			if (llmConfigRes.ok) setLlmConfig(await llmConfigRes.json());
			if (agentRes.ok) setAgent(await agentRes.json());
			if (activeRes.ok) setActivePrompt(await activeRes.json());
			else setActivePrompt(null);
			if (promptsRes.ok) setPrompts(await promptsRes.json());
			if (proposalsRes.ok) setProposals(await proposalsRes.json());
			if (datasetsRes.ok) {
				const rawDatasets = await datasetsRes.json();
				setDatasets(rawDatasets.map((d: any) => ({
					id: d.id,
					name: d.seed?.name || d.id.slice(0, 8),
					testCaseCount: d.test_case_ids?.length || 0,
				})));
			}

			// Fetch evaluation stats per prompt version + build version→dataset map
			try {
				const evalsRes = await fetch(`${API_BASE_URL}/evaluations?agent_id=${agentId}&limit=1000`);
				if (evalsRes.ok) {
					const evals = await evalsRes.json();
					setEvaluationsForChart(evals);
					const stats: Record<number, { count: number; totalPassed: number; totalTests: number }> = {};
					// Track most recent dataset used per prompt version
					const versionLatest: Record<number, { dataset_id: string; created_at: string }> = {};
					evals.forEach((ev: any) => {
						const v = ev.prompt_version;
						if (v != null) {
							// Only include completed evaluations in pass rate stats
							// (running evals have passed_count=0 which would drag the rate to 0%)
							if (ev.status === "completed") {
								if (!stats[v]) stats[v] = { count: 0, totalPassed: 0, totalTests: 0 };
								stats[v].count++;
								stats[v].totalPassed += ev.passed_count || 0;
								stats[v].totalTests += ev.total_tests || 0;
							}
							// Track most recent dataset_id per version (any status)
							if (ev.dataset_id && (!versionLatest[v] || ev.created_at > versionLatest[v].created_at)) {
								versionLatest[v] = { dataset_id: ev.dataset_id, created_at: ev.created_at };
							}
						}
					});
					const computed: Record<number, { count: number; passRate: number }> = {};
					Object.entries(stats).forEach(([v, s]) => {
						computed[parseInt(v)] = {
							count: s.count,
							passRate: s.totalTests > 0 ? (s.totalPassed / s.totalTests) * 100 : 0,
						};
					});
					setEvalStats(computed);
					// Build version → dataset_id map
					const dsMap: Record<number, string> = {};
					Object.entries(versionLatest).forEach(([v, info]) => {
						dsMap[parseInt(v)] = info.dataset_id;
					});
					setVersionDatasetMap(dsMap);
				}
			} catch (e) { console.error(e); }
		} catch (e) { console.error(e); }
		finally { setLoading(false); }

		// Check if proposal generation is still running (survives page refresh)
		try {
			const statusRes = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/generate/status`);
			if (statusRes.ok) {
				const statusData = await statusRes.json();
				if (statusData.active) {
					setGenerating(true);
					setGenerateProgress(statusData.proposals_generated || 0);
					startProposalPolling();
				}
			}
		} catch { /* ignore — status check is best-effort */ }
	};

	/** Poll for new proposals while a background generation is running. */
	const startProposalPolling = useCallback(() => {
		// Clear any existing interval
		if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
		pollIntervalRef.current = setInterval(async () => {
			if (!agentId) return;
			try {
				const [proposalsRes, statusRes] = await Promise.all([
					fetch(`${API_BASE_URL}/agents/${agentId}/proposals`),
					fetch(`${API_BASE_URL}/agents/${agentId}/proposals/generate/status`),
				]);
				if (proposalsRes.ok) {
					const latestProposals = await proposalsRes.json();
					setProposals(latestProposals);
					setGenerateProgress(latestProposals.filter((p: Proposal) => p.status === "pending").length);
				}
				if (statusRes.ok) {
					const statusData = await statusRes.json();
					if (!statusData.active) {
						// Generation finished while we were polling
						setGenerating(false);
						setGenerateProgress(0);
						if (pollIntervalRef.current) {
							clearInterval(pollIntervalRef.current);
							pollIntervalRef.current = null;
						}
					}
				}
			} catch { /* polling is best-effort */ }
		}, 3000); // Poll every 3 seconds
	}, [agentId]);

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
		};
	}, []);

	useEffect(() => { loadAll(); }, [agentId]);

	useEffect(() => {
		if (activePrompt) {
			setEditPromptText(activePrompt.system_prompt);
			setEditMode(false);
		}
	}, [activePrompt]);

	const [generateProgress, setGenerateProgress] = useState(0);
	const [generateError, setGenerateError] = useState<string | null>(null);
	const generateAbortRef = useRef<AbortController | null>(null);
	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const handleGenerate = async () => {
		if (!agentId) return;
		setGenerating(true);
		setGenerateProgress(0);
		setGenerateError(null);

		// Create AbortController for cancellation
		const abortController = new AbortController();
		generateAbortRef.current = abortController;

		// Start polling as a fallback (survives page refresh)
		startProposalPolling();

		const requestBody = {
			evaluation_ids: null,
			judge_rubric: judgeRubric.trim() || null,
			include_reasoning: includeReasoning,
		};

		const fallbackGenerate = async () => {
			const fallbackRes = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(requestBody),
				signal: abortController.signal,
			});
			if (fallbackRes.ok) {
				const newProposals = await fallbackRes.json();
				setProposals(prev => [...newProposals, ...prev]);
			}
		};

		try {
			let res: Response;
			try {
				res = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/generate/stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(requestBody),
					signal: abortController.signal,
				});
			} catch (e: any) {
				if (e?.name === "AbortError") return; // User cancelled
				// Network error reaching stream endpoint — fallback
				await fallbackGenerate();
				return;
			}
			if (!res.ok || !res.body) {
				// Stream endpoint returned error or no body — fallback
				await fallbackGenerate();
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let receivedAny = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// Process complete SSE lines
				const lines = buffer.split("\n");
				buffer = lines.pop() || ""; // Keep incomplete line in buffer
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data: ")) continue;
					const jsonStr = trimmed.slice(6);
					try {
						const parsed = JSON.parse(jsonStr);
						if (parsed.done) {
							receivedAny = true;
							if (parsed.cancelled) {
								// Server confirmed cancellation
								continue;
							}
							// Show error if all patterns failed
							if (parsed.total === 0 && parsed.errors?.length > 0) {
								setGenerateError(`LLM failed to generate proposals: ${parsed.errors[0]}`);
							}
							continue;
						}
						if (parsed.status === "llm_error") {
							console.warn(`LLM error for pattern "${parsed.pattern}": ${parsed.message}`);
							continue;
						}
						// Skip non-proposal status messages (keepalive/progress).
						// Proposals also have a 'status' field ("pending"), so we must
						// distinguish them by checking for proposal-specific fields.
						if (parsed.status && !parsed.id && !parsed.title) { receivedAny = true; continue; }
						if (parsed.error) {
							console.error("Stream error:", parsed.error);
							if (!receivedAny) {
								setGenerateError(parsed.error);
								await fallbackGenerate();
								return;
							}
							continue;
						}
						// It's a proposal — add it to state immediately
						receivedAny = true;
						setProposals(prev => [parsed, ...prev]);
						setGenerateProgress(p => p + 1);
					} catch { /* skip malformed JSON */ }
				}
			}
		} catch (e: any) {
			if (e?.name === "AbortError") return; // User cancelled — don't log as error
			console.error("Generate proposals error:", e);
		} finally {
			generateAbortRef.current = null;
			setGenerating(false);
			setGenerateProgress(0);
			// Stop polling — generation finished normally via SSE
			if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
		}
	};

	const handleCancelGenerate = async () => {
		// 1. Abort the client-side fetch stream
		if (generateAbortRef.current) {
			generateAbortRef.current.abort();
			generateAbortRef.current = null;
		}
		// 2. Signal the server to stop LLM calls
		if (agentId) {
			try {
				await fetch(`${API_BASE_URL}/agents/${agentId}/proposals/generate`, { method: "DELETE" });
			} catch { /* server cancel is best-effort */ }
		}
		setGenerating(false);
		setGenerateProgress(0);
		// 3. Stop polling
		if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
		// 4. Re-fetch proposals to show everything generated so far
		if (agentId) {
			try {
				const res = await fetch(`${API_BASE_URL}/agents/${agentId}/proposals`);
				if (res.ok) setProposals(await res.json());
			} catch { /* best-effort */ }
		}
	};

	const handleSavePrompt = async () => {
		if (!agentId || !editPromptText.trim()) return;
		setSavingPrompt(true);
		try {
			await fetch(`${API_BASE_URL}/agents/${agentId}/prompts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					system_prompt: editPromptText,
					notes: editPromptNotes || undefined,
				}),
			});
			setEditPromptNotes("");
			loadAll();
		} catch (e) { console.error(e); }
		finally { setSavingPrompt(false); }
	};

	const handleActivateVersion = async (version: number) => {
		if (!agentId) return;
		try {
			await fetch(`${API_BASE_URL}/agents/${agentId}/prompts/${version}/activate`, { method: "PUT" });
			loadAll();
		} catch (e) { console.error(e); }
	};

	const handleDeleteAllForVersion = async (version: number) => {
		if (!agentId) return;
		try {
			await fetch(`${API_BASE_URL}/agents/${agentId}/proposals?prompt_version=${version}`, { method: "DELETE" });
			loadAll();
		} catch (e) { console.error(e); }
	};

	if (loading) {
		return (
			<Box>
				<h1 className="text-2xl font-bold tracking-tight">Prompt Lab</h1>
				<Text mt="2" style={{ color: "var(--muted-foreground)" }}>Loading...</Text>
			</Box>
		);
	}

	const pendingProposals = proposals.filter(p => p.status === "pending");
	const resolvedProposals = proposals.filter(p => p.status !== "pending");

	// Group proposals by prompt version (descending)
	const proposalsByVersion = (list: Proposal[]) => {
		const grouped: Record<number, Proposal[]> = {};
		list.forEach(p => {
			const v = p.prompt_version ?? 0;
			if (!grouped[v]) grouped[v] = [];
			grouped[v].push(p);
		});
		return Object.entries(grouped)
			.sort(([a], [b]) => Number(b) - Number(a))
			.map(([version, items]) => ({ version: Number(version), items }));
	};

	const sortedPrompts = [...prompts].sort((a, b) => b.version - a.version);

	return (
		<Box>
			{/* Header */}
			<Flex align="center" gap="3" mb="5">
				<Button variant="ghost" size="1" onClick={() => navigate(-1)} style={{ cursor: "pointer" }}>
					<ArrowLeft size={16} />
				</Button>
				<Box>
					<h1 className="text-2xl font-bold tracking-tight">Prompt Lab</h1>
					<Text size="2" style={{ color: "var(--muted-foreground)" }}>{agent?.name || "Agent"}</Text>
				</Box>
			</Flex>

			<Tabs.Root defaultValue={initialTab}>
				<Tabs.List>
					<Tabs.Trigger value="proposals" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<Sparkle size={14} /> Proposals {pendingProposals.length > 0 && <Badge size="1" color="blue">{pendingProposals.length}</Badge>}
						</Flex>
					</Tabs.Trigger>
					<Tabs.Trigger value="current" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<Lightning size={14} weight="fill" /> Current Prompt
						</Flex>
					</Tabs.Trigger>
					<Tabs.Trigger value="performance" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<TrendUp size={14} weight="fill" /> Performance
						</Flex>
					</Tabs.Trigger>
					<Tabs.Trigger value="history" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<Clock size={14} weight="bold" /> History ({prompts.length})
						</Flex>
					</Tabs.Trigger>
				</Tabs.List>

				{/* Proposals Tab */}
				<Tabs.Content value="proposals">
					<Box mt="4">
						<Flex align="center" justify="between" mb="3">
							<Text size="3" weight="bold" style={{ color: "var(--foreground)" }}>AI-Powered Improvement Proposals</Text>
							<Flex align="center" gap="2">
								{!generating && (
									<>
										<Button variant="ghost" size="1" onClick={() => setShowGenerateOptions(prev => !prev)} style={{ cursor: "pointer", color: "var(--muted-foreground)" }}>
											<Gear size={14} />
										</Button>
										<Button onClick={handleGenerate} style={{ cursor: "pointer" }}>
											<Sparkle size={14} /> Generate Proposals
										</Button>
									</>
								)}
							</Flex>
						</Flex>

						{/* LLM Model Info */}
						{llmConfig && (
							<Flex align="center" gap="2" mb="3" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
								<Brain size={12} weight="fill" />
								<Text size="1">Judge Model: <span style={{ color: "var(--foreground)", fontFamily: "var(--code-font-family, monospace)" }}>{llmConfig.model}</span></Text>
								<Text size="1" style={{ opacity: 0.5 }}>•</Text>
								<Text size="1">{llmConfig.base_url}</Text>
							</Flex>
						)}

						{/* Generate Options Panel */}
						{showGenerateOptions && (
							<Card mb="3" style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
								<Box p="3">
									<Flex align="center" gap="2" mb="2">
										<Gear size={14} style={{ color: "var(--muted-foreground)" }} />
										<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Generation Options</Text>
									</Flex>

									{/* Judge Rubric */}
									<Box mb="3">
										<Text size="1" weight="bold" style={{ color: "var(--muted-foreground)", display: "block", marginBottom: 4 }}>
											Judge Rubric / Evaluation Criteria (optional)
										</Text>
										<textarea
											value={judgeRubric}
											onChange={(e) => setJudgeRubric(e.target.value)}
											placeholder="e.g. Prioritize tool selection accuracy over response quality. Focus on reducing repeated API calls. Ensure the agent always authenticates before making requests..."
											rows={3}
											style={{
												width: "100%",
												padding: "8px 10px",
												borderRadius: 6,
												border: "1px solid var(--border)",
												background: "var(--background)",
												color: "var(--foreground)",
												fontSize: 12,
												fontFamily: "inherit",
												resize: "vertical",
												outline: "none",
											}}
										/>
										<Text size="1" style={{ color: "var(--muted-foreground)", display: "block", marginTop: 2 }}>
											Custom criteria to guide the LLM when analyzing patterns and generating proposals
										</Text>
									</Box>

									{/* Include Reasoning Toggle */}
									<Flex align="center" gap="2">
										<label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
											<input
												type="checkbox"
												checked={includeReasoning}
												onChange={(e) => setIncludeReasoning(e.target.checked)}
												style={{ accentColor: "var(--primary)" }}
											/>
											<ChatCircle size={12} style={{ color: "var(--muted-foreground)" }} />
											<Text size="1" style={{ color: "var(--foreground)" }}>Include LLM reasoning</Text>
										</label>
										<Text size="1" style={{ color: "var(--muted-foreground)" }}>
											— show step-by-step analysis of each proposal
										</Text>
									</Flex>
								</Box>
							</Card>
						)}

						{generating && (
							<Box mb="4" className="fade-in-up" style={{
								background: "linear-gradient(135deg, rgba(88, 166, 255, 0.08) 0%, rgba(130, 80, 255, 0.08) 100%)",
								border: "1px solid rgba(88, 166, 255, 0.2)",
								borderRadius: 12,
								overflow: "hidden",
							}}>
								{/* Animated progress bar */}
								<Box style={{ height: 3, background: "rgba(88, 166, 255, 0.1)", position: "relative", overflow: "hidden" }}>
									<Box className="progress-sweep-bar" style={{
										position: "absolute",
										top: 0,
										left: 0,
										height: "100%",
										width: "50%",
										background: "linear-gradient(90deg, transparent, rgba(88, 166, 255, 0.6), rgba(130, 80, 255, 0.6), transparent)",
										borderRadius: 3,
									}} />
								</Box>

								<Box p="4">
									<Flex align="center" gap="3">
										{/* Spinner */}
										<Box style={{ position: "relative", width: 36, height: 36, flexShrink: 0 }}>
											<CircleNotch className="spin-slow" size={36} style={{ color: "rgba(88, 166, 255, 0.5)" }} />
											{generateProgress > 0 ? (
												<Box style={{
													position: "absolute", inset: 0,
													display: "flex", alignItems: "center", justifyContent: "center",
													fontSize: 13, fontWeight: 700, color: "var(--primary)",
													fontVariantNumeric: "tabular-nums",
												}}>
													{generateProgress}
												</Box>
											) : (
												<Box style={{
													position: "absolute", inset: 0,
													display: "flex", alignItems: "center", justifyContent: "center",
												}}>
													<Sparkle size={14} style={{ color: "var(--primary)" }} />
												</Box>
											)}
										</Box>

										{/* Text content */}
										<Box style={{ flex: 1, minWidth: 0 }}>
											<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 2 }}>
												{generateProgress > 0
													? `Generated ${generateProgress} proposal${generateProgress !== 1 ? "s" : ""}`
													: "Analyzing patterns"}
											</Text>
											<Text size="1" style={{ color: "var(--muted-foreground)" }}>
												{generateProgress > 0
													? "Scanning for additional improvement opportunities..."
													: "Reviewing annotations and identifying improvement opportunities..."}
											</Text>
										</Box>

										{/* Cancel button (inline) */}
										<Button onClick={handleCancelGenerate} variant="ghost" size="1" style={{
											cursor: "pointer",
											color: "var(--muted-foreground)",
											flexShrink: 0,
										}}>
											<StopCircle size={14} weight="fill" /> Stop
										</Button>
									</Flex>
								</Box>
							</Box>
						)}

						{generateError && !generating && (
							<Card mb="4" style={{ background: "rgba(255, 80, 80, 0.1)", border: "1px solid var(--destructive)" }}>
								<Flex align="center" gap="3" p="3">
									<X size={16} weight="bold" style={{ color: "var(--destructive)" }} />
									<Text size="2" style={{ color: "var(--destructive)" }}>{generateError}</Text>
								</Flex>
							</Card>
						)}

						{pendingProposals.length > 0 ? (
							<div className="space-y-6">
								{proposalsByVersion(pendingProposals).map(({ version, items }) => (
									<div key={`pending-v${version}`}>
										<div className="flex items-center gap-2 mb-2 px-2">
											<Badge variant="outline" color="blue" size="1">Targeting Prompt v{version}</Badge>
											<span className="text-xs text-muted-foreground">{items.length} proposal{items.length !== 1 ? "s" : ""}</span>
											<Button variant="ghost" color="gray" size="1" onClick={() => handleDeleteAllForVersion(version)} style={{ cursor: "pointer", marginLeft: "auto" }}>
												<Trash size={12} /> Clear All
											</Button>
										</div>
										{/* Column header */}
										<div
											className="grid items-center text-sm text-muted-foreground"
											style={{ gridTemplateColumns: "1fr 80px", padding: "8px 8px 4px" }}
										>
											<span>Proposal</span>
											<span className="text-right">Confidence</span>
										</div>
										<div>
											{items.map(p => (
												<ProposalCard key={p.id} proposal={p} agentId={agentId!} agent={agent} datasets={datasets} versionDatasetMap={versionDatasetMap} onRefresh={loadAll} />
											))}
										</div>
									</div>
								))}
							</div>
						) : !generating && (
							<div className="flex flex-col items-center justify-center py-12 gap-2">
								<Sparkle size={24} className="text-muted-foreground" />
								<span className="text-sm text-muted-foreground">No pending proposals. Click "Generate Proposals" to analyze annotations.</span>
							</div>
						)}

						{resolvedProposals.length > 0 && (
							<div className="mt-6">
								<span className="text-sm font-bold text-muted-foreground block mb-2">Resolved Proposals</span>
								<div className="space-y-6">
									{proposalsByVersion(resolvedProposals).map(({ version, items }) => (
										<div key={`resolved-v${version}`}>
											<div className="flex items-center gap-2 mb-2 px-2">
												<Badge variant="outline" color="gray" size="1">Targeting Prompt v{version}</Badge>
												<span className="text-xs text-muted-foreground">{items.length} proposal{items.length !== 1 ? "s" : ""}</span>
												<Button variant="ghost" color="gray" size="1" onClick={() => handleDeleteAllForVersion(version)} style={{ cursor: "pointer", marginLeft: "auto" }}>
													<Trash size={12} /> Clear All
												</Button>
											</div>
											<div>
												{items.map(p => (
													<ProposalCard key={p.id} proposal={p} agentId={agentId!} agent={agent} datasets={datasets} versionDatasetMap={versionDatasetMap} onRefresh={loadAll} />
												))}
											</div>
										</div>
									))}
								</div>
							</div>
						)}
					</Box>
				</Tabs.Content>

				{/* Current Prompt Tab */}
				<Tabs.Content value="current">
					<Box mt="4">
						<Card style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
							<Box p="4">
								{!editMode && activePrompt ? (
									<>
										<Flex align="center" justify="between" mb="3">
											<Flex align="center" gap="2">
												<Text size="3" weight="bold" style={{ color: "var(--foreground)" }}>Active System Prompt</Text>
												<Badge variant="soft" color="green">v{activePrompt.version}</Badge>
											</Flex>
											<Button variant="soft" size="2" onClick={() => setEditMode(true)} style={{ cursor: "pointer" }}>
												Edit
											</Button>
										</Flex>
										<Box style={{ background: "var(--code-bg)", borderRadius: 8, border: "1px solid var(--border)", padding: 16, fontFamily: "monospace", fontSize: 13, color: "var(--foreground)", whiteSpace: "pre-wrap", lineHeight: 1.6, maxHeight: 500, overflow: "auto" }}>
											{activePrompt.system_prompt}
										</Box>
										{/* Run Evaluation with active prompt */}
										<Box mt="3">
											<RunEvalInline version={activePrompt.version} />
										</Box>
									</>
								) : editMode ? (
									<>
										<Flex align="center" justify="between" mb="3">
											<Text size="3" weight="bold" style={{ color: "var(--foreground)" }}>
												{activePrompt ? "Edit System Prompt" : "Create System Prompt"}
											</Text>
										</Flex>
										<Box mb="3">
											<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 8 }}>Prompt Text</Text>
											<textarea
												value={editPromptText}
												onChange={(e) => setEditPromptText(e.target.value)}
												placeholder="Enter the system prompt here..."
												style={{
													width: "100%",
													minHeight: 300,
													fontFamily: "monospace",
													fontSize: 13,
													color: "var(--foreground)",
													background: "var(--code-bg)",
													border: "1px solid var(--border)",
													borderRadius: 8,
													padding: 12,
													boxSizing: "border-box",
													resize: "vertical",
												}}
											/>
										</Box>
										<Box mb="3">
											<Text size="2" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 8 }}>Version Notes (Optional)</Text>
											<input
												type="text"
												value={editPromptNotes}
												onChange={(e) => setEditPromptNotes(e.target.value)}
												placeholder="Describe what changed in this version..."
												style={{
													width: "100%",
													padding: 10,
													fontFamily: "system-ui",
													fontSize: 13,
													color: "var(--foreground)",
													background: "var(--card)",
													border: "1px solid var(--border)",
													borderRadius: 8,
													boxSizing: "border-box",
												}}
											/>
										</Box>
										<Flex gap="2" justify="end">
											<Button variant="soft" color="gray" onClick={() => {
												setEditMode(false);
												if (activePrompt) {
													setEditPromptText(activePrompt.system_prompt);
												}
												setEditPromptNotes("");
											}} style={{ cursor: "pointer" }}>
												Cancel
											</Button>
											<Button variant="solid" color="green" onClick={handleSavePrompt} disabled={savingPrompt || !editPromptText.trim()} style={{ cursor: "pointer" }}>
												{savingPrompt ? "Saving..." : "Save as New Version"}
											</Button>
										</Flex>
									</>
								) : (
									<Flex direction="column" gap="3" align="center" py="6">
										<Text size="2" style={{ color: "var(--muted-foreground)" }}>Define your agent's system prompt to get started</Text>
										<Button variant="solid" color="green" onClick={() => setEditMode(true)} style={{ cursor: "pointer" }}>
											Create Prompt
										</Button>
									</Flex>
								)}
							</Box>
						</Card>
					</Box>
				</Tabs.Content>

				{/* History Tab */}
				<Tabs.Content value="history">
					<div className="mt-4">
						{sortedPrompts.length > 0 ? (
							<div className="w-full">
								{/* Table header */}
								<div
									className="grid items-center text-sm text-muted-foreground"
									style={{ gridTemplateColumns: "60px 1fr 100px 80px 80px 140px 30px", padding: "16px 8px" }}
								>
									<span>Version</span>
									<span>Notes</span>
									<span>Evals</span>
									<span>Pass rate</span>
									<span>Delta</span>
									<span>Date</span>
									<span />
								</div>

								{/* Table rows */}
								{sortedPrompts.map((p, index) => {
									const stats = evalStats[p.version];
									const passRateColor = stats ? (stats.passRate >= 80 ? "var(--success)" : stats.passRate >= 50 ? "#d29922" : "var(--destructive)") : undefined;
									const isExpanded = expandedVersions.has(p.version);
									const compareTarget = compareVersions[p.version] != null
										? sortedPrompts.find(v => v.version === compareVersions[p.version])
										: null;

									// Compute delta vs previous version
									let deltaBadge: React.ReactNode = null;
									if (stats && index < sortedPrompts.length - 1) {
										const prevVersion = sortedPrompts[index + 1];
										const prevStats = evalStats[prevVersion.version];
										if (prevStats) {
											const delta = stats.passRate - prevStats.passRate;
											const deltaColor = delta > 0 ? "var(--success)" : delta < 0 ? "var(--destructive)" : "var(--muted-foreground)";
											const deltaIcon = delta > 0 ? <ArrowUp size={12} weight="bold" /> : delta < 0 ? <ArrowDown size={12} weight="bold" /> : null;
											const deltaLabel = delta > 0 ? "+" : "";
											deltaBadge = (
												<span style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 3,
													padding: "2px 8px",
													borderRadius: 16,
													fontSize: 11,
													fontWeight: 500,
													backgroundColor: delta > 0 ? "rgba(63, 185, 80, 0.12)" : delta < 0 ? "rgba(248, 81, 73, 0.12)" : "rgba(139, 148, 158, 0.12)",
													color: deltaColor,
													border: `1px solid ${deltaColor}30`,
												}}>
													{deltaIcon}
													{deltaLabel}{delta.toFixed(1)}%
												</span>
											);
										}
									}

									return (
										<div key={p.id}>
											{/* Main row */}
											<div
												className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
												style={{ gridTemplateColumns: "60px 1fr 100px 80px 80px 140px 30px", padding: "16px 8px", cursor: "pointer" }}
												onClick={() => toggleVersionExpanded(p.version)}
											>
												{/* Version */}
												<div className="flex items-center gap-1">
													<Badge variant={p.is_active ? "solid" : "soft"} color={p.is_active ? "green" : "gray"}>v{p.version}</Badge>
												</div>

												{/* Notes */}
												<div className="min-w-0">
													<div className="truncate text-foreground">{p.notes || "No notes"}</div>
												</div>

												{/* Evals */}
												<div className="text-muted-foreground">
													{stats ? `${stats.count}` : "–"}
												</div>

												{/* Pass rate */}
												<div className="text-right">
													{stats ? (
														<span style={{ color: passRateColor, fontWeight: 500 }}>
															{stats.passRate.toFixed(1)}%
														</span>
													) : (
														<span className="text-muted-foreground">–</span>
													)}
												</div>

												{/* Delta */}
												<div>
													{deltaBadge || <span className="text-muted-foreground">–</span>}
												</div>

												{/* Date */}
												<div className="text-muted-foreground text-xs">
													{new Date(p.created_at).toLocaleString()}
												</div>

												{/* Expand/collapse caret */}
												<div className="flex justify-center">
													{isExpanded
														? <CaretDown size={14} style={{ color: "var(--muted-foreground)" }} />
														: <CaretRight size={14} style={{ color: "var(--muted-foreground)" }} />
													}
												</div>
											</div>

											{/* Expanded content */}
											{isExpanded && (
												<div className="border-t border-border bg-black/5 px-4 pb-4 pt-3">
													{/* Run eval dataset picker row */}
													{runEvalForVersion === p.version && (
														<Box mb="3">
															<RunEvalInline version={p.version} />
														</Box>
													)}

													{/* System Prompt section */}
													<div className="mb-4">
														<div className="flex items-center justify-between mb-3">
															<div className="font-bold text-sm text-foreground">System Prompt</div>
															{sortedPrompts.length > 1 && (
																<div className="flex items-center gap-2">
																	<span className="text-xs text-muted-foreground">Compare with:</span>
																	<select
																		value={compareVersions[p.version] ?? ""}
																		onChange={(e) => setCompareTarget(p.version, e.target.value ? Number(e.target.value) : null)}
																		onClick={(e) => e.stopPropagation()}
																		style={{
																			padding: "4px 8px",
																			fontSize: 12,
																			borderRadius: 6,
																			border: "1px solid var(--border)",
																			background: "var(--card)",
																			color: "var(--foreground)",
																			cursor: "pointer",
																		}}
																	>
																		<option value="">None</option>
																		{sortedPrompts
																			.filter(v => v.version !== p.version)
																			.map(v => (
																				<option key={v.version} value={v.version}>
																					v{v.version}{v.is_active ? " (active)" : ""}
																				</option>
																			))
																		}
																	</select>
																</div>
															)}
														</div>

														{compareTarget ? (
															<VersionDiffViewer
																oldText={compareTarget.system_prompt}
																newText={p.system_prompt}
																oldVersion={compareTarget.version}
																newVersion={p.version}
															/>
														) : (
															<div style={{
																background: "var(--code-bg)",
																borderRadius: 8,
																border: "1px solid var(--border)",
																padding: 16,
																fontFamily: "monospace",
																fontSize: 12,
																color: "var(--foreground)",
																whiteSpace: "pre-wrap",
																lineHeight: 1.6,
																maxHeight: 400,
																overflow: "auto",
															}}>
																{p.system_prompt}
															</div>
														)}
													</div>

													{/* Action buttons */}
													<div className="flex gap-2 pt-3 border-t border-border">
														{runEvalForVersion !== p.version && (
															<Button
																variant="soft"
																color="blue"
																size="1"
																onClick={(e) => { e.stopPropagation(); setRunEvalForVersion(p.version); setRunEvalDatasetId(resolveDatasetForVersion(p.version)); setRunEvalError(null); }}
																style={{ cursor: "pointer" }}
															>
																<Play size={12} weight="fill" /> Run Eval
															</Button>
														)}
														{!p.is_active && (
															<Button
																variant="soft"
																color="blue"
																size="1"
																onClick={(e) => { e.stopPropagation(); handleActivateVersion(p.version); }}
																style={{ cursor: "pointer" }}
															>
																Activate
															</Button>
														)}
													</div>
												</div>
											)}
										</div>
									);
								})}
							</div>
						) : (
							<div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
								<span>No prompt versions yet</span>
							</div>
						)}
					</div>
				</Tabs.Content>

				{/* Performance Tab */}
				<Tabs.Content value="performance">
					<Box mt="4">
						<Card style={{ background: "var(--card)", border: "1px solid var(--border)" }}>
							<Box p="4">
								<Flex align="center" justify="between" mb="3">
									<Box>
										<Text size="3" weight="bold" style={{ color: "var(--foreground)", display: "block", marginBottom: 4 }}>
											Prompt Performance Over Time
										</Text>
										<Text size="2" style={{ color: "var(--muted-foreground)" }}>
											Pass rate for each evaluation, grouped by prompt version. Dashed lines mark version releases.
										</Text>
									</Box>
								</Flex>
								<PromptPerformanceChart
									evaluations={evaluationsForChart}
									prompts={prompts}
									datasets={datasets}
								/>
							</Box>
						</Card>
					</Box>
				</Tabs.Content>
			</Tabs.Root>
		</Box>
	);
}
