/**
 * Evaluation Results Page
 *
 * Displays the results of an evaluation run including test case outcomes,
 * progress tracking, and activity log.
 *
 * Annotation is done inline on each TestCaseResultPage — the "Annotate"
 * button navigates to the first unannotated test case.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
} from "@/components/ui/card";
import {
	ArrowLeft,
	CheckCircle,
	XCircle,
	CircleNotch,
	Clock,
	X,
	Warning,
	NotePencil,
	Play,
	Timer,
	ListChecks,
	CaretRight,
	ArrowsLeftRight,
	Trash,
	ChartBar,
} from "@phosphor-icons/react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbDivider,
	BreadcrumbButton,
	Tooltip,
} from "@fluentui/react-components";
import { AIContentDisclaimer } from "@/components/shared/AIContentDisclaimer";
import { useEvaluation } from "@/hooks/useEvaluation";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useSelectableClick } from "@/hooks/useSelectableClick";
import { useAgents } from "@/hooks/useAgents";
import { useDatasets } from "@/hooks/useDatasets";
import { apiClient } from "@/lib/api";

// Score ring component for pass rate
function ScoreRing({ value, size = 80 }: { value: number; size?: number }) {
	const radius = (size - 8) / 2;
	const circumference = 2 * Math.PI * radius;
	const filled = (value / 100) * circumference;
	const color = value >= 80 ? "#3fb950" : value >= 50 ? "#d29922" : "#f85149";

	return (
		<div style={{ position: "relative", width: size, height: size }}>
			<svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
				<circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={4} />
				<circle
					cx={size / 2} cy={size / 2} r={radius} fill="none"
					stroke={color} strokeWidth={4}
					strokeDasharray={circumference} strokeDashoffset={circumference - filled}
					strokeLinecap="round"
					style={{ transition: "stroke-dashoffset 0.6s ease" }}
				/>
			</svg>
			<div style={{
				position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
				fontWeight: 700, fontSize: size * 0.28, color,
			}}>
				{value}%
			</div>
		</div>
	);
}

// Status badge with proper dark-theme colors
function StatusBadge({ status }: { status: string }) {
	const config: Record<string, { bg: string; color: string; border: string; icon: React.ReactNode }> = {
		completed: { bg: "rgba(63, 185, 80, 0.12)", color: "#3fb950", border: "rgba(63, 185, 80, 0.3)", icon: <CheckCircle size={12} weight="fill" /> },
		running: { bg: "rgba(88, 166, 255, 0.12)", color: "#58a6ff", border: "rgba(88, 166, 255, 0.3)", icon: <CircleNotch size={12} className="animate-spin" /> },
		pending: { bg: "rgba(210, 153, 34, 0.12)", color: "#d29922", border: "rgba(210, 153, 34, 0.3)", icon: <CircleNotch size={12} className="animate-spin" /> },
		failed: { bg: "rgba(248, 81, 73, 0.12)", color: "#f85149", border: "rgba(248, 81, 73, 0.3)", icon: <XCircle size={12} weight="fill" /> },
		cancelled: { bg: "rgba(139, 148, 158, 0.12)", color: "var(--muted-foreground)", border: "rgba(139, 148, 158, 0.3)", icon: <X size={12} /> },
	};
	const c = config[status] || config.pending;
	return (
		<span style={{
			display: "inline-flex", alignItems: "center", gap: 4,
			padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 500,
			backgroundColor: c.bg, color: c.color, border: `1px solid ${c.border}`,
		}}>
			{c.icon}
			{status.charAt(0).toUpperCase() + status.slice(1)}
		</span>
	);
}

export function EvaluationResultsPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { evaluation, testCases, loading, error, refetch } = useEvaluation(id, true);
	const { summary, getRunAnnotation } = useAnnotations(id);
	const { agents } = useAgents();
	const { datasets } = useDatasets();
	const { createClickHandler } = useSelectableClick();
	const [isCancelling, setIsCancelling] = useState(false);
	const [isRerunning, setIsRerunning] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [showComparePopover, setShowComparePopover] = useState(false);
	const [recentEvals, setRecentEvals] = useState<any[]>([]);
	const [loadingEvals, setLoadingEvals] = useState(false);
	const [selectedTestCases, setSelectedTestCases] = useState<Set<string>>(new Set());
	const [isRerunningSelected, setIsRerunningSelected] = useState(false);

	const toggleTestCase = (id: string) => {
		setSelectedTestCases((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const selectFailed = () => {
		if (!evaluation) return;
		const failedIds = evaluation.test_cases
			.filter((tc) => !tc.passed)
			.map((tc) => tc.testcase_id);
		setSelectedTestCases(new Set(failedIds));
	};

	const clearSelection = () => setSelectedTestCases(new Set());

	const handleRerunSelected = async () => {
		if (!id || selectedTestCases.size === 0) return;
		setIsRerunningSelected(true);
		try {
			const newEval = await apiClient.rerunSelectedTestCases(id, Array.from(selectedTestCases));
			setSelectedTestCases(new Set());
			navigate(`/evaluations/${newEval.id}`);
		} catch (err) {
			console.error("Failed to rerun selected tests:", err);
		} finally {
			setIsRerunningSelected(false);
		}
	};

	const handleRerun = async () => {
		if (!id) return;
		setIsRerunning(true);
		try {
			const newEval = await apiClient.rerunEvaluation(id);
			navigate(`/evaluations/${newEval.id}`);
		} catch (err) {
			console.error("Failed to rerun evaluation:", err);
		} finally {
			setIsRerunning(false);
		}
	};

	const handleCancel = async () => {
		if (!id) return;
		setIsCancelling(true);
		try {
			await apiClient.cancelEvaluation(id);
			refetch();
		} catch (err) {
			console.error("Failed to cancel evaluation:", err);
		} finally {
			setIsCancelling(false);
		}
	};

	const handleDelete = async () => {
		if (!id || !evaluation) return;
		if (!window.confirm(`Delete evaluation "${evaluation.name}"? This will also remove all associated annotations.`)) return;
		setIsDeleting(true);
		try {
			await apiClient.deleteEvaluation(id);
			navigate(evaluation.agent_id ? `/agents/${evaluation.agent_id}` : "/agents");
		} catch (err) {
			console.error("Failed to delete evaluation:", err);
		} finally {
			setIsDeleting(false);
		}
	};

	const agent = evaluation ? agents.find((a) => a.id === evaluation.agent_id) : null;
	const dataset = evaluation ? datasets.find((s) => s.id === evaluation.dataset_id) : null;
	const agentName = agent?.name;
	const evaluationName = evaluation?.name;

	const getTestCaseName = (testcaseId: string) => {
		const testCase = testCases.find((tc) => tc.id === testcaseId);
		return testCase?.name || `Test Case ${testcaseId}`;
	};

	const handleTestCaseClick = createClickHandler((testcaseId: string) => {
		navigate(`/evaluations/${id}/testcases/${testcaseId}`);
	});

	// Navigate to first unannotated test case for annotation flow
	const handleAnnotate = () => {
		if (!evaluation) return;
		const firstUnannotated = evaluation.test_cases.find((tc) => !getRunAnnotation(tc.testcase_id));
		const target = firstUnannotated || evaluation.test_cases[0];
		if (target) {
			navigate(`/evaluations/${id}/testcases/${target.testcase_id}`);
		}
	};

	// Load recent evaluations for same agent when opening compare popover
	const handleOpenComparePopover = async () => {
		if (!evaluation || !evaluation.agent_id) return;
		setShowComparePopover(true);
		setLoadingEvals(true);
		try {
			const evals = await apiClient.getEvaluations(0, 10, evaluation.agent_id);
			// Filter out current evaluation and incomplete ones
			const recent = evals.filter(
				(e) => e.id !== id && e.status === "completed"
			);
			setRecentEvals(recent);
		} catch (err) {
			console.error("Failed to load evaluations for comparison:", err);
		} finally {
			setLoadingEvals(false);
		}
	};

	const handleSelectForComparison = (otherId: string) => {
		setShowComparePopover(false);
		navigate(`/evaluations/${id}/compare/${otherId}`);
	};

	// Progress: completed tests count fully, in-progress tests count as ~half each
	const progressPercentage = (() => {
		if (!evaluation || evaluation.total_tests <= 0) return 0;
		const completed = evaluation.completed_tests ?? 0;
		const inProgress = Math.max(0, evaluation.in_progress_tests ?? 0);
		const raw = ((completed + inProgress * 0.5) / evaluation.total_tests) * 100;
		// Clamp: show 100% only when fully done, cap at 99% while still running
		if (completed >= evaluation.total_tests) return 100;
		return Math.min(99, Math.max(0, raw));
	})();
	const passRate =
		evaluation && evaluation.total_tests > 0
			? Math.round((evaluation.passed_count / evaluation.total_tests) * 100)
			: 0;

	const annotatedCount = summary?.annotated_runs ?? 0;
	const totalAnnotatable = summary?.total_runs ?? 0;
	const regressions = evaluation?.regressions ?? [];
	const regressedIds = new Set(regressions.map((r) => r.testcase_id));

	// Rubric scoring stats (Feature: rubric-evaluation)
	const rubricStats = useMemo(() => {
		if (!evaluation?.test_cases) return null;
		const scored = evaluation.test_cases.filter(
			(tc) => tc.rubric_average_score != null
		);
		if (scored.length === 0) return null;
		const avg =
			scored.reduce((sum, tc) => sum + (tc.rubric_average_score ?? 0), 0) /
			scored.length;
		const min = Math.min(...scored.map((tc) => tc.rubric_average_score!));
		const max = Math.max(...scored.map((tc) => tc.rubric_average_score!));
		return { avg, min, max, count: scored.length, total: evaluation.test_cases.length };
	}, [evaluation]);

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<CircleNotch size={48} className="animate-spin text-primary mb-4" />
				<p className="text-muted-foreground">Loading evaluation...</p>
			</div>
		);
	}

	if (error || !evaluation) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<h2 className="text-2xl font-bold mb-2">Evaluation not found</h2>
				<p className="text-muted-foreground mb-6">
					{error || "The evaluation you're looking for doesn't exist."}
				</p>
				<Button onClick={() => navigate("/agents")} variant="outline" className="gap-2">
					<ArrowLeft size={18} />
					Back to Agents
				</Button>
			</div>
		);
	}

	const isActive = evaluation.status === "running" || evaluation.status === "pending";

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<Breadcrumb aria-label="Agent navigation" className="mb-3">
					<BreadcrumbItem>
						<BreadcrumbButton onClick={() => navigate("/agents")}>Agents</BreadcrumbButton>
					</BreadcrumbItem>
					<BreadcrumbDivider />
					<BreadcrumbItem>
						<BreadcrumbButton onClick={() => navigate(`/agents/${evaluation.agent_id}`)}>
							{agentName || "Unknown Agent"}
						</BreadcrumbButton>
					</BreadcrumbItem>
					<BreadcrumbDivider />
					<BreadcrumbItem>
						<BreadcrumbButton current>{evaluationName || evaluation.name}</BreadcrumbButton>
					</BreadcrumbItem>
				</Breadcrumb>

				<div className="flex items-start justify-between gap-4">
					<div className="space-y-2">
						<div className="flex items-center gap-3">
							<h1 className="text-2xl font-bold tracking-tight">{evaluationName || evaluation.name}</h1>
							<StatusBadge status={evaluation.status} />
						</div>
						<div className="flex items-center gap-3 text-sm" style={{ color: "var(--muted-foreground)" }}>
							<span>{new Date(evaluation.created_at).toLocaleString()}</span>
							{evaluation.prompt_version != null && (
								<>
									<span style={{ color: "var(--border)" }}>·</span>
									<span className="cursor-pointer" style={{ color: "var(--primary)" }}
										onClick={() => navigate(`/agents/${evaluation.agent_id}/prompts`)}>
										Prompt v{evaluation.prompt_version}
									</span>
								</>
							)}
							{dataset && (
								<>
									<span style={{ color: "var(--border)" }}>·</span>
									<span>{dataset.seed?.name}</span>
								</>
							)}
						</div>
						<AIContentDisclaimer />
					</div>
					<div className="flex gap-2 shrink-0" style={{ position: "relative" }}>
						{!isActive && (
							<Button variant="outline" className="gap-2" onClick={handleRerun} disabled={isRerunning}>
								<Play size={16} />
								{isRerunning ? "Starting..." : "Rerun"}
							</Button>
						)}
						{!isActive && evaluation.test_cases && evaluation.test_cases.some((tc) => !tc.passed) && (
							<Button variant="outline" className="gap-2" onClick={selectedTestCases.size > 0 ? clearSelection : selectFailed}
								style={selectedTestCases.size > 0 ? { borderColor: "rgba(88, 166, 255, 0.5)", color: "#58a6ff" } : {}}>
								<ListChecks size={16} />
								{selectedTestCases.size > 0 ? "Clear Selection" : "Select Failed"}
							</Button>
						)}
						{!isActive && selectedTestCases.size > 0 && (
							<Button className="gap-2" onClick={handleRerunSelected} disabled={isRerunningSelected}
								style={{ backgroundColor: "#58a6ff", color: "#fff", border: "none" }}>
								<Play size={16} />
								{isRerunningSelected ? "Starting..." : `Rerun Selected (${selectedTestCases.size})`}
							</Button>
						)}
						{isActive && (
							<Button variant="outline" className="gap-2" onClick={handleCancel} disabled={isCancelling}>
								<X size={16} />
								{isCancelling ? "Cancelling..." : "Cancel"}
							</Button>
						)}
						{!isActive && evaluation.test_cases && evaluation.test_cases.length > 0 && (
							<Button variant="outline" className="gap-2" onClick={handleOpenComparePopover}>
								<ArrowsLeftRight size={16} />
								Compare
							</Button>
						)}
						{evaluation.test_cases && evaluation.test_cases.length > 0 && (
							<Button variant="outline" className="gap-2" onClick={handleAnnotate}>
								<NotePencil size={16} />
								Annotate
								{totalAnnotatable > 0 && (
									<span style={{
										fontSize: 11, marginLeft: 2,
										color: annotatedCount === totalAnnotatable ? "#3fb950" : "var(--muted-foreground)",
									}}>
										{annotatedCount}/{totalAnnotatable}
									</span>
								)}
							</Button>
						)}
						{!isActive && (
							<Button variant="outline" className="gap-2" onClick={handleDelete} disabled={isDeleting}
								style={{ color: "var(--destructive)", borderColor: "var(--destructive)" }}>
								<Trash size={16} />
								{isDeleting ? "Deleting..." : "Delete"}
							</Button>
						)}

						{/* Compare Popover */}
						{showComparePopover && (
							<div style={{
								position: "absolute",
								top: "100%",
								right: 0,
								marginTop: 8,
								backgroundColor: "var(--card)",
								border: "1px solid var(--border)",
								borderRadius: 8,
								boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
								zIndex: 50,
								minWidth: 280,
								maxHeight: 400,
								overflow: "auto",
							}}>
								<div style={{
									padding: 12,
									fontSize: 13,
									fontWeight: 500,
									color: "var(--foreground)",
									borderBottom: "1px solid var(--border)",
								}}>
									Select evaluation to compare
								</div>
								{loadingEvals && (
									<div style={{
										padding: 16,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										gap: 8,
										color: "var(--muted-foreground)",
									}}>
										<CircleNotch size={16} className="animate-spin" />
										Loading...
									</div>
								)}
								{!loadingEvals && recentEvals.length === 0 && (
									<div style={{
										padding: 16,
										fontSize: 12,
										color: "var(--muted-foreground)",
										textAlign: "center",
									}}>
										No other completed evaluations found
									</div>
								)}
								{!loadingEvals && recentEvals.length > 0 && (
									<div>
										{recentEvals.map((eval_item) => (
											<div
												key={eval_item.id}
												onClick={() => handleSelectForComparison(eval_item.id)}
												style={{
													padding: "8px 12px",
													borderBottom: "1px solid var(--border)",
													cursor: "pointer",
													transition: "background-color 0.15s",
												}}
												onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--secondary)")}
												onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
											>
												<div style={{ fontSize: 12, fontWeight: 500, color: "var(--foreground)", marginBottom: 2 }}>
													{eval_item.name}
												</div>
												<div style={{
													fontSize: 11,
													color: "var(--muted-foreground)",
													display: "flex",
													justifyContent: "space-between",
													alignItems: "center",
												}}>
													<span>
														{eval_item.prompt_version != null ? `v${eval_item.prompt_version}` : "no version"}
													</span>
													<span style={{ color: "#3fb950", fontWeight: 500 }}>
														{Math.round((eval_item.passed_count / eval_item.total_tests) * 100)}%
													</span>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{showComparePopover && (
							<div
								style={{
									position: "fixed",
									inset: 0,
									zIndex: 40,
								}}
								onClick={() => setShowComparePopover(false)}
							/>
						)}
					</div>
				</div>
			</div>

			{/* Rate limit warnings (filter out regression messages — those have their own banner) */}
			{(() => {
				const rateLimitWarnings = (evaluation.warnings || []).filter(w => !w.toLowerCase().startsWith("regression"));
				return rateLimitWarnings.length > 0 ? (
					<div style={{
						padding: "12px 16px", borderRadius: 8,
						backgroundColor: "rgba(210, 153, 34, 0.1)",
						border: "1px solid rgba(210, 153, 34, 0.25)",
						color: "#d29922", fontSize: 13,
					}}>
						<div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
							<Warning size={16} style={{ marginTop: 2, flexShrink: 0 }} />
							<div>
								<strong>Rate Limit Warnings</strong>
								<div style={{ marginTop: 4 }}>
									{rateLimitWarnings.slice(0, 3).map((warning, i) => (
										<div key={i} style={{ fontSize: 12, opacity: 0.85 }}>{warning}</div>
									))}
									{rateLimitWarnings.length > 3 && (
										<div style={{ fontSize: 12, opacity: 0.6 }}>+{rateLimitWarnings.length - 3} more</div>
									)}
								</div>
							</div>
						</div>
					</div>
				) : null;
			})()}

			{/* Regression alert banner */}
			{regressions.length > 0 && (
				<div style={{
					padding: "12px 16px", borderRadius: 8,
					backgroundColor: "rgba(248, 81, 73, 0.1)",
					border: "1px solid rgba(248, 81, 73, 0.25)",
					color: "#f85149", fontSize: 13,
				}}>
					<div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
						<Warning size={16} style={{ marginTop: 2, flexShrink: 0 }} />
						<div>
							<strong>Regression Detected</strong>
							<div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>
								{regressions.length} test case{regressions.length !== 1 ? "s" : ""} that previously passed now fail{regressions.length === 1 ? "s" : ""}.
								{regressions.length <= 5 && (
									<span style={{ marginLeft: 4 }}>
										({regressions.map((r, i) => (
											<span key={r.testcase_id}>
												{i > 0 && ", "}
												{getTestCaseName(r.testcase_id)}
											</span>
										))})
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Progress bar for active evaluations */}
			{isActive && (
				<div className="fade-in-up" style={{
					background: "linear-gradient(135deg, rgba(88, 166, 255, 0.06) 0%, rgba(63, 185, 80, 0.06) 100%)",
					border: "1px solid rgba(88, 166, 255, 0.15)",
					borderRadius: 12,
					overflow: "hidden",
				}}>
					{/* Determinate progress track */}
					<div style={{ height: 3, background: "rgba(88, 166, 255, 0.08)", position: "relative", overflow: "hidden" }}>
						{/* Filled portion */}
						<div style={{
							position: "absolute", top: 0, left: 0,
							height: "100%",
							width: `${progressPercentage}%`,
							background: "linear-gradient(90deg, rgba(88, 166, 255, 0.7), rgba(63, 185, 80, 0.7))",
							borderRadius: 3,
							transition: "width 0.6s ease",
						}} />
						{/* Shimmer sweep on top */}
						<div className="progress-sweep-bar" style={{
							position: "absolute", top: 0, left: 0,
							height: "100%", width: "40%",
							background: "linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.15), transparent)",
							borderRadius: 3,
						}} />
					</div>

					<div style={{ padding: "16px 20px" }}>
						<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
							{/* Score ring as spinner */}
							<div style={{ position: "relative", width: 48, height: 48, flexShrink: 0 }}>
								<svg width={48} height={48} style={{ transform: "rotate(-90deg)" }}>
									<circle cx={24} cy={24} r={20} fill="none" stroke="rgba(88, 166, 255, 0.1)" strokeWidth={3} />
									<circle
										cx={24} cy={24} r={20} fill="none"
										stroke="rgba(88, 166, 255, 0.6)" strokeWidth={3}
										strokeDasharray={2 * Math.PI * 20}
										strokeDashoffset={2 * Math.PI * 20 * (1 - progressPercentage / 100)}
										strokeLinecap="round"
										style={{ transition: "stroke-dashoffset 0.6s ease" }}
									/>
								</svg>
								<div style={{
									position: "absolute", inset: 0,
									display: "flex", alignItems: "center", justifyContent: "center",
									fontSize: 12, fontWeight: 700,
									color: "var(--primary)",
									fontVariantNumeric: "tabular-nums",
								}}>
									{Math.round(progressPercentage)}%
								</div>
							</div>

							{/* Text content */}
							<div style={{ flex: 1, minWidth: 0 }}>
								<div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
									<span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
										{evaluation.status === "pending"
											? "Preparing evaluation"
											: evaluation.completed_tests > 0
												? `Running — ${evaluation.completed_tests} of ${evaluation.total_tests} completed`
												: (evaluation.in_progress_tests ?? 0) > 0
													? `Running — ${evaluation.in_progress_tests} test${evaluation.in_progress_tests !== 1 ? "s" : ""} in progress`
													: `Running — 0 of ${evaluation.total_tests} tests`}
									</span>
								</div>
								<span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
									{evaluation.status_message || "Processing test cases..."}
								</span>
							</div>

							{/* Right side: counter chips */}
							<div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
								{/* In-progress indicator */}
								{(evaluation.in_progress_tests ?? 0) > 0 && (
									<div style={{
										display: "flex", alignItems: "center", gap: 4,
										padding: "4px 10px", borderRadius: 20,
										background: "rgba(210, 153, 34, 0.08)",
										border: "1px solid rgba(210, 153, 34, 0.15)",
									}}>
										<div className="pulse-ring" style={{
											width: 6, height: 6, borderRadius: "50%",
											background: "#d29922",
										}} />
										<span style={{ fontSize: 13, fontWeight: 600, color: "#d29922", fontVariantNumeric: "tabular-nums" }}>
											{evaluation.in_progress_tests}
										</span>
									</div>
								)}
								{/* Completed counter */}
								<div style={{
									display: "flex", alignItems: "center", gap: 6,
									padding: "4px 12px", borderRadius: 20,
									background: "rgba(88, 166, 255, 0.08)",
									border: "1px solid rgba(88, 166, 255, 0.15)",
								}}>
									<span style={{ fontSize: 18, fontWeight: 700, color: "var(--primary)", fontVariantNumeric: "tabular-nums" }}>
										{evaluation.completed_tests}
									</span>
									<span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
										/ {evaluation.total_tests}
									</span>
								</div>
							</div>
						</div>

						{/* Rate limit warning */}
						{(evaluation.total_rate_limit_hits ?? 0) > 0 && (
							<div style={{
								marginTop: 12, padding: "6px 12px", borderRadius: 8,
								background: "rgba(210, 153, 34, 0.08)",
								border: "1px solid rgba(210, 153, 34, 0.15)",
								display: "flex", alignItems: "center", gap: 12,
								fontSize: 12, color: "#d29922",
							}}>
								<Warning size={14} />
								<span><strong>{evaluation.total_rate_limit_hits}</strong> rate limit hit{evaluation.total_rate_limit_hits !== 1 ? "s" : ""}</span>
								<span style={{ opacity: 0.6 }}>·</span>
								<span><strong>{evaluation.total_retry_wait_seconds?.toFixed(1) ?? 0}s</strong> total wait</span>
							</div>
						)}

						{/* Activity log */}
						{evaluation.status_history && evaluation.status_history.length > 0 && (
							<details style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(88, 166, 255, 0.1)" }}>
								<summary style={{
									cursor: "pointer", fontSize: 12,
									display: "flex", alignItems: "center", gap: 6,
									color: "var(--muted-foreground)",
								}}>
									<Clock size={12} />
									Activity Log ({evaluation.status_history.length})
								</summary>
								<div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto" }}>
									{evaluation.status_history.slice().reverse().map((entry, index) => (
										<div key={index} style={{
											fontSize: 12, padding: "4px 8px", borderRadius: 6, marginBottom: 2,
											display: "flex", alignItems: "flex-start", gap: 8,
											background: entry.is_rate_limit ? "rgba(210, 153, 34, 0.06)" : undefined,
											color: entry.is_rate_limit ? "#d29922" : "var(--muted-foreground)",
										}}>
											<span style={{ flexShrink: 0, fontFamily: "monospace", opacity: 0.6, fontSize: 10 }}>
												{new Date(entry.timestamp).toLocaleTimeString()}
											</span>
											<span style={{ flex: 1, wordBreak: "break-word" }}>{entry.message}</span>
											{entry.is_rate_limit && entry.wait_seconds && (
												<span style={{
													flexShrink: 0, fontFamily: "monospace",
													fontSize: 10, padding: "1px 6px", borderRadius: 4,
													background: "rgba(210, 153, 34, 0.12)",
												}}>
													+{entry.wait_seconds.toFixed(1)}s
												</span>
											)}
										</div>
									))}
								</div>
							</details>
						)}
					</div>
				</div>
			)}

			{/* Summary Stats — modern card grid */}
			{!isActive && evaluation.test_cases && evaluation.test_cases.length > 0 && (
				<div style={{
					display: "grid", gridTemplateColumns: "auto 1fr",
					gap: 24, padding: 24, borderRadius: 12,
					border: "1px solid var(--border)", backgroundColor: "var(--card)",
				}}>
					<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
						<ScoreRing value={passRate} size={96} />
					</div>
					<div style={{ display: "grid", gridTemplateColumns: rubricStats ? "repeat(4, 1fr)" : "repeat(3, 1fr)", gap: 16, alignItems: "center" }}>
						<div style={{
							padding: "14px 16px", borderRadius: 12,
							backgroundColor: "var(--card)",
							border: "1px solid var(--border)",
						}}>
							<div style={{ fontSize: 24, fontWeight: 700, color: "#58a6ff" }}>{evaluation.total_tests}</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
								<ListChecks size={12} /> Total Tests
							</div>
						</div>
						<div style={{
							padding: "14px 16px", borderRadius: 12,
							backgroundColor: "var(--card)",
							border: "1px solid var(--border)",
						}}>
							<div style={{ fontSize: 24, fontWeight: 700, color: "#3fb950" }}>{evaluation.passed_count}</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
								<CheckCircle size={12} /> Passed
							</div>
						</div>
						<div style={{
							padding: "14px 16px", borderRadius: 12,
							backgroundColor: "var(--card)",
							border: "1px solid var(--border)",
						}}>
							<div style={{ fontSize: 24, fontWeight: 700, color: "#f85149" }}>{evaluation.failed_tests}</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
								<XCircle size={12} /> Failed
							</div>
						</div>
						{rubricStats && (
							<div style={{
								padding: "14px 16px", borderRadius: 12,
								backgroundColor: "var(--card)",
								border: "1px solid var(--border)",
							}}>
								<div style={{
									fontSize: 24, fontWeight: 700,
									color: rubricStats.avg >= 3.5 ? "#3fb950" : rubricStats.avg >= 2.5 ? "#d29922" : "#f85149",
								}}>
									{rubricStats.avg.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 400, color: "var(--muted-foreground)" }}>/5</span>
								</div>
								<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
									<ChartBar size={12} /> Rubric Avg
								</div>
								<div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 4 }}>
									{rubricStats.min.toFixed(1)} — {rubricStats.max.toFixed(1)} range · {rubricStats.count}/{rubricStats.total} scored
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Activity log for completed evaluations */}
			{!isActive && evaluation.status_history && evaluation.status_history.length > 0 && (
				<details style={{ borderRadius: 8, border: "1px solid var(--border)", backgroundColor: "var(--card)" }}>
					<summary className="cursor-pointer" style={{
						padding: "12px 16px", fontSize: 13, fontWeight: 500,
						color: "var(--muted-foreground)",
						display: "flex", alignItems: "center", gap: 8,
					}}>
						<Clock size={14} />
						Activity Log ({evaluation.status_history.length} steps
						{(evaluation.total_rate_limit_hits ?? 0) > 0 && `, ${evaluation.total_rate_limit_hits} retries`})
					</summary>
					<div style={{ padding: "0 16px 16px", maxHeight: 200, overflowY: "auto" }}>
						<div className="space-y-1">
							{evaluation.status_history.map((entry, index) => (
								<div key={index}
									className="text-sm py-1.5 px-3 rounded flex items-start gap-3"
									style={{
										backgroundColor: entry.is_rate_limit ? "rgba(210, 153, 34, 0.08)" : undefined,
										color: entry.is_rate_limit ? "#d29922" : "var(--muted-foreground)",
									}}>
									<span className="shrink-0 font-mono text-xs" style={{ opacity: 0.6 }}>
										{new Date(entry.timestamp).toLocaleTimeString()}
									</span>
									<span>{entry.message}</span>
									{entry.is_rate_limit && entry.wait_seconds && (
										<span className="shrink-0 text-xs font-mono px-1.5 py-0.5 rounded ml-auto" style={{
											backgroundColor: "rgba(210, 153, 34, 0.2)",
										}}>
											+{entry.wait_seconds.toFixed(1)}s
										</span>
									)}
								</div>
							))}
						</div>
					</div>
				</details>
			)}

			{/* Test Results — modern list */}
			{evaluation.test_cases && evaluation.test_cases.length > 0 && (
				<div>
					<h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: "var(--foreground)" }}>
						Test Results
					</h2>
					<div className="w-full">
						{/* Header row */}
						<div
							className="grid items-center text-sm text-muted-foreground"
							style={{
								gridTemplateColumns: !isActive
									? (rubricStats ? "32px 1fr 100px 80px 80px 40px" : "32px 1fr 100px 80px 40px")
									: (rubricStats ? "1fr 100px 80px 80px 40px" : "1fr 100px 80px 40px"),
								padding: "16px 8px",
							}}
						>
							{!isActive && (
								<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
									<input
										type="checkbox"
										checked={selectedTestCases.size > 0 && selectedTestCases.size === evaluation.test_cases.length}
										onChange={() => {
											if (selectedTestCases.size === evaluation.test_cases.length) {
												clearSelection();
											} else {
												setSelectedTestCases(new Set(evaluation.test_cases.map((tc) => tc.testcase_id)));
											}
										}}
										style={{ cursor: "pointer", accentColor: "#58a6ff" }}
										title="Select all"
									/>
								</div>
							)}
							<div>Test Case</div>
							<div>Status</div>
							{rubricStats && <div style={{ textAlign: "center" }}>Score</div>}
							<div>Duration</div>
							<div></div>
						</div>

						{/* Data rows */}
						{evaluation.test_cases.map((testCase) => {
							const name = getTestCaseName(testCase.testcase_id);
							const duration = testCase.total_duration_seconds;
							const agentDur = testCase.agent_call_duration_seconds;
							const judgeDur = testCase.judge_call_duration_seconds;
							const ann = getRunAnnotation(testCase.testcase_id);
							const isRegressed = regressedIds.has(testCase.testcase_id);

							return (
								<div
									key={testCase.testcase_id}
									onClick={(event) => handleTestCaseClick(testCase.testcase_id, event)}
									className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
									style={{
										gridTemplateColumns: !isActive
											? (rubricStats ? "32px 1fr 100px 80px 80px 40px" : "32px 1fr 100px 80px 40px")
											: (rubricStats ? "1fr 100px 80px 80px 40px" : "1fr 100px 80px 40px"),
										padding: "16px 8px", cursor: "pointer",
										backgroundColor: selectedTestCases.has(testCase.testcase_id) ? "rgba(88, 166, 255, 0.06)" : undefined,
									}}
								>
									{/* Checkbox column */}
									{!isActive && (
										<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
											onClick={(e) => e.stopPropagation()}>
											<input
												type="checkbox"
												checked={selectedTestCases.has(testCase.testcase_id)}
												onChange={() => toggleTestCase(testCase.testcase_id)}
												style={{ cursor: "pointer", accentColor: "#58a6ff" }}
											/>
										</div>
									)}
									{/* Test case name column */}
									<div style={{ minWidth: 0 }}>
										<div style={{ fontWeight: 500, fontSize: 14, color: "var(--foreground)" }}>{name}</div>
										{testCase.response_from_agent && (
											<div style={{
												fontSize: 12, color: "var(--muted-foreground)", marginTop: 2,
												overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
											}}>
												{testCase.response_from_agent}
											</div>
										)}
									</div>

									{/* Status column */}
									<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
										<span style={{
											fontSize: 11, fontWeight: 500, padding: "2px 10px", borderRadius: 20,
											backgroundColor: testCase.passed ? "rgba(63, 185, 80, 0.12)" : "rgba(248, 81, 73, 0.12)",
											color: testCase.passed ? "#3fb950" : "#f85149",
											border: `1px solid ${testCase.passed ? "rgba(63, 185, 80, 0.3)" : "rgba(248, 81, 73, 0.3)"}`,
										}}>
											{testCase.passed ? "Passed" : "Failed"}
										</span>
									</div>

									{/* Rubric score column (Feature: rubric-evaluation) */}
									{rubricStats && (
										<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
											{testCase.rubric_average_score != null ? (
												<span style={{
													fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums",
													color: testCase.rubric_average_score >= 3.5 ? "#3fb950"
														: testCase.rubric_average_score >= 2.5 ? "#d29922"
														: "#f85149",
												}}>
													{testCase.rubric_average_score.toFixed(1)}<span style={{ fontWeight: 400, color: "var(--muted-foreground)" }}>/5</span>
												</span>
											) : (
												<span style={{ fontSize: 11, color: "var(--muted-foreground)", opacity: 0.5 }}>—</span>
											)}
										</div>
									)}

									{/* Duration column */}
									<div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
										{duration != null && (
											<span style={{
												fontSize: 11, fontFamily: "monospace",
												color: "var(--muted-foreground)",
												display: "flex", alignItems: "center", gap: 4,
											}}>
												<Timer size={12} />
												{duration.toFixed(1)}s
												{agentDur != null && judgeDur != null && (
													<Tooltip withArrow content={`Agent: ${agentDur.toFixed(1)}s · Judge: ${judgeDur.toFixed(1)}s`} relationship="label">
														<span style={{ opacity: 0.5, cursor: "help" }}>
															(a:{agentDur.toFixed(1)}s, j:{judgeDur.toFixed(1)}s)
														</span>
													</Tooltip>
												)}
											</span>
										)}
									</div>

									{/* Annotation indicator column */}
									<div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
										{ann ? (
											<Tooltip withArrow content="Annotated" relationship="label">
												<span><CheckCircle size={14} weight="fill" style={{ color: "#3fb950" }} /></span>
											</Tooltip>
										) : null}
										{isRegressed && (
											<Tooltip withArrow content="Regression: previously passed, now fails" relationship="label">
												<span style={{
													fontSize: 11, padding: "1px 6px", borderRadius: 4,
													backgroundColor: "rgba(248, 81, 73, 0.12)",
													color: "#f85149",
													border: "1px solid rgba(248, 81, 73, 0.25)",
													display: "flex", alignItems: "center", gap: 3,
													fontWeight: 600,
												}}>
													<Warning size={10} />
												</span>
											</Tooltip>
										)}
										{testCase.retry_count != null && testCase.retry_count > 0 && (
											<Tooltip withArrow content={`${testCase.retry_count} retry(ies) due to rate limits`} relationship="label">
												<span style={{
													fontSize: 11, padding: "1px 6px", borderRadius: 4,
													backgroundColor: "rgba(210, 153, 34, 0.12)",
													color: "#d29922",
													border: "1px solid rgba(210, 153, 34, 0.25)",
													display: "flex", alignItems: "center", gap: 3,
												}}>
													<Warning size={10} />
												</span>
											</Tooltip>
										)}
										<CaretRight size={14} style={{ color: "var(--muted-foreground)", opacity: 0.4 }} />
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Empty state */}
			{(!evaluation.test_cases || evaluation.test_cases.length === 0) &&
				evaluation.status !== "failed" &&
				evaluation.status !== "cancelled" && (
					<Card>
						<CardContent className="flex flex-col items-center justify-center py-12">
							{isActive ? (
								<>
									<CircleNotch size={48} className="animate-spin text-primary mb-4" />
									<p className="text-muted-foreground font-medium">
										{evaluation.status === "pending" ? "Preparing evaluation..." : "Evaluation is starting..."}
									</p>
									<p className="text-sm text-muted-foreground mt-2">
										Test results will appear here as they complete
									</p>
								</>
							) : (
								<>
									<Clock size={48} style={{ color: "var(--muted-foreground)", marginBottom: 16 }} />
									<p style={{ color: "var(--muted-foreground)" }}>No test results available yet</p>
								</>
							)}
						</CardContent>
					</Card>
				)}

			{/* Error state */}
			{evaluation.status === "failed" && (
				<div style={{
					padding: "12px 16px", borderRadius: 8,
					backgroundColor: "rgba(248, 81, 73, 0.1)",
					border: "1px solid rgba(248, 81, 73, 0.25)",
					color: "#f85149", fontSize: 13,
				}}>
					This evaluation run failed. Please check the logs for more information.
				</div>
			)}

			{/* Cancelled state */}
			{evaluation.status === "cancelled" && (
				<div style={{
					padding: "12px 16px", borderRadius: 8,
					backgroundColor: "rgba(210, 153, 34, 0.1)",
					border: "1px solid rgba(210, 153, 34, 0.25)",
					color: "#d29922", fontSize: 13,
				}}>
					This evaluation was cancelled. Completed tests: {evaluation.completed_tests} / {evaluation.total_tests}.
				</div>
			)}
		</div>
	);
}
