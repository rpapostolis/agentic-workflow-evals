import { useState, useMemo, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  CircleNotch,
  NotePencil,
  ArrowRight,
  Trash,
  CaretDown,
  CaretRight,
  CheckCircle,
  XCircle,
  Wrench,
  Timer,
  Warning,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEvaluations } from "@/hooks/useEvaluations";
import { useAgents } from "@/hooks/useAgents";
import { apiClient, AnnotationSummary, RunAnnotation, EvaluationRun } from "@/lib/api";
import { NoDataCard } from "@/components/shared/NoDataCard";
import { HelpTooltip } from "@/components/shared/HelpTooltip";

/* ── colors use CSS variables from reference design ── */
const statusColors = {
  success: { bg: "rgba(63,185,80,0.12)", text: "#3fb950" },
  warning: { bg: "rgba(210,153,34,0.12)", text: "#d29922" },
  error: { bg: "rgba(248,81,73,0.12)", text: "#f85149" },
};

interface QueueItem {
  evaluation: any;
  agent: any;
  summary: AnnotationSummary;
  coverage: number;
}
interface RunDetail {
  testcase_id: string;
  passed: boolean;
  toolCalls: number;
  duration: number | null;
  error: string | null;
  annotation: RunAnnotation | null;
}

export function AnnotationQueuePage() {
  const navigate = useNavigate();
  const { evaluations, loading: evalsLoading, error: evalsError } = useEvaluations();
  const { agents, loading: agentsLoading } = useAgents();
  const [agentFilter, setAgentFilter] = useState("all");
  const [summaries, setSummaries] = useState<Map<string, AnnotationSummary>>(new Map());
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [confirmClearId, setConfirmClearId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Map<string, RunDetail[]>>(new Map());
  const [loadingRuns, setLoadingRuns] = useState<string | null>(null);

  /* ── load summaries ── */
  useEffect(() => {
    if (!evaluations || evaluations.length === 0 || summaries.size > 0) return;
    const load = async () => {
      setLoadingSummaries(true);
      const m = new Map<string, AnnotationSummary>();
      for (const ev of evaluations.filter((e: any) => e.status === "completed")) {
        try { m.set(ev.id, await apiClient.getAnnotationSummary(ev.id)); } catch {}
      }
      setSummaries(m);
      setLoadingSummaries(false);
    };
    load();
  }, [evaluations, summaries]);

  /* ── queue items ── */
  const items = useMemo(() => {
    if (!evaluations || !agents) return [];
    const agentMap = new Map(agents.map((a: any) => [a.id, a]));
    const list: QueueItem[] = evaluations
      .filter((e: any) => e.status === "completed")
      .map((ev: any) => {
        const s = summaries.get(ev.id);
        return {
          evaluation: ev,
          agent: agentMap.get(ev.agent_id),
          summary: s || { evaluation_id: ev.id, total_runs: ev.total_tests || 0, annotated_runs: 0, total_actions: 0, annotated_actions: 0, issue_counts: {}, outcome_distribution: {} },
          coverage: s && s.total_runs > 0 ? (s.annotated_runs / s.total_runs) * 100 : 0,
        };
      })
      .sort((a, b) => a.coverage - b.coverage);
    return agentFilter === "all" ? list : list.filter((i) => i.agent?.id === agentFilter);
  }, [evaluations, agents, summaries, agentFilter]);

  const uniqueAgents = useMemo(() => {
    if (!evaluations || !agents) return [];
    const agentMap = new Map(agents.map((a: any) => [a.id, a]));
    const ids = new Set(evaluations.filter((e: any) => e.status === "completed").map((e: any) => e.agent_id));
    return Array.from(ids).map((id) => agentMap.get(id)).filter(Boolean);
  }, [evaluations, agents]);

  /* ── handlers ── */
  const clearAll = async (evalId: string) => {
    try {
      await apiClient.clearAllAnnotations(evalId);
      const s = await apiClient.getAnnotationSummary(evalId);
      setSummaries((prev) => new Map(prev).set(evalId, s));
      if (expandedId === evalId) {
        setRunDetails((prev) => {
          const m = new Map(prev);
          const d = m.get(evalId);
          if (d) m.set(evalId, d.map((r) => ({ ...r, annotation: null })));
          return m;
        });
      }
    } catch {}
    setConfirmClearId(null);
  };

  const deleteRun = async (evalId: string, runId: string) => {
    try {
      await apiClient.deleteRunAnnotation(evalId, runId);
      const s = await apiClient.getAnnotationSummary(evalId);
      setSummaries((prev) => new Map(prev).set(evalId, s));
      setRunDetails((prev) => {
        const m = new Map(prev);
        const d = m.get(evalId);
        if (d) m.set(evalId, d.map((r) => r.testcase_id === runId ? { ...r, annotation: null } : r));
        return m;
      });
    } catch {}
  };

  const toggleExpand = useCallback(async (evalId: string) => {
    if (expandedId === evalId) { setExpandedId(null); return; }
    setExpandedId(evalId);
    if (runDetails.has(evalId)) return;
    setLoadingRuns(evalId);
    try {
      const [ev, anns] = await Promise.all([apiClient.getEvaluation(evalId), apiClient.listRunAnnotations(evalId)]);
      const annMap = new Map(anns.map((a) => [a.run_id, a]));
      setRunDetails((prev) => new Map(prev).set(evalId,
        (ev as EvaluationRun).test_cases.map((tc) => ({
          testcase_id: tc.testcase_id,
          passed: tc.passed,
          toolCalls: tc.actual_tool_calls?.length ?? 0,
          duration: tc.total_duration_seconds ?? null,
          error: tc.execution_error ?? null,
          annotation: annMap.get(tc.testcase_id) ?? null,
        }))
      ));
    } catch {}
    setLoadingRuns(null);
  }, [expandedId, runDetails]);

  /* ── loading ── */
  if (evalsLoading || agentsLoading || loadingSummaries) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <CircleNotch size={48} className="animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Loading annotations...</p>
      </div>
    );
  }

  if (evalsError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Annotations{" "}
            <HelpTooltip
              text="Annotations let you add human feedback to evaluation results. Run-level annotations rate overall outcome (1-5) and efficiency. Action-level annotations drill into individual tool calls for correctness and parameter quality. Once 80%% of test cases are annotated, AI-powered prompt improvement proposals are generated automatically."
              guidePath="/guide"
              size={16}
            />
          </h1>
          <p className="text-muted-foreground mt-1">Review and annotate evaluation results</p>
        </div>
        <NoDataCard
          icon={<NotePencil size={48} className="text-muted-foreground mb-4" />}
          title="Failed to load evaluations"
          description={evalsError}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header — matches Agents/Datasets/Leaderboard pattern */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Annotations{" "}
            <HelpTooltip
              text="Annotations let you add human feedback to evaluation results. Run-level annotations rate overall outcome (1-5) and efficiency. Action-level annotations drill into individual tool calls for correctness and parameter quality. Once 80%% of test cases are annotated, AI-powered prompt improvement proposals are generated automatically."
              guidePath="/guide"
              size={16}
            />
          </h1>
          <p className="text-muted-foreground mt-1">
            {items.length} evaluation{items.length !== 1 ? "s" : ""} · sorted by coverage
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate("/annotations?tab=production")}
          className="gap-2"
        >
          <NotePencil size={16} />
          Production Trace Annotations
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Agent:</span>
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="w-[180px] h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Agents</SelectItem>
              {uniqueAgents.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {items.length === 0 ? (
        <NoDataCard
          icon={<NotePencil size={48} className="text-muted-foreground mb-4" />}
          title="No evaluations to annotate"
          description="Completed evaluations appear here for human review. Annotate results to rate agent performance, flag issues, and trigger AI-generated prompt improvement proposals."
          action={
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => navigate("/agents")}
            >
              <ArrowRight size={16} />
              Go to Agents to run an evaluation
            </Button>
          }
        />
      ) : (
        <div className="w-full">
          {/* Table header — matches DataTable style: normal case, no background */}
          <div
            className="grid items-center text-sm text-muted-foreground"
            style={{ gridTemplateColumns: "1fr 120px 100px 130px 150px", padding: "16px 8px" }}
          >
            <span>Evaluation</span>
            <span>Agent</span>
            <span className="text-center">Pass rate</span>
            <span className="text-center">Progress</span>
            <span className="text-right">Actions</span>
          </div>

          {/* Table body */}
          {items.map((item) => {
            const ev = item.evaluation;
            const passRate = ev.total_tests > 0 ? Math.round((ev.passed_count / ev.total_tests) * 100) : 0;
            const isExpanded = expandedId === ev.id;
            const details = runDetails.get(ev.id);
            const isLoadingThis = loadingRuns === ev.id;
            const hasAnns = item.summary.annotated_runs > 0;
            const isComplete = item.coverage >= 100;

            return (
              <div key={ev.id} className="border-b border-border last:border-b-0">
                {/* Main row — matches DataTable row style */}
                <div
                  className="grid items-center text-sm hover:bg-secondary/50 transition-colors"
                  style={{ gridTemplateColumns: "1fr 120px 100px 130px 150px", padding: "16px 8px", cursor: "pointer" }}
                  onClick={() => toggleExpand(ev.id)}
                >
                  {/* Evaluation name + expand toggle */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-muted-foreground flex-shrink-0">
                      {isExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                    </span>
                    <span className="font-medium truncate">{ev.name}</span>
                  </div>

                  {/* Agent */}
                  <span className="text-muted-foreground text-xs truncate">
                    {item.agent?.name || "—"}
                  </span>

                  {/* Pass rate */}
                  <span className="text-center font-semibold text-xs" style={{
                    color: passRate >= 80 ? statusColors.success.text : passRate >= 50 ? statusColors.warning.text : statusColors.error.text,
                  }}>
                    {passRate}%
                  </span>

                  {/* Progress bar + fraction */}
                  <div className="flex items-center gap-2 justify-center">
                    <div className="w-[50px] h-[5px] rounded-full bg-secondary overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${item.coverage}%`,
                          background: isComplete ? statusColors.success.text : "var(--primary)",
                        }}
                      />
                    </div>
                    <span className="text-[11px]" style={{
                      color: isComplete ? statusColors.success.text : "var(--muted-foreground)",
                      fontWeight: isComplete ? 600 : 400,
                    }}>
                      {item.summary.annotated_runs}/{item.summary.total_runs}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                    {hasAnns && (
                      <div className="relative">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={(e) => { e.stopPropagation(); setConfirmClearId(confirmClearId === ev.id ? null : ev.id); }}
                          title="Clear all annotations"
                        >
                          <Trash size={13} />
                        </Button>
                        {confirmClearId === ev.id && (
                          <div className="absolute top-full right-0 z-50 mt-1.5 p-3.5 rounded-lg min-w-[240px] bg-card border border-border shadow-lg">
                            <div className="text-sm font-semibold mb-1">Clear all annotations?</div>
                            <div className="text-xs text-muted-foreground mb-3 leading-relaxed">
                              Remove {item.summary.annotated_runs} annotation{item.summary.annotated_runs !== 1 ? "s" : ""}.
                            </div>
                            <div className="flex gap-1.5 justify-end">
                              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setConfirmClearId(null)}>
                                Cancel
                              </Button>
                              <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => clearAll(ev.id)}>
                                Clear All
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <Button
                      variant={isComplete ? "outline" : "default"}
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => navigate(`/evaluations/${ev.id}/annotate`)}
                    >
                      {isComplete ? "Change" : "Annotate"} <ArrowRight size={12} />
                    </Button>
                  </div>
                </div>

                {/* Expanded run details */}
                {isExpanded && (
                  <div className="border-t border-border bg-black/10">
                    {/* Sub-header — matches DataTable header style (normal case) */}
                    <div
                      className="grid items-center text-xs text-muted-foreground border-b border-border"
                      style={{ gridTemplateColumns: "24px 1fr 60px 60px 80px 80px 1fr 28px", gap: 6, padding: "8px 8px 8px 40px" }}
                    >
                      <span />
                      <span>Test case</span>
                      <span className="text-center">Tools</span>
                      <span className="text-center">Time</span>
                      <span className="text-center">Outcome</span>
                      <span className="text-center">Efficiency</span>
                      <span>Issues</span>
                      <span />
                    </div>
                    {isLoadingThis ? (
                      <div className="py-3 px-4 pl-10 text-xs text-muted-foreground">
                        <CircleNotch size={14} className="animate-spin inline-block mr-1.5 align-middle" />
                        Loading...
                      </div>
                    ) : details?.map((run, ri) => {
                      const ann = run.annotation;
                      const outcomeLabels: Record<number, string> = { 5: "Yes", 4: "Mostly", 3: "Partly", 2: "No", 1: "Failed" };
                      const outcomeColors: Record<number, string> = { 5: statusColors.success.text, 4: statusColors.success.text, 3: statusColors.warning.text, 2: statusColors.error.text, 1: statusColors.error.text };
                      const effColors: Record<string, string> = { efficient: statusColors.success.text, acceptable: statusColors.warning.text, wasteful: statusColors.error.text };
                      return (
                        <div
                          key={run.testcase_id}
                          className="grid items-center text-xs hover:bg-secondary/30 transition-colors"
                          style={{
                            gridTemplateColumns: "24px 1fr 60px 60px 80px 80px 1fr 28px",
                            gap: 6,
                            padding: "8px 8px 8px 40px",
                            borderBottom: ri < details.length - 1 ? "1px solid var(--border)" : undefined,
                          }}
                        >
                          {/* pass/fail icon */}
                          <div
                            className="w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center"
                            style={{
                              backgroundColor: run.passed ? statusColors.success.bg : statusColors.error.bg,
                              color: run.passed ? statusColors.success.text : statusColors.error.text,
                            }}
                          >
                            {run.passed ? <CheckCircle size={11} weight="fill" /> : <XCircle size={11} weight="fill" />}
                          </div>

                          {/* name + error */}
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate">{run.testcase_id}</span>
                            {run.error && (
                              <span title={run.error} className="flex flex-shrink-0">
                                <Warning size={12} weight="fill" style={{ color: statusColors.error.text }} />
                              </span>
                            )}
                          </div>

                          {/* tool calls */}
                          <span className="text-center text-muted-foreground flex items-center justify-center gap-1">
                            <Wrench size={10} /> {run.toolCalls}
                          </span>

                          {/* duration */}
                          <span className="text-center text-muted-foreground flex items-center justify-center gap-1">
                            {run.duration != null ? <><Timer size={10} /> {run.duration.toFixed(1)}s</> : "—"}
                          </span>

                          {/* outcome */}
                          <span className="text-center">
                            {ann?.outcome ? (
                              <span className="text-[10px] font-semibold" style={{ color: outcomeColors[ann.outcome] || "var(--muted-foreground)" }}>
                                {outcomeLabels[ann.outcome] || ann.outcome}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </span>

                          {/* efficiency */}
                          <span className="text-center">
                            {ann?.efficiency ? (
                              <span className="text-[10px] font-semibold capitalize" style={{ color: effColors[ann.efficiency] || "var(--muted-foreground)" }}>
                                {ann.efficiency}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </span>

                          {/* issues */}
                          <div className="flex gap-1 flex-wrap min-w-0">
                            {ann?.issues && ann.issues.length > 0 ? ann.issues.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-[9px] px-1.5 py-0" style={{
                                background: statusColors.warning.bg, color: statusColors.warning.text,
                                border: "none",
                              }}>{tag}</Badge>
                            )) : <span className="text-muted-foreground">—</span>}
                          </div>

                          {/* delete */}
                          {ann ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => deleteRun(ev.id, run.testcase_id)}
                              title="Delete annotation"
                            >
                              <Trash size={10} />
                            </Button>
                          ) : <span />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
