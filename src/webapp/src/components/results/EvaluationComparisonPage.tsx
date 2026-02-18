/**
 * Evaluation Comparison Page
 *
 * Shows two evaluations side by side, comparing test case results and pass rates.
 * Route: /evaluations/:id1/compare/:id2
 */

import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { CheckCircle, XCircle, CircleNotch, ArrowLeft, CaretRight, CaretDown, Sparkle, ChartBar } from "@phosphor-icons/react";
import {
	RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
	ResponsiveContainer, Tooltip,
} from "recharts";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbDivider,
	BreadcrumbButton,
} from "@fluentui/react-components";
import { Box, Flex, Text } from "@radix-ui/themes";
import { apiClient } from "@/lib/api";

interface CriterionComparison {
	criterion: string;
	avg_a: number | null;
	avg_b: number | null;
	delta: number | null;
}

interface ComparisonData {
	evaluation_a: {
		id: string;
		name: string;
		prompt_version: number | null;
		pass_rate: number;
		created_at: string;
		rubric_avg?: number | null;
	};
	evaluation_b: {
		id: string;
		name: string;
		prompt_version: number | null;
		pass_rate: number;
		created_at: string;
		rubric_avg?: number | null;
	};
	delta_summary: {
		improved: number;
		regressed: number;
		unchanged: number;
		pass_rate_delta: number;
		rubric_delta?: number | null;
	};
	test_cases: Array<{
		testcase_id: string;
		name: string;
		result_a: "passed" | "failed" | null;
		result_b: "passed" | "failed" | null;
		score_a?: number | null;
		score_b?: number | null;
		rubric_detail_a?: Record<string, number> | null;
		rubric_detail_b?: Record<string, number> | null;
		delta: "improved" | "regressed" | "unchanged" | "new" | "removed";
	}>;
	criteria_comparison?: CriterionComparison[];
}

function DeltaBadge({ delta }: { delta: string }) {
	const config: Record<string, { bg: string; color: string; label: string }> = {
		improved: { bg: "rgba(63, 185, 80, 0.12)", color: "#3fb950", label: "Improved" },
		regressed: { bg: "rgba(248, 81, 73, 0.12)", color: "#f85149", label: "Regressed" },
		unchanged: { bg: "rgba(139, 148, 158, 0.12)", color: "var(--muted-foreground)", label: "Unchanged" },
		new: { bg: "rgba(88, 166, 255, 0.12)", color: "#58a6ff", label: "New" },
		removed: { bg: "rgba(210, 153, 34, 0.12)", color: "#d29922", label: "Removed" },
	};
	const c = config[delta] || config.unchanged;
	return (
		<span style={{
			display: "inline-block",
			padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 500,
			backgroundColor: c.bg, color: c.color, border: `1px solid ${c.color}20`,
		}}>
			{c.label}
		</span>
	);
}

function ResultIcon({ result }: { result: "passed" | "failed" | null }) {
	if (result === "passed") {
		return (
			<div style={{
				width: 28, height: 28, borderRadius: 6,
				display: "flex", alignItems: "center", justifyContent: "center",
				backgroundColor: "rgba(63, 185, 80, 0.12)",
				color: "#3fb950",
			}}>
				<CheckCircle size={16} weight="fill" />
			</div>
		);
	}
	if (result === "failed") {
		return (
			<div style={{
				width: 28, height: 28, borderRadius: 6,
				display: "flex", alignItems: "center", justifyContent: "center",
				backgroundColor: "rgba(248, 81, 73, 0.12)",
				color: "#f85149",
			}}>
				<XCircle size={16} weight="fill" />
			</div>
		);
	}
	return (
		<div style={{
			width: 28, height: 28, borderRadius: 6,
			display: "flex", alignItems: "center", justifyContent: "center",
			backgroundColor: "rgba(139, 148, 158, 0.12)",
			color: "var(--muted-foreground)",
		}}>
			<span style={{ fontSize: 10, fontWeight: 600 }}>—</span>
		</div>
	);
}

/** Parse AI analysis markdown into styled section cards */
function AnalysisSections({ text }: { text: string }) {
	const sectionConfig: Record<string, { accent: string; bg: string; border: string }> = {
		"what improved": { accent: "#3fb950", bg: "rgba(63, 185, 80, 0.06)", border: "rgba(63, 185, 80, 0.2)" },
		"what regressed": { accent: "#f85149", bg: "rgba(248, 81, 73, 0.06)", border: "rgba(248, 81, 73, 0.2)" },
		"still failing": { accent: "#d29922", bg: "rgba(210, 153, 34, 0.06)", border: "rgba(210, 153, 34, 0.2)" },
		"recommendations": { accent: "#58a6ff", bg: "rgba(88, 166, 255, 0.06)", border: "rgba(88, 166, 255, 0.2)" },
	};

	// Split text into sections by ## headers
	const parts = text.split(/^## /gm).filter(Boolean);
	const sections = parts.map(part => {
		const newline = part.indexOf("\n");
		const title = newline > -1 ? part.slice(0, newline).trim() : part.trim();
		const body = newline > -1 ? part.slice(newline + 1).trim() : "";
		return { title, body };
	});

	function renderBody(body: string) {
		const html = body
			.replace(/### (.+)/g, '<div style="font-size:13px;font-weight:600;margin:12px 0 4px;color:var(--foreground)">$1</div>')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/`(.+?)`/g, '<code style="background:rgba(139,148,158,0.15);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
			.replace(/^- (.+)$/gm, '<div style="padding-left:12px;position:relative;margin:3px 0"><span style="position:absolute;left:0">·</span> $1</div>')
			.replace(/^(\d+)\. (.+)$/gm, '<div style="padding-left:16px;position:relative;margin:3px 0"><span style="position:absolute;left:0;color:var(--muted-foreground);font-size:12px">$1.</span> $2</div>')
			.replace(/\n\n/g, '<div style="height:8px"></div>')
			.replace(/\n/g, '<br/>');
		return <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--foreground)" }} dangerouslySetInnerHTML={{ __html: html }} />;
	}

	if (sections.length === 0) return null;

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			{sections.map((section, i) => {
				const key = section.title.toLowerCase();
				const config = Object.entries(sectionConfig).find(([k]) => key.includes(k))?.[1]
					?? { accent: "var(--muted-foreground)", bg: "rgba(139, 148, 158, 0.04)", border: "var(--border)" };
				return (
					<div key={i} style={{
						padding: "14px 16px",
						borderRadius: 8,
						backgroundColor: config.bg,
						borderLeft: `3px solid ${config.accent}`,
					}}>
						<div style={{
							fontSize: 13,
							fontWeight: 600,
							color: config.accent,
							marginBottom: section.body ? 8 : 0,
						}}>
							{section.title}
						</div>
						{section.body && renderBody(section.body)}
					</div>
				);
			})}
		</div>
	);
}

const RADAR_TOOLTIP_STYLE: React.CSSProperties = {
	background: "rgba(22,27,34,0.95)",
	backdropFilter: "blur(8px)",
	border: "1px solid rgba(48,54,61,0.6)",
	borderRadius: 10,
	color: "var(--foreground)",
	padding: "10px 14px",
	fontSize: 13,
	boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
};

function CriteriaTooltip({ active, payload, label }: any) {
	if (!active || !payload?.length) return null;
	const baseline = payload.find((p: any) => p.dataKey === "baseline")?.value;
	const latest = payload.find((p: any) => p.dataKey === "latest")?.value;
	const delta = baseline != null && latest != null ? latest - baseline : null;
	return (
		<div style={RADAR_TOOLTIP_STYLE}>
			<div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
				{baseline != null && (
					<span style={{ color: "#8b949e" }}>Baseline: {baseline.toFixed(1)}/5</span>
				)}
				{latest != null && (
					<span style={{ color: "#58a6ff" }}>Latest: {latest.toFixed(1)}/5</span>
				)}
				{delta != null && (
					<span style={{
						color: delta > 0 ? "#3fb950" : delta < 0 ? "#f85149" : "#8b949e",
						fontWeight: 600,
					}}>
						Δ {delta > 0 ? "+" : ""}{delta.toFixed(1)}
					</span>
				)}
			</div>
		</div>
	);
}

/** Radar chart comparing per-criterion rubric scores between baseline and latest */
function RubricCriteriaChart({ criteria, testCases }: {
	criteria?: CriterionComparison[];
	testCases: ComparisonData["test_cases"];
}) {
	// Use criteria_comparison if available, otherwise build from test case details
	let items = criteria ?? [];
	if (items.length === 0) {
		const agg_a: Record<string, number[]> = {};
		const agg_b: Record<string, number[]> = {};
		for (const tc of testCases) {
			if (tc.rubric_detail_a) {
				for (const [k, v] of Object.entries(tc.rubric_detail_a)) {
					(agg_a[k] ??= []).push(v);
				}
			}
			if (tc.rubric_detail_b) {
				for (const [k, v] of Object.entries(tc.rubric_detail_b)) {
					(agg_b[k] ??= []).push(v);
				}
			}
		}
		const allKeys = [...new Set([...Object.keys(agg_a), ...Object.keys(agg_b)])].sort();
		items = allKeys.map(k => {
			const va = agg_a[k];
			const vb = agg_b[k];
			const avgA = va ? Math.round((va.reduce((s, n) => s + n, 0) / va.length) * 100) / 100 : null;
			const avgB = vb ? Math.round((vb.reduce((s, n) => s + n, 0) / vb.length) * 100) / 100 : null;
			return {
				criterion: k,
				avg_a: avgA,
				avg_b: avgB,
				delta: avgA != null && avgB != null ? Math.round((avgB - avgA) * 100) / 100 : null,
			};
		});
	}

	if (items.length === 0) return null;

	const radarData = items.map(item => ({
		criterion: item.criterion,
		baseline: item.avg_a ?? 0,
		latest: item.avg_b ?? 0,
	}));

	return (
		<Box style={{
			background: "rgba(22,27,34,0.4)",
			borderRadius: 12,
			border: "1px solid var(--border)",
			padding: 20,
		}}>
			<Flex align="center" justify="between" mb="3">
				<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>
					Rubric Criteria Breakdown
				</Text>
				<Flex gap="3">
					<Flex align="center" gap="2" style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(48,54,61,0.3)" }}>
						<Box style={{ width: 10, height: 10, borderRadius: 3, background: "#8b949e", opacity: 0.6 }} />
						<Text size="1" style={{ color: "var(--muted-foreground)" }}>Baseline</Text>
					</Flex>
					<Flex align="center" gap="2" style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(48,54,61,0.3)" }}>
						<Box style={{ width: 10, height: 10, borderRadius: 3, background: "#58a6ff" }} />
						<Text size="1" style={{ color: "var(--muted-foreground)" }}>Latest</Text>
					</Flex>
				</Flex>
			</Flex>

			<Flex align="center" gap="4">
				{/* Radar chart */}
				<Box style={{ flex: "1 1 0", minWidth: 0 }}>
					<ResponsiveContainer width="100%" height={300}>
						<RadarChart data={radarData} outerRadius="75%">
							<defs>
								<linearGradient id="radarGradBaseline" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor="#8b949e" stopOpacity={0.15} />
									<stop offset="100%" stopColor="#8b949e" stopOpacity={0.03} />
								</linearGradient>
								<linearGradient id="radarGradLatest" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor="#58a6ff" stopOpacity={0.2} />
									<stop offset="100%" stopColor="#58a6ff" stopOpacity={0.03} />
								</linearGradient>
							</defs>
							<PolarGrid stroke="rgba(48,54,61,0.5)" />
							<PolarAngleAxis
								dataKey="criterion"
								tick={{ fill: "#8b949e", fontSize: 11 }}
							/>
							<PolarRadiusAxis
								domain={[0, 5]}
								tickCount={6}
								tick={{ fill: "#8b949e", fontSize: 9 }}
								axisLine={false}
							/>
							<Radar
								name="Baseline"
								dataKey="baseline"
								stroke="#8b949e"
								fill="url(#radarGradBaseline)"
								strokeWidth={1.5}
								dot={{ r: 3, fill: "#8b949e", stroke: "#0d1117", strokeWidth: 1.5 }}
								isAnimationActive={true}
								animationDuration={600}
							/>
							<Radar
								name="Latest"
								dataKey="latest"
								stroke="#58a6ff"
								fill="url(#radarGradLatest)"
								strokeWidth={2}
								dot={{ r: 3.5, fill: "#58a6ff", stroke: "#0d1117", strokeWidth: 1.5 }}
								isAnimationActive={true}
								animationDuration={800}
							/>
							<Tooltip content={<CriteriaTooltip />} />
						</RadarChart>
					</ResponsiveContainer>
				</Box>

				{/* Score details sidebar */}
				<Flex direction="column" gap="2" style={{ width: 210, flexShrink: 0 }}>
					{items.map((item, i) => {
						const deltaColor = item.delta != null
							? (item.delta > 0 ? "#3fb950" : item.delta < 0 ? "#f85149" : "#8b949e")
							: "#8b949e";
						return (
							<Flex key={i} direction="column" gap="1" style={{
								padding: "8px 10px",
								borderRadius: 6,
								background: "rgba(48,54,61,0.3)",
								borderLeft: `2px solid ${deltaColor}`,
							}}>
								<Text size="1" weight="bold" style={{ color: "var(--foreground)" }}>
									{item.criterion}
								</Text>
								<Flex align="center" gap="2">
									<Text size="1" style={{ color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" }}>
										{item.avg_a != null ? item.avg_a.toFixed(1) : "—"} → {item.avg_b != null ? item.avg_b.toFixed(1) : "—"}
									</Text>
									{item.delta != null && (
										<Text size="1" weight="bold" style={{ color: deltaColor, fontVariantNumeric: "tabular-nums" }}>
											{item.delta > 0 ? "+" : ""}{item.delta.toFixed(1)}
										</Text>
									)}
								</Flex>
							</Flex>
						);
					})}
				</Flex>
			</Flex>
		</Box>
	);
}

export function EvaluationComparisonPage() {
	const { id1, id2 } = useParams<{ id1: string; id2: string }>();
	const navigate = useNavigate();
	const [comparison, setComparison] = useState<ComparisonData | null>(null);
	const [agentIds, setAgentIds] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [explanation, setExplanation] = useState<string | null>(null);
	const [explainLoading, setExplainLoading] = useState(false);
	const [explainError, setExplainError] = useState<string | null>(null);
	const [analysisCollapsed, setAnalysisCollapsed] = useState(false);

	useEffect(() => {
		const fetchComparison = async () => {
			if (!id1 || !id2) return;
			try {
				setLoading(true);
				setError(null);
				const [data, evalA, evalB] = await Promise.all([
					apiClient.compareEvaluations(id1, id2),
					apiClient.getEvaluation(id1).catch(() => null),
					apiClient.getEvaluation(id2).catch(() => null),
				]);
				setComparison(data);
				setAgentIds({
					a: evalA?.agent_id ?? null,
					b: evalB?.agent_id ?? null,
				});
			} catch (err) {
				console.error("Failed to compare evaluations:", err);
				setError(err instanceof Error ? err.message : "Failed to load comparison");
			} finally {
				setLoading(false);
			}
		};
		fetchComparison();
	}, [id1, id2]);

	const handleExplain = async () => {
		if (!id1 || !id2) return;
		try {
			setExplainLoading(true);
			setExplainError(null);
			const data = await apiClient.explainComparison(id1, id2);
			setExplanation(data.explanation);
		} catch (err) {
			setExplainError(err instanceof Error ? err.message : "Failed to generate explanation");
		} finally {
			setExplainLoading(false);
		}
	};

	// All hooks must be called before any early returns (Rules of Hooks)
	const testCases = comparison?.test_cases ?? [];
	const evalA = comparison?.evaluation_a;
	const evalB = comparison?.evaluation_b;
	const delta = comparison?.delta_summary;
	const hasRubric = (evalA?.rubric_avg != null || evalB?.rubric_avg != null || testCases.some(tc => tc.score_a != null || tc.score_b != null));

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<CircleNotch size={48} className="animate-spin text-primary mb-4" />
				<p className="text-muted-foreground">Loading evaluation comparison...</p>
			</div>
		);
	}

	if (error || !comparison || !evalA || !evalB || !delta) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<h2 className="text-2xl font-bold mb-2">Comparison Failed</h2>
				<p className="text-muted-foreground mb-6">
					{error || "Could not load the evaluation comparison."}
				</p>
				<button
					onClick={() => navigate("/agents")}
					style={{
						padding: "8px 16px",
						borderRadius: 6,
						border: "1px solid var(--border)",
						backgroundColor: "var(--card)",
						color: "var(--foreground)",
						cursor: "pointer",
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<ArrowLeft size={18} />
					Back to Agents
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<Breadcrumb aria-label="Comparison navigation" className="mb-3">
					<BreadcrumbItem>
						<BreadcrumbButton onClick={() => navigate("/agents")}>Agents</BreadcrumbButton>
					</BreadcrumbItem>
					<BreadcrumbDivider />
					<BreadcrumbItem>
						<BreadcrumbButton current>Compare Evaluations</BreadcrumbButton>
					</BreadcrumbItem>
				</Breadcrumb>

				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<button
						onClick={() => navigate(-1)}
						style={{
							background: "none",
							border: "none",
							cursor: "pointer",
							display: "flex",
							alignItems: "center",
							color: "var(--muted-foreground)",
							padding: 0,
						}}
					>
						<ArrowLeft size={20} />
					</button>
					<h1 className="text-2xl font-bold">Compare Evaluations</h1>
				</div>
			</div>

			{/* Two-column eval summary cards */}
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
				{/* Eval A */}
				<div style={{
					padding: 16,
					borderRadius: 10,
					border: "1px solid var(--border)",
					backgroundColor: "var(--card)",
				}}>
					<div style={{ marginBottom: 12 }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
							<h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)", margin: 0 }}>
								Baseline
							</h2>
							<span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(139, 148, 158, 0.15)", color: "var(--muted-foreground)" }}>older</span>
						</div>
						<p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
							{new Date(evalA.created_at).toLocaleString()}
						</p>
					</div>
					<div style={{ marginBottom: 12 }}>
						<p style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>
							{evalA.name}
						</p>
					</div>
					{evalA.prompt_version != null && (
						<div style={{ marginBottom: 12 }}>
							<span
								onClick={(e) => { e.stopPropagation(); if (agentIds.a) navigate(`/agents/${agentIds.a}/prompts?tab=history&version=${evalA.prompt_version}`); }}
								style={{
									fontSize: 12,
									padding: "2px 8px",
									borderRadius: 4,
									backgroundColor: "rgba(88, 166, 255, 0.12)",
									color: "#58a6ff",
									border: "1px solid rgba(88, 166, 255, 0.25)",
									cursor: agentIds.a ? "pointer" : "default",
									transition: "background-color 0.15s",
								}}
								onMouseEnter={(e) => agentIds.a && (e.currentTarget.style.backgroundColor = "rgba(88, 166, 255, 0.25)")}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "rgba(88, 166, 255, 0.12)")}
								title={agentIds.a ? "Open in Prompt Lab → History v" + evalA.prompt_version : undefined}
							>
								Prompt v{evalA.prompt_version}
							</span>
						</div>
					)}
					<div style={{ display: "flex", gap: 12 }}>
						<div style={{
							flex: 1,
							padding: 12,
							borderRadius: 8,
							backgroundColor: "rgba(63, 185, 80, 0.08)",
							border: "1px solid rgba(63, 185, 80, 0.15)",
						}}>
							<div style={{ fontSize: 24, fontWeight: 700, color: "#3fb950" }}>
								{evalA.pass_rate}%
							</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
								Pass Rate
							</div>
						</div>
						{hasRubric && (
							<div style={{
								flex: 1,
								padding: 12,
								borderRadius: 8,
								backgroundColor: "rgba(88, 166, 255, 0.08)",
								border: "1px solid rgba(88, 166, 255, 0.15)",
							}}>
								<div style={{
									fontSize: 24, fontWeight: 700,
									color: evalA.rubric_avg != null
										? (evalA.rubric_avg >= 3.5 ? "#3fb950" : evalA.rubric_avg >= 2.5 ? "#d29922" : "#f85149")
										: "var(--muted-foreground)",
								}}>
									{evalA.rubric_avg != null ? (
										<>{evalA.rubric_avg.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 400, color: "var(--muted-foreground)" }}>/5</span></>
									) : "—"}
								</div>
								<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
									<ChartBar size={12} /> Rubric Avg
								</div>
							</div>
						)}
					</div>
				</div>

				{/* Eval B */}
				<div style={{
					padding: 16,
					borderRadius: 10,
					border: "1px solid var(--border)",
					backgroundColor: "var(--card)",
				}}>
					<div style={{ marginBottom: 12 }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
							<h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)", margin: 0 }}>
								Latest
							</h2>
							<span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(88, 166, 255, 0.15)", color: "#58a6ff" }}>newer</span>
						</div>
						<p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
							{new Date(evalB.created_at).toLocaleString()}
						</p>
					</div>
					<div style={{ marginBottom: 12 }}>
						<p style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>
							{evalB.name}
						</p>
					</div>
					{evalB.prompt_version != null && (
						<div style={{ marginBottom: 12 }}>
							<span
								onClick={(e) => { e.stopPropagation(); if (agentIds.b) navigate(`/agents/${agentIds.b}/prompts?tab=history&version=${evalB.prompt_version}`); }}
								style={{
									fontSize: 12,
									padding: "2px 8px",
									borderRadius: 4,
									backgroundColor: "rgba(88, 166, 255, 0.12)",
									color: "#58a6ff",
									border: "1px solid rgba(88, 166, 255, 0.25)",
									cursor: agentIds.b ? "pointer" : "default",
									transition: "background-color 0.15s",
								}}
								onMouseEnter={(e) => agentIds.b && (e.currentTarget.style.backgroundColor = "rgba(88, 166, 255, 0.25)")}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "rgba(88, 166, 255, 0.12)")}
								title={agentIds.b ? "Open in Prompt Lab → History v" + evalB.prompt_version : undefined}
							>
								Prompt v{evalB.prompt_version}
							</span>
						</div>
					)}
					<div style={{ display: "flex", gap: 12 }}>
						<div style={{
							flex: 1,
							padding: 12,
							borderRadius: 8,
							backgroundColor: "rgba(63, 185, 80, 0.08)",
							border: "1px solid rgba(63, 185, 80, 0.15)",
						}}>
							<div style={{ fontSize: 24, fontWeight: 700, color: "#3fb950" }}>
								{evalB.pass_rate}%
							</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
								Pass Rate
							</div>
						</div>
						{hasRubric && (
							<div style={{
								flex: 1,
								padding: 12,
								borderRadius: 8,
								backgroundColor: "rgba(88, 166, 255, 0.08)",
								border: "1px solid rgba(88, 166, 255, 0.15)",
							}}>
								<div style={{
									fontSize: 24, fontWeight: 700,
									color: evalB.rubric_avg != null
										? (evalB.rubric_avg >= 3.5 ? "#3fb950" : evalB.rubric_avg >= 2.5 ? "#d29922" : "#f85149")
										: "var(--muted-foreground)",
								}}>
									{evalB.rubric_avg != null ? (
										<>{evalB.rubric_avg.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 400, color: "var(--muted-foreground)" }}>/5</span></>
									) : "—"}
								</div>
								<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
									<ChartBar size={12} /> Rubric Avg
								</div>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Delta Summary Bar */}
			<div style={{
				padding: 16,
				borderRadius: 10,
				border: "1px solid var(--border)",
				backgroundColor: "var(--card)",
			}}>
				<h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)", marginBottom: 12 }}>
					Change Summary
				</h2>
				<div style={{
					display: "grid",
					gridTemplateColumns: hasRubric ? "repeat(5, 1fr)" : "repeat(4, 1fr)",
					gap: 12,
				}}>
					<div style={{
						padding: 12,
						borderRadius: 8,
						backgroundColor: "rgba(63, 185, 80, 0.08)",
						border: "1px solid rgba(63, 185, 80, 0.15)",
					}}>
						<div style={{ fontSize: 18, fontWeight: 700, color: "#3fb950" }}>
							+{delta.improved}
						</div>
						<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
							Improved
						</div>
					</div>
					<div style={{
						padding: 12,
						borderRadius: 8,
						backgroundColor: "rgba(248, 81, 73, 0.08)",
						border: "1px solid rgba(248, 81, 73, 0.15)",
					}}>
						<div style={{ fontSize: 18, fontWeight: 700, color: "#f85149" }}>
							-{delta.regressed}
						</div>
						<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
							Regressed
						</div>
					</div>
					<div style={{
						padding: 12,
						borderRadius: 8,
						backgroundColor: "rgba(139, 148, 158, 0.08)",
						border: "1px solid rgba(139, 148, 158, 0.15)",
					}}>
						<div style={{ fontSize: 18, fontWeight: 700, color: "var(--muted-foreground)" }}>
							{delta.unchanged}
						</div>
						<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
							Unchanged
						</div>
					</div>
					<div style={{
						padding: 12,
						borderRadius: 8,
						backgroundColor: delta.pass_rate_delta >= 0
							? "rgba(63, 185, 80, 0.08)"
							: "rgba(248, 81, 73, 0.08)",
						border: delta.pass_rate_delta >= 0
							? "1px solid rgba(63, 185, 80, 0.15)"
							: "1px solid rgba(248, 81, 73, 0.15)",
					}}>
						<div style={{
							fontSize: 18, fontWeight: 700,
							color: delta.pass_rate_delta >= 0 ? "#3fb950" : "#f85149",
						}}>
							{delta.pass_rate_delta >= 0 ? "+" : ""}{delta.pass_rate_delta.toFixed(1)}%
						</div>
						<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4 }}>
							Pass Rate Δ
						</div>
					</div>
					{hasRubric && (
						<div style={{
							padding: 12,
							borderRadius: 8,
							backgroundColor: delta.rubric_delta != null
								? (delta.rubric_delta >= 0 ? "rgba(63, 185, 80, 0.08)" : "rgba(248, 81, 73, 0.08)")
								: "rgba(139, 148, 158, 0.08)",
							border: delta.rubric_delta != null
								? (delta.rubric_delta >= 0 ? "1px solid rgba(63, 185, 80, 0.15)" : "1px solid rgba(248, 81, 73, 0.15)")
								: "1px solid rgba(139, 148, 158, 0.15)",
						}}>
							<div style={{
								fontSize: 18, fontWeight: 700,
								color: delta.rubric_delta != null
									? (delta.rubric_delta >= 0 ? "#3fb950" : "#f85149")
									: "var(--muted-foreground)",
							}}>
								{delta.rubric_delta != null
									? `${delta.rubric_delta >= 0 ? "+" : ""}${delta.rubric_delta.toFixed(1)}`
									: "—"}
							</div>
							<div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
								<ChartBar size={12} /> Rubric Δ
							</div>
						</div>
					)}
				</div>

				{/* Explain button */}
				<div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
					<button
						onClick={handleExplain}
						disabled={explainLoading}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "8px 16px",
							borderRadius: 8,
							border: "1px solid var(--border)",
							backgroundColor: explainLoading ? "var(--secondary)" : "var(--card)",
							color: "var(--foreground)",
							cursor: explainLoading ? "default" : "pointer",
							fontSize: 13,
							fontWeight: 500,
							transition: "all 0.15s",
						}}
						onMouseEnter={(e) => !explainLoading && (e.currentTarget.style.backgroundColor = "var(--secondary)")}
						onMouseLeave={(e) => !explainLoading && (e.currentTarget.style.backgroundColor = "var(--card)")}
					>
						{explainLoading ? (
							<CircleNotch size={16} className="animate-spin" />
						) : (
							<Sparkle size={16} />
						)}
						{explainLoading ? "Analyzing..." : explanation ? "Re-analyze" : "Explain Changes"}
					</button>
					{explainError && (
						<span style={{ fontSize: 12, color: "#f85149" }}>{explainError}</span>
					)}
				</div>
			</div>

			{/* AI Explanation — collapsible */}
			{explanation && (
				<div style={{
					borderRadius: 10,
					border: "1px solid rgba(88, 166, 255, 0.25)",
					backgroundColor: "rgba(88, 166, 255, 0.04)",
					overflow: "hidden",
				}}>
					<button
						onClick={() => setAnalysisCollapsed(!analysisCollapsed)}
						style={{
							width: "100%",
							display: "flex",
							alignItems: "center",
							gap: 8,
							padding: "16px 20px",
							background: "none",
							border: "none",
							cursor: "pointer",
							color: "#58a6ff",
						}}
					>
						<Sparkle size={18} />
						<h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, flex: 1, textAlign: "left" }}>
							AI Analysis
						</h2>
						<CaretDown
							size={16}
							style={{
								transition: "transform 0.2s",
								transform: analysisCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
							}}
						/>
					</button>
					{!analysisCollapsed && (
						<div style={{ padding: "0 16px 16px" }}>
							<AnalysisSections text={explanation} />
						</div>
					)}
				</div>
			)}

			{/* Test Cases Table */}
			{testCases && testCases.length > 0 && (
				<div>
					<h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: "var(--foreground)" }}>
						Test Case Results
					</h2>
					<div style={{ display: "flex", flexDirection: "column", gap: 0, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)" }}>
						{/* Table header */}
						<div style={{
							display: "grid",
							gridTemplateColumns: hasRubric ? "2fr 1fr 0.6fr 1fr 0.6fr 1fr 0.3fr" : "2fr 1fr 1fr 1fr 0.3fr",
							gap: 12,
							padding: "12px 16px",
							backgroundColor: "rgba(139, 148, 158, 0.1)",
							borderBottom: "1px solid var(--border)",
						}}>
							<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>Test Case Name</div>
							<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textAlign: "center" }}>
								Baseline{evalA.prompt_version != null ? ` (v${evalA.prompt_version})` : ""}
							</div>
							{hasRubric && (
								<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textAlign: "center" }}>Score</div>
							)}
							<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textAlign: "center" }}>
								Latest{evalB.prompt_version != null ? ` (v${evalB.prompt_version})` : ""}
							</div>
							{hasRubric && (
								<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textAlign: "center" }}>Score</div>
							)}
							<div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textAlign: "center" }}>Delta</div>
							<div />
						</div>

						{/* Table rows */}
						{testCases.map((tc, index) => {
							const scoreDelta = (tc.score_a != null && tc.score_b != null) ? tc.score_b - tc.score_a : null;
							return (
							<div
								key={tc.testcase_id}
								onClick={() => navigate(`/evaluations/${id1}/testcases/${tc.testcase_id}`)}
								style={{
									display: "grid",
									gridTemplateColumns: hasRubric ? "2fr 1fr 0.6fr 1fr 0.6fr 1fr 0.3fr" : "2fr 1fr 1fr 1fr 0.3fr",
									gap: 12,
									padding: "12px 16px",
									backgroundColor: "var(--card)",
									cursor: "pointer",
									userSelect: "text",
									borderBottom: index < testCases.length - 1 ? "1px solid var(--border)" : undefined,
									transition: "background-color 0.15s",
									alignItems: "center",
								}}
								onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--secondary)")}
								onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--card)")}
							>
								<div style={{ minWidth: 0 }}>
									<div style={{ fontWeight: 500, fontSize: 14, color: "var(--foreground)" }}>
										{tc.name}
									</div>
								</div>
								<div style={{ display: "flex", justifyContent: "center" }}>
									<ResultIcon result={tc.result_a} />
								</div>
								{hasRubric && (
									<div style={{ display: "flex", justifyContent: "center" }}>
										{tc.score_a != null ? (
											<span style={{
												fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums",
												color: tc.score_a >= 3.5 ? "#3fb950" : tc.score_a >= 2.5 ? "#d29922" : "#f85149",
											}}>
												{tc.score_a.toFixed(1)}
											</span>
										) : (
											<span style={{ fontSize: 11, color: "var(--muted-foreground)", opacity: 0.4 }}>—</span>
										)}
									</div>
								)}
								<div style={{ display: "flex", justifyContent: "center" }}>
									<ResultIcon result={tc.result_b} />
								</div>
								{hasRubric && (
									<div style={{ display: "flex", justifyContent: "center" }}>
										{tc.score_b != null ? (
											<span style={{
												fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums",
												color: tc.score_b >= 3.5 ? "#3fb950" : tc.score_b >= 2.5 ? "#d29922" : "#f85149",
											}}>
												{tc.score_b.toFixed(1)}
											</span>
										) : (
											<span style={{ fontSize: 11, color: "var(--muted-foreground)", opacity: 0.4 }}>—</span>
										)}
									</div>
								)}
								<div style={{ display: "flex", justifyContent: "center", gap: 6, alignItems: "center" }}>
									<DeltaBadge delta={tc.delta} />
									{hasRubric && scoreDelta != null && (
										<span style={{
											fontSize: 11, fontWeight: 600,
											color: scoreDelta > 0 ? "#3fb950" : scoreDelta < 0 ? "#f85149" : "var(--muted-foreground)",
										}}>
											{scoreDelta > 0 ? "+" : ""}{scoreDelta.toFixed(1)}
										</span>
									)}
								</div>
								<div style={{ display: "flex", justifyContent: "center" }}>
									<CaretRight size={14} style={{ color: "var(--muted-foreground)", opacity: 0.4 }} />
								</div>
							</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Rubric Criteria Breakdown Chart */}
			{hasRubric && <RubricCriteriaChart criteria={comparison.criteria_comparison} testCases={testCases} />}

			{/* Empty state */}
			{(!testCases || testCases.length === 0) && (
				<div style={{
					padding: "48px 24px",
					borderRadius: 10,
					border: "1px solid var(--border)",
					backgroundColor: "var(--card)",
					textAlign: "center",
				}}>
					<p style={{ color: "var(--muted-foreground)" }}>No test cases to compare</p>
				</div>
			)}
		</div>
	);
}
