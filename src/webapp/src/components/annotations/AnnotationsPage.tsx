/**
 * Annotations Page — 3-column annotation workspace
 *
 * Layout:
 *   Top bar: back + title + stats + progress
 *   Body: left sidebar (test cases) + center content + right annotation panel
 *
 * The right panel keeps annotation controls always visible and close to content,
 * minimising mouse travel during annotation workflows.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
	ArrowLeft,
	CheckCircle,
	XCircle,
	CircleNotch,
	CaretRight,
	CaretDown,
	ChatText,
	ArrowRight,
	Wrench,
	Timer,
	NotePencil,
	Trash,
} from "@phosphor-icons/react";
import { useEvaluation } from "@/hooks/useEvaluation";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useAgents } from "@/hooks/useAgents";

/* ── status colors (CSS variables with 12% opacity) ──────── */
const S = {
	green:     "#3fb950",
	greenBg:   "rgba(63, 185, 80, 0.12)",
	greenBd:   "#3fb950",
	red:       "#f85149",
	redBg:     "rgba(248, 81, 73, 0.12)",
	redBd:     "#f85149",
	blue:      "#58a6ff",
	blueBg:    "rgba(88, 166, 255, 0.12)",
	blueBd:    "#58a6ff",
	amber:     "#d29922",
	amberBg:   "rgba(210, 153, 34, 0.12)",
	amberBd:   "#d29922",
};

/* ── rating scales ──────────────────────────────────────── */
const OUTCOMES = [
	{ value: 5, label: "Yes",    color: S.green, bg: S.greenBg },
	{ value: 4, label: "Mostly", color: S.green, bg: S.greenBg },
	{ value: 3, label: "Partly", color: S.amber, bg: S.amberBg },
	{ value: 2, label: "No",     color: S.red,   bg: S.redBg   },
	{ value: 1, label: "Failed", color: S.red,   bg: S.redBg   },
];
const EFFICIENCY = [
	{ value: "efficient",  color: S.green, bg: S.greenBg },
	{ value: "acceptable", color: S.amber, bg: S.amberBg },
	{ value: "wasteful",   color: S.red,   bg: S.redBg   },
];
const CORRECTNESS = [
	{ value: "correct",    color: S.green, bg: S.greenBg },
	{ value: "acceptable", color: S.amber, bg: S.amberBg },
	{ value: "incorrect",  color: S.red,   bg: S.redBg   },
];
const PARAM_QUALITY = [
	{ value: "good",       color: S.green, bg: S.greenBg },
	{ value: "suboptimal", color: S.amber, bg: S.amberBg },
	{ value: "wrong",      color: S.red,   bg: S.redBg   },
];
const INFO_UTIL = [
	{ value: "good",    color: S.green, bg: S.greenBg },
	{ value: "partial", color: S.amber, bg: S.amberBg },
	{ value: "ignored", color: S.red,   bg: S.redBg   },
];

/* ── small components ───────────────────────────────────── */
function Pill({ label, selected, color, bg, onClick }: {
	label: string; selected: boolean; color: string; bg: string; onClick: () => void;
}) {
	return (
		<button onClick={onClick} style={{
			padding: "4px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600,
			cursor: "pointer", transition: "all 0.15s", textTransform: "capitalize",
			border: selected ? `1px solid ${color}` : "1px solid var(--border)",
			background: selected ? bg : "transparent",
			color: selected ? color : "var(--muted-foreground)",
		}}>
			{label}
		</button>
	);
}

function TagChip({ label, selected, onClick }: {
	label: string; selected: boolean; onClick: () => void;
}) {
	return (
		<button onClick={onClick} style={{
			padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 500,
			cursor: "pointer", transition: "all 0.15s",
			border: selected ? `1px solid ${S.amber}` : "1px solid var(--border)",
			background: selected ? S.amberBg : "transparent",
			color: selected ? S.amber : "var(--muted-foreground)",
		}}>
			{label}
		</button>
	);
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════ */
export function AnnotationsPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { evaluation, testCases, loading: evalLoading } = useEvaluation(id, false);
	const {
		summary, issueTags, loading: annLoading,
		saveRunAnnotation, saveActionAnnotation,
		getRunAnnotation, getActionAnnotation,
		deleteRunAnnotation, deleteActionAnnotation, clearAllAnnotations,
	} = useAnnotations(id);
	const { agents } = useAgents();

	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
	const [selectedActionIdx, setSelectedActionIdx] = useState<number | null>(null);
	const [panelTab, setPanelTab] = useState<"run" | "action">("run");
	const [responseExpanded, setResponseExpanded] = useState(true);
	const [showClearConfirm, setShowClearConfirm] = useState(false);
	const [statusFilter, setStatusFilter] = useState<"all" | "passed" | "failed">("all");

	const agent = evaluation ? agents.find((a) => a.id === evaluation.agent_id) : null;

	// Auto-select first test case when evaluation loads
	useEffect(() => {
		if (evaluation && evaluation.test_cases.length > 0 && !selectedRunId) {
			setSelectedRunId(evaluation.test_cases[0].testcase_id);
		}
	}, [evaluation, selectedRunId]);

	const selectedTestCase = useMemo(
		() => evaluation?.test_cases.find((tc) => tc.testcase_id === selectedRunId),
		[evaluation, selectedRunId]
	);
	const selectedTestCaseDef = useMemo(
		() => testCases.find((tc) => tc.id === selectedRunId),
		[testCases, selectedRunId]
	);

	const runAnn = selectedRunId ? getRunAnnotation(selectedRunId) : null;
	const actionAnn = selectedRunId && selectedActionIdx !== null
		? getActionAnnotation(selectedRunId, selectedActionIdx) : null;

	const loading = evalLoading || annLoading;

	/* ── derived ──────────────────────────────────────── */
	const annotatedCount = summary?.annotated_runs ?? 0;
	const totalCount = summary?.total_runs ?? 0;
	const progressPct = totalCount > 0 ? Math.round((annotatedCount / totalCount) * 100) : 0;

	const passedCount = useMemo(() =>
		evaluation?.test_cases.filter((tc) => tc.passed).length ?? 0,
		[evaluation]
	);
	const failedCount = useMemo(() =>
		evaluation?.test_cases.filter((tc) => !tc.passed).length ?? 0,
		[evaluation]
	);

	const filteredTestCases = useMemo(() => {
		if (!evaluation) return [];
		return evaluation.test_cases.filter((tc) => {
			if (statusFilter === "passed") return tc.passed;
			if (statusFilter === "failed") return !tc.passed;
			return true;
		});
	}, [evaluation, statusFilter]);

	/* ── handlers ──────────────────────────────────────── */
	const handleRunField = async (field: string, value: any) => {
		if (!selectedRunId) return;
		const current = runAnn || { issues: [] };
		await saveRunAnnotation(selectedRunId, { ...current, [field]: value });
	};
	const toggleIssue = async (tag: string) => {
		if (!selectedRunId) return;
		const current = runAnn || { issues: [] as string[] };
		const issues: string[] = current.issues?.includes(tag)
			? current.issues.filter((t: string) => t !== tag)
			: [...(current.issues || []), tag];
		await saveRunAnnotation(selectedRunId, { ...current, issues });
	};
	const handleActionField = async (field: string, value: any) => {
		if (!selectedRunId || selectedActionIdx === null) return;
		const current = actionAnn || { error_contributor: false };
		await saveActionAnnotation(selectedRunId, selectedActionIdx, { ...current, [field]: value });
	};

	const goNext = () => {
		if (!filteredTestCases.length) return;
		const currentIdx = filteredTestCases.findIndex((tc) => tc.testcase_id === selectedRunId);
		// Try to find next unannotated within the filtered list
		for (let i = 1; i <= filteredTestCases.length; i++) {
			const nextIdx = (currentIdx + i) % filteredTestCases.length;
			const tc = filteredTestCases[nextIdx];
			if (!getRunAnnotation(tc.testcase_id)) {
				setSelectedRunId(tc.testcase_id);
				setSelectedActionIdx(0);
				setPanelTab("run");
				setResponseExpanded(true);
				return;
			}
		}
		// All annotated — just go to next in filtered list
		if (currentIdx < filteredTestCases.length - 1) {
			const tc = filteredTestCases[currentIdx + 1];
			setSelectedRunId(tc.testcase_id);
			setSelectedActionIdx(0);
			setPanelTab("run");
			setResponseExpanded(true);
		}
	};

	/* ── navigate test cases by index (keyboard / scroll) ── */
	const listRef = useRef<HTMLDivElement>(null);

	const selectByIndex = useCallback((idx: number) => {
		if (!filteredTestCases.length) return;
		const clamped = Math.max(0, Math.min(idx, filteredTestCases.length - 1));
		const tc = filteredTestCases[clamped];
		setSelectedRunId(tc.testcase_id);
		setSelectedActionIdx(0);
		setPanelTab("run");
		setResponseExpanded(true);
		// Scroll the selected item into view
		requestAnimationFrame(() => {
			listRef.current
				?.querySelectorAll<HTMLElement>(":scope > div")
				?.[clamped]
				?.scrollIntoView({ block: "nearest" });
		});
	}, [filteredTestCases]);

	// Arrow Up / Down to navigate the test case list
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// Don't hijack arrows when the user is typing in an input/textarea
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			if (!filteredTestCases.length) return;

			const currentIdx = filteredTestCases.findIndex((tc) => tc.testcase_id === selectedRunId);
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				const next = e.key === "ArrowUp" ? currentIdx - 1 : currentIdx + 1;
				selectByIndex(next);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [filteredTestCases, selectedRunId, selectByIndex]);

	// Mouse scroll on sidebar selects prev / next test case
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			if (!filteredTestCases.length) return;
			const currentIdx = filteredTestCases.findIndex((tc) => tc.testcase_id === selectedRunId);
			const next = e.deltaY > 0 ? currentIdx + 1 : currentIdx - 1;
			selectByIndex(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [filteredTestCases, selectedRunId, selectByIndex]);

	/* ── loading / empty ───────────────────────────────── */
	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<CircleNotch size={48} className="animate-spin text-primary mb-4" />
				<p className="text-muted-foreground">Loading annotations...</p>
			</div>
		);
	}
	if (!evaluation) {
		return (
			<div style={{ textAlign: "center", paddingTop: 80, color: "var(--muted-foreground)" }}>
				Evaluation not found
			</div>
		);
	}

	/* ═══════════════════════════════════════════════════════
	   RENDER
	   ═══════════════════════════════════════════════════════ */
	return (
		<div style={{
			height: "100vh", display: "flex", flexDirection: "column",
			color: "var(--foreground)",
		}}>

			{/* ═══ TOP BAR ═══ */}
			<div style={{
				padding: "12px 24px",
				borderBottom: "1px solid var(--border)",
				flexShrink: 0,
				display: "flex", alignItems: "center", gap: 16,
			}}>
				<button
					onClick={() => navigate(-1)}
					style={{
						background: "none", border: "none", cursor: "pointer",
						color: "var(--muted-foreground)", display: "flex", alignItems: "center",
						gap: 6, fontSize: 13, padding: "4px 8px", borderRadius: 6,
					}}
					onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--secondary)")}
					onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
				>
					<ArrowLeft size={15} /> Back
				</button>

				<div style={{ width: 1, height: 20, background: "var(--border)" }} />

				<div style={{ fontSize: 15, fontWeight: 600 }}>
					{evaluation.name || "Evaluation"}
					{agent && (
						<span style={{ fontWeight: 400, fontSize: 13, color: "var(--muted-foreground)", marginLeft: 8 }}>
							· {agent.name}
						</span>
					)}
				</div>

				<div style={{ flex: 1 }} />

				{/* inline stats */}
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
						<span style={{ fontWeight: 600, color: S.green }}>{passedCount}</span> passed
					</span>
					<span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
						<span style={{ fontWeight: 600, color: S.red }}>{failedCount}</span> failed
					</span>
				</div>

				<div style={{ width: 1, height: 20, background: "var(--border)" }} />

				{/* progress */}
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<span style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
						{annotatedCount}/{totalCount}
					</span>
					<div style={{ width: 100, height: 6, borderRadius: 3, background: "var(--secondary)", overflow: "hidden" }}>
						<div style={{
							width: `${progressPct}%`, height: "100%", borderRadius: 3,
							background: progressPct === 100 ? S.green : S.blue,
							transition: "width 0.3s",
						}} />
					</div>
					<span style={{
						fontSize: 13, fontWeight: 700,
						color: progressPct === 100 ? S.green : S.blue,
					}}>
						{progressPct}%
					</span>
				</div>

				{/* Clear all button */}
				{annotatedCount > 0 && (
					<div style={{ position: "relative" }}>
						<button
							onClick={() => setShowClearConfirm(true)}
							style={{
								display: "flex", alignItems: "center", gap: 6,
								padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500,
								cursor: "pointer", border: `1px solid ${S.red}`,
								background: "transparent", color: S.red,
								transition: "all 0.15s",
							}}
							onMouseEnter={(e) => { e.currentTarget.style.background = S.redBg; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
						>
							<Trash size={13} /> Clear All
						</button>

						{showClearConfirm && (
							<div style={{
								position: "absolute", top: "calc(100% + 8px)", right: 0,
								padding: "16px 20px", borderRadius: 10, zIndex: 100,
								background: "var(--card)", border: "1px solid var(--border)",
								boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
								minWidth: 260,
							}}>
								<div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
									Clear all annotations?
								</div>
								<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 14, lineHeight: 1.5 }}>
									This will permanently remove all {annotatedCount} annotation{annotatedCount !== 1 ? "s" : ""} for this evaluation.
								</div>
								<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
									<button onClick={() => setShowClearConfirm(false)} style={{
										padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 500,
										cursor: "pointer", border: "1px solid var(--border)",
										background: "var(--secondary)", color: "var(--foreground)",
									}}>
										Cancel
									</button>
									<button onClick={async () => {
										await clearAllAnnotations();
										setShowClearConfirm(false);
									}} style={{
										padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
										cursor: "pointer", border: `1px solid ${S.red}`,
										background: S.red, color: "#fff",
									}}>
										Clear All
									</button>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* ═══ BODY: 3-column layout ═══ */}
			<div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>

				{/* ── COL 1: TEST CASE LIST ────────────────── */}
				<div style={{
					width: 280, flexShrink: 0,
					borderRight: "1px solid var(--border)",
					display: "flex", flexDirection: "column",
					minHeight: 0,
				}}>
					{/* sidebar header — pinned */}
					<div style={{
						padding: "10px 12px",
						borderBottom: "1px solid var(--border)",
						flexShrink: 0,
					}}>
						<div style={{
							fontSize: 12, fontWeight: 600,
							color: "var(--muted-foreground)",
							display: "flex", alignItems: "center", justifyContent: "space-between",
							marginBottom: 8,
						}}>
							<span>Test Cases</span>
							<span style={{ fontWeight: 400 }}>{filteredTestCases.length}/{evaluation.test_cases.length}</span>
						</div>
						<div style={{ display: "flex", gap: 4 }}>
							{([
								{ key: "all" as const, label: "All", color: S.blue, bg: S.blueBg },
								{ key: "passed" as const, label: `✓ ${passedCount}`, color: S.green, bg: S.greenBg },
								{ key: "failed" as const, label: `✗ ${failedCount}`, color: S.red, bg: S.redBg },
							]).map(({ key, label, color, bg }) => {
								const active = statusFilter === key;
								return (
									<button key={key} onClick={() => setStatusFilter(key)} style={{
										padding: "2px 10px", borderRadius: 12, fontSize: 11, fontWeight: 500,
										cursor: "pointer", transition: "all 0.15s", border: "1px solid",
										borderColor: active ? color : "var(--border)",
										background: active ? bg : "transparent",
										color: active ? color : "var(--muted-foreground)",
									}}>
										{label}
									</button>
								);
							})}
						</div>
					</div>

					{/* scrollable test case list */}
					<div ref={listRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
					{filteredTestCases.map((tc, index) => {
						const tcDef = testCases.find((t) => t.id === tc.testcase_id);
						const ann = getRunAnnotation(tc.testcase_id);
						const isSel = selectedRunId === tc.testcase_id;
						return (
							<div key={tc.testcase_id}
								onClick={() => {
									setSelectedRunId(tc.testcase_id);
									setSelectedActionIdx(0);
									setPanelTab("run");
									setResponseExpanded(true);
								}}
								style={{
									display: "flex", alignItems: "center", gap: 12,
									padding: "12px 16px",
									cursor: "pointer",
									borderBottom: index < filteredTestCases.length - 1 ? "1px solid var(--border)" : undefined,
									transition: "background-color 0.15s",
									backgroundColor: isSel ? "var(--secondary)" : "var(--card)",
									borderLeft: isSel ? `2px solid ${S.blue}` : "2px solid transparent",
								}}
								onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.backgroundColor = "var(--secondary)"; }}
								onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.backgroundColor = "var(--card)"; }}
							>
								{/* pass/fail icon — same 28px box as EvaluationResultsPage */}
								<div style={{
									width: 28, height: 28, borderRadius: 6,
									display: "flex", alignItems: "center", justifyContent: "center",
									backgroundColor: tc.passed ? S.greenBg : S.redBg,
									color: tc.passed ? S.green : S.red,
									flexShrink: 0,
								}}>
									{tc.passed
										? <CheckCircle size={16} weight="fill" />
										: <XCircle size={16} weight="fill" />
									}
								</div>

								{/* test info */}
								<div style={{ flex: 1, minWidth: 0 }}>
									<div style={{
										fontWeight: 500, fontSize: 13, color: "var(--foreground)",
										overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
									}}>
										{tcDef?.name || tc.testcase_id}
									</div>
									<div style={{
										display: "flex", alignItems: "center", gap: 8,
										fontSize: 12, color: "var(--muted-foreground)", marginTop: 2,
									}}>
										<span style={{ display: "flex", alignItems: "center", gap: 3 }}>
											<Wrench size={11} /> {tc.actual_tool_calls.length}
										</span>
										{tc.total_duration_seconds && (
											<span style={{ display: "flex", alignItems: "center", gap: 3 }}>
												<Timer size={11} /> {tc.total_duration_seconds.toFixed(1)}s
											</span>
										)}
									</div>
								</div>

								{/* annotation indicator — hover shows delete */}
								{ann ? (
									<div
										style={{ position: "relative", flexShrink: 0, width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}
										className="ann-indicator"
									>
										<CheckCircle size={16} weight="fill" style={{ color: S.green }} className="ann-check" />
										<button
											className="ann-delete"
											onClick={(e) => { e.stopPropagation(); deleteRunAnnotation(tc.testcase_id); }}
											title="Delete annotation"
											style={{
												position: "absolute", inset: -2,
												display: "none", alignItems: "center", justifyContent: "center",
												background: S.redBg, border: `1px solid ${S.red}`,
												borderRadius: 6, cursor: "pointer", padding: 0,
												color: S.red,
											}}
										>
											<Trash size={12} />
										</button>
									</div>
								) : (
									<div style={{ width: 16, height: 16, borderRadius: 8, border: "2px solid var(--border)", flexShrink: 0 }} />
								)}
							</div>
						);
					})}
					</div>{/* end scrollable list */}
				</div>

				{/* ── COL 2: CONTENT ───────────────────────── */}
				{selectedRunId && selectedTestCase ? (
					<div style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>

						{/* test case header */}
						<div style={{ marginBottom: 24 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
								<h2 className="text-xl" style={{ fontWeight: 600, margin: 0 }}>
									{selectedTestCaseDef?.name || selectedRunId}
								</h2>
								<span style={{
									display: "inline-flex", alignItems: "center", gap: 4,
									padding: "2px 10px", borderRadius: 20,
									fontSize: 12, fontWeight: 500,
									backgroundColor: selectedTestCase.passed ? S.greenBg : S.redBg,
									color: selectedTestCase.passed ? S.green : S.red,
									border: `1px solid ${selectedTestCase.passed ? S.green : S.red}`,
								}}>
									{selectedTestCase.passed
										? <CheckCircle size={12} weight="fill" />
										: <XCircle size={12} weight="fill" />
									}
									{selectedTestCase.passed ? "Passed" : "Failed"}
								</span>
							</div>
							<div style={{ fontSize: 13, color: "var(--muted-foreground)", display: "flex", alignItems: "center", gap: 12 }}>
								<span style={{ display: "flex", alignItems: "center", gap: 4 }}>
									<Wrench size={13} />
									{selectedTestCase.actual_tool_calls.length} tool calls
								</span>
								{selectedTestCase.total_duration_seconds && (
									<span style={{ display: "flex", alignItems: "center", gap: 4 }}>
										<Timer size={13} />
										{selectedTestCase.total_duration_seconds.toFixed(1)}s
									</span>
								)}
							</div>
							{/* Original task prompt */}
							{selectedTestCaseDef?.input && (
								<div style={{
									marginTop: 12, padding: "10px 14px",
									borderRadius: 8, backgroundColor: "var(--secondary)",
									border: "1px solid var(--border)",
									fontSize: 13, lineHeight: 1.5,
									color: "var(--muted-foreground)",
								}}>
									<span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted-foreground)", opacity: 0.7 }}>
										Task Input
									</span>
									<div style={{ marginTop: 4 }}>
										{selectedTestCaseDef.input}
									</div>
								</div>
							)}
						</div>

						{/* Agent response — collapsible */}
						{selectedTestCase.response_from_agent && (
							<div style={{ marginBottom: 24 }}>
								<button
									onClick={() => setResponseExpanded(!responseExpanded)}
									style={{
										display: "flex", alignItems: "center", gap: 8,
										background: "none", border: "none", cursor: "pointer",
										color: "var(--muted-foreground)", fontSize: 13, fontWeight: 600,
										padding: 0, marginBottom: 8,
									}}
								>
									{responseExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
									<ChatText size={15} /> Agent response
								</button>
								{responseExpanded && (
									<div style={{
										padding: 16, borderRadius: 8,
										backgroundColor: "var(--card)",
										border: "1px solid var(--border)",
										fontSize: 13, color: "var(--muted-foreground)",
										lineHeight: 1.6, whiteSpace: "pre-wrap",
										maxHeight: 300, overflowY: "auto",
										fontFamily: MONO,
									}}>
										{selectedTestCase.response_from_agent}
									</div>
								)}
							</div>
						)}

						{/* Tool calls list */}
						<div>
							<h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 12 }}>
								Tool Calls
							</h3>
							<div style={{
								borderRadius: 10, overflow: "hidden",
								border: "1px solid var(--border)",
							}}>
								{selectedTestCase.actual_tool_calls.map((call, idx) => {
									const aAnn = getActionAnnotation(selectedRunId!, idx);
									const isSel = selectedActionIdx === idx;
									return (
										<div key={idx}
											onClick={() => { setSelectedActionIdx(idx); setPanelTab("action"); }}
											style={{
												display: "flex", alignItems: "center", gap: 12,
												padding: "12px 16px",
												cursor: "pointer",
												transition: "background-color 0.15s",
												backgroundColor: isSel ? "var(--secondary)" : "var(--card)",
												borderBottom: idx < selectedTestCase.actual_tool_calls.length - 1
													? "1px solid var(--border)" : undefined,
												borderLeft: isSel ? `2px solid ${S.blue}` : "2px solid transparent",
											}}
											onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.backgroundColor = "var(--secondary)"; }}
											onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.backgroundColor = isSel ? "var(--secondary)" : "var(--card)"; }}
										>
											{/* step number */}
											<div style={{
												width: 28, height: 28, borderRadius: 6, flexShrink: 0,
												display: "flex", alignItems: "center", justifyContent: "center",
												fontSize: 12, fontWeight: 700,
												backgroundColor: aAnn ? S.greenBg : "var(--secondary)",
												color: aAnn ? S.green : "var(--muted-foreground)",
												border: aAnn ? `1px solid ${S.greenBd}` : "1px solid var(--border)",
											}}>
												{idx + 1}
											</div>

											{/* name + args preview */}
											<div style={{ flex: 1, minWidth: 0 }}>
												<div style={{ fontSize: 13, fontWeight: 500, fontFamily: MONO }}>
													{call.name}
												</div>
												{call.arguments && call.arguments.length > 0 && (
													<div style={{
														fontSize: 12, color: "var(--muted-foreground)", marginTop: 2,
														overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
													}}>
														{call.arguments.map((a: any) => `${a.name}=${JSON.stringify(a.value)}`).join(", ")}
													</div>
												)}
											</div>

											{/* annotation badge */}
											{aAnn?.correctness && (
												<span style={{
													fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 20,
													color: aAnn.correctness === "correct" ? S.green : aAnn.correctness === "incorrect" ? S.red : S.amber,
													backgroundColor: aAnn.correctness === "correct" ? S.greenBg : aAnn.correctness === "incorrect" ? S.redBg : S.amberBg,
													border: `1px solid ${aAnn.correctness === "correct" ? S.green : aAnn.correctness === "incorrect" ? S.red : S.amber}`,
												}}>
													{aAnn.correctness}
												</span>
											)}
											<CaretRight size={14} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} />
										</div>
									);
								})}
							</div>
						</div>

						{/* Selected action detail */}
						{selectedActionIdx !== null && selectedTestCase.actual_tool_calls[selectedActionIdx] && (
							<div style={{ marginTop: 24 }}>
								<h3 style={{
									fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 12,
									display: "flex", alignItems: "center", gap: 8,
								}}>
									<Wrench size={14} />
									{selectedTestCase.actual_tool_calls[selectedActionIdx].name}
									<span style={{ fontWeight: 400, color: "var(--muted-foreground)" }}>— arguments</span>
								</h3>
								<div style={{
									padding: 16, borderRadius: 8,
									backgroundColor: "var(--card)",
									border: "1px solid var(--border)",
									fontSize: 13, color: "var(--muted-foreground)",
									fontFamily: MONO,
									maxHeight: 240, overflowY: "auto", lineHeight: 1.6,
								}}>
									{selectedTestCase.actual_tool_calls[selectedActionIdx].arguments?.length > 0 ? (
										selectedTestCase.actual_tool_calls[selectedActionIdx].arguments.map((a: any, i: number) => (
											<div key={i} style={{ marginBottom: 4 }}>
												<span style={{ color: S.blue }}>{a.name}</span>: {JSON.stringify(a.value)}
											</div>
										))
									) : (
										<span style={{ color: "var(--muted-foreground)" }}>No arguments</span>
									)}
								</div>
							</div>
						)}
					</div>
				) : (
					/* empty state when no test case selected */
					<div style={{
						flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
						color: "var(--muted-foreground)", fontSize: 14,
					}}>
						<div style={{ textAlign: "center" }}>
							<NotePencil size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
							<div>Select a test case to begin annotating</div>
						</div>
					</div>
				)}

				{/* ── COL 3: ANNOTATION PANEL ──────────────── */}
				{selectedRunId && selectedTestCase && (
					<div style={{
						width: 320, flexShrink: 0,
						borderLeft: "1px solid var(--border)",
						backgroundColor: "var(--card)",
						display: "flex", flexDirection: "column",
						overflowY: "auto",
					}}>
						{/* panel header: tab switcher */}
						<div style={{
							padding: "12px 16px",
							borderBottom: "1px solid var(--border)",
							display: "flex", alignItems: "center", gap: 8,
							flexShrink: 0,
						}}>
							{(["run", "action"] as const).map((tab) => (
								<button key={tab} onClick={() => setPanelTab(tab)} style={{
									padding: "4px 16px", borderRadius: 20, fontSize: 12, fontWeight: 600,
									cursor: "pointer", transition: "all 0.15s",
									border: panelTab === tab ? `1px solid ${S.blue}` : "1px solid var(--border)",
									background: panelTab === tab ? S.blueBg : "transparent",
									color: panelTab === tab ? S.blue : "var(--muted-foreground)",
								}}>
									{tab === "run" ? "Run" : "Action"}
								</button>
							))}
							{panelTab === "action" && selectedActionIdx !== null && (
								<span style={{ fontSize: 11, color: "var(--muted-foreground)", fontFamily: MONO, marginLeft: 4 }}>
									#{selectedActionIdx + 1}
								</span>
							)}
						</div>

						{/* panel body: annotation controls */}
						<div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 20 }}>

							{panelTab === "run" ? (
								<>
									{/* Outcome */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Correct?
										</div>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{OUTCOMES.map((o) => (
												<Pill key={o.value} label={o.label} selected={runAnn?.outcome === o.value}
													color={o.color} bg={o.bg} onClick={() => handleRunField("outcome", o.value)} />
											))}
										</div>
									</div>

									{/* Efficiency */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Efficiency
										</div>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{EFFICIENCY.map((e) => (
												<Pill key={e.value} label={e.value} selected={runAnn?.efficiency === e.value}
													color={e.color} bg={e.bg} onClick={() => handleRunField("efficiency", e.value)} />
											))}
										</div>
									</div>

									{/* Issues */}
									{issueTags.length > 0 && (
										<div>
											<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
												Issues
											</div>
											<div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
												{issueTags.map((tag) => (
													<TagChip key={tag} label={tag}
														selected={runAnn?.issues?.includes(tag) || false}
														onClick={() => toggleIssue(tag)} />
												))}
											</div>
										</div>
									)}

									{/* Notes */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Notes
										</div>
										<textarea
											value={runAnn?.notes || ""}
											onChange={(e) => handleRunField("notes", e.target.value)}
											placeholder="Run-level notes..."
											style={{
												width: "100%", minHeight: 80, padding: "10px 12px", borderRadius: 8,
												border: "1px solid var(--border)", background: "var(--secondary)",
												color: "var(--foreground)", fontSize: 13, resize: "vertical",
												outline: "none", fontFamily: "inherit", lineHeight: 1.5,
											}}
											onFocus={(e) => (e.currentTarget.style.borderColor = S.blue)}
											onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
										/>
									</div>
								</>
							) : selectedActionIdx !== null ? (
								<>
									{/* Action context */}
									<div style={{
										padding: "8px 12px", borderRadius: 6,
										backgroundColor: "var(--secondary)", border: "1px solid var(--border)",
										fontSize: 12, fontFamily: MONO, color: "var(--muted-foreground)",
									}}>
										Step {selectedActionIdx + 1}: {selectedTestCase.actual_tool_calls[selectedActionIdx]?.name}
									</div>

									{/* Correctness */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Decision
										</div>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{CORRECTNESS.map((c) => (
												<Pill key={c.value} label={c.value} selected={actionAnn?.correctness === c.value}
													color={c.color} bg={c.bg} onClick={() => handleActionField("correctness", c.value)} />
											))}
										</div>
									</div>

									{/* Param quality */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Parameters
										</div>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{PARAM_QUALITY.map((p) => (
												<Pill key={p.value} label={p.value} selected={actionAnn?.parameter_quality === p.value}
													color={p.color} bg={p.bg} onClick={() => handleActionField("parameter_quality", p.value)} />
											))}
										</div>
									</div>

									{/* Info utilization */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Info Utilization
										</div>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{INFO_UTIL.map((i) => (
												<Pill key={i.value} label={i.value} selected={actionAnn?.info_utilization === i.value}
													color={i.color} bg={i.bg} onClick={() => handleActionField("info_utilization", i.value)} />
											))}
										</div>
									</div>

									{/* Error contributor */}
									<label style={{
										display: "flex", alignItems: "center", gap: 8,
										cursor: "pointer", padding: "8px 12px", borderRadius: 6,
										border: "1px solid var(--border)",
										backgroundColor: actionAnn?.error_contributor ? S.redBg : "transparent",
									}}>
										<input type="checkbox" checked={actionAnn?.error_contributor || false}
											onChange={(e) => handleActionField("error_contributor", e.target.checked)}
											style={{ width: 14, height: 14, accentColor: S.red }} />
										<span style={{ fontSize: 12, fontWeight: 500, color: actionAnn?.error_contributor ? S.red : "var(--muted-foreground)" }}>
											Error contributor
										</span>
									</label>

									{/* Correction notes */}
									<div>
										<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 8 }}>
											Correction
										</div>
										<textarea
											value={actionAnn?.correction || ""}
											onChange={(e) => handleActionField("correction", e.target.value)}
											placeholder="What should it have done instead?"
											style={{
												width: "100%", minHeight: 80, padding: "10px 12px", borderRadius: 8,
												border: "1px solid var(--border)", background: "var(--secondary)",
												color: "var(--foreground)", fontSize: 13, resize: "vertical",
												outline: "none", fontFamily: "inherit", lineHeight: 1.5,
											}}
											onFocus={(e) => (e.currentTarget.style.borderColor = S.blue)}
											onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
										/>
									</div>
								</>
							) : (
								<div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: "12px 0" }}>
									Select a tool call to annotate individual actions.
								</div>
							)}
						</div>

						{/* panel footer: context-aware button */}
						<div style={{
							padding: "12px 16px",
							borderTop: "1px solid var(--border)",
							flexShrink: 0,
							display: "flex", flexDirection: "column", gap: 8,
						}}>
							{/* Delete this annotation */}
							{runAnn && (
								<button onClick={() => { if (selectedRunId) deleteRunAnnotation(selectedRunId); }} style={{
									width: "100%",
									padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 500,
									cursor: "pointer", border: `1px solid ${S.red}`,
									background: "transparent", color: S.red,
									display: "flex", alignItems: "center", justifyContent: "center",
									gap: 6, transition: "all 0.15s",
								}}
									onMouseEnter={(e) => { e.currentTarget.style.background = S.redBg; }}
									onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
								>
									<Trash size={13} /> Delete Annotation
								</button>
							)}
							{/* Next / Change button */}
							<button onClick={goNext} style={{
								width: "100%",
								padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
								cursor: "pointer", border: "1px solid var(--border)",
								background: "var(--secondary)", color: "var(--foreground)",
								display: "flex", alignItems: "center", justifyContent: "center",
								gap: 8, transition: "all 0.15s",
							}}
								onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = S.blueBg; e.currentTarget.style.borderColor = S.blue; e.currentTarget.style.color = S.blue; }}
								onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--secondary)"; e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--foreground)"; }}
							>
								{runAnn
								? (annotatedCount >= totalCount ? "Change Annotation" : "Next unannotated")
								: "Skip to next"
							} <ArrowRight size={14} />
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
