/**
 * Evaluations Page - Radix UI Themes Edition
 *
 * Features:
 * - Stats cards (Total, Running, Completed, Avg Pass Rate)
 * - Pass rate trend chart (Recharts AreaChart)
 * - Per-prompt-version performance summary
 * - Compare mode (select 2 evaluations → navigate to comparison page)
 * - Filterable, searchable evaluation table
 */

import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Flex, Text, Card, Button, Badge, Table, Dialog, Select, TextField, Checkbox } from "@radix-ui/themes";
import { Play, RefreshCw, Trash2, Eye, GitCompareArrows, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { useEvaluations } from "@/hooks/useEvaluations";
import { useAgents } from "@/hooks/useAgents";
import { useDatasets } from "@/hooks/useDatasets";
import { apiClient, EvaluationRun, TrendDataPoint } from "@/lib/api";

const COLORS = {
  green: "#3fb950",
  greenBg: "rgba(63, 185, 80, 0.12)",
  red: "#f85149",
  redBg: "rgba(248, 81, 73, 0.12)",
  blue: "#58a6ff",
  blueBg: "rgba(88, 166, 255, 0.12)",
  amber: "#d29922",
  amberBg: "rgba(210, 153, 34, 0.12)",
};

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "#161b22",
  border: "1px solid rgba(48,54,61,0.6)",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 12,
  color: "#e6edf3",
};

export function EvaluationsPage() {
  const navigate = useNavigate();
  const { evaluations, loading, error, refetch } = useEvaluations();
  const { agents } = useAgents();
  const { datasets } = useDatasets();

  // Dialog state
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedDataset, setSelectedDataset] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EvaluationRun | null>(null);

  // Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  // Compare state
  const [compareMode, setCompareMode] = useState(false);
  const [compareSelections, setCompareSelections] = useState<string[]>([]);

  // Analytics state
  const [analyticsOpen, setAnalyticsOpen] = useState(true);
  const [trends, setTrends] = useState<TrendDataPoint[]>([]);
  const [trendsLoading, setTrendsLoading] = useState(false);

  // Fetch trend data
  useEffect(() => {
    let cancelled = false;
    setTrendsLoading(true);
    apiClient
      .getPassRateTrends(undefined, 30)
      .then((data) => {
        if (!cancelled) setTrends(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTrendsLoading(false);
      });
    return () => { cancelled = true; };
  }, [evaluations.length]); // refetch when evaluations change

  // Build lookup maps
  const agentMap = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((a: any) => (m[a.id] = a.name));
    return m;
  }, [agents]);

  const datasetMap = useMemo(() => {
    const m: Record<string, string> = {};
    datasets.forEach((d: any) => (m[d.id] = d.seed?.name || d.id));
    return m;
  }, [datasets]);

  // Filter evaluations
  const filteredEvaluations = useMemo(() => {
    let filtered = evaluations;
    if (statusFilter !== "all") {
      filtered = filtered.filter((e) => e.status === statusFilter);
    }
    if (agentFilter !== "all") {
      filtered = filtered.filter((e) => e.agent_id === agentFilter);
    }
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          (e.name || "").toLowerCase().includes(lower) ||
          (agentMap[e.agent_id] || "").toLowerCase().includes(lower) ||
          (datasetMap[e.dataset_id] || "").toLowerCase().includes(lower)
      );
    }
    return filtered;
  }, [evaluations, statusFilter, agentFilter, searchTerm, agentMap, datasetMap]);

  // Stats
  const stats = useMemo(() => {
    const completed = evaluations.filter((e) => e.status === "completed");
    const avgPassRate =
      completed.length > 0
        ? Math.round(
            completed.reduce((sum, e) => {
              const total = e.passed_count + (e.failed_tests ?? 0);
              return sum + (total > 0 ? (e.passed_count / total) * 100 : 0);
            }, 0) / completed.length
          )
        : 0;

    return {
      total: evaluations.length,
      running: evaluations.filter((e) => e.status === "running").length,
      completed: completed.length,
      avgPassRate,
    };
  }, [evaluations]);

  // Prompt version performance (computed from evaluations)
  const promptVersionStats = useMemo(() => {
    const completed = evaluations.filter((e) => e.status === "completed");
    const byVersion: Record<number, { evals: number; totalRate: number; passRates: number[] }> = {};

    completed.forEach((e) => {
      const version = e.prompt_version ?? 0;
      if (!byVersion[version]) {
        byVersion[version] = { evals: 0, totalRate: 0, passRates: [] };
      }
      const total = e.passed_count + (e.failed_tests ?? 0);
      const rate = total > 0 ? (e.passed_count / total) * 100 : 0;
      byVersion[version].evals++;
      byVersion[version].totalRate += rate;
      byVersion[version].passRates.push(rate);
    });

    const versions = Object.entries(byVersion)
      .map(([version, data]) => ({
        version: Number(version),
        label: Number(version) === 0 ? "Default" : `v${version}`,
        evals: data.evals,
        avgPassRate: Math.round(data.totalRate / data.evals),
      }))
      .sort((a, b) => a.version - b.version);

    // Compute deltas
    return versions.map((v, i) => ({
      ...v,
      delta: i > 0 ? v.avgPassRate - versions[i - 1].avgPassRate : null,
    }));
  }, [evaluations]);

  // Helpers
  const getPassRateColor = (passRate: number) => {
    if (passRate >= 80) return COLORS.green;
    if (passRate >= 50) return COLORS.amber;
    return COLORS.red;
  };

  const getStatusColor = (status: string) => {
    const map: Record<string, { color: string; bg: string }> = {
      completed: { color: COLORS.green, bg: COLORS.greenBg },
      running: { color: COLORS.blue, bg: COLORS.blueBg },
      failed: { color: COLORS.red, bg: COLORS.redBg },
      pending: { color: "var(--gray-9)", bg: "var(--gray-3)" },
      cancelled: { color: "var(--gray-9)", bg: "var(--gray-3)" },
    };
    return map[status] || map.pending;
  };

  const formatDuration = (start?: string | null, end?: string | null) => {
    if (!start) return "—";
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const secs = Math.round((e - s) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // Compare handlers
  function toggleCompareSelection(id: string) {
    setCompareSelections((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  function handleCompare() {
    if (compareSelections.length === 2) {
      navigate(`/evaluations/${compareSelections[0]}/compare/${compareSelections[1]}`);
    }
  }

  // Handlers
  const handleRunEvaluation = async () => {
    if (!selectedAgent || !selectedDataset) return;
    setIsRunning(true);
    try {
      const agent = agents.find((a) => a.id === selectedAgent);
      const evaluation = await apiClient.createEvaluation({
        agent_id: selectedAgent,
        agent_endpoint: agent?.agent_invocation_url || "",
        dataset_id: selectedDataset,
        name: `${agentMap[selectedAgent]} on ${datasetMap[selectedDataset]}`,
      });
      setRunDialogOpen(false);
      setSelectedAgent("");
      setSelectedDataset("");
      navigate(`/evaluations/${evaluation.id}`);
    } catch (err) {
      console.error("Failed to run evaluation:", err);
      alert(`Failed to start evaluation:\n\n${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteEvaluation(deleteTarget.id);
      setDeleteDialogOpen(false);
      setDeleteTarget(null);
      refetch();
    } catch (err) {
      console.error("Failed to delete evaluation:", err);
      alert(`Failed to delete evaluation:\n\n${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const completedCount = evaluations.filter((e) => e.status === "completed").length;

  if (error) {
    return (
      <Box p="6">
        <Text color="red">Failed to load evaluations: {error}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Flex direction="column" gap="4">
        {/* Header */}
        <Flex justify="between" align="center">
          <Box>
            <Text size="6" weight="bold">Evaluations</Text>
            <Text size="2" color="gray" style={{ display: "block", marginTop: 4 }}>
              Run and review agent evaluations against test datasets
            </Text>
          </Box>
          <Flex gap="2" align="center">
            {compareMode ? (
              <>
                <Text size="2" color="gray" style={{ marginRight: 4 }}>
                  {compareSelections.length}/2 selected
                </Text>
                <Button
                  size="2"
                  disabled={compareSelections.length !== 2}
                  onClick={handleCompare}
                >
                  <GitCompareArrows size={16} style={{ marginRight: 4 }} />
                  Compare
                </Button>
                <Button
                  variant="soft"
                  color="gray"
                  size="2"
                  onClick={() => {
                    setCompareMode(false);
                    setCompareSelections([]);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="soft"
                  size="2"
                  onClick={() => setCompareMode(true)}
                  disabled={completedCount < 2}
                >
                  <GitCompareArrows size={16} style={{ marginRight: 4 }} />
                  Compare
                </Button>
                <Button variant="soft" onClick={() => refetch()} disabled={loading}>
                  <RefreshCw size={16} style={{ marginRight: 4 }} />
                  Refresh
                </Button>
                <Button onClick={() => setRunDialogOpen(true)}>
                  <Play size={16} style={{ marginRight: 4 }} />
                  Run Evaluation
                </Button>
              </>
            )}
          </Flex>
        </Flex>

        {/* Stats Cards */}
        <Flex gap="3">
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Total Evaluations</Text>
            <Text size="6" weight="bold">{stats.total}</Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Running</Text>
            <Text size="6" weight="bold" color="blue">{stats.running}</Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Completed</Text>
            <Text size="6" weight="bold" color="green">{stats.completed}</Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Avg Pass Rate</Text>
            <Text size="6" weight="bold" style={{ color: getPassRateColor(stats.avgPassRate) }}>
              {stats.avgPassRate}%
            </Text>
          </Card>
        </Flex>

        {/* Analytics Section (collapsible) */}
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <Box
            style={{ padding: "12px 16px", cursor: "pointer", userSelect: "none" }}
            onClick={() => setAnalyticsOpen(!analyticsOpen)}
          >
            <Flex align="center" justify="between">
              <Flex align="center" gap="2">
                <TrendingUp size={16} style={{ color: "var(--gray-9)" }} />
                <Text size="2" weight="bold">Analytics</Text>
              </Flex>
              {analyticsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </Flex>
          </Box>

          {analyticsOpen && (
            <Box style={{ padding: "0 16px 16px", borderTop: "1px solid var(--gray-4)" }}>
              <Flex gap="4" style={{ marginTop: 16 }}>
                {/* Pass Rate Trend Chart */}
                <Box style={{ flex: 2, minWidth: 0 }}>
                  <Text size="2" weight="medium" style={{ display: "block", marginBottom: 8 }}>
                    Pass Rate Trend (30 days)
                  </Text>
                  <Box style={{ height: 200 }}>
                    {trendsLoading ? (
                      <Flex align="center" justify="center" style={{ height: "100%" }}>
                        <Text size="1" color="gray">Loading trends...</Text>
                      </Flex>
                    ) : trends.length >= 2 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={trends} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                          <defs>
                            <linearGradient id="evalTrendGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={COLORS.green} stopOpacity={0.2} />
                              <stop offset="100%" stopColor={COLORS.green} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
                          <XAxis
                            dataKey="date"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "#8b949e", fontSize: 10 }}
                            tickFormatter={(v: string) => v.slice(5)}
                          />
                          <YAxis
                            domain={[0, 100]}
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "#8b949e", fontSize: 10 }}
                            tickFormatter={(v: number) => `${v}%`}
                          />
                          <ReTooltip
                            contentStyle={TOOLTIP_STYLE}
                            formatter={(v: number) => [`${Math.round(v)}%`, "Pass Rate"]}
                            labelFormatter={(label: string) => `Date: ${label}`}
                          />
                          <Area
                            type="monotone"
                            dataKey="avg_pass_rate"
                            stroke={COLORS.green}
                            fill="url(#evalTrendGrad)"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 3, fill: COLORS.green, stroke: "#0d1117", strokeWidth: 2 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <Flex align="center" justify="center" style={{ height: "100%", opacity: 0.5 }}>
                        <Text size="1" color="gray">
                          {stats.completed > 0
                            ? "Need 2+ data points for trend chart"
                            : "Trend data will appear after evaluations complete"}
                        </Text>
                      </Flex>
                    )}
                  </Box>
                </Box>

                {/* Prompt Version Performance */}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="2" weight="medium" style={{ display: "block", marginBottom: 8 }}>
                    Prompt Version Performance
                  </Text>
                  {promptVersionStats.length === 0 ? (
                    <Flex align="center" justify="center" style={{ height: 200, opacity: 0.5 }}>
                      <Text size="1" color="gray">No prompt versions tracked yet</Text>
                    </Flex>
                  ) : promptVersionStats.length <= 6 ? (
                    // Show as cards when few versions
                    <Flex direction="column" gap="2" style={{ maxHeight: 200, overflowY: "auto" }}>
                      {promptVersionStats.map((v) => (
                        <Box
                          key={v.version}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 6,
                            border: "1px solid var(--gray-4)",
                            background: "var(--gray-2)",
                          }}
                        >
                          <Flex align="center" justify="between">
                            <Flex align="center" gap="2">
                              <Badge
                                size="1"
                                variant="soft"
                                style={{
                                  background: getPassRateColor(v.avgPassRate) + "20",
                                  color: getPassRateColor(v.avgPassRate),
                                }}
                              >
                                {v.label}
                              </Badge>
                              <Text size="2" weight="bold" style={{ color: getPassRateColor(v.avgPassRate) }}>
                                {v.avgPassRate}%
                              </Text>
                            </Flex>
                            <Flex align="center" gap="2">
                              {v.delta !== null && (
                                <Flex align="center" gap="1">
                                  {v.delta > 0 ? (
                                    <TrendingUp size={12} style={{ color: COLORS.green }} />
                                  ) : v.delta < 0 ? (
                                    <TrendingDown size={12} style={{ color: COLORS.red }} />
                                  ) : (
                                    <Minus size={12} style={{ color: "var(--gray-9)" }} />
                                  )}
                                  <Text
                                    size="1"
                                    style={{
                                      color: v.delta > 0 ? COLORS.green : v.delta < 0 ? COLORS.red : "var(--gray-9)",
                                    }}
                                  >
                                    {v.delta > 0 ? "+" : ""}
                                    {v.delta}%
                                  </Text>
                                </Flex>
                              )}
                              <Text size="1" color="gray">{v.evals} eval{v.evals !== 1 ? "s" : ""}</Text>
                            </Flex>
                          </Flex>
                        </Box>
                      ))}
                    </Flex>
                  ) : (
                    // Show as bar chart when many versions
                    <Box style={{ height: 200 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={promptVersionStats} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                          <CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
                          <XAxis
                            dataKey="label"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "#8b949e", fontSize: 10 }}
                          />
                          <YAxis
                            domain={[0, 100]}
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "#8b949e", fontSize: 10 }}
                            tickFormatter={(v: number) => `${v}%`}
                          />
                          <ReTooltip
                            contentStyle={TOOLTIP_STYLE}
                            formatter={(v: number, _: string, props: any) => [
                              `${v}% (${props.payload.evals} evals)`,
                              "Pass Rate",
                            ]}
                          />
                          <Bar dataKey="avgPassRate" radius={[4, 4, 0, 0]}>
                            {promptVersionStats.map((entry, index) => (
                              <Cell key={index} fill={getPassRateColor(entry.avgPassRate)} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </Box>
                  )}
                </Box>
              </Flex>
            </Box>
          )}
        </Card>

        {/* Filters */}
        <Flex gap="3" align="center">
          <TextField.Root
            placeholder="Search evaluations..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ flex: 1 }}
          />
          <Select.Root value={statusFilter} onValueChange={setStatusFilter}>
            <Select.Trigger placeholder="Filter by status" style={{ width: 200 }} />
            <Select.Content>
              <Select.Item value="all">All Statuses</Select.Item>
              <Select.Item value="completed">Completed</Select.Item>
              <Select.Item value="running">Running</Select.Item>
              <Select.Item value="failed">Failed</Select.Item>
              <Select.Item value="pending">Pending</Select.Item>
            </Select.Content>
          </Select.Root>
          <Select.Root value={agentFilter} onValueChange={setAgentFilter}>
            <Select.Trigger placeholder="Filter by agent" style={{ width: 200 }} />
            <Select.Content>
              <Select.Item value="all">All Agents</Select.Item>
              {agents.map((a) => (
                <Select.Item key={a.id} value={a.id}>
                  {a.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Flex>

        {/* Table */}
        {loading ? (
          <Flex justify="center" align="center" style={{ minHeight: 200 }}>
            <Text color="gray">Loading evaluations...</Text>
          </Flex>
        ) : filteredEvaluations.length === 0 ? (
          <Card>
            <Flex align="center" justify="center" style={{ minHeight: 200 }} direction="column" gap="2">
              <Text color="gray">No evaluations yet</Text>
              <Button onClick={() => setRunDialogOpen(true)}>Run First Evaluation</Button>
            </Flex>
          </Card>
        ) : (
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  {compareMode && <Table.ColumnHeaderCell style={{ width: 40 }}></Table.ColumnHeaderCell>}
                  <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Agent</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Dataset</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Pass Rate</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Prompt</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Duration</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredEvaluations.map((evaluation) => {
                  const total = evaluation.passed_count + (evaluation.failed_tests ?? 0);
                  const passRate = total > 0 ? Math.round((evaluation.passed_count / total) * 100) : 0;
                  const statusStyle = getStatusColor(evaluation.status);
                  const isSelected = compareSelections.includes(evaluation.id);

                  return (
                    <Table.Row
                      key={evaluation.id}
                      style={{
                        cursor: "pointer",
                        background: isSelected ? COLORS.blueBg : undefined,
                      }}
                    >
                      {compareMode && (
                        <Table.Cell>
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleCompareSelection(evaluation.id)}
                            onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          />
                        </Table.Cell>
                      )}
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="2" weight="medium">
                          {evaluation.name || `Evaluation ${evaluation.id.slice(0, 8)}`}
                        </Text>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="2">{agentMap[evaluation.agent_id] || evaluation.agent_id.slice(0, 12)}</Text>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="2">
                          {datasetMap[evaluation.dataset_id] || evaluation.dataset_id.slice(0, 12)}
                        </Text>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Badge
                          style={{
                            backgroundColor: statusStyle.bg,
                            color: statusStyle.color,
                            textTransform: "capitalize",
                          }}
                        >
                          {evaluation.status}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        {total > 0 ? (
                          <Flex align="center" gap="2" style={{ minWidth: 120 }}>
                            <Box style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--gray-4)" }}>
                              <Box
                                style={{
                                  height: 6,
                                  borderRadius: 3,
                                  width: `${passRate}%`,
                                  background: getPassRateColor(passRate),
                                  transition: "width 0.3s",
                                }}
                              />
                            </Box>
                            <Text
                              size="1"
                              weight="bold"
                              style={{ color: getPassRateColor(passRate), minWidth: 36 }}
                            >
                              {passRate}%
                            </Text>
                          </Flex>
                        ) : (
                          <Text size="1" color="gray">—</Text>
                        )}
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="1" color="gray">
                          {evaluation.prompt_version ? `v${evaluation.prompt_version}` : "—"}
                        </Text>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="1" style={{ fontFamily: "monospace" }}>
                          {formatDuration(evaluation.started_at, evaluation.completed_at)}
                        </Text>
                      </Table.Cell>
                      <Table.Cell onClick={() => navigate(`/evaluations/${evaluation.id}`)}>
                        <Text size="1" color="gray">{timeAgo(evaluation.created_at)}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex gap="2">
                          <Button
                            size="1"
                            variant="soft"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/evaluations/${evaluation.id}`);
                            }}
                          >
                            <Eye size={14} style={{ marginRight: 4 }} />
                            View
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            color="red"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(evaluation);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Card>
        )}
      </Flex>

      {/* Run Evaluation Dialog */}
      <Dialog.Root open={runDialogOpen} onOpenChange={setRunDialogOpen}>
        <Dialog.Content style={{ maxWidth: 500 }}>
          <Dialog.Title>Run Evaluation</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Select an agent and dataset to start a new evaluation run
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <Box>
              <Text as="label" size="2" weight="bold" style={{ display: "block", marginBottom: 4 }}>
                Agent *
              </Text>
              <Select.Root value={selectedAgent} onValueChange={setSelectedAgent}>
                <Select.Trigger placeholder="Select agent..." style={{ width: "100%" }} />
                <Select.Content>
                  {agents.map((a) => (
                    <Select.Item key={a.id} value={a.id}>
                      {a.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
            <Box>
              <Text as="label" size="2" weight="bold" style={{ display: "block", marginBottom: 4 }}>
                Dataset *
              </Text>
              <Select.Root value={selectedDataset} onValueChange={setSelectedDataset}>
                <Select.Trigger placeholder="Select dataset..." style={{ width: "100%" }} />
                <Select.Content>
                  {datasets.map((d) => (
                    <Select.Item key={d.id} value={d.id}>
                      {d.seed?.name || d.id} ({d.test_case_ids?.length || 0} test cases)
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
          </Flex>
          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={isRunning}>Cancel</Button>
            </Dialog.Close>
            <Button onClick={handleRunEvaluation} disabled={!selectedAgent || !selectedDataset || isRunning}>
              <Play size={16} style={{ marginRight: 6 }} />
              {isRunning ? "Starting..." : "Run Evaluation"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* Delete Confirmation Dialog */}
      <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <Dialog.Content style={{ maxWidth: 450 }}>
          <Dialog.Title>Delete Evaluation?</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            This will permanently delete "{deleteTarget?.name}" and all its results. This cannot be undone.
          </Dialog.Description>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button color="red" onClick={handleDelete}>Delete</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Box>
  );
}
