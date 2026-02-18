import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useEvaluation } from "@/hooks/useEvaluation";
import { useDatasets } from "@/hooks/useDatasets";
import { useAgents } from "@/hooks/useAgents";
import { useTestCase } from "@/hooks/useTestCase";
import { TestCaseResult } from "@/lib/api";
import { formatJsonForDisplay, formatResponseJson, isResponseLong, getTruncatedResponse } from "@/lib/jsonUtils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeft,
  CircleNotch,
  Check,
  X,
  ChatDots,
  File,
  ArrowsInSimple,
  ArrowsOutSimple,
  Warning,
  Wrench,
  CheckSquare,
  ChartBar,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle, XCircle, CaretLeft, CaretRight as CaretRightIcon, CaretDown, NotePencil } from "@phosphor-icons/react";

import { Separator } from "@/components/ui/separator";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { NoDataCard } from "@/components/shared/NoDataCard";
import { AIContentDisclaimer } from "@/components/shared/AIContentDisclaimer";
import { GenerateAssertionsDialog } from "@/components/shared/GenerateAssertionsDialog";
import { useSelectableClick } from "@/hooks/useSelectableClick";
import { useAnnotations } from "@/hooks/useAnnotations";

interface BaseCardItem {
  id: string;
  type:
    | "tools"
    | "response"
    | "description"
    | "input"
    | "expected_response"
    | "quality"
    | "rubric"
    | "error";
  title: string;
  content: string;
}

interface ToolCardItem extends BaseCardItem {
  type: "tools";
  actualTools: any[];
  expectedTools: any[];
}

interface RubricCardItem extends BaseCardItem {
  type: "rubric";
  rubricScores: { criterion: string; score: number; reasoning: string }[];
  averageScore: number;
  passed: boolean;
}

interface BasicInfoCardItem extends BaseCardItem {
  type:
    | "response"
    | "description"
    | "input"
    | "expected_response"
    | "quality"
    | "error";
  /** Per-item pass/fail (used by behavior assertion cards). */
  passed?: boolean;
}

type CardItem =
  | ToolCardItem
  | RubricCardItem
  | BasicInfoCardItem;

/* ── normalise tool-call arguments ─────────────────────── */
// CU Agent returns arguments as an object: {url: "http://..."}
// MCP/standard format is an array: [{name: "url", value: "http://..."}]
// This helper normalises both into the array form the UI expects.
function normaliseArgs(args: any): { name: string; value: any }[] {
  if (!args) return [];
  if (Array.isArray(args)) return args;              // already array
  if (typeof args === "object") {
    return Object.entries(args).map(([name, value]) => ({ name, value }));
  }
  return [];
}

/* ── annotation colors & scales ─────────────────────────── */
const AN = {
	green: "#3fb950", greenBg: "rgba(63, 185, 80, 0.12)", greenBd: "rgba(63, 185, 80, 0.15)",
	red: "#f85149", redBg: "rgba(248, 81, 73, 0.12)", redBd: "rgba(248, 81, 73, 0.15)",
	blue: "#58a6ff", blueBg: "rgba(88, 166, 255, 0.12)", blueBd: "rgba(88, 166, 255, 0.15)",
	amber: "#d29922", amberBg: "rgba(210, 153, 34, 0.12)", amberBd: "rgba(210, 153, 34, 0.20)",
};
const ANN_OUTCOMES = [
	{ value: 5, label: "Yes", color: AN.green, bg: AN.greenBg },
	{ value: 4, label: "Mostly", color: AN.green, bg: AN.greenBg },
	{ value: 3, label: "Partly", color: AN.amber, bg: AN.amberBg },
	{ value: 2, label: "No", color: AN.red, bg: AN.redBg },
	{ value: 1, label: "Failed", color: AN.red, bg: AN.redBg },
];
const ANN_EFFICIENCY = [
	{ value: "efficient", color: AN.green, bg: AN.greenBg },
	{ value: "acceptable", color: AN.amber, bg: AN.amberBg },
	{ value: "wasteful", color: AN.red, bg: AN.redBg },
];
const ANN_CORRECTNESS = [
	{ value: "correct", color: AN.green, bg: AN.greenBg },
	{ value: "acceptable", color: AN.amber, bg: AN.amberBg },
	{ value: "incorrect", color: AN.red, bg: AN.redBg },
];
const ANN_PARAM_QUALITY = [
	{ value: "good", color: AN.green, bg: AN.greenBg },
	{ value: "suboptimal", color: AN.amber, bg: AN.amberBg },
	{ value: "wrong", color: AN.red, bg: AN.redBg },
];
const ANN_INFO_UTIL = [
	{ value: "good", color: AN.green, bg: AN.greenBg },
	{ value: "partial", color: AN.amber, bg: AN.amberBg },
	{ value: "ignored", color: AN.red, bg: AN.redBg },
];

function AnnPill({ label, selected, color, bg, onClick }: {
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

function AnnTagChip({ label, selected, onClick }: {
	label: string; selected: boolean; onClick: () => void;
}) {
	return (
		<button onClick={onClick} style={{
			padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 500,
			cursor: "pointer", transition: "all 0.15s",
			border: selected ? `1px solid ${AN.amber}` : "1px solid var(--border)",
			background: selected ? AN.amberBg : "transparent",
			color: selected ? AN.amber : "var(--muted-foreground)",
		}}>
			{label}
		</button>
	);
}


export function TestCaseResultPage() {
  const { eval_id, testcase_id } = useParams<{
    eval_id: string;
    testcase_id: string;
  }>();
  const navigate = useNavigate();
  const { evaluation, loading, error } = useEvaluation(eval_id);
  const { datasets } = useDatasets();
  const { agents } = useAgents();
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [expandedResponses, setExpandedResponses] = useState<Set<string>>(new Set());
  const { createClickHandler } = useSelectableClick();
  const {
    summary, issueTags,
    saveRunAnnotation, getRunAnnotation,
    saveActionAnnotation, getActionAnnotation,
  } = useAnnotations(eval_id);

  const [annPanelOpen, setAnnPanelOpen] = useState(false);

  // Initialize all cards as collapsed
  const [initializedCollapsed, setInitializedCollapsed] = useState(false);

  // Get the dataset_id from evaluation to fetch the test case
  const datasetId = evaluation?.dataset_id;
  const { testCase: fetchedTestCase, loading: testCaseLoading } = useTestCase(
    datasetId,
    testcase_id
  );

  const { testCaseResult, agent, dataset } = useMemo(() => {
    if (!evaluation || !testcase_id) {
      return { testCaseResult: null, agent: null, dataset: null };
    }

    // Find the test case result in the evaluation
    // Try both exact match and decoded match in case of URL encoding issues
    let foundTestCaseResult = evaluation.test_cases?.find(
      (tc) => tc.testcase_id === testcase_id
    );

    // If not found, try with decoded testcase_id
    if (!foundTestCaseResult && testcase_id) {
      const decodedTestcaseId = decodeURIComponent(testcase_id);
      foundTestCaseResult = evaluation.test_cases?.find(
        (tc) => tc.testcase_id === decodedTestcaseId
      );
    }

    // If still not found, try case-insensitive comparison
    if (!foundTestCaseResult && testcase_id) {
      foundTestCaseResult = evaluation.test_cases?.find(
        (tc) => tc.testcase_id.toLowerCase() === testcase_id.toLowerCase()
      );
    }

    if (!foundTestCaseResult) {
      return { testCaseResult: null, agent: null, dataset: null };
    }

    // Find the dataset
    const foundDataset = datasets.find((s) => s.id === evaluation.dataset_id);

    // Find the agent
    const foundAgent = agents.find((a) => a.id === evaluation.agent_id);

    return {
      testCaseResult: foundTestCaseResult,
      agent: foundAgent,
      dataset: foundDataset,
    };
  }, [evaluation, testcase_id, datasets, agents]);

  // Use the fetched test case instead of the one from datasets
  const testCase = fetchedTestCase;

  // Navigation between test cases
  const { currentIdx, prevTcId, nextTcId, totalTestCases } = useMemo(() => {
    if (!evaluation?.test_cases || !testcase_id)
      return { currentIdx: -1, prevTcId: null as string | null, nextTcId: null as string | null, totalTestCases: 0 };
    const idx = evaluation.test_cases.findIndex((tc) => tc.testcase_id === testcase_id);
    return {
      currentIdx: idx,
      prevTcId: idx > 0 ? evaluation.test_cases[idx - 1].testcase_id : null,
      nextTcId: idx >= 0 && idx < evaluation.test_cases.length - 1 ? evaluation.test_cases[idx + 1].testcase_id : null,
      totalTestCases: evaluation.test_cases.length,
    };
  }, [evaluation, testcase_id]);

  // Annotation state for current test case
  const runAnn = testcase_id ? getRunAnnotation(testcase_id) : null;
  const annotatedCount = summary?.annotated_runs ?? 0;
  const totalAnnotatable = summary?.total_runs ?? 0;

  const handleRunField = async (field: string, value: any) => {
    if (!testcase_id) return;
    const current = runAnn || { issues: [] };
    await saveRunAnnotation(testcase_id, { ...current, [field]: value });
  };
  const toggleIssue = async (tag: string) => {
    if (!testcase_id) return;
    const current = runAnn || { issues: [] as string[] };
    const issues: string[] = current.issues?.includes(tag)
      ? current.issues.filter((t: string) => t !== tag)
      : [...(current.issues || []), tag];
    await saveRunAnnotation(testcase_id, { ...current, issues });
  };

  const handleActionField = async (actionIndex: number, field: string, value: any) => {
    if (!testcase_id) return;
    const current = getActionAnnotation(testcase_id, actionIndex) || { error_contributor: false };
    await saveActionAnnotation(testcase_id, actionIndex, { ...current, [field]: value });
  };

  const cardData = useMemo(() => {
    if (!testCaseResult) return [];

    const items: CardItem[] = [];

    // Add actual tool calls card
    if (
      testCaseResult.actual_tool_calls &&
      testCaseResult.actual_tool_calls.length > 0
    ) {
      items.push({
        id: "actual_tools",
        type: "tools",
        title: "Actual Tool Calls",
        content: `${testCaseResult.actual_tool_calls.length} tool call${
          testCaseResult.actual_tool_calls.length !== 1 ? "s" : ""
        }`,
        actualTools: testCaseResult.actual_tool_calls,
        expectedTools: [],
      });
    }

    // Add rubric scoring card (Feature: rubric-evaluation)
    if (testCaseResult.rubric_scores?.length) {
      items.push({
        id: "rubric_scores",
        type: "rubric",
        title: "Rubric Evaluation",
        content: `Average: ${testCaseResult.rubric_average_score?.toFixed(1) ?? "N/A"}/5`,
        rubricScores: testCaseResult.rubric_scores,
        averageScore: testCaseResult.rubric_average_score ?? 0,
        passed: testCaseResult.passed,
      } as RubricCardItem);
    }

    // Add behavior assertion result cards (Feature: 3-tier-assertions)
    if (testCaseResult.behavior_assertions?.length) {
      testCaseResult.behavior_assertions.forEach((ba, index) => {
        items.push({
          id: `behavior_assertion_${index}`,
          type: "quality",
          title: ba.assertion,
          content: ba.llm_judge_output,
          passed: ba.passed,
        });
      });
    }

    // Add response quality assessment card
    if (testCaseResult.response_quality_assertion) {
      items.push({
        id: "response_quality",
        type: "quality",
        title: "Response Quality Assessment",
        content: testCaseResult.response_quality_assertion.llm_judge_output,
        passed: testCaseResult.response_quality_assertion.passed,
      });
    }

    // Add execution error if present
    if (testCaseResult.execution_error) {
      items.push({
        id: "error",
        type: "error",
        title: "Execution Error",
        content: testCaseResult.execution_error,
      });
    }

    return items;
  }, [testCaseResult, testCase]);

  // Initialize all cards as collapsed when cardData changes
  useEffect(() => {
    if (cardData.length > 0 && !initializedCollapsed) {
      const allCardIds = new Set(cardData.map((item) => item.id));
      setCollapsedCards(allCardIds);
      setInitializedCollapsed(true);
    }
  }, [cardData, initializedCollapsed]);

  const [activeFilter, setActiveFilter] = useState<string>("All");

  // Helper function to determine if a card passed or failed
  const getCardStatus = (item: CardItem) => {
    switch (item.type) {
      case "quality": {
        // Behavior assertion cards carry their own passed field
        const basicItem = item as BasicInfoCardItem;
        if (basicItem.passed !== undefined) {
          return basicItem.passed ? "Passed" : "Failed";
        }
        // Fallback for response_quality_assertion card
        return testCaseResult?.response_quality_assertion?.passed
          ? "Passed"
          : "Failed";
      }
      case "rubric": {
        const rubricItem = item as RubricCardItem;
        return `${rubricItem.averageScore.toFixed(1)}/5`;
      }
      case "tools":
      case "description":
      case "input":
      case "expected_response":
      case "error":
      default:
        return null; // No pass/fail status
    }
  };

  const getCardIcon = (type: string, item?: CardItem) => {
    switch (type) {
      case "tools":
        return <Wrench size={20} className="text-primary" />;
      case "quality": {
        const itemPassed = (item as BasicInfoCardItem)?.passed !== undefined
          ? (item as BasicInfoCardItem).passed
          : testCaseResult?.response_quality_assertion?.passed;
        return itemPassed ? (
          <Check size={20} style={{ color: "#3fb950" }} weight="bold" />
        ) : (
          <X size={20} style={{ color: "#f85149" }} weight="bold" />
        );
      }
      case "rubric":
        return <ChartBar size={20} style={{ color: "#58a6ff" }} />;
      case "error":
        return <Warning size={20} style={{ color: "#f85149" }} />;
      default:
        return null;
    }
  };

  const toggleCardCollapse = (cardId: string) => {
    setCollapsedCards((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(cardId)) {
        newSet.delete(cardId);
      } else {
        newSet.add(cardId);
      }
      return newSet;
    });
  };

  const handleCardToggle = createClickHandler((cardId: string) => {
    toggleCardCollapse(cardId);
  });

  // Count failures (must be above early returns to satisfy Rules of Hooks)
  const failedCount = useMemo(() => {
    if (!testCaseResult) return 0;
    let count = 0;
    testCaseResult.behavior_assertions?.forEach((ba) => { if (!ba.passed) count++; });
    if (testCaseResult.response_quality_assertion && !testCaseResult.response_quality_assertion.passed) count++;
    return count;
  }, [testCaseResult]);

  // Simple filtering logic
  const filteredCardData = useMemo(() => {
    if (activeFilter === "All") {
      return cardData;
    }

    return cardData.filter((item) => {
      switch (activeFilter) {
        case "Response Quality Assertions":
          return item.type === "quality";
        case "Actual Tool Calls":
          return item.type === "tools";
        case "Rubric Scores":
          return item.type === "rubric";
        default:
          return true;
      }
    });
  }, [cardData, activeFilter]);

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  const toggleResponseExpanded = (responseId: string) => {
    setExpandedResponses((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(responseId)) {
        newSet.delete(responseId);
      } else {
        newSet.add(responseId);
      }
      return newSet;
    });
  };

  const renderCardContent = (item: CardItem) => {
    const isExpanded = expandedItems.has(item.id);
    const maxItemsToShow = 2;

    if (item.type === "tools") {
      const toolItem = item as ToolCardItem;
      return (
        <div className="space-y-3">
          {/* Show only Actual Tool Calls */}
          {toolItem.actualTools.length > 0 && (
            <>
              <div className="text-sm bg-muted/50 p-3 rounded-md space-y-4">
                <p className="text-sm text-muted-foreground">Tool calls</p>
                {(isExpanded
                  ? toolItem.actualTools
                  : toolItem.actualTools.slice(0, maxItemsToShow)
                ).map((toolCall, idx) => {
                  const actAnn = testcase_id ? getActionAnnotation(testcase_id, idx) : null;
                  return (
                  <div key={idx} style={{ borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden" }}>
                    {/* Step header */}
                    <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", backgroundColor: "var(--secondary)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Step {idx + 1}</span>
                        <code className="text-xs font-mono bg-primary/10 px-1.5 py-0.5 rounded">
                          {toolCall.name}
                        </code>
                      </div>
                      {actAnn && (actAnn.correctness || actAnn.parameter_quality || actAnn.info_utilization) && (
                        <CheckCircle size={14} weight="fill" style={{ color: AN.green }} />
                      )}
                    </div>
                    <div style={{ padding: "8px 12px" }}>
                      {/* Tool call details */}
                      <div className="space-y-1">
                        {(() => {
                          const normArgs = normaliseArgs(toolCall.arguments);
                          return normArgs.length > 0 ? (
                            normArgs.map((arg: any, argIdx: number) => (
                              <div key={argIdx} className="text-xs">
                                <span style={{ color: "#58a6ff", fontWeight: "600" }}>
                                  {arg.name}:
                                </span>{" "}
                                <span className="font-mono">
                                  {formatJsonForDisplay(arg.value)}
                                </span>
                              </div>
                            ))
                          ) : (
                            <p className="text-xs text-muted-foreground italic">
                              No parameters
                            </p>
                          );
                        })()}
                      </div>
                      {/* Show MCP tool response */}
                      {toolCall.response && (
                        <div className="mt-2">
                          <div className="text-xs">
                            <span className="text-muted-foreground font-medium">
                              Tool response:
                            </span>{" "}
                            <Badge variant="secondary" className="text-xs">
                              {toolCall.response?.success === true ? 'Success' : 'Failed'}
                            </Badge>
                          </div>
                        </div>
                      )}
                      {/* ── Step-level annotation ── */}
                      <div style={{
                        marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border)",
                        display: "flex", flexDirection: "column", gap: 8,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <NotePencil size={12} style={{ color: "var(--muted-foreground)" }} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)" }}>Step Annotation</span>
                        </div>
                        {/* Correctness + Param Quality + Info Util in a row */}
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 4 }}>Correctness</div>
                            <div style={{ display: "flex", gap: 4 }}>
                              {ANN_CORRECTNESS.map((c) => (
                                <AnnPill key={c.value} label={c.value} selected={actAnn?.correctness === c.value}
                                  color={c.color} bg={c.bg} onClick={() => handleActionField(idx, "correctness", c.value)} />
                              ))}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 4 }}>Param Quality</div>
                            <div style={{ display: "flex", gap: 4 }}>
                              {ANN_PARAM_QUALITY.map((p) => (
                                <AnnPill key={p.value} label={p.value} selected={actAnn?.parameter_quality === p.value}
                                  color={p.color} bg={p.bg} onClick={() => handleActionField(idx, "parameter_quality", p.value)} />
                              ))}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 4 }}>Info Utilization</div>
                            <div style={{ display: "flex", gap: 4 }}>
                              {ANN_INFO_UTIL.map((u) => (
                                <AnnPill key={u.value} label={u.value} selected={actAnn?.info_utilization === u.value}
                                  color={u.color} bg={u.bg} onClick={() => handleActionField(idx, "info_utilization", u.value)} />
                              ))}
                            </div>
                          </div>
                        </div>
                        {/* Error contributor toggle + Correction */}
                        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                          <button
                            onClick={() => handleActionField(idx, "error_contributor", !actAnn?.error_contributor)}
                            style={{
                              display: "flex", alignItems: "center", gap: 6,
                              padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600,
                              cursor: "pointer", transition: "all 0.15s",
                              border: actAnn?.error_contributor ? `1px solid ${AN.red}` : "1px solid var(--border)",
                              background: actAnn?.error_contributor ? AN.redBg : "transparent",
                              color: actAnn?.error_contributor ? AN.red : "var(--muted-foreground)",
                            }}
                          >
                            <XCircle size={12} weight={actAnn?.error_contributor ? "fill" : "regular"} />
                            Error contributor
                          </button>
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <input
                              type="text"
                              value={actAnn?.correction || ""}
                              onChange={(e) => handleActionField(idx, "correction", e.target.value)}
                              placeholder="Correction note..."
                              style={{
                                width: "100%", padding: "4px 10px", borderRadius: 6,
                                border: "1px solid var(--border)", background: "var(--secondary)",
                                color: "var(--foreground)", fontSize: 12, outline: "none", fontFamily: "inherit",
                              }}
                              onFocus={(e) => (e.currentTarget.style.borderColor = AN.blue)}
                              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })}
                {toolItem.actualTools.length > maxItemsToShow && (
                  <div className="flex justify-center pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(item.id);
                      }}
                    >
                      {isExpanded
                        ? "Show Less"
                        : `Show More (${
                            toolItem.actualTools.length - maxItemsToShow
                          })`}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      );
    } else if (item.type === "rubric") {
      // Rubric scoring results (Feature: rubric-evaluation)
      const rubricItem = item as RubricCardItem;
      const scoreColor = (score: number) => {
        if (score >= 4.5) return "#3fb950";
        if (score >= 3.5) return "#58a6ff";
        if (score >= 2.5) return "#d29922";
        if (score >= 1.5) return "#f0883e";
        return "#f85149";
      };

      return (
        <div className="space-y-3">
          {/* Average score header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderRadius: 8,
            backgroundColor: rubricItem.passed ? "rgba(63, 185, 80, 0.08)" : "rgba(248, 81, 73, 0.08)",
            border: `1px solid ${rubricItem.passed ? "rgba(63, 185, 80, 0.2)" : "rgba(248, 81, 73, 0.2)"}`,
          }}>
            <div className="flex items-center gap-2">
              {rubricItem.passed ? (
                <Check size={16} style={{ color: "#3fb950" }} weight="bold" />
              ) : (
                <X size={16} style={{ color: "#f85149" }} weight="bold" />
              )}
              <span className="text-sm font-medium">
                {rubricItem.passed ? "PASSED" : "FAILED"} — Average {rubricItem.averageScore.toFixed(2)}/5
              </span>
            </div>
          </div>

          {/* Per-criterion scores */}
          <div className="space-y-2">
            {rubricItem.rubricScores.map((score, idx) => (
              <div key={idx} style={{
                padding: "10px 14px",
                borderRadius: 8,
                backgroundColor: "var(--muted)",
                border: "1px solid var(--border)",
              }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium">{score.criterion}</span>
                  <div className="flex items-center gap-1.5">
                    {/* Score dots */}
                    {[1, 2, 3, 4, 5].map((level) => (
                      <div
                        key={level}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          backgroundColor: level <= score.score ? scoreColor(score.score) : "var(--border)",
                        }}
                      />
                    ))}
                    <span className="text-sm font-bold ml-1" style={{ color: scoreColor(score.score) }}>
                      {score.score}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{score.reasoning}</p>
              </div>
            ))}
          </div>
        </div>
      );
    } else if (item.type === "quality") {
      // Response Quality with pass/fail and LLM explanation
      // Behavior assertion cards carry their own passed field;
      // fall back to global response_quality_assertion for the RQ card.
      const basicItem = item as BasicInfoCardItem;
      const passed = basicItem.passed !== undefined
        ? basicItem.passed
        : testCaseResult?.response_quality_assertion?.passed;
      const originalAssertion = item.id.startsWith("behavior_assertion_")
        ? undefined  // behavior cards already show assertion text in title
        : testCase?.response_quality_expectation?.assertion;

      return (
        <div className="space-y-3">
          {/* Show original assertion if available */}
          {originalAssertion && (
            <div className="bg-muted/50 p-3 rounded">
              <div className="text-sm font-medium text-muted-foreground mb-2">
                Original Assertion:
              </div>
              <p className="text-sm whitespace-pre-wrap">{originalAssertion}</p>
            </div>
          )}

          {/* Show evaluation result */}
          <div
            style={{
              borderLeftWidth: "4px",
              paddingLeft: "12px",
              paddingTop: "8px",
              paddingBottom: "8px",
              borderRadius: "4px",
              backgroundColor: passed ? "rgba(63, 185, 80, 0.08)" : "rgba(248, 81, 73, 0.08)",
              borderLeftColor: passed ? "#3fb950" : "#f85149",
            }}
          >
            <div className="flex items-start gap-2">
              {passed ? (
                <Check
                  size={14}
                  style={{ color: "#3fb950" }}
                  className="mt-0.5 flex-shrink-0"
                  weight="bold"
                />
              ) : (
                <X
                  size={14}
                  style={{ color: "#f85149" }}
                  className="mt-0.5 flex-shrink-0"
                  weight="bold"
                />
              )}
              <div className="flex-1">
                <div className="text-sm font-medium mb-2">
                  {passed ? "PASSED" : "FAILED"}
                </div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  LLM Judge Response:
                </div>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                  {item.content}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    } else {
      // Basic info cards
      return (
        <div className="space-y-2">
          <div className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap max-h-[200px] overflow-y-auto">
            {item.content}
          </div>
        </div>
      );
    }
  };

  if (loading || testCaseLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <CircleNotch
          size={48}
          className="animate-spin text-primary mb-4"
        />
        <p className="text-muted-foreground">Loading test case result...</p>
        {eval_id && (
          <p className="text-sm text-muted-foreground mt-2">
            Evaluation ID: {eval_id} | Test Case ID: {testcase_id}
          </p>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <Alert variant="destructive" className="max-w-md mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button
          onClick={() => navigate("/agents")}
          variant="outline"
          className="gap-2"
        >
          <ArrowLeft size={16} />
          Back to Agents
        </Button>
      </div>
    );
  }

  if (!evaluation || !testCaseResult) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <h2 className="text-2xl font-bold mb-2">Test case result not found</h2>
        <p className="text-muted-foreground mb-6">
          {!evaluation
            ? "The evaluation could not be loaded."
            : "The test case result you're looking for doesn't exist in this evaluation."}
        </p>
        {evaluation && (
          <div className="text-sm text-muted-foreground mb-4 space-y-1">
            <p>
              <strong>Evaluation ID:</strong> {eval_id}
            </p>
            <p>
              <strong>Looking for Test Case ID:</strong> {testcase_id}
            </p>
            <p>
              <strong>Evaluation Status:</strong> {evaluation.status}
            </p>
            <p>
              <strong>Total Test Cases:</strong>{" "}
              {evaluation.test_cases?.length || 0}
            </p>
            {evaluation.test_cases?.length > 0 && (
              <div>
                <p>
                  <strong>Available Test Case IDs:</strong>
                </p>
                <ul className="list-disc list-inside ml-2">
                  {evaluation.test_cases.map((tc, idx) => (
                    <li key={idx} className="font-mono text-xs">
                      {tc.testcase_id}
                      {tc.testcase_id === testcase_id && (
                        <span style={{ color: "#3fb950" }}>
                          {" "}
                          ← Exact match!
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            onClick={() => navigate(`/evaluations/${eval_id}`)}
            variant="outline"
            className="gap-2"
          >
            <ArrowLeft size={16} />
            Back to Evaluation
          </Button>
          <Button
            onClick={() => navigate("/agents")}
            variant="ghost"
            className="gap-2"
          >
            <ArrowLeft size={16} />
            All Agents
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        {/* Breadcrumb navigation */}
        <div className="mb-3 text-xs text-muted-foreground flex items-center gap-2">
          <button onClick={() => navigate("/agents")} className="hover:text-foreground transition-colors">Agents</button>
          <span>/</span>
          <button onClick={() => navigate(`/agents/${agent?.id}`)} className="hover:text-foreground transition-colors">
            {agent?.name || "Agent"}
          </button>
          <span>/</span>
          <button onClick={() => navigate(`/evaluations/${eval_id}`)} className="hover:text-foreground transition-colors">
            {evaluation.name}
          </button>
          <span>/</span>
          <span className="text-foreground">{testCase?.name || "Test Case"}</span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{testCase?.name || `Test Case`}</h1>
              <Badge variant="secondary" className="text-xs">
                <span className="inline-flex items-center gap-1.5">
                  {testCaseResult.passed ? (
                    <CheckCircle size={14} weight="fill" />
                  ) : (
                    <XCircle size={14} weight="fill" />
                  )}
                  {testCaseResult.passed ? "Passed" : "Failed"}
                </span>
              </Badge>
            </div>
            <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
              {testCase?.description || "No description available"}
            </p>
            <AIContentDisclaimer />
          </div>
          {/* Prev / Next navigation */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
              {currentIdx + 1} / {totalTestCases}
            </span>
            <button
              onClick={() => prevTcId && navigate(`/evaluations/${eval_id}/testcases/${prevTcId}`)}
              disabled={!prevTcId}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, borderRadius: 6,
                border: "1px solid var(--border)", background: "transparent",
                cursor: prevTcId ? "pointer" : "not-allowed",
                opacity: prevTcId ? 1 : 0.3, color: "var(--muted-foreground)",
                transition: "all 0.15s",
              }}
            >
              <CaretLeft size={16} />
            </button>
            <button
              onClick={() => nextTcId && navigate(`/evaluations/${eval_id}/testcases/${nextTcId}`)}
              disabled={!nextTcId}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, borderRadius: 6,
                border: "1px solid var(--border)", background: "transparent",
                cursor: nextTcId ? "pointer" : "not-allowed",
                opacity: nextTcId ? 1 : 0.3, color: "var(--muted-foreground)",
                transition: "all 0.15s",
              }}
            >
              <CaretRightIcon size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Annotation — compact collapsible strip */}
      <div style={{
        borderRadius: 10, border: "1px solid var(--border)", backgroundColor: "var(--card)",
        overflow: "hidden",
      }}>
        {/* Collapsed header bar — always visible */}
        <button
          onClick={() => setAnnPanelOpen((v) => !v)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 16px", cursor: "pointer", border: "none", background: "transparent",
            transition: "background-color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <NotePencil size={14} style={{ color: "var(--muted-foreground)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>Annotation</span>
            {/* Inline summary chips when collapsed */}
            {!annPanelOpen && runAnn?.outcome && (() => {
              const o = ANN_OUTCOMES.find((x) => x.value === runAnn.outcome);
              return o ? <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 20, border: `1px solid ${o.color}`, background: o.bg, color: o.color }}>{o.label}</span> : null;
            })()}
            {!annPanelOpen && runAnn?.efficiency && (() => {
              const e = ANN_EFFICIENCY.find((x) => x.value === runAnn.efficiency);
              return e ? <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 10px", borderRadius: 20, border: `1px solid ${e.color}`, background: e.bg, color: e.color, textTransform: "capitalize" as const }}>{e.value}</span> : null;
            })()}
            {!annPanelOpen && runAnn?.issues && runAnn.issues.length > 0 && (
              <span style={{ fontSize: 11, color: AN.amber }}>{runAnn.issues.length} issue{runAnn.issues.length !== 1 ? "s" : ""}</span>
            )}
            {runAnn && (runAnn.outcome || runAnn.efficiency) && (
              <CheckCircle size={14} weight="fill" style={{ color: AN.green }} />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
              {annotatedCount}/{totalAnnotatable}
            </span>
            <CaretDown size={14} style={{
              color: "var(--muted-foreground)",
              transition: "transform 0.2s",
              transform: annPanelOpen ? "rotate(180deg)" : "rotate(0deg)",
            }} />
          </div>
        </button>

        {/* Expanded annotation controls */}
        {annPanelOpen && (
          <div style={{
            padding: "12px 16px 16px", borderTop: "1px solid var(--border)",
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            {/* Row 1: Outcome + Efficiency */}
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 5 }}>Correct?</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {ANN_OUTCOMES.map((o) => (
                    <AnnPill key={o.value} label={o.label} selected={runAnn?.outcome === o.value}
                      color={o.color} bg={o.bg} onClick={() => handleRunField("outcome", o.value)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 5 }}>Efficiency</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {ANN_EFFICIENCY.map((e) => (
                    <AnnPill key={e.value} label={e.value} selected={runAnn?.efficiency === e.value}
                      color={e.color} bg={e.bg} onClick={() => handleRunField("efficiency", e.value)} />
                  ))}
                </div>
              </div>
            </div>
            {/* Row 2: Issues */}
            {issueTags.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 5 }}>Issues</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {issueTags.map((tag) => (
                    <AnnTagChip key={tag} label={tag}
                      selected={runAnn?.issues?.includes(tag) || false}
                      onClick={() => toggleIssue(tag)} />
                  ))}
                </div>
              </div>
            )}
            {/* Row 3: Notes */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", marginBottom: 5 }}>Notes</div>
              <textarea
                value={runAnn?.notes || ""}
                onChange={(e) => handleRunField("notes", e.target.value)}
                placeholder="Add notes..."
                rows={2}
                style={{
                  width: "100%", padding: "6px 10px", borderRadius: 6,
                  border: "1px solid var(--border)", background: "var(--secondary)",
                  color: "var(--foreground)", fontSize: 12, resize: "vertical",
                  outline: "none", fontFamily: "inherit", lineHeight: 1.5,
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = AN.blue)}
                onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              />
            </div>
          </div>
        )}
      </div>

      {/* Compact stats strip */}
      <div className="grid grid-cols-2 gap-3 p-4 rounded-[12px] border border-[var(--border)] bg-[var(--card)]">
        <div className="p-3 rounded-[8px] bg-[rgba(88,166,255,0.12)] border border-[rgba(88,166,255,0.15)]">
          <div className="text-xl font-bold text-[#58a6ff]">
            {testCaseResult.actual_tool_calls?.length || 0}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <Wrench size={12} /> Tool Calls
          </div>
        </div>
        {testCaseResult.rubric_scores?.length ? (
          <div className="p-3 rounded-[8px] bg-[rgba(88,166,255,0.12)] border border-[rgba(88,166,255,0.15)]">
            <div className="text-xl font-bold" style={{
              color: (testCaseResult.rubric_average_score ?? 0) >= 3.0 ? "#3fb950" : "#f85149"
            }}>
              {testCaseResult.rubric_average_score?.toFixed(1) ?? "N/A"}<span className="text-sm font-normal text-muted-foreground">/5</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <ChartBar size={12} /> Rubric Score
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-[8px] bg-[rgba(248,81,73,0.12)] border border-[rgba(248,81,73,0.15)]">
            <div className="text-xl font-bold text-[#f85149]">
              {failedCount}
            </div>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <XCircle size={12} /> Assertions Failed
            </div>
          </div>
        )}
      </div>

      {/* Execution Error */}
      {testCaseResult.execution_error && (
        <div style={{
          padding: "12px 16px",
          borderRadius: 8,
          backgroundColor: "rgba(248, 81, 73, 0.1)",
          border: "1px solid rgba(248, 81, 73, 0.25)",
          color: "#f85149",
          fontSize: 13,
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}>
          <Warning size={16} style={{ marginTop: 2, flexShrink: 0 }} />
          <div><strong>Execution Error:</strong> {testCaseResult.execution_error}</div>
        </div>
      )}

      {/* Input & Response — side by side panels */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[var(--border)] text-sm font-medium text-muted-foreground flex items-center gap-2">
            <ChatDots size={14} /> Input (Agent Prompt)
          </div>
          <div className="p-3.5 text-sm whitespace-pre-wrap text-foreground max-h-64 overflow-y-auto leading-6">
            {testCase?.input || "No input available"}
          </div>
        </div>
        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--card)] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[var(--border)] text-sm font-medium text-muted-foreground flex items-center gap-2">
            <ChatDots size={14} /> Response
          </div>
          <div className="p-3.5 text-sm whitespace-pre-wrap text-foreground max-h-64 overflow-y-auto leading-6">
            {testCaseResult.response_from_agent || "No response available"}
          </div>
        </div>
      </div>

      {/* Results section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-2xl font-bold text-foreground">Results</h2>
          <div className="flex items-center gap-3">
            <GenerateAssertionsDialog
              evaluationId={eval_id!}
              testcaseId={testcase_id!}
              testCase={testCase ?? null}
              onApplied={() => {
                // Refresh the page data
                window.location.reload();
              }}
            />
            <div className="flex gap-2">
            {["All", "Actual Tool Calls", ...(testCaseResult?.rubric_scores?.length ? ["Rubric Scores"] : []), "Response Quality Assertions"].map((filter) => (
              <button
                key={filter}
                onClick={() => setActiveFilter(filter)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  activeFilter === filter
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border border-[var(--border)] bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {filter}
              </button>
            ))}
            </div>
          </div>
        </div>

        {cardData.length === 0 ? (
          <NoDataCard
            icon={<File size={48} className="text-muted-foreground mb-4" />}
            title="No detailed information available"
            description="This test case has no additional details."
          />
        ) : (
          <div className="flex flex-col gap-0 rounded-[12px] overflow-hidden border border-[var(--border)]">
            {filteredCardData.map((item, index) => {
              const isCollapsed = collapsedCards.has(item.id);
              const status = getCardStatus(item);
              return (
                <div
                  key={item.id}
                  className="bg-[var(--card)] border-b border-[var(--border)] last:border-b-0"
                >
                  {/* Row header — always visible */}
                  <div
                    onClick={(event) => handleCardToggle(item.id, event)}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer transition-all hover:bg-[var(--secondary)] hover:border-primary/30"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-6 h-6 rounded-[6px] flex items-center justify-center flex-shrink-0 ${
                        status === "Passed" ? "bg-[rgba(63,185,80,0.12)] text-[#3fb950]"
                          : status === "Failed" ? "bg-[rgba(248,81,73,0.12)] text-[#f85149]"
                          : "bg-[rgba(88,166,255,0.12)] text-[#58a6ff]"
                      }`}>
                        {getCardIcon(item.type, item)}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-foreground">
                          {item.type === "tools" && "Actual Tool Calls"}
                          {item.type === "quality" && (item.id.startsWith("behavior_assertion_") ? "Behavior Assertion" : "Response Quality")}
                          {item.type === "rubric" && "Rubric Evaluation"}
                          {item.type === "error" && "Execution Error"}
                        </span>
                        {item.id.startsWith("behavior_assertion_") && (
                          <span className="text-xs text-muted-foreground" style={{ whiteSpace: "normal", lineHeight: "1.4" }}>
                            {item.title}
                          </span>
                        )}
                        {!item.id.startsWith("behavior_assertion_") && (
                          <span className="text-xs text-muted-foreground">
                            {item.type === "tools" && (item as ToolCardItem).actualTools && `${(item as ToolCardItem).actualTools.length} calls`}
                            {item.type === "quality" && "Quality Check"}
                            {item.type === "rubric" && `${(item as RubricCardItem).rubricScores.length} criteria`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {status && (
                        <Badge variant="secondary" className="text-xs">
                          {status}
                        </Badge>
                      )}
                      {isCollapsed ? (
                        <ArrowsOutSimple size={14} className="text-muted-foreground opacity-50" />
                      ) : (
                        <ArrowsInSimple size={14} className="text-muted-foreground opacity-50" />
                      )}
                    </div>
                  </div>

                  {/* Expanded content */}
                  {!isCollapsed && (
                    <div className="px-4 pb-4 border-t border-[var(--border)]">
                      <div className="pt-3">
                        {renderCardContent(item)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {filteredCardData.length === 0 && cardData.length > 0 && (
          <NoDataCard
            icon={<File size={48} className="text-muted-foreground mb-4" />}
            title="No items found"
            description="Try selecting a different filter"
          />
        )}
      </div>
    </div>
  );
}
