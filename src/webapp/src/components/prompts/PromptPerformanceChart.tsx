import { useMemo } from "react";
import {
	ComposedChart,
	Area,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	ResponsiveContainer,
	ReferenceLine,
} from "recharts";
import { Box, Flex, Text } from "@radix-ui/themes";
import { ChartLineUp } from "@phosphor-icons/react";

// ─── Constants ──────────────────────────────────────────────────────

const COLOR_PALETTE = [
	"#3fb950",
	"#58a6ff",
	"#bc8cff",
	"#d29922",
	"#f85149",
	"#f0883e",
	"#79c0ff",
	"#56d364",
];

const TOOLTIP_STYLE: React.CSSProperties = {
	background: "rgba(22,27,34,0.95)",
	backdropFilter: "blur(8px)",
	border: "1px solid rgba(48,54,61,0.6)",
	borderRadius: 10,
	color: "var(--foreground)",
	padding: "10px 14px",
	fontSize: 13,
	boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
};

// ─── Types ──────────────────────────────────────────────────────────

interface DatasetInfo {
	id: string;
	name: string;
	testCaseCount: number;
}

interface PromptVersion {
	id: string;
	version: number;
	system_prompt: string;
	notes: string | null;
	is_active: boolean;
	created_at: string;
}

interface ChartPoint {
	evaluationId: string;
	evaluationName: string;
	timestamp: number; // numeric for proper x-axis ordering
	dateLabel: string; // "Feb 9"
	timeLabel: string; // "14:30"
	passRate: number;
	promptVersion: number;
	datasetName: string;
	passed: number;
	total: number;
}

interface Props {
	evaluations: any[];
	prompts: PromptVersion[];
	datasets: DatasetInfo[];
}

// ─── Custom Tooltip ─────────────────────────────────────────────────

function PerformanceTooltip({ active, payload }: any) {
	if (!active || !payload?.[0]) return null;
	const d: ChartPoint = payload[0].payload;
	return (
		<div style={TOOLTIP_STYLE}>
			<div style={{ fontWeight: 600, marginBottom: 4, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
				{d.evaluationName}
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
				<span style={{ color: d.passRate >= 80 ? "#3fb950" : d.passRate >= 50 ? "#d29922" : "#f85149" }}>
					Pass Rate: {d.passRate.toFixed(1)}% ({d.passed}/{d.total})
				</span>
				<span style={{ color: "var(--muted-foreground)" }}>
					{d.dateLabel} at {d.timeLabel}
				</span>
				<span style={{ color: "#bc8cff" }}>
					Prompt v{d.promptVersion}
				</span>
				<span style={{ color: "#79c0ff" }}>
					Dataset: {d.datasetName}
				</span>
			</div>
		</div>
	);
}

// ─── Main Component ─────────────────────────────────────────────────

export function PromptPerformanceChart({ evaluations, prompts, datasets }: Props) {
	const { allPoints, versionsInChart, versionColorMap, versionMarkers } = useMemo(() => {
		// Filter to completed evals with a version
		const completed = evaluations.filter(
			(e: any) => e.status === "completed" && e.prompt_version != null && e.total_tests > 0
		);

		if (completed.length === 0) {
			return { allPoints: [], versionsInChart: [], versionColorMap: {} as Record<number, string>, versionMarkers: [] };
		}

		// Sort chronologically
		const sorted = completed.sort(
			(a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
		);

		// Transform to chart points
		const allPoints: ChartPoint[] = sorted.map((ev: any) => {
			const dt = new Date(ev.created_at);
			return {
				evaluationId: ev.id,
				evaluationName: ev.name || `Eval ${ev.id.slice(0, 6)}`,
				timestamp: dt.getTime(),
				dateLabel: dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
				timeLabel: dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
				passRate: (ev.passed_count / ev.total_tests) * 100,
				promptVersion: ev.prompt_version,
				datasetName: datasets.find((d) => d.id === ev.dataset_id)?.name || ev.dataset_id?.slice(0, 8) || "Unknown",
				passed: ev.passed_count || 0,
				total: ev.total_tests || 0,
			};
		});

		// Unique versions in chart order
		const versionsInChart = Array.from(new Set(allPoints.map((p) => p.promptVersion))).sort((a, b) => a - b);

		// Color assignment
		const versionColorMap: Record<number, string> = {};
		versionsInChart.forEach((v, i) => {
			versionColorMap[v] = COLOR_PALETTE[i % COLOR_PALETTE.length];
		});

		// Version creation markers
		const versionMarkers = prompts
			.filter((p) => versionsInChart.includes(p.version))
			.map((p) => ({
				version: p.version,
				timestamp: new Date(p.created_at).getTime(),
				label: `v${p.version}`,
				notes: p.notes,
			}));

		return { allPoints, versionsInChart, versionColorMap, versionMarkers };
	}, [evaluations, prompts, datasets]);

	// ─── Empty state ────────────────────────────────────────────────
	if (allPoints.length === 0) {
		return (
			<Flex
				align="center"
				justify="center"
				direction="column"
				gap="2"
				py="6"
				style={{
					background: "rgba(22,27,34,0.4)",
					borderRadius: 12,
					border: "1px solid var(--border)",
					minHeight: 200,
				}}
			>
				<ChartLineUp size={32} style={{ color: "var(--muted-foreground)", opacity: 0.5 }} />
				<Text size="2" style={{ color: "var(--muted-foreground)" }}>
					No completed evaluations yet. Run evaluations to see performance trends.
				</Text>
			</Flex>
		);
	}

	// ─── Format x-axis ticks ────────────────────────────────────────
	const formatTimestamp = (ts: number) => {
		const dt = new Date(ts);
		return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	};

	return (
		<Flex direction="column" gap="3">
			{/* Chart */}
			<Box style={{ height: 360, width: "100%" }}>
				<ResponsiveContainer width="100%" height="100%">
					<ComposedChart margin={{ top: 16, right: 24, bottom: 8, left: -12 }}>
						<defs>
							{versionsInChart.map((v) => (
								<linearGradient key={`grad-${v}`} id={`perfGrad-${v}`} x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor={versionColorMap[v]} stopOpacity={0.18} />
									<stop offset="100%" stopColor={versionColorMap[v]} stopOpacity={0} />
								</linearGradient>
							))}
						</defs>

						<CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
						<XAxis
							dataKey="timestamp"
							type="number"
							domain={["dataMin", "dataMax"]}
							scale="time"
							axisLine={false}
							tickLine={false}
							tick={{ fill: "#8b949e", fontSize: 11 }}
							tickFormatter={formatTimestamp}
							allowDuplicatedCategory={false}
						/>
						<YAxis
							domain={[0, 100]}
							axisLine={false}
							tickLine={false}
							tick={{ fill: "#8b949e", fontSize: 11 }}
							tickFormatter={(v: number) => `${v}%`}
						/>

						{/* Version creation markers */}
						{versionMarkers.map((marker) => (
							<ReferenceLine
								key={`ref-${marker.version}`}
								x={marker.timestamp}
								stroke="rgba(139,148,158,0.35)"
								strokeDasharray="4 4"
								label={{
									value: marker.label,
									position: "top",
									fill: "#8b949e",
									fontSize: 11,
									fontWeight: 500,
									offset: 8,
								}}
							/>
						))}

						{/* One Area series per version */}
						{versionsInChart.map((version) => {
							const versionData = allPoints.filter((p) => p.promptVersion === version);
							return (
								<Area
									key={`area-${version}`}
									data={versionData}
									type="monotone"
									dataKey="passRate"
									name={`v${version}`}
									stroke={versionColorMap[version]}
									fill={`url(#perfGrad-${version})`}
									strokeWidth={2}
									dot={{
										r: 4,
										fill: versionColorMap[version],
										stroke: "#0d1117",
										strokeWidth: 2,
									}}
									activeDot={{
										r: 6,
										fill: versionColorMap[version],
										stroke: "#0d1117",
										strokeWidth: 2,
									}}
									connectNulls={false}
									isAnimationActive={true}
									animationDuration={800}
								/>
							);
						})}

						<Tooltip
							content={<PerformanceTooltip />}
							cursor={{ stroke: "rgba(88,166,255,0.15)", strokeWidth: 1 }}
						/>
					</ComposedChart>
				</ResponsiveContainer>
			</Box>

			{/* Legend */}
			<Flex wrap="wrap" gap="3" style={{ paddingLeft: 36 }}>
				{versionsInChart.map((v) => {
					const versionPrompt = prompts.find((p) => p.version === v);
					const versionPoints = allPoints.filter((p) => p.promptVersion === v);
					const avgRate = versionPoints.reduce((sum, p) => sum + p.passRate, 0) / versionPoints.length;
					return (
						<Flex key={`legend-${v}`} align="center" gap="2" style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(48,54,61,0.3)" }}>
							<Box
								style={{
									width: 10,
									height: 10,
									borderRadius: 3,
									background: versionColorMap[v],
									flexShrink: 0,
								}}
							/>
							<Text size="1" weight="bold" style={{ color: "var(--foreground)" }}>
								v{v}
							</Text>
							<Text size="1" style={{ color: "var(--muted-foreground)" }}>
								{avgRate.toFixed(0)}% avg
							</Text>
							<Text size="1" style={{ color: "var(--muted-foreground)" }}>
								·
							</Text>
							<Text size="1" style={{ color: "var(--muted-foreground)" }}>
								{versionPoints.length} eval{versionPoints.length !== 1 ? "s" : ""}
							</Text>
							{versionPrompt?.is_active && (
								<Text size="1" style={{ color: "#3fb950", fontWeight: 500 }}>
									active
								</Text>
							)}
						</Flex>
					);
				})}
			</Flex>
		</Flex>
	);
}
