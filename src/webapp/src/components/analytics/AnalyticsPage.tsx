import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Card, Flex, Grid, Text, Badge, Select, ScrollArea, Dialog, Button } from "@radix-ui/themes";
import {
	TrendUp, TrendDown, ChatCircle, Clock, ChartBar,
	Robot, Warning, CheckCircle, Minus, ArrowUpRight, Calendar,
	CaretDown, CaretRight, Trash
} from "@phosphor-icons/react";
import {
	AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
	Tooltip as ReTooltip, ResponsiveContainer, Cell,
} from "recharts";
import { API_BASE_URL } from "../../lib/config";

// ─── Shared styles ──────────────────────────────────────────────────

const TOOLTIP_STYLE = {
	background: "var(--card)",
	backdropFilter: "blur(8px)",
	border: "1px solid var(--border)",
	borderRadius: 10,
	color: "var(--foreground)",
	padding: "10px 14px",
	fontSize: 13,
	boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
};

const CARD_STYLE = { background: "var(--card)", border: "1px solid var(--border)" };
const BAR_COLORS = ["#f85149", "#d29922", "#bc8cff", "#58a6ff", "#3fb950", "#f0883e", "#79c0ff", "#56d364"];

// ─── Stat Card ──────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color }: {
	icon: any; label: string; value: string | number; sub?: string; color: string;
}) {
	return (
		<Card style={CARD_STYLE}>
			<Flex direction="column" gap="1" p="2" px="3">
				<Flex align="center" gap="2">
					<Box style={{ width: 22, height: 22, borderRadius: 5, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
						<Icon size={12} style={{ color }} />
					</Box>
					<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{label}</Text>
				</Flex>
				<Text size="5" weight="bold" style={{ color: "var(--foreground)" }}>{value}</Text>
				{sub && <Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10 }}>{sub}</Text>}
			</Flex>
		</Card>
	);
}

// ─── Section heading ────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text size="4" weight="bold" mb="3" style={{ color: "var(--foreground)", display: "block" }}>
			{children}
		</Text>
	);
}

// ─── Trend badge ────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: string }) {
	const map: Record<string, { color: string; icon: any; label: string }> = {
		improving: { color: "#3fb950", icon: TrendUp, label: "Improving" },
		declining: { color: "#f85149", icon: TrendDown, label: "Declining" },
		stable:    { color: "var(--muted-foreground)", icon: Minus, label: "Stable" },
	};
	const t = map[trend] || map.stable;
	const Icon = t.icon;
	return (
		<Flex align="center" gap="1" style={{ color: t.color, fontSize: 11, fontWeight: 600 }}>
			<Icon size={12} /> {t.label}
		</Flex>
	);
}

// ─── Tab Button ─────────────────────────────────────────────────────

type TabId = "agents" | "evaluations" | "prompts";

function TabButton({ id, active, label, count, onClick }: {
	id: TabId; active: boolean; label: string; count?: number; onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			style={{
				padding: "8px 18px",
				borderRadius: 8,
				border: active ? "1px solid rgba(88,166,255,0.4)" : "1px solid transparent",
				background: active ? "rgba(88,166,255,0.1)" : "transparent",
				color: active ? "#58a6ff" : "var(--muted-foreground)",
				fontSize: 13,
				fontWeight: active ? 600 : 400,
				cursor: "pointer",
				transition: "all 0.15s",
				display: "flex", alignItems: "center", gap: 6,
			}}
		>
			{label}
			{count !== undefined && (
				<span style={{
					fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 10,
					background: active ? "rgba(88,166,255,0.2)" : "var(--secondary)",
					color: active ? "#58a6ff" : "var(--muted-foreground)",
				}}>
					{count}
				</span>
			)}
		</button>
	);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════

export function AnalyticsPage() {
	const navigate = useNavigate();
	const [agents, setAgents] = useState<any[]>([]);
	const [selectedAgent, setSelectedAgent] = useState<string>("all");

	// Time range
	const [timePreset, setTimePreset] = useState<string>("30d");
	const [customFrom, setCustomFrom] = useState<string>("");
	const [customTo, setCustomTo] = useState<string>("");
	const [showCustom, setShowCustom] = useState(false);
	const [appliedFrom, setAppliedFrom] = useState<string>("");
	const [appliedTo, setAppliedTo] = useState<string>("");
	const [resetting, setResetting] = useState(false);

	// Active tab
	const [activeTab, setActiveTab] = useState<TabId>("agents");

	// Build query string
	const timeQuery = useMemo(() => {
		if (timePreset === "custom" && appliedFrom) {
			const parts = [`from_date=${encodeURIComponent(appliedFrom)}`];
			if (appliedTo) parts.push(`to_date=${encodeURIComponent(appliedTo)}`);
			return parts.join("&");
		}
		if (timePreset === "24h") return "hours=24";
		const d = parseInt(timePreset) || 30;
		return `days=${d}`;
	}, [timePreset, appliedFrom, appliedTo]);

	const timeLabel = useMemo(() => {
		const labels: Record<string, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "14d": "Last 14 days", "30d": "Last 30 days", "90d": "Last 90 days" };
		if (timePreset === "custom" && appliedFrom) {
			const f = appliedFrom.replace("T", " ").slice(0, 16);
			const t = appliedTo ? appliedTo.replace("T", " ").slice(0, 16) : "now";
			return `${f} → ${t}`;
		}
		return labels[timePreset] || "Last 30 days";
	}, [timePreset, appliedFrom, appliedTo]);

	// Data slices
	const [stats, setStats] = useState<any>(null);
	const [trends, setTrends] = useState<any[]>([]);
	const [patterns, setPatterns] = useState<any>(null);
	const [perAgent, setPerAgent] = useState<any[]>([]);
	const [promptPerf, setPromptPerf] = useState<any>(null);
	const [testStability, setTestStability] = useState<any>(null);
	const [evalVelocity, setEvalVelocity] = useState<any[]>([]);
	const [loading, setLoading] = useState(true);

	// Progressive disclosure
	const [expandedTests, setExpandedTests] = useState<Set<string>>(new Set());
	const [stabilityFilter, setStabilityFilter] = useState<string>("all");

	// Prompt performance controls
	const [cardSearchQuery, setCardSearchQuery] = useState("");
	const [showAllCards, setShowAllCards] = useState(false);
	const [cardViewMode, setCardViewMode] = useState<"top" | "all" | "improving" | "declining">("top");
	const [groupBy, setGroupBy] = useState<"prompt" | "model">("prompt");
	const [modelPerf, setModelPerf] = useState<any>(null);

	// Agent Comparison table controls
	const [agentTableSearch, setAgentTableSearch] = useState("");
	const [agentTableSort, setAgentTableSort] = useState<{key: string; direction: "asc" | "desc"}>({key: "avg_pass_rate", direction: "desc"});
	const [agentIdToName, setAgentIdToName] = useState<Record<string, string>>({});

	useEffect(() => {
		fetch(`${API_BASE_URL}/agents`).then(r => r.json()).then(data => {
			setAgents(data);
			const mapping: Record<string, string> = {};
			data.forEach((agent: any) => { mapping[agent.id] = agent.name; });
			setAgentIdToName(mapping);
		}).catch(console.error);
	}, []);

	useEffect(() => {
		async function load() {
			setLoading(true);
			const ap = selectedAgent !== "all" ? selectedAgent : undefined;
			const agentPart = ap ? `agent_id=${ap}` : "";
			const timeAndAgent = [agentPart, timeQuery].filter(Boolean).join("&");
			const agentOnly = agentPart;
			const q = timeAndAgent ? `?${timeAndAgent}` : "";
			const aq = agentOnly ? `?${agentOnly}` : "";

			try {
				const [dashR, trendR, patR, agentR, promptR, modelR, stabilityR, velocityR] = await Promise.all([
					fetch(`${API_BASE_URL}/analytics/dashboard${q}`),
					fetch(`${API_BASE_URL}/analytics/trends${q}`),
					fetch(`${API_BASE_URL}/analytics/failure-patterns${aq}`),
					fetch(`${API_BASE_URL}/analytics/per-agent`),
					fetch(`${API_BASE_URL}/analytics/prompt-performance${q}`),
					fetch(`${API_BASE_URL}/analytics/model-performance${q}`),
					fetch(`${API_BASE_URL}/analytics/test-stability${q}`),
					fetch(`${API_BASE_URL}/analytics/eval-velocity${q}`),
				]);
				if (dashR.ok) setStats(await dashR.json());
				if (trendR.ok) setTrends(await trendR.json());
				if (patR.ok) setPatterns(await patR.json());
				if (agentR.ok) setPerAgent(await agentR.json());
				if (promptR.ok) setPromptPerf(await promptR.json());
				if (modelR.ok) setModelPerf(await modelR.json());
				if (stabilityR.ok) setTestStability(await stabilityR.json());
				if (velocityR.ok) setEvalVelocity(await velocityR.json());
			} catch (e) { console.error(e); }
			finally { setLoading(false); }
		}
		load();
	}, [selectedAgent, timeQuery]);

	// ─── Stability helpers ─────────────────────────────────────────
	const filteredStabilityTests = useMemo(() => {
		if (!testStability?.tests) return [];
		if (stabilityFilter === "all") return testStability.tests;
		return testStability.tests.filter((t: any) => t.stability === stabilityFilter);
	}, [testStability, stabilityFilter]);

	const stabilityCounts = useMemo(() => {
		if (!testStability?.tests) return { solid: 0, flaky: 0, broken: 0, total: 0 };
		const tests = testStability.tests;
		return {
			solid: tests.filter((t: any) => t.stability === "solid").length,
			flaky: tests.filter((t: any) => t.stability === "flaky").length,
			broken: tests.filter((t: any) => t.stability === "broken").length,
			total: tests.length,
		};
	}, [testStability]);

	const toggleTestExpand = useCallback((id: string) => {
		setExpandedTests(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		});
	}, []);

	// ─── Prompt / Model performance summaries ──────────────────────
	const agentSummaries = useMemo(() => {
		if (!promptPerf?.agents?.length) return [];
		return promptPerf.agents.map((agent: any) => {
			const allRates: number[] = [];
			const versionSummaries = agent.versions.map((ver: any) => {
				const rates = ver.evals.map((e: any) => e.pass_rate);
				rates.forEach((r: number) => allRates.push(r));
				const avg = rates.length ? Math.round(rates.reduce((a: number, b: number) => a + b, 0) / rates.length * 10) / 10 : 0;
				const best = rates.length ? Math.max(...rates) : 0;
				const latest = rates.length ? rates[rates.length - 1] : 0;
				const trend = rates.length >= 2 ? (rates[rates.length - 1] > rates[0] ? "improving" : rates[rates.length - 1] < rates[0] ? "declining" : "stable") : "stable";
				return { ...ver, rates, avg, best, latest, trend };
			});
			const activeVersion = versionSummaries.find((v: any) => v.is_active) || versionSummaries[versionSummaries.length - 1];
			const firstVersion = versionSummaries[0];
			const delta = activeVersion && firstVersion && versionSummaries.length > 1
				? Math.round((activeVersion.avg - firstVersion.avg) * 10) / 10 : 0;
			const overallTrend = delta > 0 ? "improving" : delta < 0 ? "declining" : "stable";
			return { ...agent, versionSummaries, activeVersion, delta, allRates, overallTrend };
		});
	}, [promptPerf]);

	const agentModelSummaries = useMemo(() => {
		if (!modelPerf?.agents?.length) return [];
		return modelPerf.agents.map((agent: any) => {
			const allRates: number[] = [];
			const modelSummaries = agent.models.map((model: any) => {
				const rates = model.evals.map((e: any) => e.pass_rate);
				rates.forEach((r: number) => allRates.push(r));
				const avg = rates.length ? Math.round(rates.reduce((a: number, b: number) => a + b, 0) / rates.length * 10) / 10 : 0;
				const best = rates.length ? Math.max(...rates) : 0;
				const latest = rates.length ? rates[rates.length - 1] : 0;
				const trend = rates.length >= 2 ? (rates[rates.length - 1] > rates[0] ? "improving" : rates[rates.length - 1] < rates[0] ? "declining" : "stable") : "stable";
				return { ...model, rates, avg, best, latest, trend, isActive: false };
			});
			const latestModel = modelSummaries[modelSummaries.length - 1];
			const firstModel = modelSummaries[0];
			const delta = latestModel && firstModel && modelSummaries.length > 1
				? Math.round((latestModel.avg - firstModel.avg) * 10) / 10 : 0;
			const overallTrend = delta > 0 ? "improving" : delta < 0 ? "declining" : "stable";
			return { ...agent, versionSummaries: modelSummaries, activeVersion: latestModel, delta, allRates, overallTrend };
		});
	}, [modelPerf]);

	const currentSummaries = useMemo(() => groupBy === "prompt" ? agentSummaries : agentModelSummaries, [groupBy, agentSummaries, agentModelSummaries]);

	const searchFiltered = useMemo(() => {
		if (!cardSearchQuery.trim()) return currentSummaries;
		const query = cardSearchQuery.toLowerCase();
		return currentSummaries.filter((a: any) => a.agent_name.toLowerCase().includes(query));
	}, [currentSummaries, cardSearchQuery]);

	const displayedAgents = useMemo(() => {
		let filtered = searchFiltered;
		if (cardViewMode === "improving") filtered = filtered.filter((a: any) => a.delta > 0);
		else if (cardViewMode === "declining") filtered = filtered.filter((a: any) => a.delta < 0);
		else if (cardViewMode === "top") {
			const improving = filtered.filter((a: any) => a.delta > 0).sort((a: any, b: any) => b.delta - a.delta).slice(0, 5);
			const declining = filtered.filter((a: any) => a.delta < 0).sort((a: any, b: any) => a.delta - b.delta).slice(0, 5);
			filtered = [...improving, ...declining].sort((a: any, b: any) => a.agent_name.localeCompare(b.agent_name));
			if (filtered.length === 0) filtered = searchFiltered;
		}
		return filtered;
	}, [searchFiltered, cardViewMode]);

	const cardsToShow = useMemo(() => showAllCards ? displayedAgents : displayedAgents.slice(0, 12), [displayedAgents, showAllCards]);

	// ─── Agent comparison table helpers ────────────────────────────
	const filteredAgents = useMemo(() => {
		if (!perAgent.length) return [];
		let filtered = perAgent;
		if (agentTableSearch.trim()) {
			const query = agentTableSearch.toLowerCase();
			filtered = filtered.filter((a: any) => a.agent_name.toLowerCase().includes(query) || a.model?.toLowerCase().includes(query));
		}
		filtered = [...filtered].sort((a: any, b: any) => {
			const aVal = a[agentTableSort.key];
			const bVal = b[agentTableSort.key];
			const dir = agentTableSort.direction === "asc" ? 1 : -1;
			return typeof aVal === "string" ? aVal.localeCompare(bVal) * dir : (aVal - bVal) * dir;
		});
		return filtered;
	}, [perAgent, agentTableSearch, agentTableSort]);

	const handleResetAllData = useCallback(async () => {
		if (!window.confirm("This will permanently delete ALL agents, datasets, evaluations, annotations, prompts, and proposals. Are you sure?")) return;
		if (!window.confirm("Final confirmation: this action cannot be undone. Proceed?")) return;
		setResetting(true);
		try {
			const res = await fetch(`${API_BASE_URL}/admin/reset`, { method: "DELETE" });
			if (res.ok) {
				const data = await res.json();
				const total = Object.values(data.deleted as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
				alert(`Reset complete. ${total} records deleted across ${Object.keys(data.deleted).length} tables.`);
				window.location.reload();
			} else {
				alert("Reset failed: " + (await res.text()));
			}
		} catch (e) {
			alert("Reset failed: " + e);
		} finally {
			setResetting(false);
		}
	}, []);

	// ═══ RENDER ════════════════════════════════════════════════════════

	return (
		<Box>
			{/* ─── Header ─── */}
			<Flex align="center" justify="between" mb="5">
				<h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
				<Flex gap="3" align="center">
					<Select.Root value={selectedAgent} onValueChange={setSelectedAgent}>
						<Select.Trigger placeholder="All Agents" style={{ minWidth: 180 }} />
						<Select.Content>
							<Select.Item value="all">All Agents</Select.Item>
							{agents.map(a => <Select.Item key={a.id} value={a.id}>{a.name}</Select.Item>)}
						</Select.Content>
					</Select.Root>
					<Select.Root value={timePreset} onValueChange={v => {
						if (v === "custom") { setShowCustom(true); }
						else { setTimePreset(v); setAppliedFrom(""); setAppliedTo(""); }
					}}>
						<Select.Trigger style={{ minWidth: 150 }} />
						<Select.Content>
							<Select.Item value="24h">Last 24 hours</Select.Item>
							<Select.Item value="7d">Last 7 days</Select.Item>
							<Select.Item value="14d">Last 14 days</Select.Item>
							<Select.Item value="30d">Last 30 days</Select.Item>
							<Select.Item value="90d">Last 90 days</Select.Item>
							<Select.Item value="custom">Custom range…</Select.Item>
						</Select.Content>
					</Select.Root>
					{timePreset === "custom" && appliedFrom && (
						<Flex align="center" gap="1" style={{ fontSize: 11, color: "var(--muted-foreground)", background: "var(--accent)", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }} onClick={() => setShowCustom(true)}>
							<Calendar size={12} />
							<span>{timeLabel}</span>
						</Flex>
					)}
					<button
						onClick={handleResetAllData}
						disabled={resetting}
						className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors"
						style={{
							color: "var(--destructive)",
							borderColor: "var(--destructive)",
							opacity: resetting ? 0.5 : 1,
							cursor: resetting ? "not-allowed" : "pointer",
						}}
						title="Delete all data"
					>
						<Trash size={14} />
						{resetting ? "Resetting…" : "Clear All Data"}
					</button>
				</Flex>
			</Flex>

			{/* Custom Range Dialog */}
			<Dialog.Root open={showCustom} onOpenChange={setShowCustom}>
				<Dialog.Content style={{ maxWidth: 400 }}>
					<Dialog.Title>Custom Time Range</Dialog.Title>
					<Dialog.Description size="2" mb="4" style={{ color: "var(--muted-foreground)" }}>
						Pick a start and optional end date/time.
					</Dialog.Description>
					<Flex direction="column" gap="3">
						<label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
							From
							<input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)} style={{
								display: "block", width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6,
								border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", fontSize: 13,
							}} />
						</label>
						<label style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
							To <span style={{ opacity: 0.5 }}>(leave empty for "now")</span>
							<input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)} style={{
								display: "block", width: "100%", marginTop: 4, padding: "8px 10px", borderRadius: 6,
								border: "1px solid var(--border)", background: "var(--card)", color: "var(--foreground)", fontSize: 13,
							}} />
						</label>
					</Flex>
					<Flex gap="3" mt="4" justify="end">
						<Dialog.Close>
							<Button variant="soft" color="gray">Cancel</Button>
						</Dialog.Close>
						<Button disabled={!customFrom} onClick={() => {
							setAppliedFrom(customFrom);
							setAppliedTo(customTo);
							setTimePreset("custom");
							setShowCustom(false);
						}}>Apply</Button>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>

			{/* ═══ KPI + Trend Hero Row ═══ */}
			<div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
				{/* KPIs — compact 2×2 grid */}
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, width: 340, flexShrink: 0 }}>
					<StatCard icon={ChartBar} label="Evaluations" value={stats?.total_evaluations ?? 0} sub={`${stats?.completed_evaluations ?? 0} completed`} color="#58a6ff" />
					<StatCard icon={TrendUp} label="Avg Pass Rate" value={`${stats?.avg_pass_rate ?? 0}%`} sub={stats?.avg_pass_rate >= 70 ? "Healthy" : stats?.avg_pass_rate >= 40 ? "Needs attention" : "Critical"} color="#3fb950" />
					<StatCard icon={Robot} label="Active Agents" value={stats?.total_agents ?? 0} sub={`${perAgent.length} with evals`} color="#bc8cff" />
					<StatCard icon={Warning} label="Failed Evals" value={stats?.failed_evaluations ?? 0} sub={stats?.total_evaluations > 0 ? `${Math.round(((stats?.failed_evaluations ?? 0) / stats.total_evaluations) * 100)}% failure rate` : undefined} color="#f85149" />
				</div>
				{/* Pass Rate Trend — always visible */}
				<Card style={{ ...CARD_STYLE, flex: 1, minWidth: 0 }}>
					<Box p="3">
						<Flex align="center" justify="between" mb="1">
							<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Pass Rate Over Time</Text>
							{trends.length > 0 && <Text size="1" style={{ color: "var(--muted-foreground)" }}>{trends.length} data points</Text>}
						</Flex>
						<Box style={{ height: 152 }}>
							{trends.length > 0 ? (
								<ResponsiveContainer width="100%" height="100%">
									<AreaChart data={trends} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
										<defs>
											<linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
												<stop offset="0%" stopColor="#3fb950" stopOpacity={0.2} />
												<stop offset="100%" stopColor="#3fb950" stopOpacity={0} />
											</linearGradient>
										</defs>
										<CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
										<XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} tickFormatter={v => v.slice(5)} />
										<YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} tickFormatter={v => `${v}%`} />
										<ReTooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: "rgba(88,166,255,0.2)", strokeWidth: 1 }} formatter={(v: number) => [`${v}%`, "Pass Rate"]} />
										<Area type="monotone" dataKey="avg_pass_rate" stroke="#3fb950" fill="url(#trendGrad)" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: "#3fb950", stroke: "#0d1117", strokeWidth: 2 }} />
									</AreaChart>
								</ResponsiveContainer>
							) : (
								<Flex align="center" justify="center" style={{ height: "100%" }}>
									<Text size="2" style={{ color: "var(--muted-foreground)" }}>No trend data available</Text>
								</Flex>
							)}
						</Box>
					</Box>
				</Card>
			</div>

			{/* ═══ Tab Navigation ═══ */}
			<div style={{
				display: "flex", gap: 4, marginBottom: 20,
				borderBottom: "1px solid var(--border)", paddingBottom: 0,
			}}>
				<TabButton id="agents" active={activeTab === "agents"} label="Agents" count={perAgent.length} onClick={() => setActiveTab("agents")} />
				<TabButton id="evaluations" active={activeTab === "evaluations"} label="Evaluations" count={stats?.recent_evaluations?.length} onClick={() => setActiveTab("evaluations")} />
				<TabButton id="prompts" active={activeTab === "prompts"} label="Prompts & Quality" count={currentSummaries.length || undefined} onClick={() => setActiveTab("prompts")} />
			</div>

			{/* ═══════════════════════════════════════════════════════════════
			    TAB: Agents — Leaderboard + Full Comparison
			    ═══════════════════════════════════════════════════════════════ */}
			{activeTab === "agents" && (
				<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

					{/* Agent Leaderboard */}
					<Card style={CARD_STYLE}>
						<Box p="4">
							<Flex align="center" justify="between" mb="3">
								<SectionTitle>Top Agents by Pass Rate</SectionTitle>
								<Text size="1" style={{ color: "var(--muted-foreground)" }}>{perAgent.length} agents</Text>
							</Flex>
							{perAgent.length > 0 ? (
								<>
									<div className="grid items-center text-xs text-muted-foreground" style={{ gridTemplateColumns: "32px 1fr 80px 80px 60px 60px", padding: "4px 0" }}>
										<span>#</span><span>Agent</span><span className="text-right">Pass Rate</span><span className="text-right">Best</span><span className="text-right">Trend</span><span className="text-right">Evals</span>
									</div>
									{[...perAgent].sort((a: any, b: any) => b.avg_pass_rate - a.avg_pass_rate).slice(0, 8).map((a: any, idx: number) => (
										<div key={a.agent_id} className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors" style={{ gridTemplateColumns: "32px 1fr 80px 80px 60px 60px", padding: "8px 0", cursor: "pointer" }} onClick={() => navigate(`/agents/${a.agent_id}`)}>
											<Text size="1" style={{ color: "var(--muted-foreground)" }}>{idx + 1}</Text>
											<Text size="2" weight="medium" style={{ color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.agent_name}</Text>
											<span className="text-right text-xs font-semibold" style={{ color: a.avg_pass_rate >= 70 ? "#3fb950" : a.avg_pass_rate >= 40 ? "#d29922" : "#f85149" }}>{a.avg_pass_rate}%</span>
											<Text size="2" className="text-right" style={{ color: "#3fb950" }}>{a.best_pass_rate}%</Text>
											<span className="text-right"><TrendBadge trend={a.trend} /></span>
											<Text size="1" className="text-right" style={{ color: "var(--muted-foreground)" }}>{a.eval_count}</Text>
										</div>
									))}
								</>
							) : (
								<Flex align="center" justify="center" style={{ height: 120 }}>
									<Text size="2" style={{ color: "var(--muted-foreground)" }}>No agent data yet</Text>
								</Flex>
							)}
						</Box>
					</Card>

					{/* All Agents — Detailed Metrics (always visible) */}
					{perAgent.length > 0 && (
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="3">
									<SectionTitle>All Agents — Detailed Metrics</SectionTitle>
									<input type="text" placeholder="Search agents..." value={agentTableSearch} onChange={(e) => setAgentTableSearch(e.target.value)} style={{
										padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)",
										background: "var(--card)", color: "var(--foreground)", fontSize: 13, width: 200,
									}} />
								</Flex>
								<div className="grid items-center text-xs text-muted-foreground" style={{ gridTemplateColumns: "1fr 90px 55px 70px 55px 60px 55px 80px", padding: "6px 0" }}>
									<div style={{ cursor: "pointer" }} onClick={() => setAgentTableSort({key: "agent_name", direction: agentTableSort.key === "agent_name" && agentTableSort.direction === "asc" ? "desc" : "asc"})}>
										Agent {agentTableSort.key === "agent_name" && (agentTableSort.direction === "asc" ? "↑" : "↓")}
									</div>
									<div>Model</div><div>Evals</div>
									<div style={{ cursor: "pointer" }} onClick={() => setAgentTableSort({key: "avg_pass_rate", direction: agentTableSort.key === "avg_pass_rate" && agentTableSort.direction === "desc" ? "asc" : "desc"})}>
										Avg Pass {agentTableSort.key === "avg_pass_rate" && (agentTableSort.direction === "asc" ? "↑" : "↓")}
									</div>
									<div>Best</div><div>Trend</div><div>Regr.</div><div className="text-right">Sparkline</div>
								</div>
								{filteredAgents.map((a: any) => (
									<div key={a.agent_id} className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors" style={{ gridTemplateColumns: "1fr 90px 55px 70px 55px 60px 55px 80px", padding: "8px 0", cursor: "pointer" }} onClick={() => navigate(`/agents/${a.agent_id}`)}>
										<Text size="2" weight="medium" style={{ color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.agent_name}</Text>
										<Badge variant="soft" color="gray" size="1">{a.model}</Badge>
										<Text size="2" style={{ color: "var(--foreground)" }}>{a.eval_count}</Text>
										<Text size="2" weight="bold" style={{ color: a.avg_pass_rate >= 70 ? "#3fb950" : a.avg_pass_rate >= 40 ? "#d29922" : "#f85149" }}>{a.avg_pass_rate}%</Text>
										<Text size="2" style={{ color: "#3fb950" }}>{a.best_pass_rate}%</Text>
										<TrendBadge trend={a.trend} />
										<div>{a.regressions > 0 ? <Badge variant="soft" color="red" size="1">{a.regressions}</Badge> : <Text size="1" style={{ color: "var(--muted-foreground)" }}>0</Text>}</div>
										<div className="flex justify-end">
											{a.recent_rates?.length > 1 && (
												<svg width={60} height={20} viewBox={`0 0 ${(a.recent_rates.length - 1) * 20} 20`}>
													<polyline fill="none" stroke="#58a6ff" strokeWidth={1.5} points={a.recent_rates.map((r: number, i: number) => `${i * 20},${20 - r / 5}`).join(" ")} />
													{a.recent_rates.map((r: number, i: number) => <circle key={i} cx={i * 20} cy={20 - r / 5} r={2} fill="#58a6ff" />)}
												</svg>
											)}
										</div>
									</div>
								))}
							</Box>
						</Card>
					)}
				</div>
			)}

			{/* ═══════════════════════════════════════════════════════════════
			    TAB: Evaluations — KPIs, Failure Patterns, Test Stability
			    ═══════════════════════════════════════════════════════════════ */}
			{activeTab === "evaluations" && (
				<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

					{/* Eval-specific KPI cards */}
					{(() => {
						const total = stats?.total_evaluations ?? 0;
						const completed = stats?.completed_evaluations ?? 0;
						const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
						const coverage = stats?.annotation_coverage ?? 0;
						const coverageColor = coverage >= 80 ? "#3fb950" : coverage >= 40 ? "#d29922" : "#f85149";
						const solidPct = stabilityCounts.total > 0 ? Math.round((stabilityCounts.solid / stabilityCounts.total) * 100) : 0;
						return (
							<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
								<StatCard icon={CheckCircle} label="Completion Rate" value={`${completionPct}%`} sub={`${completed} of ${total} completed`} color="#3fb950" />
								<StatCard icon={ChatCircle} label="Annotation Coverage" value={`${coverage}%`} sub={coverage >= 80 ? "Comprehensive" : coverage >= 40 ? "Moderate" : "Needs more annotations"} color={coverageColor} />
								<StatCard icon={CheckCircle} label="Test Health" value={`${solidPct}%`} sub={`${stabilityCounts.solid} solid of ${stabilityCounts.total} tests`} color="#58a6ff" />
								<StatCard icon={Warning} label="Flaky Tests" value={stabilityCounts.flaky + stabilityCounts.broken} sub={stabilityCounts.broken > 0 ? `${stabilityCounts.broken} broken, ${stabilityCounts.flaky} flaky` : `${stabilityCounts.flaky} intermittent failures`} color="#d29922" />
							</div>
						);
					})()}

					{/* Failure Patterns + Flaky/Broken Tests side-by-side */}
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
						{/* Failure Patterns */}
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="2">
									<SectionTitle>Most Common Failure Types</SectionTitle>
									{patterns && <Badge variant="soft" color="gray" size="1">{patterns.total_annotations} annotations</Badge>}
								</Flex>
								<Box style={{ height: 220 }}>
									{patterns?.issue_tags?.length > 0 ? (() => {
										const tags = patterns.issue_tags.slice(0, 8);
										return (
											<ResponsiveContainer width="100%" height="100%">
												<BarChart data={tags} margin={{ top: 8, right: 8, bottom: 48, left: -12 }}>
													<defs>
														{tags.map((_: any, i: number) => (
															<linearGradient key={i} id={`barGrad${i}`} x1="0" y1="1" x2="0" y2="0">
																<stop offset="0%" stopColor={BAR_COLORS[i % BAR_COLORS.length]} stopOpacity={0.1} />
																<stop offset="100%" stopColor={BAR_COLORS[i % BAR_COLORS.length]} stopOpacity={0.85} />
															</linearGradient>
														))}
													</defs>
													<CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
													<YAxis axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 11 }} allowDecimals={false} />
													<XAxis dataKey="tag" axisLine={false} tickLine={false} interval={0}
														tick={(props: any) => {
															const { x, y, payload } = props;
															const words = (payload.value as string).split(/[\s_]+/);
															return (
																<text x={x} y={y + 8} textAnchor="middle" fill="#c9d1d9" fontSize={10}>
																	{words.map((w: string, j: number) => (
																		<tspan key={j} x={x} dy={j === 0 ? 0 : 13}>{w}</tspan>
																	))}
																</text>
															);
														}} height={48}
													/>
													<ReTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(88,166,255,0.04)" }} formatter={(v: number) => [v, "Count"]} labelFormatter={(l: string) => l.replace(/_/g, " ")} />
													<Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={36}>
														{tags.map((_: any, i: number) => <Cell key={i} fill={`url(#barGrad${i})`} />)}
													</Bar>
												</BarChart>
											</ResponsiveContainer>
										);
									})() : (
										<Flex align="center" justify="center" style={{ height: "100%" }}>
											<Text size="2" style={{ color: "var(--muted-foreground)" }}>No failure patterns yet</Text>
										</Flex>
									)}
								</Box>
							</Box>
						</Card>

						{/* Flaky & Broken Tests — compact list */}
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="2">
									<SectionTitle>Flaky & Broken Tests</SectionTitle>
									<Flex gap="1" align="center">
										{[
											{ value: "all", label: "All", color: undefined },
											{ value: "broken", label: "Broken", color: "red" as const },
											{ value: "flaky", label: "Flaky", color: "orange" as const },
											{ value: "solid", label: "Solid", color: "green" as const },
										].map(f => (
											<Badge key={f.value} variant={stabilityFilter === f.value ? "solid" : "soft"} color={f.color || "gray"} size="1" style={{ cursor: "pointer", fontSize: 10 }} onClick={() => setStabilityFilter(f.value)}>
												{f.label}
											</Badge>
										))}
									</Flex>
								</Flex>
								{/* Stability bar */}
								{stabilityCounts.total > 0 && (
									<div style={{ marginBottom: 8 }}>
										<div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--secondary)" }}>
											{stabilityCounts.solid > 0 && <div style={{ width: `${(stabilityCounts.solid / stabilityCounts.total) * 100}%`, background: "#3fb950", transition: "width 0.3s" }} />}
											{stabilityCounts.flaky > 0 && <div style={{ width: `${(stabilityCounts.flaky / stabilityCounts.total) * 100}%`, background: "#d29922", transition: "width 0.3s" }} />}
											{stabilityCounts.broken > 0 && <div style={{ width: `${(stabilityCounts.broken / stabilityCounts.total) * 100}%`, background: "#f85149", transition: "width 0.3s" }} />}
										</div>
									</div>
								)}
								<ScrollArea style={{ maxHeight: 196 }}>
									{filteredStabilityTests.length > 0 ? filteredStabilityTests.slice(0, 15).map((t: any) => {
										const stabilityColor = t.stability === "solid" ? "#3fb950" : t.stability === "flaky" ? "#d29922" : "#f85149";
										return (
											<Flex key={t.testcase_id} align="center" gap="2" style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
												<Badge variant="soft" color={t.stability === "solid" ? "green" : t.stability === "flaky" ? "orange" : "red"} size="1" style={{ fontSize: 9, flexShrink: 0, width: 50, justifyContent: "center" }}>
													{t.stability}
												</Badge>
												<Text size="1" style={{ color: "var(--foreground)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.testcase_name}>
													{t.testcase_name}
												</Text>
												<Text size="1" weight="bold" style={{ color: stabilityColor, flexShrink: 0 }}>{t.pass_rate}%</Text>
												<Flex gap="0.5" style={{ flexShrink: 0 }}>
													{[...t.history].reverse().slice(0, 10).map((h: any, i: number) => (
														<span key={i} style={{
															width: 8, height: 8, borderRadius: 2, flexShrink: 0,
															background: h.passed === true ? "rgba(63,185,80,0.7)" : h.passed === false ? "rgba(248,81,73,0.7)" : "rgba(139,148,158,0.3)",
														}} />
													))}
												</Flex>
											</Flex>
										);
									}) : (
										<Flex align="center" justify="center" style={{ height: 120 }}>
											<Text size="2" style={{ color: "var(--muted-foreground)" }}>
												{stabilityCounts.total === 0 ? "No test stability data yet" : "No tests match filter"}
											</Text>
										</Flex>
									)}
								</ScrollArea>
							</Box>
						</Card>
					</div>

					{/* Row 3: Eval Velocity + Pass Rate Distribution + Recent Activity */}
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
						{/* Evaluation Velocity */}
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="2">
									<SectionTitle>Evaluation Cadence</SectionTitle>
									{evalVelocity.length > 0 && <Text size="1" style={{ color: "var(--muted-foreground)" }}>{evalVelocity.reduce((s: number, w: any) => s + w.eval_count, 0)} total</Text>}
								</Flex>
								<Box style={{ height: 180 }}>
									{evalVelocity.length > 0 ? (
										<ResponsiveContainer width="100%" height="100%">
											<BarChart data={evalVelocity} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
												<CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
												<XAxis dataKey="week" axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 9 }} tickFormatter={(v: string) => v.slice(5)} />
												<YAxis axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} allowDecimals={false} />
												<ReTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, name: string) => [name === "eval_count" ? `${v} evals` : `${v}%`, name === "eval_count" ? "Evals" : "Avg Pass Rate"]} labelFormatter={(l: string) => `Week of ${l}`} />
												<Bar dataKey="eval_count" fill="#58a6ff" radius={[4, 4, 0, 0]} maxBarSize={24} opacity={0.8} />
											</BarChart>
										</ResponsiveContainer>
									) : (
										<Flex align="center" justify="center" style={{ height: "100%" }}>
											<Text size="2" style={{ color: "var(--muted-foreground)" }}>No velocity data yet</Text>
										</Flex>
									)}
								</Box>
							</Box>
						</Card>

						{/* Pass Rate Distribution */}
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="2">
									<SectionTitle>Pass Rate Distribution</SectionTitle>
								</Flex>
								<Box style={{ height: 180 }}>
									{(() => {
										const recentEvals = stats?.recent_evaluations || [];
										if (recentEvals.length === 0) return (
											<Flex align="center" justify="center" style={{ height: "100%" }}>
												<Text size="2" style={{ color: "var(--muted-foreground)" }}>No eval data yet</Text>
											</Flex>
										);
										const buckets = [
											{ range: "0-20%", min: 0, max: 20, count: 0, color: "#f85149" },
											{ range: "20-40%", min: 20, max: 40, count: 0, color: "#f0883e" },
											{ range: "40-60%", min: 40, max: 60, count: 0, color: "#d29922" },
											{ range: "60-80%", min: 60, max: 80, count: 0, color: "#58a6ff" },
											{ range: "80-100%", min: 80, max: 101, count: 0, color: "#3fb950" },
										];
										recentEvals.forEach((ev: any) => {
											const rate = ev.pass_rate ?? 0;
											const bucket = buckets.find(b => rate >= b.min && rate < b.max);
											if (bucket) bucket.count++;
										});
										return (
											<ResponsiveContainer width="100%" height="100%">
												<BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
													<CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
													<XAxis dataKey="range" axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} />
													<YAxis axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} allowDecimals={false} />
													<ReTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v} evals`, "Count"]} />
													<Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={36}>
														{buckets.map((b, i) => <Cell key={i} fill={b.color} opacity={0.8} />)}
													</Bar>
												</BarChart>
											</ResponsiveContainer>
										);
									})()}
								</Box>
							</Box>
						</Card>

						{/* Recent Activity */}
						<Card style={CARD_STYLE}>
							<Box p="4">
								<Flex align="center" justify="between" mb="2">
									<SectionTitle>Recent Activity</SectionTitle>
								</Flex>
								{stats?.recent_evaluations?.length > 0 ? (
									<ScrollArea style={{ maxHeight: 196 }}>
										{stats.recent_evaluations.slice(0, 8).map((ev: any) => {
											const statusColor: Record<string, string> = { completed: "#3fb950", running: "#58a6ff", failed: "#f85149", cancelled: "#d29922", pending: "#8b949e" };
											return (
												<div key={ev.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", cursor: "pointer" }} onClick={() => navigate(`/evaluations/${ev.id}`)}>
													<Flex align="center" justify="between" gap="2">
														<Flex align="center" gap="2" style={{ flex: 1, minWidth: 0 }}>
															<span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor[ev.status] || "#8b949e", flexShrink: 0 }} />
															<Text size="1" style={{ color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
																{ev.name}
															</Text>
														</Flex>
														<Flex align="center" gap="2" style={{ flexShrink: 0 }}>
															<Text size="1" weight="bold" style={{ color: ev.pass_rate >= 70 ? "#3fb950" : ev.pass_rate >= 40 ? "#d29922" : "#f85149" }}>
																{ev.pass_rate}%
															</Text>
															<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10 }}>
																{ev.created_at?.slice(5, 10)}
															</Text>
														</Flex>
													</Flex>
													<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10, marginLeft: 14 }}>
														{ev.agent_name} · {ev.total_tests} tests
													</Text>
												</div>
											);
										})}
									</ScrollArea>
								) : (
									<Flex align="center" justify="center" style={{ height: 180 }}>
										<Text size="2" style={{ color: "var(--muted-foreground)" }}>No recent evaluations</Text>
									</Flex>
								)}
							</Box>
						</Card>
					</div>

				</div>
			)}


			{/* ═══════════════════════════════════════════════════════════════
			    TAB: Prompts & Quality — Version Trends, Model Comparison
			    ═══════════════════════════════════════════════════════════════ */}
			{activeTab === "prompts" && (
				<div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

					{/* Quality Overview — summary stats row */}
					{currentSummaries.length > 0 && (() => {
						const improving = currentSummaries.filter((a: any) => a.delta > 0).length;
						const declining = currentSummaries.filter((a: any) => a.delta < 0).length;
						const stable = currentSummaries.filter((a: any) => a.delta === 0).length;
						const totalVersions = currentSummaries.reduce((sum: number, a: any) => sum + a.versionSummaries.length, 0);
						const avgDelta = currentSummaries.length ? Math.round(currentSummaries.reduce((sum: number, a: any) => sum + a.delta, 0) / currentSummaries.length * 10) / 10 : 0;
						const bestAgent = [...currentSummaries].sort((a: any, b: any) => (b.activeVersion?.avg ?? 0) - (a.activeVersion?.avg ?? 0))[0];
						const worstAgent = [...currentSummaries].sort((a: any, b: any) => (a.activeVersion?.avg ?? 0) - (b.activeVersion?.avg ?? 0))[0];

						return (
							<Grid columns="4" gap="3">
								<Card style={CARD_STYLE}>
									<Flex direction="column" gap="1" p="3">
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>Avg Quality Change</Text>
										<Flex align="center" gap="2">
											<Text size="5" weight="bold" style={{ color: avgDelta >= 0 ? "#3fb950" : "#f85149" }}>
												{avgDelta >= 0 ? "+" : ""}{avgDelta}%
											</Text>
											<TrendBadge trend={avgDelta > 0 ? "improving" : avgDelta < 0 ? "declining" : "stable"} />
										</Flex>
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10 }}>avg change across agents</Text>
									</Flex>
								</Card>
								<Card style={CARD_STYLE}>
									<Flex direction="column" gap="1" p="3">
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>Agents by Direction</Text>
										<Flex gap="3" align="baseline">
											<span style={{ fontSize: 14, fontWeight: 700, color: "#3fb950" }}>{improving}</span>
											<span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>improving</span>
											<span style={{ fontSize: 14, fontWeight: 700, color: "#f85149" }}>{declining}</span>
											<span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>declining</span>
											<span style={{ fontSize: 14, fontWeight: 700, color: "var(--muted-foreground)" }}>{stable}</span>
											<span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>stable</span>
										</Flex>
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10 }}>{totalVersions} total {groupBy === "prompt" ? "versions" : "models"} tracked</Text>
									</Flex>
								</Card>
								<Card style={CARD_STYLE}>
									<Flex direction="column" gap="1" p="3">
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>Highest Pass Rate</Text>
										{bestAgent ? (
											<>
												<Text size="3" weight="bold" style={{ color: "#3fb950", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bestAgent.activeVersion?.avg ?? 0}%</Text>
												<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bestAgent.agent_name}</Text>
											</>
										) : <Text size="1" style={{ color: "var(--muted-foreground)" }}>—</Text>}
									</Flex>
								</Card>
								<Card style={CARD_STYLE}>
									<Flex direction="column" gap="1" p="3">
										<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11 }}>Lowest Pass Rate</Text>
										{worstAgent ? (
											<>
												<Text size="3" weight="bold" style={{ color: "#f85149", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worstAgent.activeVersion?.avg ?? 0}%</Text>
												<Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worstAgent.agent_name}</Text>
											</>
										) : <Text size="1" style={{ color: "var(--muted-foreground)" }}>—</Text>}
									</Flex>
								</Card>
							</Grid>
						);
					})()}

					{/* Version / Model Performance — Small Multiples */}
					{currentSummaries.length > 0 && (() => {
						const improving = currentSummaries.filter((a: any) => a.delta > 0).length;
						const total = currentSummaries.length;
						const VERSION_PALETTE = ["#8b949e", "#58a6ff", "#3fb950", "#bc8cff", "#f0883e"];

						return (
							<Card style={CARD_STYLE}>
								<Box p="4">
									<Flex align="center" justify="between" mb="1">
										<Flex align="center" gap="3">
											<SectionTitle>
												{groupBy === "prompt" ? "Prompt Version Performance" : "Model Performance Comparison"}
											</SectionTitle>
											<Flex gap="1">
												{([
													{ value: "prompt" as const, label: "By Prompt" },
													{ value: "model" as const, label: "By Model" },
												]).map(mode => (
													<button key={mode.value} onClick={() => setGroupBy(mode.value)} style={{
														padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: groupBy === mode.value ? 600 : 400,
														border: `1px solid ${groupBy === mode.value ? "#58a6ff" : "var(--border)"}`,
														background: groupBy === mode.value ? "rgba(88,166,255,0.15)" : "transparent",
														color: groupBy === mode.value ? "#58a6ff" : "var(--muted-foreground)",
														cursor: "pointer", transition: "all 0.15s",
													}}>{mode.label}</button>
												))}
											</Flex>
										</Flex>
										<Text size="1" style={{ color: "var(--muted-foreground)" }}>
											{improving} of {total} agents improved
										</Text>
									</Flex>

									{/* Controls */}
									<Flex gap="2" mb="3" align="center" wrap="wrap">
										<input type="text" placeholder="Search agents..." value={cardSearchQuery} onChange={(e) => setCardSearchQuery(e.target.value)} style={{
											padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)",
											background: "var(--card)", color: "var(--foreground)", fontSize: 13, width: 200,
										}} />
										<Flex gap="1">
											{([
												{ value: "top" as const, label: "Top 10" },
												{ value: "all" as const, label: "All" },
												{ value: "improving" as const, label: "Improving" },
												{ value: "declining" as const, label: "Declining" },
											]).map(mode => (
												<button key={mode.value} onClick={() => { setCardViewMode(mode.value); setShowAllCards(false); }} style={{
													padding: "4px 10px", borderRadius: 6, fontSize: 12,
													border: `1px solid ${cardViewMode === mode.value ? "var(--accent)" : "var(--border)"}`,
													background: cardViewMode === mode.value ? "var(--accent)" : "transparent",
													color: cardViewMode === mode.value ? "var(--accent-foreground)" : "var(--muted-foreground)",
													fontWeight: cardViewMode === mode.value ? 600 : 400, cursor: "pointer", transition: "all 0.2s",
												}}>{mode.label}</button>
											))}
										</Flex>
										<Text size="1" style={{ color: "var(--muted-foreground)", marginLeft: "auto" }}>
											Showing {cardsToShow.length} of {displayedAgents.length}
										</Text>
									</Flex>

									{/* Cards grid */}
									<div style={{
										display: "grid",
										gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
										gap: 12, marginBottom: 12,
									}}>
										{cardsToShow.map((agent: any) => {
											const vs = agent.versionSummaries;
											return (
												<div key={agent.agent_id} style={{
													background: "var(--card)", border: "1px solid var(--border)",
													borderRadius: 10, padding: "14px 16px",
												}}>
													<Flex align="center" justify="between" mb="2">
														<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>{agent.agent_name}</Text>
														{agent.delta !== 0 && (
															<span style={{
																fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10,
																background: agent.delta > 0 ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
																color: agent.delta > 0 ? "#3fb950" : "#f85149",
															}}>{agent.delta > 0 ? "+" : ""}{agent.delta}%</span>
														)}
													</Flex>

													{/* Mini sparkline SVG */}
													<div style={{ height: 56, marginBottom: 10 }}>
														{vs.length <= 1 ? (
															<Flex align="center" justify="center" style={{ height: "100%" }}>
																<Text size="1" style={{ color: "var(--muted-foreground)" }}>
																	{vs.length === 0 ? (groupBy === "prompt" ? "No versions" : "No models") : `${groupBy === "prompt" ? `v${vs[0].version}` : vs[0].model}: ${vs[0].avg}%`}
																</Text>
															</Flex>
														) : (() => {
															const points = vs.map((ver: any, idx: number) => ({
																x: idx, y: ver.avg,
																color: VERSION_PALETTE[idx % VERSION_PALETTE.length],
																isActive: groupBy === "prompt" ? ver.is_active : (idx === vs.length - 1),
																label: `${groupBy === "prompt" ? `v${ver.version}` : ver.model}: ${ver.avg}%`,
															}));
															const w = 260, h = 56, px = 20, py = 8;
															const minY = Math.max(0, Math.min(...points.map(p => p.y)) - 15);
															const maxY = Math.min(100, Math.max(...points.map(p => p.y)) + 15);
															const rangeY = maxY - minY || 1;
															const sx = (i: number) => px + (i / (points.length - 1)) * (w - 2 * px);
															const sy = (v: number) => py + (1 - (v - minY) / rangeY) * (h - 2 * py);
															return (
																<svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
																	<line x1={px} y1={sy(minY + rangeY / 2)} x2={w - px} y2={sy(minY + rangeY / 2)} stroke="rgba(48,54,61,0.3)" strokeDasharray="2 3" />
																	<polyline points={points.map((p, i) => `${sx(i)},${sy(p.y)}`).join(" ")} fill="none" stroke="rgba(139,148,158,0.4)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
																	{points.map((p, i) => (
																		<g key={i}>
																			<circle cx={sx(i)} cy={sy(p.y)} r={p.isActive ? 5 : 3.5} fill={p.color} stroke={p.isActive ? "#fff" : "rgba(13,17,23,0.8)"} strokeWidth={p.isActive ? 2 : 1.5} opacity={p.isActive ? 1 : 0.85}>
																				<title>{p.label}</title>
																			</circle>
																			{p.isActive && <circle cx={sx(i)} cy={sy(p.y)} r={8} fill="none" stroke={p.color} strokeWidth={1} opacity={0.3} />}
																		</g>
																	))}
																</svg>
															);
														})()}
													</div>

													{/* Version pills */}
													<Flex gap="2" wrap="wrap">
														{vs.map((ver: any, idx: number) => {
															const color = VERSION_PALETTE[idx % VERSION_PALETTE.length];
															const displayName = groupBy === "prompt" ? `v${ver.version}` : (ver.model || `Model ${idx + 1}`);
															const isActive = groupBy === "prompt" ? ver.is_active : (idx === vs.length - 1);
															return (
																<Flex key={idx} align="center" gap="1" style={{
																	fontSize: 11, padding: "2px 8px", borderRadius: 6,
																	background: isActive ? `${color}22` : "var(--secondary)",
																	border: isActive ? `1px solid ${color}44` : "1px solid transparent",
																	color: isActive ? color : "var(--muted-foreground)",
																}}>
																	<span style={{ width: 5, height: 5, borderRadius: "50%", background: color, flexShrink: 0 }} />
																	{displayName}
																	<span style={{ fontWeight: 600, marginLeft: 2 }}>{ver.avg}%</span>
																	{isActive && <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 2 }}>{groupBy === "prompt" ? "active" : "latest"}</span>}
																</Flex>
															);
														})}
													</Flex>
												</div>
											);
										})}
									</div>

									{!showAllCards && displayedAgents.length > cardsToShow.length && (
										<Flex justify="center">
											<button onClick={() => setShowAllCards(true)} style={{
												padding: "8px 16px", borderRadius: 6, border: "1px solid var(--border)",
												background: "var(--card)", color: "var(--foreground)", fontSize: 13,
												cursor: "pointer", fontWeight: 500, transition: "all 0.2s",
											}}
												onMouseEnter={(e) => e.currentTarget.style.background = "var(--accent)"}
												onMouseLeave={(e) => e.currentTarget.style.background = "var(--card)"}
											>Show {displayedAgents.length - cardsToShow.length} More</button>
										</Flex>
									)}
								</Box>
							</Card>
						);
					})()}

					{/* Version Ranking Table — sortable summary of all agents' active versions */}
					{currentSummaries.length > 0 && (
						<Card style={CARD_STYLE}>
							<Box p="4">
								<SectionTitle>{groupBy === "prompt" ? "Prompt Version Comparison" : "Current Model Comparison"}</SectionTitle>
								<div className="grid items-center text-xs text-muted-foreground" style={{ gridTemplateColumns: "1fr 120px 80px 80px 70px 60px", padding: "6px 0" }}>
									<span>Agent</span>
									<span>{groupBy === "prompt" ? "Active Version" : "Latest Model"}</span>
									<span className="text-right">Avg Pass</span>
									<span className="text-right">Best</span>
									<span className="text-right">Delta</span>
									<span className="text-right">Trend</span>
								</div>
								{[...currentSummaries].sort((a: any, b: any) => (b.activeVersion?.avg ?? 0) - (a.activeVersion?.avg ?? 0)).map((agent: any) => {
									const av = agent.activeVersion;
									const displayName = groupBy === "prompt" ? (av ? `v${av.version}` : "—") : (av?.model || "—");
									return (
										<div key={agent.agent_id} className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors" style={{ gridTemplateColumns: "1fr 120px 80px 80px 70px 60px", padding: "8px 0" }}>
											<Text size="2" weight="medium" style={{ color: "var(--foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.agent_name}</Text>
											<Badge variant="soft" color="gray" size="1">{displayName}</Badge>
											<Text size="2" weight="bold" className="text-right" style={{ color: (av?.avg ?? 0) >= 70 ? "#3fb950" : (av?.avg ?? 0) >= 40 ? "#d29922" : "#f85149" }}>{av?.avg ?? 0}%</Text>
											<Text size="2" className="text-right" style={{ color: "#3fb950" }}>{av?.best ?? 0}%</Text>
											<span className="text-right" style={{
												fontSize: 12, fontWeight: 600,
												color: agent.delta > 0 ? "#3fb950" : agent.delta < 0 ? "#f85149" : "var(--muted-foreground)",
											}}>{agent.delta > 0 ? "+" : ""}{agent.delta}%</span>
											<span className="text-right"><TrendBadge trend={agent.overallTrend} /></span>
										</div>
									);
								})}
							</Box>
						</Card>
					)}

					{/* Empty state */}
					{currentSummaries.length === 0 && (
						<Card style={CARD_STYLE}>
							<Flex align="center" justify="center" p="6">
								<Text size="2" style={{ color: "var(--muted-foreground)" }}>No prompt or model data available yet. Run evaluations with different prompt versions to see quality trends.</Text>
							</Flex>
						</Card>
					)}
				</div>
			)}
		</Box>
	);
}
