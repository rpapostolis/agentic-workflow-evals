/**
 * Eval Lifecycle — Interactive Process Explainer
 *
 * Full-page interactive guide showing the 8-step evaluation loop
 * with circular SVG diagram, clickable step list, rich detail panels,
 * and a philosophy section explaining the "why" behind eval-driven development.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	Robot,
	Flask,
	Play,
	ChartBar,
	Sparkle,
	GitDiff,
	ShieldCheck,
	Crosshair,
	ArrowClockwise,
	Lightbulb,
	BookOpen,
	CheckSquare,
} from "@phosphor-icons/react";

// ─── Step content ───────────────────────────────────────────────────

interface Principle {
	icon: React.ComponentType<any>;
	title: string;
	color: string;
	body: string;
}

interface StepContent {
	id: string;
	number: number;
	category: string;
	title: string;
	icon: React.ComponentType<any>;
	iconChar: string;
	description: string;
	whyItMatters: string;
	mechanics: string[];
	example: string;
	pitfall: string;
	accentColor: string;
	navigateTo: string;
	principles?: Principle[];
}

const STEPS: StepContent[] = [
	{
		id: "philosophy",
		number: 0,
		category: "UNDERSTAND",
		title: "The Philosophy",
		icon: BookOpen,
		iconChar: "\u2605",
		description:
			"Building reliable AI agents requires a fundamentally different approach than traditional software development. You can't write unit tests for non-deterministic systems the same way you test deterministic code. Eval-driven development bridges this gap — instead of hoping your prompt is good enough, you define what \"correct\" means, measure your agent against it, and iterate until the gap closes.",
		whyItMatters:
			"Most teams build AI agents by writing a prompt, trying a few examples manually, and shipping. This works until it doesn't — and when it breaks, you have no systematic way to diagnose or fix the problem. Eval-driven development gives you a feedback loop: every failure becomes a signal, every iteration is measurable, and every improvement is verifiable. Teams that adopt this approach typically reach 80%+ pass rates within 3-5 iterations, whereas ad hoc prompting plateaus around 50-60%.",
		mechanics: [
			"Define behavioral contracts (not string-matching tests) — assert on tool calls, argument values, and semantic response quality",
			"Automate the judge: an LLM evaluates each assertion with chain-of-thought reasoning, catching semantic equivalences that brittle tests miss",
			"Measure every change: every prompt edit gets a before/after comparison with per-test deltas",
			"Guard against regression: holdout test cases detect overfitting, comparison views catch silent breakage",
		],
		example:
			"Traditional approach: tweak prompt → manually test 2-3 inputs → ship and hope.\nEval-driven approach: tweak prompt → run 7+ tests automatically → see 57% → read failures → apply targeted fix → re-run → see 85% → verify no regressions → ship with confidence.",
		pitfall: "Don't skip the philosophy and jump straight into mechanics. Understanding why you evaluate — not just how — is what separates teams that build reliable agents from teams that fight the same bugs forever.",
		accentColor: "#bc8cff",
		navigateTo: "/agents",
		principles: [
			{
				icon: Crosshair,
				title: "Test Behavior, Not Output",
				color: "#58a6ff",
				body: "Traditional testing asks \"is the response correct?\" — eval-driven development asks \"did the agent take the right actions with the right parameters?\" By testing tool calls and arguments, you catch the actual decision-making process, not just whether the final sentence sounds good.",
			},
			{
				icon: ArrowClockwise,
				title: "Iterate, Don't Guess",
				color: "#3fb950",
				body: "Prompt engineering by intuition hits a ceiling fast. The eval loop replaces guesswork with measurement: run evaluation, read the failures, apply a targeted fix, measure again. Each cycle gives you a clear signal.",
			},
			{
				icon: ShieldCheck,
				title: "Guard Against Regression",
				color: "#f85149",
				body: "Every prompt change is a risk. A fix that makes 3 tests pass might silently break 2 others. The comparison view catches this immediately — you see exactly which tests improved, which regressed, and which held steady.",
			},
			{
				icon: Lightbulb,
				title: "Let Failures Drive Improvements",
				color: "#f0883e",
				body: "Failures aren't problems — they're the most valuable signal in your pipeline. Each one tells you something specific about how your agent misunderstands its instructions. The Prompt Lab turns these signals into concrete, targeted prompt changes.",
			},
		],
	},
	{
		id: "create",
		number: 1,
		category: "REGISTER",
		title: "Register Agent",
		icon: Robot,
		iconChar: "\u26A1",
		description:
			"Connect your AI agent to the evaluation framework by registering its HTTP endpoint. The evaluator needs to know where to send test inputs and how to interpret responses. This is the foundation of every eval loop — without a registered agent, there is nothing to test.",
		whyItMatters:
			"A well-defined agent registration decouples the evaluation framework from your agent's implementation. It doesn't matter if your agent uses GPT-4, Claude, a local model, or a rule-based system — as long as it speaks HTTP, the evaluator can test it. This means you can swap models, change architectures, and refactor freely, while your test suite remains stable.",
		mechanics: [
			"Define agent name, endpoint URL, and model type for tracking",
			"Configure timeout (how long to wait for each response) and concurrency",
			"The agent receives test inputs as JSON via HTTP POST and returns structured responses with tool calls",
			"Multiple agents can be registered and compared on the same test suite",
		],
		example:
			'The CU Agent is auto-registered at http://localhost:8001/invoke, model cua-agent (qwen3-vl:8b tuned via Modelfile), timeout 600s. The evaluator will POST {\"input\": \"Go to wikipedia.org and find the population of Tokyo...\"} and the agent drives a real browser to complete the task.',
		pitfall: "Don't skip configuring the timeout. Browser automation agents need long timeouts (5-10 min) — multi-step web tasks are slow, and a 30s default will cause false failures.",
		accentColor: "#58a6ff",
		navigateTo: "/agents",
	},
	{
		id: "define",
		number: 2,
		category: "DEFINE",
		title: "Add Test Cases",
		icon: Flask,
		iconChar: "\u25C9",
		description:
			"Build a dataset of behavioral contracts. Each test case is a specification: given this input, the agent should call these tools with these arguments, and the final response should meet these criteria. Think of test cases as executable requirements — they define what \"correct\" means for your agent.",
		whyItMatters:
			"The quality of your evaluations is determined entirely by the quality of your test cases. Vague tests give vague results. The most effective test suites encode real user scenarios with precise assertions — not just \"did the agent respond?\" but \"did it call the right tool with the right date in the right format?\" This specificity is what turns evaluations from a vanity metric into an actionable feedback signal.",
		mechanics: [
			"Each test case starts with an input prompt — a real task for the browser agent (navigate, extract, fill forms)",
			"Two assertion modes: response_only (just check the answer) and hybrid (behavior assertions + response quality)",
			"Behavior assertions describe what the agent should do: \"Agent navigates to news.ycombinator.com\", \"Agent extracts at least 5 story titles\"",
			"The LLM judge evaluates each assertion against the actual tool calls and response with chain-of-thought reasoning",
			"Mark test cases as holdout to prevent overfitting — holdout tests are excluded from AI proposal generation",
		],
		example:
			'3 test cases covering both modes:\n\n1. response_only — "Go to wikipedia.org and find the population of Tokyo. Return just the number."\n   Mode auto-detected: no assertions defined, so the judge evaluates the response quality only.\n\n2. hybrid — "Go to news.ycombinator.com and extract the top 5 story titles."\n   4 behavior assertions: navigates to HN, reads front page, extracts 5+ titles, returns numbered list.\n\n3. hybrid — "Go to localhost:5001/datasets and create a new dataset via the UI."\n   3 behavior assertions: navigates to datasets page, fills in the form fields, submits the form.',
		pitfall: "Avoid writing assertions that are too loose (\"response should be helpful\") or too brittle (\"response must be exactly this string\"). Aim for semantic assertions that capture intent — the LLM judge understands meaning, not just string matching.",
		accentColor: "#bc8cff",
		navigateTo: "/datasets",
	},
	{
		id: "capture",
		number: 3,
		category: "EXPAND",
		title: "Learn from Production",
		icon: Flask,
		iconChar: "\u25CB",
		description:
			"Run real tasks against your agent on-demand and capture the full execution trace — every tool call, every argument, latency, token usage, and the final response. The Run Task feature lets you generate production-grade traces without deploying to production, then annotate them, flag issues, and convert the best ones into test cases that expand your evaluation suite.",
		whyItMatters:
			"Manual test case creation has a blind spot: you can only test what you imagine. Running the agent on real tasks reveals behaviors you didn't anticipate — unexpected navigation paths, partial extraction, retry loops, timeout edge cases. By annotating these traces and converting them to test cases, you build a suite that reflects actual agent behavior, not just theoretical scenarios. Each converted trace closes a coverage gap.",
		mechanics: [
			"Run Task: click the green button on Production Traces, pick an agent, enter natural-language instructions — the agent executes in a real browser and the full trace is stored automatically",
			"Trace detail: review input, output, every tool call with arguments, latency, model, and token counts",
			"Annotate: rate outcome (1-5), tag efficiency, flag issues, and mark as test-case candidate",
			"Convert to Test Case: one click turns an annotated trace into a test case in any dataset — input maps to instructions, output to expected response",
			"PII scanning: every trace is automatically scanned for personally identifiable information before storage",
		],
		example:
			"Run Task: \"Go to wikipedia.org and find the population of Japan\". Agent opens browser, navigates, extracts the number — trace captured in ~90 seconds. You open the trace, see 4 tool calls (navigate, read_page, extract, respond). Annotate: outcome 5/5, efficiency \"efficient\". Mark as test-case candidate, convert to your Web Tasks dataset. Next evaluation now includes this real-world scenario.",
		pitfall: "Don't only capture failures. Successful runs are equally valuable — they validate your test coverage matches real usage patterns and establish baseline behavior. A test suite built only from edge cases can miss common-path regressions.",
		accentColor: "#bc8cff",
		navigateTo: "/production-traces",
	},
	{
		id: "execute",
		number: 4,
		category: "EXECUTE",
		title: "Run Evaluation",
		icon: Play,
		iconChar: "\u25C6",
		description:
			"The evaluator sends each test case to your agent endpoint, captures the full response including every tool call, and then passes each assertion to an LLM judge for scoring. This is the moment of truth — where your specifications meet your agent's actual behavior.",
		whyItMatters:
			"Automated evaluation eliminates the most painful bottleneck in agent development: manual testing. Instead of clicking through scenarios and eyeballing results, you get a precise, reproducible score in minutes. The LLM judge understands semantic equivalence — it knows that \"March 15th\" and \"2025-03-15\" and \"tomorrow\" can all mean the same date. This semantic judgment is what makes AI evaluation fundamentally more powerful than traditional unit tests for agent behavior.",
		mechanics: [
			"Warmup delay prevents race conditions with agent initialization",
			"Tests execute in parallel with controlled concurrency",
			"Each test is sent to the agent, then judged by an LLM",
			"Rate limit handling with automatic retry",
			"Real-time progress tracking throughout execution",
		],
		example:
			"3 test cases launch with concurrency 1 (browser agent can only run one session at a time). Each agent call takes 60-180s as the CUA navigates pages, clicks elements, and reads content. The LLM judge then evaluates each assertion at ~5s per check. Total wall time for 3 tests: ~5-10 minutes.",
		pitfall: "Browser automation agents are inherently slow — each test involves real page loads, rendering, and multi-step navigation. Keep concurrency at 1 for CUA agents (they share a single browser) and set timeouts to 600s to avoid false failures on complex tasks.",
		accentColor: "#3fb950",
		navigateTo: "/agents",
	},
	{
		id: "analyze",
		number: 5,
		category: "ANALYZE",
		title: "Review Results",
		icon: ChartBar,
		iconChar: "\u25A3",
		description:
			"Examine your evaluation results at every level of detail: overall pass rate, per-test breakdown, individual assertion results, and the judge's reasoning for each decision. The results page is where patterns emerge — you'll see which scenarios your agent handles well and where it consistently struggles.",
		whyItMatters:
			"Raw pass/fail numbers are just the starting point. The real value is in the failure analysis. When you see that 3 out of 7 tests fail, the question is: why? Is it the same root cause (e.g., the agent always parses dates wrong) or different issues? The results view gives you assertion-level detail so you can trace each failure to its root cause. This diagnosis is what makes the next step — prompt improvement — targeted and effective rather than guesswork.",
		mechanics: [
			"Overall pass rate with a visual score ring — green (80%+), amber (50%+), red (<50%)",
			"Per-test breakdown: expand any test case to see tool calls, arguments, and assertion results",
			"Assertion-level detail: see the judge's reasoning for why each check passed or failed",
			"Execution timing: how long each agent call and judge call took (identifies slow tests)",
			"Regression detection: if a previously-passing test now fails, it's flagged automatically",
		],
		example:
			'33% pass rate (1/3). "Wikipedia population" passed — agent navigated correctly and extracted the number. "Hacker News headlines" failed: agent only extracted 3 titles instead of 5 (assertion: "extracts at least 5 story titles" → FAIL). "Create dataset via UI" failed: agent clicked the wrong button and never reached the form. Root cause pattern: incomplete extraction (1 test) + UI navigation error (1 test).',
		pitfall: "Don't just look at the pass rate. Two evaluations can both show 33% but have completely different failure patterns. Always drill into the individual failures — the judge's reasoning tells you exactly what went wrong.",
		accentColor: "#d29922",
		navigateTo: "/dashboard",
	},
	{
		id: "annotate",
		number: 6,
		category: "ANNOTATE",
		title: "Review & Label",
		icon: CheckSquare,
		iconChar: "\u2713",
		description:
			"Add the human layer. Automated assertions catch the obvious failures, but some judgments need a human eye. The Annotations page lets you review each test result in detail — rate the overall outcome, flag specific tool calls as incorrect, and tag recurring issues. This human signal is what makes prompt improvements targeted rather than generic.",
		whyItMatters:
			"LLM judges are powerful but imperfect. They can miss subtle failures that a domain expert catches immediately — like an agent that calls the right tool with technically valid parameters but in the wrong business context. Your annotations capture this expert knowledge. Once you've annotated enough results (80%+ coverage), the system auto-triggers AI proposal generation using your human labels as ground truth, producing higher-quality prompt fixes than automated analysis alone.",
		mechanics: [
			"Run-level annotations: rate each test result on a 1-5 scale (Failed → Yes) with efficiency tags",
			"Action-level annotations: drill into individual tool calls to mark correctness, parameter quality, and error contribution",
			"Issue tagging: flag recurring problems like \"wrong tool used\", \"bad parameters\", \"repeated work\", or \"skipped required check\"",
			"Auto-trigger: once annotation coverage exceeds 80%, the system generates prompt improvement proposals informed by your labels",
			"Export: download annotations as JSON or CSV for offline analysis or team review",
		],
		example:
			"Test: \"Extract top 5 Hacker News titles\". Automated judge: FAIL (only 3 titles). Your annotation: 2/5 — agent navigated correctly but stopped scrolling too early. Action annotation: read_page_text marked as \"partly correct\" with note \"extracted titles from visible area only, didn't scroll to load more\". The scroll action is tagged as \"skipped required check\". This nuance feeds directly into the next prompt proposal.",
		pitfall: "Don't annotate only the failures. Reviewing passing tests occasionally catches false positives — cases where the judge said PASS but the agent took an inefficient or fragile path to get there.",
		accentColor: "#e3b341",
		navigateTo: "/annotations",
	},
	{
		id: "optimize",
		number: 7,
		category: "OPTIMIZE",
		title: "Improve Prompt",
		icon: Sparkle,
		iconChar: "\u2666",
		description:
			"The Prompt Lab is where failures become improvements. It analyzes patterns across your evaluation results — grouping failures by root cause — and generates AI-powered proposals: specific, concrete changes to your system prompt, each with a confidence score and detailed reasoning.",
		whyItMatters:
			"Manual prompt engineering is slow and fragile. You read a few failures, guess at a fix, update the prompt, re-run, and hope for the best. The Prompt Lab automates this cycle: it reads every failure, identifies statistical patterns (\"3/7 tests fail on date formatting\"), and generates targeted fixes (\"Add: Always use ISO 8601 date format YYYY-MM-DD\"). Each proposal comes with a confidence score calibrated on the strength of evidence — high confidence means the pattern is clear and the fix is well-supported.",
		mechanics: [
			"Pattern detection: failures are grouped by root cause — not surface symptoms",
			"AI proposals: each proposal is a specific prompt modification with title, reasoning, and confidence (0.0-1.0)",
			"One-click apply: proposals create a new prompt version automatically (version history is preserved)",
			"Regression safety: applying a proposal triggers a confirmation gate warning that changes can cause regressions",
			"Deduplication: the system tracks previously generated proposals and avoids suggesting the same fix twice",
		],
		example:
			'Pattern detected: "Incomplete page reading" (2/3 failures). Proposal: add "After navigating to a page, always use read_page_text to capture the full content before extracting information. If the page has dynamic content or requires scrolling, scroll down and read again to ensure nothing is missed." Confidence: 0.78.',
		pitfall: "Don't blindly apply high-confidence proposals. Always run a new evaluation after applying to check for regressions — a prompt change that fixes extraction tests might make the agent overly cautious on simple navigation tasks.",
		accentColor: "#f0883e",
		navigateTo: "/prompt-lab",
	},
	{
		id: "iterate",
		number: 8,
		category: "ITERATE",
		title: "Compare & Repeat",
		icon: GitDiff,
		iconChar: "\u25C6",
		description:
			"Close the loop by comparing your new evaluation against the baseline. The comparison view aligns results test-by-test, showing exactly which cases improved, which regressed, and which stayed the same. Then start the next iteration — the best agents are built through dozens of these cycles, not a single pass.",
		whyItMatters:
			"Without comparison, you're flying blind. A prompt change might improve your overall pass rate from 57% to 71% — but did it improve the right tests? Did anything regress? The comparison view answers these questions definitively. Over time, your version history becomes a record of every decision: what you changed, why, and what happened. This institutional memory is invaluable when debugging regressions or onboarding new team members.",
		mechanics: [
			"Side-by-side comparison: Baseline (older) vs Latest (newer) with automatic time-based ordering",
			"Per-test deltas: Improved (was failing, now passes), Regressed (was passing, now fails), Unchanged",
			"Pass rate delta: the net change in overall score with color coding (green = better, red = worse)",
			"Holdout monitoring: if you marked holdout test cases, their results are tracked separately to detect overfitting",
			"Version history: track the trajectory across prompt versions — see the trendline of improvement",
		],
		example:
			"Prompt v1 (33.3%) \u2192 Prompt v3 (100%): Wikipedia test unchanged (still passing), HN headlines improved (now extracts all 5), dataset creation improved (correct button targeting). Holdout: 1/1 passing. Net pass rate \u0394: +66.7%.",
		pitfall: "If you see improvements on training tests but not on holdout tests, your prompt changes may be overfitting to specific test cases rather than genuinely improving behavior.",
		accentColor: "#f85149",
		navigateTo: "/dashboard",
	},
];

// ─── Circular Diagram (SVG) ─────────────────────────────────────────

function CircularDiagram({
	activeStep,
	onStepClick,
}: {
	activeStep: number;
	onStepClick: (idx: number) => void;
}) {
	const cx = 140;
	const cy = 140;
	const r = 108;
	const nodeR = 20;

	const positions = STEPS.map((_, i) => {
		const angle = (i / STEPS.length) * Math.PI * 2 - Math.PI / 2;
		return {
			x: cx + r * Math.cos(angle),
			y: cy + r * Math.sin(angle),
		};
	});

	return (
		<svg width={280} height={280} viewBox="0 0 280 280" style={{ flexShrink: 0 }}>
			{/* Arrow lines between nodes */}
			{positions.map((pos, i) => {
				const next = positions[(i + 1) % positions.length];
				const dx = next.x - pos.x;
				const dy = next.y - pos.y;
				const len = Math.sqrt(dx * dx + dy * dy);
				const ux = dx / len;
				const uy = dy / len;
				const startX = pos.x + ux * (nodeR + 4);
				const startY = pos.y + uy * (nodeR + 4);
				const endX = next.x - ux * (nodeR + 4);
				const endY = next.y - uy * (nodeR + 4);

				const midX = (startX + endX) / 2;
				const midY = (startY + endY) / 2;

				const arrowSize = 5;
				const perpX = -uy * arrowSize;
				const perpY = ux * arrowSize;

				return (
					<g key={`line-${i}`}>
						<line
							x1={startX} y1={startY} x2={endX} y2={endY}
							stroke="#30363d" strokeWidth={1.5} opacity={0.6}
						/>
						<polygon
							points={`${midX + ux * arrowSize},${midY + uy * arrowSize} ${midX + perpX},${midY + perpY} ${midX - perpX},${midY - perpY}`}
							fill="#30363d" opacity={0.6}
						/>
					</g>
				);
			})}

			{/* Center label */}
			<text x={cx} y={cy - 6} textAnchor="middle" fill="#8b949e" fontSize={8.5} fontWeight={600} letterSpacing={2}>
				CONTINUOUS
			</text>
			<text x={cx} y={cy + 8} textAnchor="middle" fill="#8b949e" fontSize={8.5} fontWeight={600} letterSpacing={2}>
				IMPROVEMENT
			</text>

			{/* Step nodes */}
			{positions.map((pos, i) => {
				const step = STEPS[i];
				const isActive = i === activeStep;

				return (
					<g key={step.id} onClick={() => onStepClick(i)} style={{ cursor: "pointer" }}>
						{isActive && (
							<circle cx={pos.x} cy={pos.y} r={nodeR + 6} fill="none" stroke={step.accentColor} strokeWidth={2} opacity={0.3}>
								<animate attributeName="r" values={`${nodeR + 4};${nodeR + 10};${nodeR + 4}`} dur="2s" repeatCount="indefinite" />
								<animate attributeName="opacity" values="0.3;0.08;0.3" dur="2s" repeatCount="indefinite" />
							</circle>
						)}
						<circle
							cx={pos.x} cy={pos.y} r={nodeR}
							fill={isActive ? `${step.accentColor}18` : "#161b22"}
							stroke={isActive ? step.accentColor : "#30363d"}
							strokeWidth={isActive ? 2.5 : 1.5}
						/>
						<text
							x={pos.x} y={pos.y + 1} textAnchor="middle" dominantBaseline="central"
							fill={isActive ? step.accentColor : "#8b949e"} fontSize={step.number === 0 ? 12 : 14} fontWeight={600}
						>
							{step.number === 0 ? "\u2605" : step.number}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

// ─── Step List (vertical sidebar) ───────────────────────────────────

function StepList({
	activeStep,
	onStepClick,
}: {
	activeStep: number;
	onStepClick: (idx: number) => void;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%" }}>
			{STEPS.map((step, i) => {
				const isActive = i === activeStep;
				return (
					<button
						key={step.id}
						onClick={() => onStepClick(i)}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 12,
							padding: "10px 16px",
							borderRadius: 10,
							border: isActive ? `1px solid ${step.accentColor}40` : "1px solid transparent",
							background: isActive ? `${step.accentColor}0a` : "transparent",
							cursor: "pointer",
							textAlign: "left",
							transition: "all 0.2s ease",
						}}
						onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(88,166,255,0.04)"; }}
						onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
					>
						<span style={{ fontSize: 14, color: isActive ? step.accentColor : "var(--muted-foreground)", width: 18, textAlign: "center", flexShrink: 0 }}>
							{step.iconChar}
						</span>
						<div>
							<div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", color: isActive ? step.accentColor : "var(--muted-foreground)", marginBottom: 2 }}>
								{step.number === 0 ? "\u2605" : step.number}. {step.category}
							</div>
							<div style={{ fontSize: 14, fontWeight: isActive ? 600 : 500, color: isActive ? "var(--foreground)" : "var(--muted-foreground)" }}>
								{step.title}
							</div>
						</div>
					</button>
				);
			})}
		</div>
	);
}

// ─── Detail Panel ───────────────────────────────────────────────────

function StepDetail({ step }: { step: StepContent }) {
	const navigate = useNavigate();

	// ── Consistent typography tokens ──
	const LABEL = { fontSize: 11, fontWeight: 700 as const, letterSpacing: 1.8, textTransform: "uppercase" as const, color: step.accentColor };
	const BODY = { fontSize: 14, lineHeight: 1.7, color: "var(--muted-foreground)", margin: 0 };
	const MONO = { fontSize: 13, lineHeight: 1.65, color: "var(--muted-foreground)", margin: 0, fontFamily: "monospace", whiteSpace: "pre-wrap" as const };

	return (
		<div
			key={step.id}
			className="fade-in-up"
			style={{
				flex: 1,
				background: "var(--card)",
				border: "1px solid var(--border)",
				borderRadius: 14,
				padding: "32px 36px",
				display: "flex",
				flexDirection: "column",
				gap: 24,
			}}
		>
			{/* Header */}
			<div>
				<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
					<div style={{
						width: 36, height: 36, borderRadius: 9,
						background: `${step.accentColor}15`, border: `1px solid ${step.accentColor}30`,
						display: "flex", alignItems: "center", justifyContent: "center",
					}}>
						<step.icon size={18} color={step.accentColor} />
					</div>
					<div style={{ ...LABEL, fontSize: 12, letterSpacing: 2 }}>
						{step.number === 0 ? "FOUNDATION" : `STEP ${step.number}`} — {step.category}
					</div>
				</div>
				<h2 style={{ fontSize: 28, fontWeight: 700, color: "var(--foreground)", margin: 0, lineHeight: 1.2 }}>
					{step.title}
				</h2>
			</div>

			{/* Description */}
			<p style={{ ...BODY, fontSize: 15 }}>
				{step.description}
			</p>

			{/* Why It Matters */}
			<div style={{
				background: `${step.accentColor}06`,
				border: `1px solid ${step.accentColor}12`,
				borderRadius: 10,
				padding: "16px 20px",
			}}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
					<Lightbulb size={14} color={step.accentColor} />
					<span style={{ ...LABEL }}>WHY IT MATTERS</span>
				</div>
				<p style={{ ...BODY }}>{step.whyItMatters}</p>
			</div>

			{/* Core Principles (Step 0 only) */}
			{step.principles && (
				<div>
					<div style={{ ...LABEL, marginBottom: 12 }}>CORE PRINCIPLES</div>
					<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
						{step.principles.map((p) => (
							<div
								key={p.title}
								style={{
									display: "flex", alignItems: "flex-start", gap: 10,
									padding: "10px 14px", borderRadius: 8,
									background: `${p.color}06`, border: `1px solid ${p.color}15`,
								}}
							>
								<div style={{
									width: 24, height: 24, borderRadius: 6, flexShrink: 0, marginTop: 1,
									background: `${p.color}12`, border: `1px solid ${p.color}20`,
									display: "flex", alignItems: "center", justifyContent: "center",
								}}>
									<p.icon size={12} color={p.color} />
								</div>
								<div>
									<div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)", marginBottom: 2 }}>{p.title}</div>
									<div style={{ ...BODY, fontSize: 12, lineHeight: 1.5 }}>{p.body}</div>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Key Mechanics */}
			<div>
				<div style={{ ...LABEL, marginBottom: 12 }}>KEY MECHANICS</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{step.mechanics.map((m, i) => (
						<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
							<span style={{ width: 5, height: 5, borderRadius: "50%", background: step.accentColor, flexShrink: 0, marginTop: 7 }} />
							<span style={{ ...BODY }}>{m}</span>
						</div>
					))}
				</div>
			</div>

			{/* Example */}
			<div style={{
				background: `${step.accentColor}08`, border: `1px solid ${step.accentColor}15`,
				borderRadius: 10, padding: "14px 20px",
			}}>
				<div style={{ ...LABEL, marginBottom: 8 }}>EXAMPLE</div>
				<p style={{ ...MONO }}>{step.example}</p>
			</div>

			{/* Pitfall */}
			<div style={{
				display: "flex", gap: 10, alignItems: "flex-start",
				padding: "12px 16px", borderRadius: 8,
				background: `${step.accentColor}06`, border: `1px solid ${step.accentColor}12`,
			}}>
				<ShieldCheck size={15} color={step.accentColor} style={{ flexShrink: 0, marginTop: 2 }} />
				<div>
					<span style={{ ...LABEL, letterSpacing: 1.4 }}>WATCH OUT </span>
					<span style={{ ...BODY }}>{step.pitfall}</span>
				</div>
			</div>

			{/* Navigate button */}
			<div>
				<button
					onClick={() => navigate(step.navigateTo)}
					style={{
						padding: "10px 24px", borderRadius: 8,
						border: `1px solid ${step.accentColor}40`, background: `${step.accentColor}10`,
						color: step.accentColor, cursor: "pointer", fontSize: 14, fontWeight: 600,
						transition: "all 0.15s ease",
					}}
					onMouseEnter={(e) => { e.currentTarget.style.background = `${step.accentColor}20`; }}
					onMouseLeave={(e) => { e.currentTarget.style.background = `${step.accentColor}10`; }}
				>
					{step.number === 0 ? "Start with Step 1 \u2192" : `Go to ${step.title} \u2192`}
				</button>
			</div>
		</div>
	);
}


// ─── Page Component ─────────────────────────────────────────────────

export function EvalLifecyclePage() {
	const [activeStep, setActiveStep] = useState(0);

	return (	
		<div>
			{/* ── Hero ── */}
			<div style={{ marginBottom: 48 }}>
				<div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "#58a6ff", marginBottom: 14 }}>
					THE EVALUATION LOOP
				</div>
				<h1 style={{ fontSize: 36, fontWeight: 700, color: "var(--foreground)", margin: 0, lineHeight: 1.15 }}>
					<span style={{ color: "rgb(188, 140, 255)" }}>Hope</span> won't fix your Agents — <span style={{ color: "#3fb950" }}>Evals Loops</span> <wbr></wbr>will.
				</h1>
				<p style={{ fontSize: 15, lineHeight: 1.7, color: "var(--muted-foreground)", marginTop: 18, margin: 0, marginBlockStart: 18 }}>
					AI agents fail in unpredictable ways. They call the wrong tools, misparse dates, hallucinate
					parameters, and produce plausible-sounding answers that are silently wrong. The only way to catch
					these failures systematically is to evaluate — define what correct behavior looks like, measure
					your agent against it, and iterate until the gap closes. That is the evaluation loop.
				</p>
			</div>

			{/* ── Interactive Lifecycle ── */}
			<div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 80 }}>
				{/* Left column */}
				<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, flexShrink: 0, width: 280 }}>
					<CircularDiagram activeStep={activeStep} onStepClick={setActiveStep} />
					<StepList activeStep={activeStep} onStepClick={setActiveStep} />
				</div>

				{/* Right column */}
				<StepDetail step={STEPS[activeStep]} />
			</div>

		</div>
	);
}
