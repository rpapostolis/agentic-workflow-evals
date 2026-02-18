import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useGuideSidecar } from "@/contexts/GuideSidecarContext";
import { API_BASE_URL } from "@/lib/config";
import {
  X,
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  ArrowRight,
  ArrowCounterClockwise,
  Copy,
  Check,
  ClipboardText,
  Lightning,
} from "@phosphor-icons/react";

// ═══════════════════════════════════════════════════════════
// Guide Data
// ═══════════════════════════════════════════════════════════

interface Task {
  id: string;
  text: string;
  /** String to copy to clipboard when the copy icon is clicked */
  copy?: string;
  /** App route to navigate to when the link portion is clicked (e.g. "/agents") */
  nav?: string;
  /**
   * Auto-detection key. If provided, the sidecar will poll the API and
   * auto-tick this task when the condition is met. Keys are resolved by
   * the useAutoDetect hook against live API state.
   */
  detect?: string;
}

interface Section {
  label?: string;
  tasks?: Task[];
  code?: string;
  note?: string;
  noteType?: "info" | "warn" | "success";
}

interface Step {
  num: number;
  title: string;
  eva: string;
  sections: Section[];
}

// Detection keys:
// "has_agents"          — at least 1 agent exists
// "has_datasets"        — at least 1 dataset exists
// "has_testcases:N"     — at least N test cases across all datasets
// "has_tc_mode:MODE"    — at least 1 test case with this assertion_mode
// "has_eval_completed"  — at least 1 completed evaluation
// "has_eval_completed:2"— at least 2 completed evaluations
// "has_annotations"     — at least 1 annotation exists
// "has_prompt_v2"       — at least 1 agent has prompt version >= 2

const STEPS: Step[] = [
  {
    num: 0,
    title: "Prerequisites & Clean Slate",
    eva: "PREPARE",
    sections: [
      {
        label: "Ollama — 2 models + custom Modelfile",
        tasks: [
          { id: "prereq-vision", text: "Pull vision model: ollama pull qwen3-vl:8b", copy: "ollama pull qwen3-vl:8b" },
          { id: "prereq-judge", text: "Pull judge model: ollama pull qwen3-coder:latest", copy: "ollama pull qwen3-coder:latest" },
          { id: "prereq-modelfile", text: "Build tuned agent model: ollama create cua-agent -f src/agents/computer_use/Modelfile", copy: "ollama create cua-agent -f src/agents/computer_use/Modelfile" },
          { id: "prereq-ollama", text: "Ollama running (enable flash attention for speed)", copy: "launchctl setenv OLLAMA_FLASH_ATTENTION 1 && launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0" },
        ],
        note: "CU Agent uses cua-agent (qwen3-vl:8b + Modelfile tuning), Judge uses qwen3-coder. Set OLLAMA_FLASH_ATTENTION=1 for faster inference.",
      },
      {
        label: "Clean Slate",
        tasks: [
          { id: "clean-stop", text: "Stop previous session: ./services.sh stop", copy: "./services.sh stop" },
          { id: "clean-db", text: "Delete database: rm -f data/evals.db", copy: "rm -f data/evals.db" },
          { id: "clean-start", text: "Start services: ./services.sh start (no --seed)", copy: "./services.sh start" },
        ],
        code: "./services.sh stop\nrm -f data/evals.db\n./services.sh start",
      },
      {
        label: "Verify",
        tasks: [
          { id: "verify-agent", text: "API auto-seeded CU Agent", copy: "curl -s http://localhost:8000/api/agents | python -m json.tool", detect: "has_agents" },
          { id: "verify-cua", text: "CU Agent process healthy", copy: "curl -s http://localhost:8001/health | python -m json.tool" },
          { id: "verify-ui", text: "Dashboard shows 1 agent, 0 datasets", nav: "/analytics", detect: "has_agents" },
        ],
      },
    ],
  },
  {
    num: 1,
    title: "Verify Agent",
    eva: "REGISTER",
    sections: [
      {
        tasks: [
          { id: "agent-nav", text: "Agents — Computer Use Agent is already listed", nav: "/agents", detect: "has_agents" },
          { id: "agent-check", text: "Click into it — endpoint: localhost:8001/invoke, model: cua-agent (qwen3-vl:8b)", detect: "has_agents" },
        ],
        note: "Auto-registered on startup. The API seeds a DB record for the CU Agent process that services.sh starts.",
      },
    ],
  },
  {
    num: 2,
    title: "Add Test Cases",
    eva: "DEFINE",
    sections: [
      {
        label: "2a — Create Dataset",
        tasks: [
          { id: "ds-create", text: "Datasets → Create Dataset", nav: "/datasets", detect: "has_datasets" },
          { id: "ds-name", text: "Name: Web Tasks", copy: "Web Tasks", detect: "has_datasets" },
          { id: "ds-goal", text: "Goal: Validate browser automation across search, lookup, and form-fill tasks", copy: "Validate browser automation across search, lookup, and form-fill tasks" },
        ],
        note: "Domain is optional — leave blank for now.",
      },
      {
        label: "2b — response_only: Wikipedia lookup",
        tasks: [
          { id: "tc1-add", text: "Add Test Case → Name:", copy: "Wikipedia population lookup", detect: "has_testcases:1" },
          { id: "tc1-input", text: "Input:", copy: "Go to wikipedia.org and find the current population of Tokyo. Return just the number." },
          { id: "tc1-expected", text: "Expected Response (optional):", copy: "A number around 13-14 million (e.g. 13,960,000)" },
          { id: "tc1-verify", text: "Save → back in list, Mode column shows response_only (auto-detected)", detect: "has_tc_mode:response_only" },
        ],
        note: "Mode is auto-detected from the test case data, not set during creation.",
      },
      {
        label: "2c — hybrid: Hacker News headlines",
        tasks: [
          { id: "tc2-add", text: "Add Test Case → Name:", copy: "Hacker News top stories", detect: "has_testcases:2" },
          { id: "tc2-input", text: "Input:", copy: "Go to news.ycombinator.com and extract the top 5 story titles from the front page. Return them as a numbered list." },
          { id: "tc2-save", text: "Save, then click into the test case to open its detail page" },
          { id: "tc2-mode", text: "Scroll to Assertion Mode → click Hybrid", detect: "has_tc_mode:hybrid" },
          { id: "tc2-ba1", text: "Add Behavior Assertion →", copy: "Agent navigates to news.ycombinator.com" },
          { id: "tc2-ba2", text: "Add Behavior Assertion →", copy: "Agent reads the front page content without clicking into individual stories" },
          { id: "tc2-ba3", text: "Add Behavior Assertion →", copy: "Agent extracts at least 5 story titles from the page" },
          { id: "tc2-ba4", text: "Add Behavior Assertion →", copy: "Agent returns a numbered list format in the response" },
          { id: "tc2-verify", text: "Badge shows 4, Mode = hybrid in list", detect: "has_tc_mode:hybrid" },
        ],
        note: "Assertion mode and behavior assertions are set on the test case detail page, not during creation.",
      },
      {
        label: "2d — Self-test: create dataset in our UI",
        tasks: [
          { id: "tc3-add", text: "Add Test Case → Name:", copy: "Create dataset via UI", detect: "has_testcases:3" },
          { id: "tc3-input", text: "Input:", copy: "Go to http://localhost:5001/datasets and create a new dataset by clicking 'Create Dataset'. Fill in Name: 'Agent-Created Test' and Goal: 'Auto-generated by CUA'. Click the create button. Report whether the dataset was created successfully." },
          { id: "tc3-save", text: "Save, then click into the test case to open its detail page" },
          { id: "tc3-ba1", text: "Add Behavior Assertion →", copy: "Agent should navigate to the datasets page at localhost:5001" },
          { id: "tc3-ba2", text: "Add Behavior Assertion →", copy: "Agent should click 'Create Dataset' and fill in the form fields" },
          { id: "tc3-ba3", text: "Add Behavior Assertion →", copy: "Agent should submit the form and confirm the dataset was created" },
          { id: "tc3-verify", text: "Mode shows hybrid in list", detect: "has_tc_mode:hybrid" },
        ],
        note: "The agent tests our own UI — zero external dependencies. Check Datasets page after to see the agent-created dataset!",
      },
      {
        label: "Checkpoint",
        note: "3 test cases: response_only and hybrid. Dashboard: 1 agent, 1 dataset.",
        noteType: "success",
      },
    ],
  },
  {
    num: 3,
    title: "Learn from Production",
    eva: "EXPAND",
    sections: [
      {
        label: "Run a task",
        tasks: [
          { id: "prod-nav", text: "Navigate to Production Traces", nav: "/production-traces" },
          { id: "prod-run", text: "Click Run Task → select Computer Use Agent" },
          { id: "prod-input", text: 'Enter: "Go to wikipedia.org and find the population of Japan"', copy: "Go to wikipedia.org and find the population of Japan" },
          { id: "prod-wait", text: "Wait for execution (~2-5 min), trace appears in list", detect: "has_production_traces:1" },
        ],
        note: "The CUA agent will open a browser and execute the task. Set CU_HEADLESS=false to watch.",
        noteType: "warn",
      },
      {
        label: "Annotate & convert",
        tasks: [
          { id: "prod-open", text: "Click the new trace to open detail panel" },
          { id: "prod-annotate", text: "Annotate: outcome, efficiency, issues, notes" },
          { id: "prod-candidate", text: "Mark as test-case candidate" },
          { id: "prod-convert", text: "Convert to Test Case → add to your dataset" },
        ],
      },
      {
        label: "Checkpoint",
        note: "1 production trace → annotated → converted to test case. Full Eva Loop!",
        noteType: "success",
      },
    ],
  },
  {
    num: 4,
    title: "Run Evaluation",
    eva: "EXECUTE",
    sections: [
      {
        label: "Create and run",
        tasks: [
          { id: "eval-nav", text: "Agents → Computer Use Agent → New Evaluation", nav: "/agents" },
          { id: "eval-config", text: "Dataset: Web Tasks, Endpoint: localhost:8001/invoke, Demo Mode: OFF", copy: "http://localhost:8001/invoke" },
          { id: "eval-run", text: "Click Run Evaluation" },
        ],
        note: "Demo Mode OFF — CU Agent opens a real browser. Set CU_HEADLESS=false to watch.",
        noteType: "warn",
      },
      {
        label: "Watch it run",
        tasks: [
          { id: "eval-progress", text: "Progress: 0/3 → 3/3 (1-5 min per test case)" },
          { id: "eval-done", text: "Status reaches completed", detect: "has_eval_completed" },
        ],
      },
    ],
  },
  {
    num: 5,
    title: "Review Results",
    eva: "ANALYZE",
    sections: [
      {
        label: "Review each mode",
        tasks: [
          { id: "res-overview", text: "Open evaluation — see pass/fail per test case", nav: "/evaluations", detect: "has_eval_completed" },
          { id: "res-ro", text: "Wikipedia result: only Response Quality card (response_only)" },
          { id: "res-hy", text: "Hacker News result: 4 behavior assertion cards + response quality (hybrid)" },
          { id: "res-form", text: "Self-test result: 3 behavior assertion cards + response quality (hybrid)" },
        ],
      },
      {
        label: "Generate Assertions",
        tasks: [
          { id: "gen-click", text: "Wikipedia result → Generate Assertions (⚡ button)" },
          { id: "gen-select", text: "Select 2 behavior assertions" },
          { id: "gen-apply", text: "Apply — mode upgrades to hybrid" },
          { id: "gen-verify", text: "Verify in Datasets → test case shows hybrid with 2 assertions", nav: "/datasets" },
        ],
      },
    ],
  },
  {
    num: 6,
    title: "Review & Label",
    eva: "ANNOTATE",
    sections: [
      {
        tasks: [
          { id: "ann-hy", text: "Hacker News result → annotate (Outcome, Efficiency, Issues, Notes)", nav: "/evaluations" },
          { id: "ann-steps", text: "Self-test result → expand tool call steps → annotate each step (Correctness, Param Quality, Info Util)" },
          { id: "ann-coverage", text: "Annotate all 3 → 100% coverage", detect: "has_annotations" },
        ],
        note: "Annotations layer human judgment on top of LLM judge decisions.",
      },
    ],
  },
  {
    num: 7,
    title: "Improve Prompt",
    eva: "OPTIMIZE",
    sections: [
      {
        tasks: [
          { id: "prompt-gen", text: "Prompt Lab → Generate Proposals", nav: "/prompt-lab" },
          { id: "prompt-review", text: "Review proposals (title, category, confidence, diff)" },
          { id: "prompt-apply", text: "Apply best proposal → creates prompt v2", detect: "has_prompt_v2" },
        ],
      },
    ],
  },
  {
    num: 8,
    title: "Compare & Repeat",
    eva: "ITERATE",
    sections: [
      {
        label: "Run second evaluation",
        tasks: [
          { id: "cmp-run", text: "New Evaluation → same config, Demo Mode OFF", nav: "/agents" },
          { id: "cmp-wait", text: "Wait for completion", detect: "has_eval_completed:2" },
        ],
      },
      {
        label: "Analytics",
        tasks: [
          { id: "cmp-analytics", text: "Evaluations page → Analytics section (collapsible)", nav: "/evaluations", detect: "has_eval_completed:2" },
          { id: "cmp-trend", text: "Pass Rate Trend — area chart with data points over 30 days" },
          { id: "cmp-versions", text: "Prompt Version Performance — v1 vs v2 cards with delta badge" },
        ],
      },
      {
        label: "Compare side-by-side",
        tasks: [
          { id: "cmp-toggle", text: "Click Compare toggle → checkboxes appear on rows", nav: "/evaluations" },
          { id: "cmp-select", text: "Select both evaluations (exactly 2) → click Compare 2" },
          { id: "cmp-cards", text: "Comparison page: side-by-side eval cards with pass rates" },
          { id: "cmp-delta", text: "Delta summary: improved / regressed / unchanged counts" },
          { id: "cmp-table", text: "Per-test-case table with result from both evaluations" },
        ],
      },
      {
        label: "Prompt deep-links",
        tasks: [
          { id: "cmp-deeplink", text: "Click a Prompt v badge → opens Prompt Lab History with that version expanded" },
          { id: "cmp-back", text: "Browser Back → returns to comparison page" },
        ],
        note: "Full Eva Loop complete! 1 agent, 3 test cases, 2 evals, behavior assertions throughout.",
        noteType: "success",
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// Helper: get all task IDs
// ═══════════════════════════════════════════════════════════

function getAllTaskIds(): string[] {
  const ids: string[] = [];
  for (const step of STEPS) {
    for (const sec of step.sections) {
      if (sec.tasks) for (const t of sec.tasks) ids.push(t.id);
    }
  }
  return ids;
}

function getStepTaskIds(step: Step): string[] {
  const ids: string[] = [];
  for (const sec of step.sections) {
    if (sec.tasks) for (const t of sec.tasks) ids.push(t.id);
  }
  return ids;
}

// ═══════════════════════════════════════════════════════════
// Service health check
// ═══════════════════════════════════════════════════════════

type ServiceStatus = "unknown" | "checking" | "ok" | "fail";

interface ServiceState {
  api: ServiceStatus;
  agent: ServiceStatus;
  ollama: ServiceStatus;
}

// ═══════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY = "eva-guide-progress";

function loadChecked(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveChecked(checked: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// Auto-detection: poll API state and resolve detect keys
// ═══════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 12_000; // 12 seconds

interface ApiSnapshot {
  agentCount: number;
  datasetCount: number;
  datasets: Array<{ id: string; name: string }>;
  testCases: Array<{ id: string; dataset_id: string; assertion_mode?: string }>;
  evaluations: Array<{ id: string; status: string }>;
  annotationCount: number;
  maxPromptVersion: number;
  productionTraceCount: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchApiSnapshot(): Promise<ApiSnapshot> {
  const snap: ApiSnapshot = {
    agentCount: 0,
    datasetCount: 0,
    datasets: [],
    testCases: [],
    evaluations: [],
    annotationCount: 0,
    maxPromptVersion: 0,
    productionTraceCount: 0,
  };

  // Agents
  const agents = await fetchJson<any[]>(`${API_BASE_URL}/agents`);
  if (agents) {
    snap.agentCount = agents.length;
    // Check max prompt version across agents
    for (const a of agents) {
      const ver = a.prompt_version ?? a.promptVersion ?? 1;
      if (ver > snap.maxPromptVersion) snap.maxPromptVersion = ver;
    }
  }

  // Datasets
  const datasets = await fetchJson<any[]>(`${API_BASE_URL}/datasets`);
  if (datasets) {
    snap.datasetCount = datasets.length;
    snap.datasets = datasets.map((d: any) => ({ id: d.id, name: d.name }));
  }

  // Test cases — fetch for each dataset
  for (const ds of snap.datasets) {
    const tcs = await fetchJson<any[]>(`${API_BASE_URL}/datasets/${ds.id}/testcases`);
    if (tcs) {
      for (const tc of tcs) {
        snap.testCases.push({
          id: tc.id,
          dataset_id: ds.id,
          assertion_mode: tc.assertion_mode ?? "response_only",
        });
      }
    }
  }

  // Evaluations
  const evals = await fetchJson<any[]>(`${API_BASE_URL}/evaluations`);
  if (evals) {
    snap.evaluations = evals.map((e: any) => ({ id: e.id, status: e.status }));
  }

  // Annotations — check for any eval with annotations
  const completedEvals = snap.evaluations.filter((e) => e.status === "completed");
  for (const ev of completedEvals.slice(0, 3)) {
    const runs = await fetchJson<any[]>(`${API_BASE_URL}/evaluations/${ev.id}/annotations/runs`);
    if (runs && runs.length > 0) {
      snap.annotationCount += runs.length;
      break; // we just need to know there's at least 1
    }
  }

  // Production traces
  const prodTraces = await fetchJson<any[]>(`${API_BASE_URL}/production-traces`);
  if (prodTraces) {
    snap.productionTraceCount = prodTraces.length;
  }

  return snap;
}

/** Resolve a detect key against the latest API snapshot */
function resolveDetectKey(key: string, snap: ApiSnapshot): boolean {
  if (key === "has_agents") return snap.agentCount > 0;
  if (key === "has_datasets") return snap.datasetCount > 0;
  if (key === "has_annotations") return snap.annotationCount > 0;
  if (key === "has_prompt_v2") return snap.maxPromptVersion >= 2;

  // has_testcases:N
  const tcMatch = key.match(/^has_testcases:(\d+)$/);
  if (tcMatch) return snap.testCases.length >= parseInt(tcMatch[1], 10);

  // has_tc_mode:MODE
  const modeMatch = key.match(/^has_tc_mode:(.+)$/);
  if (modeMatch) return snap.testCases.some((tc) => tc.assertion_mode === modeMatch[1]);

  // has_production_traces or has_production_traces:N
  if (key.startsWith("has_production_traces")) {
    const ptMatch = key.match(/^has_production_traces:(\d+)$/);
    const needed = ptMatch ? parseInt(ptMatch[1], 10) : 1;
    return snap.productionTraceCount >= needed;
  }

  // has_eval_completed or has_eval_completed:N
  if (key.startsWith("has_eval_completed")) {
    const countMatch = key.match(/^has_eval_completed:(\d+)$/);
    const needed = countMatch ? parseInt(countMatch[1], 10) : 1;
    const completed = snap.evaluations.filter((e) => e.status === "completed").length;
    return completed >= needed;
  }

  return false;
}

/** Collect all detect keys from steps */
function getAllDetectKeys(): Map<string, string[]> {
  // detect key → list of task IDs that use it
  const map = new Map<string, string[]>();
  for (const step of STEPS) {
    for (const sec of step.sections) {
      if (sec.tasks) {
        for (const t of sec.tasks) {
          if (t.detect) {
            const ids = map.get(t.detect) ?? [];
            ids.push(t.id);
            map.set(t.detect, ids);
          }
        }
      }
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════

export function GuideSidecar() {
  const { isOpen, close } = useGuideSidecar();
  const navigate = useNavigate();
  const [checked, setChecked] = useState<Record<string, boolean>>(loadChecked);
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({ 0: true });
  const [services, setServices] = useState<ServiceState>({
    api: "unknown",
    agent: "unknown",
    ollama: "unknown",
  });
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Persist checked state
  useEffect(() => {
    saveChecked(checked);
  }, [checked]);

  // Progress
  const allIds = useMemo(() => getAllTaskIds(), []);
  const doneCount = useMemo(() => allIds.filter((id) => checked[id]).length, [allIds, checked]);
  const pct = allIds.length > 0 ? Math.round((doneCount / allIds.length) * 100) : 0;

  // Toggle task — also clears from autoDetected so the poll can recheck
  const toggleTask = useCallback((id: string) => {
    setChecked((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
        // Remove from autoDetected so it gets rechecked on next poll
        setAutoDetected((ad) => {
          if (!ad.has(id)) return ad;
          const copy = new Set(ad);
          copy.delete(id);
          return copy;
        });
      } else {
        next[id] = true;
      }
      return next;
    });
  }, []);

  // Complete / uncomplete all tasks in a section
  const toggleSection = useCallback((sec: Section) => {
    if (!sec.tasks || sec.tasks.length === 0) return;
    const ids = sec.tasks.map((t) => t.id);
    const allDone = ids.every((id) => checked[id]);
    setChecked((prev) => {
      const next = { ...prev };
      if (allDone) {
        // Uncheck all
        for (const id of ids) delete next[id];
      } else {
        // Check all
        for (const id of ids) next[id] = true;
      }
      return next;
    });
  }, [checked]);

  // Toggle step
  const toggleStep = useCallback((num: number) => {
    setOpenSteps((prev) => ({ ...prev, [num]: !prev[num] }));
  }, []);

  // Next step
  const goToNextStep = useCallback(() => {
    for (const step of STEPS) {
      const ids = getStepTaskIds(step);
      const allDone = ids.length > 0 && ids.every((id) => checked[id]);
      if (!allDone) {
        setOpenSteps({ [step.num]: true });
        // Scroll to step
        const el = document.getElementById(`guide-step-${step.num}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }, [checked]);

  // Reset all
  const resetProgress = useCallback(() => {
    setChecked({});
    setAutoDetected(new Set());
    setOpenSteps({ 0: true });
  }, []);

  // Reset a single step
  const resetStep = useCallback((stepNum: number) => {
    const step = STEPS.find((s) => s.num === stepNum);
    if (!step) return;
    const ids = getStepTaskIds(step);
    setChecked((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    setAutoDetected((prev) => {
      let changed = false;
      const copy = new Set(prev);
      for (const id of ids) {
        if (copy.has(id)) { copy.delete(id); changed = true; }
      }
      return changed ? copy : prev;
    });
  }, []);

  // Service health checks
  const checkServices = useCallback(async () => {
    setServices({ api: "checking", agent: "checking", ollama: "checking" });

    const check = async (url: string): Promise<boolean> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    };

    const [api, agent, ollama] = await Promise.all([
      check("/api/health"),
      check("http://localhost:8001/health"),
      check("http://localhost:11434/api/tags"),
    ]);

    setServices({
      api: api ? "ok" : "fail",
      agent: agent ? "ok" : "fail",
      ollama: ollama ? "ok" : "fail",
    });
  }, []);

  // Copy code
  const copyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 1500);
    });
  }, []);

  // ── Auto-detection: poll API and auto-tick tasks ──────────
  const [autoDetected, setAutoDetected] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectKeys = useMemo(() => getAllDetectKeys(), []);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const runDetection = async () => {
      try {
        const snap = await fetchApiSnapshot();
        if (cancelled) return;

        const newAutoIds = new Set<string>();
        for (const [key, taskIds] of detectKeys.entries()) {
          if (resolveDetectKey(key, snap)) {
            for (const id of taskIds) newAutoIds.add(id);
          }
        }

        // Cascade: if a task with detect resolved, also tick all
        // preceding tasks in the same section (they must have been
        // completed to reach the detected state).
        for (const step of STEPS) {
          for (const sec of step.sections) {
            if (!sec.tasks) continue;
            let latestDetectedIdx = -1;
            for (let i = sec.tasks.length - 1; i >= 0; i--) {
              if (newAutoIds.has(sec.tasks[i].id)) {
                latestDetectedIdx = i;
                break;
              }
            }
            if (latestDetectedIdx > 0) {
              for (let i = 0; i < latestDetectedIdx; i++) {
                newAutoIds.add(sec.tasks[i].id);
              }
            }
          }
        }

        // Sync auto-detected with checked state:
        // - Add newly detected items
        // - Remove items that were previously auto-detected but no longer resolve
        setAutoDetected((prevAuto) => {
          // Items that were auto-detected before but no longer resolve
          const staleIds = new Set<string>();
          for (const id of prevAuto) {
            if (!newAutoIds.has(id)) staleIds.add(id);
          }

          // Uncheck stale auto-detected items
          if (staleIds.size > 0) {
            setChecked((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const id of staleIds) {
                if (next[id]) { delete next[id]; changed = true; }
              }
              return changed ? next : prev;
            });
          }

          // Check newly detected items
          if (newAutoIds.size > 0) {
            setChecked((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const id of newAutoIds) {
                if (!next[id]) { next[id] = true; changed = true; }
              }
              return changed ? next : prev;
            });
          }

          return newAutoIds;
        });
      } catch {
        // Silent fail — will retry next interval
      }
    };

    // Run immediately on open
    runDetection();

    // Then poll
    pollRef.current = setInterval(runDetection, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen, detectKeys]);

  if (!isOpen) return null;

  const statusDot = (s: ServiceStatus) => {
    const colors: Record<ServiceStatus, string> = {
      unknown: "var(--muted-foreground)",
      checking: "#fdcb6e",
      ok: "#00b894",
      fail: "#e17055",
    };
    return (
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: colors[s],
          display: "inline-block",
          animation: s === "checking" ? "pulse 1s infinite" : undefined,
        }}
      />
    );
  };

  return (
    <>
    {/* Spacer to push main content left while sidecar is fixed */}
    <div style={{ width: 340, minWidth: 340, flexShrink: 0 }} />
    <div
      data-guide-sidecar
      style={{
        width: 340,
        height: "100vh",
        borderLeft: "1px solid var(--border)",
        background: "var(--card)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: 9990,
      }}
    >
      {/* ── Header ──────────────────────── */}
      <div
        style={{
          padding: "12px 14px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>
              E2E Guide
            </span>
            <span
              style={{
                fontSize: 10,
                background: "var(--blue-3)",
                color: "var(--blue-11)",
                padding: "1px 7px",
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              CUA
            </span>
          </div>
          <button
            onClick={close}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted-foreground)",
              padding: 2,
              display: "flex",
              borderRadius: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Progress bar */}
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--accent)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: pct === 100
                ? "#00b894"
                : "linear-gradient(90deg, var(--blue-9), var(--blue-11))",
              borderRadius: 3,
              transition: "width 0.4s ease",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 4,
            fontSize: 11,
            color: "var(--muted-foreground)",
          }}
        >
          <span>{doneCount} / {allIds.length} tasks</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {autoDetected.size > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 2, color: "#00b894" }} title="Auto-detected from API">
                <Lightning size={10} weight="fill" /> {autoDetected.size}
              </span>
            )}
            <span style={{ color: pct === 100 ? "#00b894" : "var(--blue-11)", fontWeight: 600 }}>
              {pct}%
            </span>
          </span>
        </div>
      </div>

      {/* ── Service status bar ──────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          fontSize: 11,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--muted-foreground)" }}>
          {statusDot(services.api)} API
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--muted-foreground)" }}>
          {statusDot(services.agent)} CUA
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--muted-foreground)" }}>
          {statusDot(services.ollama)} Ollama
        </div>
        <button
          onClick={checkServices}
          style={{
            marginLeft: "auto",
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 10,
            background: "var(--blue-3)",
            color: "var(--blue-11)",
            border: "none",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Check
        </button>
      </div>

      {/* ── Steps ───────────────────────── */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {STEPS.map((step) => {
          const ids = getStepTaskIds(step);
          const stepDone = ids.filter((id) => checked[id]).length;
          const allDone = ids.length > 0 && stepDone === ids.length;
          const isStepOpen = !!openSteps[step.num];

          return (
            <div
              key={step.num}
              id={`guide-step-${step.num}`}
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              {/* Step header */}
              <div
                onClick={() => toggleStep(step.num)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                  userSelect: "none",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
              >
                {/* Step number circle */}
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                    background: allDone ? "#00b894" : "transparent",
                    border: allDone
                      ? "2px solid #00b894"
                      : stepDone > 0
                        ? "2px solid var(--blue-9)"
                        : "2px solid var(--border)",
                    color: allDone
                      ? "white"
                      : stepDone > 0
                        ? "var(--blue-11)"
                        : "var(--muted-foreground)",
                    transition: "all 0.3s",
                  }}
                >
                  {allDone ? "✓" : step.num}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--foreground)" }}>
                    {step.title}
                  </div>
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                      color: "var(--muted-foreground)",
                      opacity: 0.7,
                      marginTop: 1,
                    }}
                  >
                    {step.eva}
                  </div>
                </div>

                {ids.length > 0 && (
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 10.5,
                      color: allDone ? "#00b894" : "var(--muted-foreground)",
                      whiteSpace: "nowrap",
                      fontWeight: allDone ? 600 : 400,
                    }}
                  >
                    {allDone ? "✓" : `${stepDone}/${ids.length}`}
                    {stepDone > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          resetStep(step.num);
                        }}
                        title={`Reset step ${step.num}`}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 1,
                          display: "flex",
                          alignItems: "center",
                          color: "var(--muted-foreground)",
                          opacity: 0.5,
                          transition: "opacity 0.15s",
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.5"; }}
                      >
                        <ArrowCounterClockwise size={11} />
                      </button>
                    )}
                  </span>
                )}

                {isStepOpen ? (
                  <CaretDown size={14} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} />
                ) : (
                  <CaretRight size={14} style={{ color: "var(--muted-foreground)", flexShrink: 0 }} />
                )}
              </div>

              {/* Step body */}
              {isStepOpen && (
                <div style={{ padding: "0 14px 12px 46px" }}>
                  {step.sections.map((sec, si) => {
                    const secTaskIds = sec.tasks?.map((t) => t.id) ?? [];
                    const secDoneCount = secTaskIds.filter((id) => checked[id]).length;
                    const secAllDone = secTaskIds.length > 0 && secDoneCount === secTaskIds.length;
                    return (
                    <div key={si}>
                      {sec.label && (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            margin: si === 0 ? "0 0 4px" : "12px 0 4px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: 0.5,
                              color: secAllDone ? "#00b894" : "var(--blue-11)",
                            }}
                          >
                            {sec.label}
                          </span>
                          {secTaskIds.length > 0 && (
                            <button
                              onClick={() => toggleSection(sec)}
                              title={secAllDone ? "Uncheck all tasks in this section" : "Complete all tasks in this section"}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 3,
                                fontSize: 9,
                                fontWeight: 600,
                                padding: "1px 6px",
                                borderRadius: 8,
                                border: "1px solid",
                                borderColor: secAllDone ? "#00b894" : "var(--border)",
                                background: secAllDone ? "rgba(0, 184, 148, 0.08)" : "transparent",
                                color: secAllDone ? "#00b894" : "var(--muted-foreground)",
                                cursor: "pointer",
                                transition: "all 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                if (!secAllDone) {
                                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--blue-9)";
                                  (e.currentTarget as HTMLButtonElement).style.color = "var(--blue-11)";
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!secAllDone) {
                                  (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                                  (e.currentTarget as HTMLButtonElement).style.color = "var(--muted-foreground)";
                                }
                              }}
                            >
                              {secAllDone ? <CheckCircle size={10} weight="fill" /> : <CheckCircle size={10} />}
                              {secAllDone ? "Done" : `${secDoneCount}/${secTaskIds.length}`}
                            </button>
                          )}
                        </div>
                      )}

                      {sec.tasks?.map((task) => {
                        const isDone = !!checked[task.id];
                        const isAutoDetected = autoDetected.has(task.id);
                        return (
                          <div
                            key={task.id}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 8,
                              padding: "4px 0",
                              userSelect: "none",
                            }}
                          >
                            {/* Checkbox */}
                            <div
                              onClick={() => toggleTask(task.id)}
                              style={{
                                cursor: "pointer",
                                flexShrink: 0,
                                marginTop: 1,
                              }}
                              title={isAutoDetected ? "Auto-detected from API — click to reset" : undefined}
                            >
                              {isDone && isAutoDetected ? (
                                <Lightning size={16} weight="fill" style={{ color: "#00b894" }} />
                              ) : isDone ? (
                                <CheckCircle size={16} weight="fill" style={{ color: "#00b894" }} />
                              ) : (
                                <Circle size={16} style={{ color: "var(--border)" }} />
                              )}
                            </div>

                            {/* Text — with optional nav link */}
                            <span
                              onClick={task.nav ? () => navigate(task.nav!) : () => toggleTask(task.id)}
                              style={{
                                flex: 1,
                                fontSize: 12,
                                lineHeight: 1.5,
                                color: isDone ? "var(--muted-foreground)" : "var(--foreground)",
                                textDecoration: isDone ? "line-through" : "none",
                                cursor: task.nav ? "pointer" : "pointer",
                                ...(task.nav && !isDone ? {
                                  borderBottom: "1px dashed var(--blue-8)",
                                  paddingBottom: 1,
                                } : {}),
                              }}
                              title={task.nav ? `Go to ${task.nav}` : undefined}
                            >
                              {task.nav && !isDone && (
                                <span style={{ color: "var(--blue-11)", marginRight: 2 }}>↗</span>
                              )}
                              {task.text}
                            </span>

                            {/* Copy button */}
                            {task.copy && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyCode(task.copy!);
                                }}
                                title={`Copy: ${task.copy}`}
                                style={{
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "1px 2px",
                                  flexShrink: 0,
                                  marginTop: 1,
                                  display: "flex",
                                  alignItems: "center",
                                  color: copiedCode === task.copy ? "#00b894" : "var(--muted-foreground)",
                                  opacity: copiedCode === task.copy ? 1 : 0.5,
                                  transition: "all 0.15s",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                                onMouseLeave={(e) => {
                                  if (copiedCode !== task.copy) (e.currentTarget as HTMLButtonElement).style.opacity = "0.5";
                                }}
                              >
                                {copiedCode === task.copy ? (
                                  <Check size={13} />
                                ) : (
                                  <ClipboardText size={13} />
                                )}
                              </button>
                            )}
                          </div>
                        );
                      })}

                      {sec.code && (
                        <div
                          style={{
                            position: "relative",
                            background: "var(--accent)",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            margin: "6px 0",
                            overflow: "hidden",
                          }}
                        >
                          <pre
                            style={{
                              padding: "8px 10px",
                              fontFamily: "'SF Mono', 'Fira Code', monospace",
                              fontSize: 11,
                              lineHeight: 1.5,
                              color: "var(--foreground)",
                              whiteSpace: "pre",
                              overflowX: "auto",
                              margin: 0,
                            }}
                          >
                            {sec.code}
                          </pre>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyCode(sec.code!);
                            }}
                            style={{
                              position: "absolute",
                              top: 4,
                              right: 4,
                              background: "var(--card)",
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              padding: "1px 5px",
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                              fontSize: 10,
                              color: copiedCode === sec.code ? "#00b894" : "var(--muted-foreground)",
                            }}
                          >
                            {copiedCode === sec.code ? (
                              <><Check size={10} /> Copied</>
                            ) : (
                              <><Copy size={10} /> Copy</>
                            )}
                          </button>
                        </div>
                      )}

                      {sec.note && (
                        <div
                          style={{
                            fontSize: 11,
                            lineHeight: 1.5,
                            color: "var(--muted-foreground)",
                            padding: "6px 8px",
                            background: "var(--accent)",
                            borderRadius: 5,
                            borderLeft: `3px solid ${
                              sec.noteType === "success"
                                ? "#00b894"
                                : sec.noteType === "warn"
                                  ? "#fdcb6e"
                                  : "var(--blue-9)"
                            }`,
                            margin: "6px 0",
                          }}
                        >
                          {sec.note}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Footer ──────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 14px",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <button
          onClick={resetProgress}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "var(--muted-foreground)",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "4px 8px",
            cursor: "pointer",
          }}
        >
          <ArrowCounterClockwise size={12} /> Reset
        </button>
        <button
          onClick={goToNextStep}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "white",
            background: "var(--blue-9)",
            border: "none",
            borderRadius: 5,
            padding: "4px 10px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Next Step <ArrowRight size={12} />
        </button>
      </div>

      {/* Pulse animation for service checks */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
    </>
  );
}
