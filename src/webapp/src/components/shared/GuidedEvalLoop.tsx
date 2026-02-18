/**
 * GuidedEvalLoop — Lightweight contextual nudge
 *
 * Instead of a persistent stepper bar, this shows a small, dismissible
 * hint only when the user hasn't completed the obvious next step.
 * It renders a single sentence + link, not a pipeline diagram.
 *
 * Disappears entirely once the user has run at least one evaluation,
 * or after dismissal (persisted in localStorage).
 */

import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, X } from "@phosphor-icons/react";

import { API_BASE_URL } from "@/lib/config";

const LS_KEY = "agenteval_nudge_dismissed";

interface NudgeState {
	hasAgents: boolean;
	hasDatasets: boolean;
	hasAnyEval: boolean;
	loading: boolean;
}

export function GuidedEvalLoop() {
	const location = useLocation();
	const navigate = useNavigate();
	const [dismissed, setDismissed] = useState(
		() => localStorage.getItem(LS_KEY) === "true"
	);
	const [state, setState] = useState<NudgeState>({
		hasAgents: false,
		hasDatasets: false,
		hasAnyEval: false,
		loading: true,
	});

	useEffect(() => {
		let cancelled = false;
		async function check() {
			try {
				const [agents, datasets, evals] = await Promise.all([
					fetch(`${API_BASE_URL}/agents`).then((r) => (r.ok ? r.json() : [])),
					fetch(`${API_BASE_URL}/datasets`).then((r) => (r.ok ? r.json() : [])),
					fetch(`${API_BASE_URL}/evaluations`).then((r) => (r.ok ? r.json() : [])),
				]);
				if (!cancelled) {
					setState({
						hasAgents: agents.length > 0,
						hasDatasets: datasets.length > 0,
						hasAnyEval: evals.length > 0,
						loading: false,
					});
				}
			} catch {
				if (!cancelled) setState((s) => ({ ...s, loading: false }));
			}
		}
		check();
		return () => { cancelled = true; };
	}, []);

	if (state.loading || dismissed) return null;

	// Once the user has run any eval, they know the flow — stop nudging.
	if (state.hasAnyEval) return null;

	// Only show on Setup / Evaluate pages, not on analytics or deep views
	const show = ["/agents", "/datasets", "/annotations", "/prompt-lab", "/leaderboard"].some(
		(p) => location.pathname === p
	);
	if (!show) return null;

	// Figure out what the next step is
	let message: string;
	let actionLabel: string;
	let actionPath: string;

	if (!state.hasDatasets && !state.hasAgents) {
		message = "Get started by creating a dataset and registering an agent.";
		actionLabel = "Create dataset";
		actionPath = "/datasets";
	} else if (!state.hasDatasets) {
		message = "You have an agent registered. Next, create a dataset with test cases.";
		actionLabel = "Create dataset";
		actionPath = "/datasets";
	} else if (!state.hasAgents) {
		message = "You have a dataset. Next, register the agent you want to evaluate.";
		actionLabel = "Register agent";
		actionPath = "/agents";
	} else {
		message = "You're ready to run your first evaluation.";
		actionLabel = "Go to Agents";
		actionPath = "/agents";
	}

	const dismiss = () => {
		localStorage.setItem(LS_KEY, "true");
		setDismissed(true);
	};

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "10px 16px",
				marginBottom: 20,
				borderRadius: 8,
				border: "1px solid rgba(88,166,255,0.2)",
				background: "rgba(88,166,255,0.04)",
				fontSize: 13,
				color: "var(--muted-foreground)",
			}}
		>
			<span style={{ flex: 1 }}>{message}</span>
			{location.pathname !== actionPath && (
				<button
					onClick={() => navigate(actionPath)}
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "4px 12px",
						borderRadius: 6,
						border: "1px solid rgba(88,166,255,0.3)",
						background: "rgba(88,166,255,0.08)",
						color: "#58a6ff",
						cursor: "pointer",
						fontSize: 12,
						fontWeight: 500,
						whiteSpace: "nowrap",
					}}
				>
					{actionLabel}
					<ArrowRight size={12} />
				</button>
			)}
			<button
				onClick={dismiss}
				aria-label="Dismiss"
				style={{
					display: "flex",
					alignItems: "center",
					padding: 2,
					border: "none",
					background: "none",
					color: "var(--muted-foreground)",
					cursor: "pointer",
					opacity: 0.5,
					flexShrink: 0,
				}}
			>
				<X size={14} />
			</button>
		</div>
	);
}
