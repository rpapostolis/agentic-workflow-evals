import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useMemo } from "react";
import { Box, Card, Flex, Text, Badge } from "@radix-ui/themes";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CircleNotch,
  Trash,
  DotsThree,
  Play,
  TrendUp,
  TrendDown,
  Minus,
  CheckCircle,
  ChartLine,
  Lightning,
  Target,
  Timer,
  Warning,
  Gear,
  CaretDown,
} from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge as ShadBadge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SearchFilterControls,
} from "@/components/shared/SearchFilterControls";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import { toast } from "sonner";
import { useTableState } from "@/hooks/useTableState";
import { apiClient, TrendDataPoint, FailurePatterns, JudgeConfig } from "@/lib/api";
import { API_BASE_URL } from "@/lib/config";
import { Agent } from "@/lib/types";
import { useAgentEvaluations } from "@/hooks/useAgentEvaluations";
import { useDatasets } from "@/hooks/useDatasets";
import { useSelectableClick } from "@/hooks/useSelectableClick";
import { useDemoMode } from "@/contexts/DemoModeContext";

// ─── Shared styles (match AnalyticsPage) ────────────────────────────

const TOOLTIP_STYLE = {
  background: "var(--card)",
  backdropFilter: "blur(8px)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--foreground)",
  padding: "10px 14px",
  fontSize: 12,
  boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
};

const CARD_STYLE = { background: "var(--card)", border: "1px solid var(--border)" };

const COLORS = {
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  blue: "#58a6ff",
  purple: "#bc8cff",
  orange: "#f0883e",
  cyan: "#56d364",
};

function passRateColor(rate: number): string {
  if (rate >= 80) return COLORS.green;
  if (rate >= 50) return COLORS.yellow;
  return COLORS.red;
}

// ─── Stat Card (same pattern as AnalyticsPage) ─────────────────────

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

// ─── Score Ring ─────────────────────────────────────────────────────

function ScoreRing({ value, size = 22, strokeWidth = 3, color }: {
  value: number; size?: number; strokeWidth?: number; color: string;
}) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (value / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
    </svg>
  );
}

// ─── Trend badge ────────────────────────────────────────────────────

function TrendBadge({ direction }: { direction: "up" | "down" | "stable" }) {
  const icon = direction === "up"
    ? <TrendUp size={12} weight="bold" />
    : direction === "down"
      ? <TrendDown size={12} weight="bold" />
      : <Minus size={12} />;
  const color = direction === "up" ? COLORS.green : direction === "down" ? COLORS.red : "var(--muted-foreground)";
  const label = direction === "up" ? "Improving" : direction === "down" ? "Declining" : "Stable";
  return (
    <Flex align="center" gap="1" style={{ color }}>
      {icon}
      <Text size="1" style={{ color }}>{label}</Text>
    </Flex>
  );
}

// ─── Config Row ─────────────────────────────────────────────────────

function ConfigRow({ label, value, color, mono }: {
  label: string; value: string; color?: string; mono?: boolean;
}) {
  return (
    <Flex align="baseline" gap="2" py="1">
      <Text size="1" style={{ color: "var(--muted-foreground)", minWidth: 90, flexShrink: 0 }}>{label}</Text>
      <Text size="1" weight="bold" style={{
        color: color || "var(--foreground)",
        fontFamily: mono ? "var(--code-font-family, monospace)" : undefined,
        wordBreak: "break-all",
      }}>{value}</Text>
    </Flex>
  );
}

// ═══════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePrompt, setActivePrompt] = useState<any | null>(null);
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false);

  // Analytics state
  const [trends, setTrends] = useState<TrendDataPoint[]>([]);
  const [failurePatterns, setFailurePatterns] = useState<FailurePatterns | null>(null);

  // Config state
  const [agentHealth, setAgentHealth] = useState<Record<string, any> | null>(null);
  const [llmConfig, setLlmConfig] = useState<Record<string, any> | null>(null);
  const [judgeConfig, setJudgeConfig] = useState<JudgeConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [judgeHealth, setJudgeHealth] = useState<{ llmReachable: boolean; modelAvailable: boolean; isCloud: boolean } | null>(null);
  const [configExpanded, setConfigExpanded] = useState(() => {
    try { return localStorage.getItem("agentDetail.configExpanded") !== "false"; } catch { return true; }
  });
  const toggleConfig = () => setConfigExpanded(prev => {
    const next = !prev;
    try { localStorage.setItem("agentDetail.configExpanded", String(next)); } catch {}
    return next;
  });

  // Filter and sort state
  const [selectedDatasetFilters, setSelectedDatasetFilters] = useState<string[]>([]);

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [evaluationToDelete, setEvaluationToDelete] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Run evaluation state
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [verboseLogging, setVerboseLogging] = useState(false);
  const { isDemoMode } = useDemoMode();
  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [isRunningEvaluation, setIsRunningEvaluation] = useState(false);
  const { createClickHandler } = useSelectableClick();

  const {
    evaluations,
    loading: evaluationsLoading,
    refetch: refetchEvaluations,
  } = useAgentEvaluations(id);

  const {
    datasets,
    loading: datasetsLoading,
    error: datasetsError,
  } = useDatasets();

  // Fetch agent
  useEffect(() => {
    const fetchAgent = async () => {
      if (!id) { setError("Agent ID is required"); setIsLoading(false); return; }
      try {
        setIsLoading(true);
        const fetchedAgent = await apiClient.getAgent(id);
        setAgent(fetchedAgent);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load agent details");
      } finally {
        setIsLoading(false);
      }
    };
    fetchAgent();
  }, [id]);

  // Fetch active prompt
  useEffect(() => {
    const fetchActivePrompt = async () => {
      if (!id) return;
      try {
        setIsLoadingPrompt(true);
        const prompt = await apiClient.getActivePrompt(id);
        setActivePrompt(prompt);
      } catch { setActivePrompt(null); }
      finally { setIsLoadingPrompt(false); }
    };
    fetchActivePrompt();
  }, [id]);

  // Fetch analytics
  useEffect(() => {
    const fetchAnalytics = async () => {
      if (!id) return;
      try {
        const [trendData, failureData] = await Promise.all([
          apiClient.getPassRateTrends(id, 30).catch(() => []),
          apiClient.getFailurePatterns(id).catch(() => null),
        ]);
        setTrends(trendData);
        setFailurePatterns(failureData);
      } catch {}
    };
    fetchAnalytics();
  }, [id]);

  // Fetch agent health + LLM config + judge config (parallel)
  useEffect(() => {
    if (!agent) return;
    const fetchConfig = async () => {
      const healthEndpoint = agent.agent_invocation_url.replace(/\/invoke$/, "/health");
      const [healthResult, cfgResult, judgeResult] = await Promise.allSettled([
        fetch(healthEndpoint, { signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null),
        fetch(`${API_BASE_URL}/config/llm`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null),
        apiClient.getActiveJudgeConfig(),
      ]);
      if (healthResult.status === "fulfilled" && healthResult.value) setAgentHealth(healthResult.value);
      const cfg = cfgResult.status === "fulfilled" ? cfgResult.value : null;
      if (cfg) setLlmConfig(cfg);
      if (judgeResult.status === "fulfilled" && judgeResult.value) setJudgeConfig(judgeResult.value);
      setConfigLoaded(true);

      // Probe judge LLM health
      if (cfg?.base_url && cfg?.model) {
        const isCloud = /anthropic\.com|openai\.com/.test(cfg.base_url);
        if (isCloud) {
          // Cloud APIs are always reachable and models are always "available" —
          // no local pull needed. Auth errors surface at eval time, not here.
          setJudgeHealth({ llmReachable: true, modelAvailable: true, isCloud: true });
        } else {
          // Ollama: hit /api/tags to check reachability and whether the model is pulled
          try {
            const ollamaBase = cfg.base_url.replace(/\/v1\/?$/, "");
            const tagsRes = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
            if (tagsRes.ok) {
              const tags = await tagsRes.json();
              const modelNames: string[] = (tags.models || []).map((m: any) => m.name || "");
              const modelBase = cfg.model.split(":")[0];
              const found = modelNames.some((n: string) => n.includes(modelBase));
              setJudgeHealth({ llmReachable: true, modelAvailable: found, isCloud: false });
            } else {
              setJudgeHealth({ llmReachable: false, modelAvailable: false, isCloud: false });
            }
          } catch {
            setJudgeHealth({ llmReachable: false, modelAvailable: false, isCloud: false });
          }
        }
      }
    };
    fetchConfig();
  }, [agent]);

  // Process evaluations
  const processedEvaluations = useMemo(() => {
    if (!evaluations || !datasets) return { entries: [], datasets: [] };

    const getDatasetName = (datasetId: string) => {
      const dataset = datasets?.find((s) => s.id === datasetId);
      return dataset?.seed?.name || "Unknown Dataset";
    };

    const entries = evaluations.map((evaluation) => {
      const passRate = evaluation.total_tests > 0
        ? (evaluation.passed_count / evaluation.total_tests) * 100 : 0;
      const datasetName = getDatasetName(evaluation.dataset_id);
      const evaluationDate = new Date(evaluation.created_at);
      let durationMs: number | null = null;
      if (evaluation.started_at && evaluation.completed_at) {
        durationMs = new Date(evaluation.completed_at).getTime() - new Date(evaluation.started_at).getTime();
      }
      return {
        ...evaluation,
        passRate,
        passRateDisplay: `${Math.round(passRate)}%`,
        datasetName,
        date: evaluationDate,
        durationMs,
        dateDisplay: `${evaluationDate.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}, ${evaluationDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`,
      };
    });

    const uniqueDatasets = Array.from(new Set(entries.map((e) => e.datasetName))).sort();
    return { entries, datasets: uniqueDatasets };
  }, [evaluations, datasets]);

  // Derived stats
  const stats = useMemo(() => {
    const completed = processedEvaluations.entries.filter((e) => e.status === "completed");
    if (completed.length === 0) return {
      totalRuns: 0, completed: 0, avgPassRate: 0, latestPassRate: 0,
      trend: "stable" as const, totalTests: 0, avgDuration: null as number | null,
      passedTotal: 0, failedTotal: 0, assertionModes: {} as Record<string, number>,
    };

    const avgPassRate = completed.reduce((s, e) => s + e.passRate, 0) / completed.length;
    const latestPassRate = completed[0]?.passRate ?? 0;
    const prevPassRate = completed[1]?.passRate;
    const passedTotal = completed.reduce((s, e) => s + e.passed_count, 0);
    const failedTotal = completed.reduce((s, e) => s + (e.total_tests - e.passed_count), 0);
    const totalTests = completed.reduce((s, e) => s + e.total_tests, 0);
    const durations = completed.map((e) => e.durationMs).filter((d): d is number => d !== null);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    let trend: "up" | "down" | "stable" = "stable";
    if (prevPassRate !== undefined) {
      if (latestPassRate > prevPassRate + 2) trend = "up";
      else if (latestPassRate < prevPassRate - 2) trend = "down";
    }

    const assertionModes: Record<string, number> = {};
    for (const ev of completed) {
      if (ev.test_cases) {
        for (const tc of ev.test_cases) {
          const mode = tc.assertion_mode || "response_only";
          assertionModes[mode] = (assertionModes[mode] || 0) + 1;
        }
      }
    }

    return {
      totalRuns: processedEvaluations.entries.length, completed: completed.length,
      avgPassRate, latestPassRate, trend, totalTests, avgDuration,
      passedTotal, failedTotal, assertionModes,
    };
  }, [processedEvaluations]);

  // Pass/fail chart data
  const passFailData = useMemo(() => {
    return processedEvaluations.entries
      .filter((e) => e.status === "completed")
      .slice(0, 10)
      .reverse()
      .map((e, i) => ({
        name: `#${i + 1}`,
        passed: e.passed_count,
        failed: e.total_tests - e.passed_count,
        passRate: Math.round(e.passRate),
        evalName: e.name,
      }));
  }, [processedEvaluations]);

  // Assertion mode pie data
  const assertionPieData = useMemo(() => {
    const modeColors: Record<string, string> = {
      response_only: COLORS.blue,
      hybrid: COLORS.purple,
      tool_level: COLORS.orange,
    };
    return Object.entries(stats.assertionModes).map(([mode, count]) => ({
      name: mode.replace("_", " "),
      value: count,
      fill: modeColors[mode] || COLORS.cyan,
    }));
  }, [stats.assertionModes]);

  // Table state
  const {
    searchTerm, setSearchTerm, sortOrder, handleSort,
    filteredData: filteredEvaluations,
  } = useTableState({
    data: processedEvaluations.entries,
    searchFields: ["name"],
    defaultSortField: "date",
    initialSortOrder: "desc",
    customSortFunction: (a: any, b: any, order: "asc" | "desc" | "none") => {
      const d = b.date.getTime() - a.date.getTime();
      return (order === "desc" || order === "none") ? d : -d;
    },
    filters: {
      dataset: { getValue: (e: any) => e.datasetName, selectedValues: selectedDatasetFilters },
    },
  });

  const handleDeleteEvaluation = (evaluation: any) => {
    setEvaluationToDelete(evaluation);
    // Delay until DropdownMenu closes — its close event fires
    // "interact outside" on the AlertDialog immediately.
    requestAnimationFrame(() => setDeleteDialogOpen(true));
  };

  const handleEvaluationClick = createClickHandler((evaluationId: string) => {
    navigate(`/evaluations/${evaluationId}`);
  });

  const confirmDeleteEvaluation = async () => {
    if (!evaluationToDelete) return;
    setIsDeleting(true);
    try {
      await apiClient.deleteEvaluation(evaluationToDelete.id);
      toast.success("Evaluation deleted successfully");
      setDeleteDialogOpen(false);
      setEvaluationToDelete(null);
      await refetchEvaluations();
    } catch { toast.error("Failed to delete evaluation"); }
    finally { setIsDeleting(false); }
  };

  const handleStartEvaluation = async () => {
    if (!selectedDataset || !agent) { toast.error("Please select a dataset first"); return; }
    setIsRunningEvaluation(true);
    try {
      const dataset = datasets?.find((s) => s.id === selectedDataset);
      if (!dataset) { toast.error("Dataset not found"); return; }
      const evaluationRun = await apiClient.createEvaluation({
        name: `${agent.name} - ${dataset.seed.name}`,
        dataset_id: selectedDataset,
        agent_id: agent.id,
        agent_endpoint: agent.agent_invocation_url,
        agent_auth_required: true,
        timeout_seconds: 300,
        verbose_logging: verboseLogging,
        demo_mode: false,
      });
      toast.success(`Evaluation started: ${evaluationRun.name}`, {
        description: `Running ${dataset.test_case_ids.length} test cases`,
      });
      setRunDialogOpen(false);
      setSelectedDataset("");
      setVerboseLogging(false);
      navigate(`/evaluations/${evaluationRun.id}`);
    } catch (err) {
      toast.error("Failed to start evaluation", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally { setIsRunningEvaluation(false); }
  };

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  }

  // Loading / error states
  if (isLoading) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ minHeight: "60vh" }}>
        <CircleNotch size={48} className="animate-spin text-primary" style={{ marginBottom: 16 }} />
        <Text size="2" style={{ color: "var(--muted-foreground)" }}>Loading agent details...</Text>
      </Flex>
    );
  }

  if (error || !agent) {
    return (
      <Box>
        <Button variant="ghost" size="sm" onClick={() => navigate("/agents")} className="gap-2 mb-4">
          <ArrowLeft size={16} /> Back to Agents
        </Button>
        <Alert><AlertDescription>{error || "Agent not found"}</AlertDescription></Alert>
      </Box>
    );
  }

  const hasEvals = processedEvaluations.entries.length > 0;
  const hasCompleted = stats.completed > 0;

  return (
    <Flex direction="column" gap="5">
      {/* ── Header ──────────────────────────────── */}
      <Flex justify="between" align="start" gap="4">
        <Flex direction="column" gap="1" style={{ flex: 1 }}>
          <button
            onClick={() => navigate("/agents")}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-1 bg-transparent border-none cursor-pointer p-0"
          >
            <ArrowLeft size={14} /> Back to Agents
          </button>
          <Text size="6" weight="bold" style={{ color: "var(--foreground)" }}>{agent.name}</Text>
          {agent.description && (
            <Text size="2" style={{ color: "var(--muted-foreground)" }}>{agent.description}</Text>
          )}
          <Flex gap="2" align="center" wrap="wrap" pt="2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => navigate(`/agents/${id}/prompts`)}>
              Prompt Lab
            </Button>
            {!isLoadingPrompt && activePrompt && (
              <Badge color="green" variant="soft" size="1">Prompt v{activePrompt.version} active</Badge>
            )}
            {!isLoadingPrompt && !activePrompt && (
              <Badge color="orange" variant="soft" size="1">No prompt</Badge>
            )}
            {agent.model && (
              <Badge variant="soft" size="1">{agent.model}</Badge>
            )}
            {(() => {
              const raw = agent.created_at || agent.createdAt;
              if (!raw) return null;
              const d = new Date(raw);
              if (isNaN(d.getTime())) return null;
              return (
                <Text size="1" style={{ color: "var(--muted-foreground)" }}>
                  Registered {d.toLocaleDateString()}
                </Text>
              );
            })()}
          </Flex>
        </Flex>
        <Button onClick={() => setRunDialogOpen(true)} className="gap-2">
          <Play size={16} /> Run Evaluation
        </Button>
      </Flex>

      {/* ── Collapsible Config Section ── */}
      <Card style={{ ...CARD_STYLE, overflow: "hidden" }}>
        <button
          onClick={toggleConfig}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 8,
            padding: "10px 14px", cursor: "pointer",
            background: "transparent", border: "none", color: "var(--foreground)",
            fontSize: 13, fontWeight: 600, fontFamily: "inherit",
          }}
        >
          <CaretDown
            size={14}
            weight="bold"
            style={{
              transition: "transform 0.2s ease",
              transform: configExpanded ? "rotate(0deg)" : "rotate(-90deg)",
              color: "var(--muted-foreground)",
            }}
          />
          Configuration
          <Flex gap="2" ml="auto" align="center">
            {agentHealth && (
              <Badge color={agentHealth.status === "ok" ? "green" : "red"} variant="soft" size="1">
                Agent {agentHealth.status === "ok" ? "✓" : "✗"}
              </Badge>
            )}
            {judgeHealth && (
              <Badge color={judgeHealth.llmReachable && judgeHealth.modelAvailable ? "green" : "red"} variant="soft" size="1">
                Judge {judgeHealth.llmReachable && judgeHealth.modelAvailable ? "✓" : "✗"}
              </Badge>
            )}
          </Flex>
        </button>

        <div style={{
          maxHeight: configExpanded ? 800 : 0,
          opacity: configExpanded ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.3s ease, opacity 0.2s ease",
          padding: configExpanded ? "0 14px 14px" : "0 14px",
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* AGENT — the LLM that executes browser tasks */}
        <Card style={CARD_STYLE}>
          <Box p="3">
            <Flex align="center" gap="2" mb="3">
              <Box style={{ width: 22, height: 22, borderRadius: 5, background: `${COLORS.blue}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Lightning size={12} style={{ color: COLORS.blue }} />
              </Box>
              <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Agent</Text>
              <Text size="1" style={{ color: "var(--muted-foreground)" }}>executes tasks</Text>
              {agentHealth ? (
                <Badge
                  color={agentHealth.status === "ok" ? "green" : "yellow"}
                  variant="soft"
                  size="1"
                  style={{ marginLeft: "auto" }}
                >
                  {agentHealth.status === "ok" ? "Healthy" : "Degraded"}
                </Badge>
              ) : (
                <Badge color="gray" variant="soft" size="1" style={{ marginLeft: "auto" }}>Connecting...</Badge>
              )}
            </Flex>

            {/* Health indicators */}
            {agentHealth && (
              <Flex gap="2" mb="3" wrap="wrap">
                {[
                  { label: "Playwright", ok: agentHealth.playwright_ready },
                  { label: "Ollama", ok: agentHealth.ollama_reachable },
                ].map(svc => (
                  <Flex key={svc.label} align="center" gap="1" px="2" py="1"
                    style={{
                      borderRadius: 6, fontSize: 11, fontWeight: 500,
                      background: svc.ok ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)",
                      border: `1px solid ${svc.ok ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}`,
                      color: svc.ok ? COLORS.green : COLORS.red,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: svc.ok ? COLORS.green : COLORS.red }} />
                    {svc.label}
                  </Flex>
                ))}
                {agentHealth?.active_tasks > 0 && (
                  <Flex align="center" gap="1" px="2" py="1"
                    style={{ borderRadius: 6, fontSize: 11, fontWeight: 500, background: "rgba(88,166,255,0.08)", border: "1px solid rgba(88,166,255,0.2)", color: COLORS.blue }}
                  >
                    {agentHealth.active_tasks} active task{agentHealth.active_tasks !== 1 ? "s" : ""}
                  </Flex>
                )}
              </Flex>
            )}

            <Flex direction="column" gap="0" mb="3">
              <ConfigRow label="Model" value={(agentHealth?.model || agent.model || "—").replace(/^ollama\//, "")} color={COLORS.blue} />
              <ConfigRow label="Endpoint" value={agent.agent_invocation_url} mono />
              {agentHealth?.ollama_host && <ConfigRow label="Ollama Host" value={agentHealth.ollama_host} mono />}
            </Flex>

            {/* System Prompt */}
            <div
              onClick={() => navigate(`/agents/${id}/prompts?tab=current`)}
              style={{
                padding: "8px 10px", borderRadius: 6, cursor: "pointer",
                background: activePrompt ? "rgba(88,166,255,0.06)" : "var(--secondary)",
                border: `1px solid ${activePrompt ? "rgba(88,166,255,0.15)" : "var(--border)"}`,
                transition: "all 0.15s",
              }}
            >
              <Flex align="center" justify="between" mb="1">
                <Flex align="center" gap="1">
                  <Text size="1" weight="bold" style={{ color: "var(--foreground)" }}>System Prompt</Text>
                  {activePrompt && (
                    <Badge color="blue" variant="soft" size="1">v{activePrompt.version}</Badge>
                  )}
                </Flex>
                <Text size="1" style={{ color: COLORS.blue, fontSize: 10 }}>
                  {activePrompt ? "Prompt Lab →" : "Create in Prompt Lab →"}
                </Text>
              </Flex>
              {activePrompt?.system_prompt ? (
                <Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden", lineHeight: "1.4" }}>
                  {activePrompt.system_prompt.slice(0, 150)}{activePrompt.system_prompt.length > 150 ? "…" : ""}
                </Text>
              ) : (
                <Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11, fontStyle: "italic" }}>
                  No system prompt defined yet
                </Text>
              )}
            </div>

            {/* Issues */}
            {agentHealth?.issues && agentHealth.issues.length > 0 && (
              <Box mt="2" p="2" style={{ borderRadius: 6, background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.15)" }}>
                {agentHealth.issues.map((issue: string, i: number) => (
                  <Text key={i} size="1" style={{ color: COLORS.red, display: "block" }}>{issue}</Text>
                ))}
              </Box>
            )}
          </Box>
        </Card>

        {/* JUDGE — the separate LLM that scores agent output */}
        <Card style={CARD_STYLE}>
          <Box p="3">
            <Flex align="center" gap="2" mb="3">
              <Box style={{ width: 22, height: 22, borderRadius: 5, background: `${COLORS.purple}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Target size={12} style={{ color: COLORS.purple }} />
              </Box>
              <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Judge</Text>
              <Text size="1" style={{ color: "var(--muted-foreground)" }}>scores results</Text>
              {judgeHealth ? (
                <Badge color={judgeHealth.llmReachable && judgeHealth.modelAvailable ? "green" : "red"} variant="soft" size="1" style={{ marginLeft: "auto" }}>
                  {judgeHealth.llmReachable && judgeHealth.modelAvailable ? "Healthy" : "Degraded"}
                </Badge>
              ) : configLoaded ? (
                <Badge color="gray" variant="soft" size="1" style={{ marginLeft: "auto" }}>Unknown</Badge>
              ) : (
                <Badge color="gray" variant="soft" size="1" style={{ marginLeft: "auto" }}>Connecting...</Badge>
              )}
            </Flex>

            {/* Health indicators */}
            {judgeHealth && (
              <Flex gap="2" mb="3" wrap="wrap">
                {[
                  { label: judgeHealth.isCloud ? "API Endpoint" : "LLM Endpoint", ok: judgeHealth.llmReachable },
                  { label: judgeHealth.isCloud ? "Model Ready"  : "Model Pulled",  ok: judgeHealth.modelAvailable },
                ].map(svc => (
                  <Flex key={svc.label} align="center" gap="1" px="2" py="1"
                    style={{
                      borderRadius: 6, fontSize: 11, fontWeight: 500,
                      background: svc.ok ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)",
                      border: `1px solid ${svc.ok ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}`,
                      color: svc.ok ? COLORS.green : COLORS.red,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: svc.ok ? COLORS.green : COLORS.red }} />
                    {svc.label}
                  </Flex>
                ))}
              </Flex>
            )}

            <Flex direction="column" gap="0" mb="3">
              <ConfigRow label="Model" value={llmConfig?.model || (configLoaded ? "Not configured" : "Loading…")} color={COLORS.purple} />
              {llmConfig?.base_url && <ConfigRow label="Base URL" value={llmConfig.base_url} mono />}
              {judgeConfig && <ConfigRow label="Scoring" value={judgeConfig.scoring_mode === "rubric" ? "Rubric" : "Binary (Pass/Fail)"} />}
            </Flex>

            {/* Judge Prompt */}
            <div
              onClick={() => navigate("/judge-config?tab=system")}
              style={{
                padding: "8px 10px", borderRadius: 6, cursor: "pointer",
                background: judgeConfig ? "rgba(188,140,255,0.06)" : "var(--secondary)",
                border: `1px solid ${judgeConfig ? "rgba(188,140,255,0.15)" : "var(--border)"}`,
                transition: "all 0.15s",
              }}
            >
              <Flex align="center" justify="between" mb="1">
                <Flex align="center" gap="1">
                  <Text size="1" weight="bold" style={{ color: "var(--foreground)" }}>Judge Prompt</Text>
                  {judgeConfig && (
                    <Badge color="purple" variant="soft" size="1">{judgeConfig.name} v{judgeConfig.version}</Badge>
                  )}
                </Flex>
                <Text size="1" style={{ color: COLORS.purple, fontSize: 10 }}>
                  {judgeConfig ? "Configure →" : "Set up →"}
                </Text>
              </Flex>
              {judgeConfig?.system_prompt ? (
                <Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden", lineHeight: "1.4" }}>
                  {judgeConfig.system_prompt.slice(0, 150)}{judgeConfig.system_prompt.length > 150 ? "…" : ""}
                </Text>
              ) : (
                <Text size="1" style={{ color: "var(--muted-foreground)", fontSize: 11, fontStyle: "italic" }}>
                  No judge prompt configured
                </Text>
              )}
            </div>
          </Box>
        </Card>
          </div>
        </div>
      </Card>

      {/* ── Stats + Trend Row ─────────────────────── */}
      <div style={{ display: "flex", gap: 12 }}>
        {/* Left: KPIs 2×2 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, flex: "0 0 auto", width: 340 }}>
          <StatCard icon={Target} label="Avg Pass Rate"
            value={hasCompleted ? `${Math.round(stats.avgPassRate)}%` : "—"}
            sub={hasCompleted ? `Latest: ${Math.round(stats.latestPassRate)}%` : "No evaluations yet"}
            color={hasCompleted ? passRateColor(stats.avgPassRate) : "var(--muted-foreground)"} />
          <StatCard icon={Lightning} label="Evaluations"
            value={stats.completed || 0}
            sub={hasCompleted ? `${stats.totalTests} total test runs` : "Run your first evaluation"}
            color={COLORS.blue} />
          <StatCard icon={CheckCircle} label="Passed"
            value={stats.passedTotal || 0}
            sub={hasCompleted ? `${stats.failedTotal} failed` : "—"}
            color={COLORS.green} />
          <StatCard icon={Timer} label="Avg Duration"
            value={stats.avgDuration !== null ? formatDuration(stats.avgDuration) : "—"}
            sub={hasCompleted ? "per evaluation" : "—"}
            color={COLORS.cyan} />
        </div>

        {/* Right: 30-Day Trend */}
        <Card style={{ ...CARD_STYLE, flex: 1, minWidth: 0 }}>
          <Box p="3" style={{ height: "100%" }}>
            <Flex align="center" justify="between" mb="1">
              <Flex align="center" gap="2">
                <ChartLine size={14} style={{ color: "var(--muted-foreground)" }} />
                <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Pass Rate Trend</Text>
              </Flex>
              {hasCompleted && <TrendBadge direction={stats.trend} />}
            </Flex>
            <Box style={{ height: "calc(100% - 28px)", minHeight: 100 }}>
              {trends.length >= 2 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trends} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                    <defs>
                      <linearGradient id="agentTrendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.green} stopOpacity={0.2} />
                        <stop offset="100%" stopColor={COLORS.green} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: "#8b949e", fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
                    <ReTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${Math.round(v)}%`, "Pass Rate"]} />
                    <Area type="monotone" dataKey="avg_pass_rate" stroke={COLORS.green} fill="url(#agentTrendGrad)" strokeWidth={2} dot={false}
                      activeDot={{ r: 3, fill: COLORS.green, stroke: "#0d1117", strokeWidth: 2 }} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Flex align="center" justify="center" style={{ height: "100%", opacity: 0.5 }}>
                  <Text size="1" style={{ color: "var(--muted-foreground)" }}>
                    {hasEvals ? "Need 2+ data points for trend" : "Trend data will appear after evaluations"}
                  </Text>
                </Flex>
              )}
            </Box>
          </Box>
        </Card>
      </div>

      {/* ── Charts Row (pass/fail + assertion modes) ── */}
      {hasCompleted && passFailData.length >= 2 && (
        <div style={{ display: "grid", gridTemplateColumns: assertionPieData.length > 0 ? "2fr 1fr" : "1fr", gap: 12 }}>
          {/* Pass/Fail per Evaluation */}
          <Card style={CARD_STYLE}>
            <Box p="3">
              <Flex align="center" justify="between" mb="2">
                <Flex align="center" gap="2">
                  <Box style={{ width: 22, height: 22, borderRadius: 5, background: `${COLORS.green}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ChartLine size={12} style={{ color: COLORS.green }} />
                  </Box>
                  <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Pass / Fail by Evaluation</Text>
                </Flex>
                <Text size="1" style={{ color: "var(--muted-foreground)" }}>{passFailData.length} recent runs</Text>
              </Flex>
              <Box style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={passFailData} barSize={24}>
                    <CartesianGrid vertical={false} stroke="rgba(48,54,61,0.4)" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <ReTooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, name: string) => [v, name === "passed" ? "Passed" : "Failed"]}
                      labelFormatter={(_: string, p: any[]) => p?.[0]?.payload?.evalName || _}
                    />
                    <Bar dataKey="passed" stackId="a" fill={COLORS.green} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="failed" stackId="a" fill={COLORS.red} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </Box>
          </Card>

          {/* Assertion Modes */}
          {assertionPieData.length > 0 && (
            <Card style={CARD_STYLE}>
              <Box p="3">
                <Flex align="center" gap="2" mb="2">
                  <Box style={{ width: 22, height: 22, borderRadius: 5, background: `${COLORS.purple}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Target size={12} style={{ color: COLORS.purple }} />
                  </Box>
                  <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Assertion Modes</Text>
                </Flex>
                <Flex align="center" gap="3" mt="4">
                  <Box style={{ width: 90, height: 90 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={assertionPieData} cx="50%" cy="50%" innerRadius={25} outerRadius={40}
                          paddingAngle={3} dataKey="value" strokeWidth={0}>
                          {assertionPieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </Box>
                  <Flex direction="column" gap="2">
                    {assertionPieData.map((entry) => (
                      <Flex key={entry.name} align="center" gap="2">
                        <Box style={{ width: 8, height: 8, borderRadius: 2, background: entry.fill, flexShrink: 0 }} />
                        <Text size="1" style={{ color: "var(--foreground)" }}>{entry.name}</Text>
                        <Text size="1" weight="bold" style={{ color: "var(--muted-foreground)" }}>{entry.value}</Text>
                      </Flex>
                    ))}
                  </Flex>
                </Flex>
              </Box>
            </Card>
          )}
        </div>
      )}

      {/* ── Failure Patterns ───────────────────── */}
      {failurePatterns && failurePatterns.total_annotations > 0 && failurePatterns.issue_tags.length > 0 && (
        <Card style={CARD_STYLE}>
          <Box p="3">
            <Flex align="center" gap="2" mb="2">
              <Warning size={14} style={{ color: COLORS.yellow }} />
              <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Top Issues from Annotations</Text>
              <Text size="1" style={{ color: "var(--muted-foreground)" }}>({failurePatterns.total_annotations} annotations)</Text>
            </Flex>
            <Flex gap="2" wrap="wrap">
              {failurePatterns.issue_tags.slice(0, 8).map((tag) => (
                <Flex key={tag.tag} align="center" gap="2" px="2" py="1"
                  style={{ borderRadius: 8, background: "rgba(248, 81, 73, 0.08)", border: "1px solid rgba(248, 81, 73, 0.15)" }}>
                  <Text size="1" style={{ color: "var(--foreground)" }}>{tag.tag}</Text>
                  <Text size="1" weight="bold" style={{
                    color: COLORS.red, background: "rgba(248, 81, 73, 0.12)",
                    borderRadius: 4, padding: "0 5px",
                  }}>{tag.count}</Text>
                </Flex>
              ))}
            </Flex>
          </Box>
        </Card>
      )}

      {/* ── Evaluation History ─────────────────── */}
      <Box>
        <Flex justify="between" align="center" mb="2">
          <Text size="4" weight="bold" style={{ color: "var(--foreground)" }}>Evaluation History</Text>
          {hasEvals && (
            <Text size="1" style={{ color: "var(--muted-foreground)" }}>
              {processedEvaluations.entries.length} run{processedEvaluations.entries.length !== 1 ? "s" : ""}
            </Text>
          )}
        </Flex>

        {evaluationsLoading ? (
          <Card style={CARD_STYLE}>
            <Flex direction="column" align="center" justify="center" py="6">
              <CircleNotch size={32} className="animate-spin text-primary" style={{ marginBottom: 8 }} />
              <Text size="2" style={{ color: "var(--muted-foreground)" }}>Loading evaluations...</Text>
            </Flex>
          </Card>
        ) : !hasEvals ? (
          <Card style={CARD_STYLE}>
            <Flex direction="column" align="center" justify="center" py="8">
              <Box style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                <Play size={20} style={{ color: "var(--muted-foreground)" }} />
              </Box>
              <Text size="2" weight="medium" style={{ color: "var(--muted-foreground)" }}>No evaluation runs yet</Text>
              <Text size="1" style={{ color: "var(--muted-foreground)", marginTop: 4 }}>Run your first evaluation to see performance data</Text>
              <Button onClick={() => setRunDialogOpen(true)} className="gap-2 mt-4" size="sm">
                <Play size={14} /> Run Evaluation
              </Button>
            </Flex>
          </Card>
        ) : (
          <Flex direction="column" gap="3">
            <Flex justify="between" align="start" gap="4">
              <Box style={{ flex: 1 }}>
                <SearchFilterControls
                  searchValue={searchTerm}
                  onSearchChange={setSearchTerm}
                  searchPlaceholder="Search evaluations"
                  filters={[{
                    key: "dataset",
                    placeholder: "Evaluation dataset",
                    options: processedEvaluations.datasets,
                    selectedOptions: selectedDatasetFilters,
                    onSelectionChange: setSelectedDatasetFilters,
                    multiselect: true,
                    minWidth: "200px",
                  }]}
                  sortOrder={sortOrder}
                  onSortChange={handleSort}
                  sortLabel="Latest Runs"
                />
              </Box>
            </Flex>

            {filteredEvaluations.length === 0 ? (
              <Flex direction="column" align="center" justify="center" py="6" style={{ color: "var(--muted-foreground)" }}>
                <Text size="2">No evaluations match your search criteria</Text>
                <Text size="1" style={{ marginTop: 4 }}>Try adjusting your filters or search terms</Text>
              </Flex>
            ) : (
              <Box>
                {/* Table header */}
                <div className="grid items-center text-xs text-muted-foreground"
                  style={{ gridTemplateColumns: "1fr 160px 90px 60px 60px 40px", padding: "10px 8px" }}>
                  <span>Evaluation</span>
                  <span>Dataset</span>
                  <span>Status</span>
                  <span className="text-right">Pass</span>
                  <span className="text-right">Duration</span>
                  <span />
                </div>

                {/* Table rows */}
                {filteredEvaluations.map((evaluation) => (
                  <div key={evaluation.id}
                    className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
                    style={{ gridTemplateColumns: "1fr 160px 90px 60px 60px 40px", padding: "12px 8px", cursor: "pointer", userSelect: "text" }}
                    onClick={(event) => handleEvaluationClick(evaluation.id, event)}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate text-sm">{evaluation.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {evaluation.dateDisplay}
                        {evaluation.prompt_version && (
                          <span style={{ marginLeft: 6, color: COLORS.purple, fontWeight: 600 }}>v{evaluation.prompt_version}</span>
                        )}
                      </div>
                    </div>

                    <span className="text-xs text-muted-foreground truncate">
                      {evaluation.datasetName} • {evaluation.total_tests} test{evaluation.total_tests !== 1 ? "s" : ""}
                    </span>

                    <div>
                      <ShadBadge variant="secondary" className="text-xs"
                        style={
                          evaluation.status === "completed" || evaluation.status === "passed"
                            ? { background: "rgba(63, 185, 80, 0.12)", color: COLORS.green, border: "none" }
                            : evaluation.status === "running"
                              ? { background: "rgba(88, 166, 255, 0.12)", color: COLORS.blue, border: "none" }
                              : evaluation.status === "failed"
                                ? { background: "rgba(248, 81, 73, 0.12)", color: COLORS.red, border: "none" }
                                : {}
                        }
                      >
                        {evaluation.status.charAt(0).toUpperCase() + evaluation.status.slice(1)}
                      </ShadBadge>
                    </div>

                    <div className="flex items-center justify-end gap-1">
                      {evaluation.status === "completed" ? (
                        <>
                          <ScoreRing value={evaluation.passRate} color={passRateColor(evaluation.passRate)} />
                          <span style={{ fontSize: 12, fontWeight: 600, color: passRateColor(evaluation.passRate) }}>
                            {evaluation.passRateDisplay}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>

                    <span className="text-right text-xs text-muted-foreground">
                      {evaluation.durationMs !== null ? formatDuration(evaluation.durationMs) : "—"}
                    </span>

                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <DotsThree size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); handleDeleteEvaluation(evaluation); }}
                            variant="destructive"
                          >
                            <Trash size={14} className="mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </Box>
            )}
          </Flex>
        )}
      </Box>

      {/* Delete Evaluation Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Evaluation</AlertDialogTitle>
            <AlertDialogDescription>Are you sure? This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteEvaluation} disabled={isDeleting} className="bg-red-600 hover:bg-red-700">
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run Evaluation Modal */}
      <Dialog open={runDialogOpen} onOpenChange={setRunDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Evaluation</DialogTitle>
            <DialogDescription>Select an evaluation dataset to test this agent</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="space-y-2">
              <Label htmlFor="dataset">Evaluation Dataset</Label>
              {datasetsLoading ? (
                <div className="flex items-center gap-2">
                  <CircleNotch size={16} className="animate-spin" />
                  <span className="text-sm text-muted-foreground">Loading datasets...</span>
                </div>
              ) : datasetsError ? (
                <Alert><AlertDescription>Failed to load datasets.</AlertDescription></Alert>
              ) : (
                <select
                  id="dataset" title="Select evaluation dataset"
                  value={selectedDataset}
                  onChange={(e) => setSelectedDataset(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Select a dataset</option>
                  {datasets?.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.seed.name} ({dataset.test_case_ids.length} test cases)
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <input type="checkbox" id="verboseLogging" checked={verboseLogging}
                onChange={(e) => setVerboseLogging(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
              <Label htmlFor="verboseLogging" className="text-sm font-normal cursor-pointer">
                Verbose logging (show each assertion in activity log)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunDialogOpen(false)}>Cancel</Button>
            <Button disabled={!selectedDataset || datasetsLoading || isRunningEvaluation} onClick={handleStartEvaluation}>
              {isRunningEvaluation ? (<><CircleNotch size={16} className="animate-spin mr-2" />Starting...</>) : "Run Evaluation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Flex>
  );
}
