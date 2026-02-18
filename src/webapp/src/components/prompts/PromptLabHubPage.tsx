import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Sparkle, Robot, ArrowRight, Lightning, Clock } from "@phosphor-icons/react";
import { getAgentIcon } from "@/lib/agentIcons";
import { NoDataCard } from "@/components/shared/NoDataCard";
import { API_BASE_URL } from "../../lib/config";

interface AgentSummary {
	id: string;
	name: string;
	description?: string;
	url?: string;
}

interface AgentPromptInfo {
	agentId: string;
	promptCount: number;
	activeVersion: number | null;
	proposalCount: number;
}

export function PromptLabHubPage() {
	const navigate = useNavigate();
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [promptInfo, setPromptInfo] = useState<Record<string, AgentPromptInfo>>({});
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		loadAgents();
	}, []);

	const loadAgents = async () => {
		try {
			const res = await fetch(`${API_BASE_URL}/agents?skip=0&limit=100`);
			if (res.ok) {
				const data = await res.json();
				setAgents(data);
				const infoPromises = data.map(async (agent: AgentSummary) => {
					const [promptsRes, proposalsRes] = await Promise.all([
						fetch(`${API_BASE_URL}/agents/${agent.id}/prompts`).catch(() => null),
						fetch(`${API_BASE_URL}/agents/${agent.id}/proposals?status=pending`).catch(() => null),
					]);
					const prompts = promptsRes?.ok ? await promptsRes.json() : [];
					const proposals = proposalsRes?.ok ? await proposalsRes.json() : [];
					const active = prompts.find((p: any) => p.is_active);
					return {
						agentId: agent.id,
						promptCount: prompts.length,
						activeVersion: active ? active.version : null,
						proposalCount: proposals.length,
					};
				});
				const infos = await Promise.all(infoPromises);
				const infoMap: Record<string, AgentPromptInfo> = {};
				infos.forEach((info: AgentPromptInfo) => {
					infoMap[info.agentId] = info;
				});
				setPromptInfo(infoMap);
			}
		} catch (e) {
			console.error("Failed to load agents:", e);
		} finally {
			setLoading(false);
		}
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-bold tracking-tight">Prompt Lab</h1>
					<p className="text-muted-foreground mt-1">AI-powered prompt engineering for your agents</p>
				</div>
				<p className="text-muted-foreground text-sm">Loading agents...</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-2xl font-bold tracking-tight">Prompt Lab</h1>
				<p className="text-muted-foreground mt-1">
					AI-powered prompt engineering for your agents
				</p>
			</div>

			{agents.length === 0 ? (
				<NoDataCard
					icon={<Robot size={48} className="text-muted-foreground mb-4" />}
					title="No agents registered yet"
					description="Register agents from the Agents page to start using the Prompt Lab."
				/>
			) : (
				<div className="w-full">
					{/* Table header */}
					<div
						className="grid items-center text-sm text-muted-foreground"
						style={{ gridTemplateColumns: "1fr 120px 120px 140px", padding: "16px 8px" }}
					>
						<span>Agent</span>
						<span>Active version</span>
						<span>Versions</span>
						<span>Proposals</span>
					</div>

					{/* Table rows */}
					{agents.map((agent) => {
						const info = promptInfo[agent.id];
						return (
							<div
								key={agent.id}
								className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
								style={{ gridTemplateColumns: "1fr 120px 120px 140px", padding: "16px 8px", cursor: "pointer" }}
								onClick={() => navigate(`/agents/${agent.id}/prompts`)}
							>
								{/* Agent name with icon */}
								<div className="flex items-center gap-3 min-w-0">
									<img
										src={getAgentIcon(agent.id)}
										alt=""
										className="w-8 h-8 rounded-md flex-shrink-0"
									/>
									<div className="min-w-0 flex-1">
										<div className="font-semibold text-sm truncate">{agent.name}</div>
										{agent.description && (
											<div className="text-xs text-muted-foreground truncate mt-0.5">
												{agent.description}
											</div>
										)}
									</div>
								</div>

								{/* Active version */}
								<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
									<Lightning size={12} />
									{info?.activeVersion !== null && info?.activeVersion !== undefined
										? <Badge variant="secondary" className="text-xs">v{info.activeVersion}</Badge>
										: "No prompt"}
								</span>

								{/* Version count */}
								<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
									<Clock size={12} />
									{info ? `${info.promptCount} version${info.promptCount !== 1 ? "s" : ""}` : "—"}
								</span>

								{/* Proposals */}
								<div className="flex items-center gap-2">
									{info?.proposalCount ? (
										<Badge variant="secondary" className="text-xs" style={{
											background: "rgba(88,166,255,0.12)",
											color: "#58a6ff",
											border: "none",
										}}>
											<Sparkle size={10} className="mr-1" /> {info.proposalCount} pending
										</Badge>
									) : (
										<span className="text-xs text-muted-foreground">—</span>
									)}
									<ArrowRight size={14} className="text-muted-foreground ml-auto" />
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
