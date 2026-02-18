import { useState, useEffect, useCallback } from "react";
import { Box, Card, Flex, Text, Badge, Tabs } from "@radix-ui/themes";
import { Button } from "@/components/ui/button";
import {
	ArrowLeft,
	Plus,
	Trash,
	CaretDown,
	PencilSimple,
	FloppyDisk,
	Gavel,
	Lightning,
	ClockCounterClockwise,
	ListChecks,
	Code,
	CircleNotch,
	CaretRight,
	CheckCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { apiClient, JudgeConfig, JudgeConfigCreate, RubricCriterion } from "@/lib/api";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// ─── Shared styles ───────────────────────────────────────────────────

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

const LEVEL_COLORS = ["#f85149", "#f0883e", "#d29922", "#56d364", "#3fb950"];

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a precise evaluator. Assess each assertion objectively and return ONLY valid JSON. Keep each reasoning to ONE sentence. Return passed=true only if the assertion is clearly satisfied.`;

const DEFAULT_BATCHED_TEMPLATE = `You are evaluating multiple assertions about an AI agent's tool usage in a single pass.

**Test Context:**
- Input: {{test_input}}
- Description: {{test_description}}

**Tool:** {{tool_name}}
**Agent's Tool Calls:** {{tool_calls_json}}
**Actual Tools Used:** {{actual_tools}}

**Assertions to evaluate (evaluate ALL of them):**
{{assertions_block}}

**Task:** For EACH assertion, determine if it is satisfied (true/false) with a one-sentence explanation.

Respond with ONLY a JSON object containing a "results" array, one entry per assertion in the SAME ORDER:
{
    "results": [
        {"index": 0, "passed": true, "reasoning": "One sentence explanation."},
        {"index": 1, "passed": false, "reasoning": "One sentence explanation."}
    ]
}`;

const DEFAULT_SINGLE_TEMPLATE = `You are evaluating a specific assertion about an AI agent's performance.

**Test Context:**
- Input: {{test_input}}
- Description: {{test_description}}

{{assertion_context}}

**Task:** Determine if this assertion is satisfied (True/False).

Respond in JSON format with a single human-readable sentence explanation:
{
    "passed": true,
    "reasoning": "One sentence explaining why this assertion passed or failed."
}`;

const AVAILABLE_VARIABLES = [
	"{{test_input}}",
	"{{test_description}}",
	"{{tool_name}}",
	"{{argument_name}}",
	"{{assertion_text}}",
	"{{tool_calls_json}}",
	"{{actual_tools}}",
	"{{agent_response}}",
	"{{expected_response}}",
	"{{assertions_block}}",
	"{{rubric}}",
	"{{assertion_context}}",
];

// ─── Types ───────────────────────────────────────────────────────────

interface EditState {
	name: string;
	notes: string;
	system_prompt: string;
	user_prompt_template_batched: string;
	user_prompt_template_single: string;
	scoring_mode: "binary" | "rubric";
	pass_threshold: number | null;
	rubric: RubricCriterion[];
}

type SystemPrompt = {
	key: string;
	name: string;
	description: string;
	content: string;
	updated_at: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diffMs = now - then;
	const mins = Math.floor(diffMs / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(dateStr).toLocaleDateString();
}

// ═════════════════════════════════════════════════════════════════════
// Main Component
// ═════════════════════════════════════════════════════════════════════

export function JudgeConfigPage() {
	// ─── Navigation state ────────────────────────────────────────────
	const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
	const [configs, setConfigs] = useState<JudgeConfig[]>([]);
	const [versions, setVersions] = useState<JudgeConfig[]>([]);
	const [loading, setLoading] = useState(true);

	// ─── Create dialog ───────────────────────────────────────────────
	const [isCreating, setIsCreating] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createSystemPrompt, setCreateSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);

	// ─── Saving / activating ─────────────────────────────────────────
	const [isSaving, setIsSaving] = useState(false);
	const [isActivating, setIsActivating] = useState(false);

	// ─── Editor state ────────────────────────────────────────────────
	const [editState, setEditState] = useState<EditState>({
		name: "",
		notes: "",
		system_prompt: "",
		user_prompt_template_batched: "",
		user_prompt_template_single: "",
		scoring_mode: "binary",
		pass_threshold: null,
		rubric: [],
	});

	// ─── Templates tab ───────────────────────────────────────────────
	const [activeTemplate, setActiveTemplate] = useState<"batched" | "single">("batched");

	// ─── Rubric criteria expand/collapse ─────────────────────────────
	const [expandedCriteria, setExpandedCriteria] = useState<Set<number>>(new Set());
	const toggleCriterion = (i: number) => {
		setExpandedCriteria((prev) => {
			const next = new Set(prev);
			if (next.has(i)) next.delete(i);
			else next.add(i);
			return next;
		});
	};

	// ─── Variables panel ─────────────────────────────────────────────
	const [showVariables, setShowVariables] = useState(false);

	// ─── System Prompts ──────────────────────────────────────────────
	const [systemPrompts, setSystemPrompts] = useState<SystemPrompt[]>([]);
	const [editingPromptKey, setEditingPromptKey] = useState<string | null>(null);
	const [editingPromptContent, setEditingPromptContent] = useState("");
	const [savingPrompt, setSavingPrompt] = useState(false);
	const [systemPromptsExpanded, setSystemPromptsExpanded] = useState(() => {
		try { return localStorage.getItem("judgeConfig.sysPromptsOpen") === "true"; } catch { return false; }
	});
	const toggleSystemPrompts = () => setSystemPromptsExpanded(prev => {
		const next = !prev;
		try { localStorage.setItem("judgeConfig.sysPromptsOpen", String(next)); } catch {}
		return next;
	});

	const fetchSystemPrompts = useCallback(async () => {
		try {
			const data = await apiClient.listSystemPrompts();
			setSystemPrompts(data);
		} catch (e) {
			console.error("Failed to load system prompts", e);
		}
	}, []);

	useEffect(() => { fetchSystemPrompts(); }, [fetchSystemPrompts]);

	const handleSaveSystemPrompt = async (key: string) => {
		setSavingPrompt(true);
		try {
			await apiClient.updateSystemPrompt(key, { content: editingPromptContent });
			toast.success("System prompt updated");
			setEditingPromptKey(null);
			fetchSystemPrompts();
		} catch { toast.error("Failed to update prompt"); }
		finally { setSavingPrompt(false); }
	};

	// ─── Config CRUD ─────────────────────────────────────────────────

	const fetchConfigs = async () => {
		try {
			setLoading(true);
			const allConfigs = await apiClient.listJudgeConfigs();
			// Dedupe by config ID, keeping the first occurrence per ID.
			// Backend returns ORDER BY id, version DESC so the first entry
			// for each ID is the latest version (or the active one).
			const seen = new Map<string, JudgeConfig>();
			for (const c of allConfigs) {
				if (!seen.has(c.id)) {
					// Prefer the active version if there is one
					seen.set(c.id, c);
				} else if (c.is_active && !seen.get(c.id)!.is_active) {
					seen.set(c.id, c);
				}
			}
			const uniqueConfigs = Array.from(seen.values())
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
			setConfigs(uniqueConfigs);
		} catch { toast.error("Failed to load judge configs"); }
		finally { setLoading(false); }
	};

	useEffect(() => { fetchConfigs(); }, []);

	const handleSelectConfig = async (configId: string) => {
		try {
			const configVersions = await apiClient.listJudgeConfigVersions(configId);
			setVersions(configVersions.sort((a, b) => b.version - a.version));
			const latest = configVersions[0];
			if (latest) {
				setEditState({
					name: latest.name,
					notes: latest.notes || "",
					system_prompt: latest.system_prompt,
					user_prompt_template_batched: latest.user_prompt_template_batched,
					user_prompt_template_single: latest.user_prompt_template_single,
					scoring_mode: latest.scoring_mode,
					pass_threshold: latest.pass_threshold || null,
					rubric: latest.rubric || [],
				});
			}
			setSelectedConfigId(configId);
		} catch { toast.error("Failed to load config versions"); }
	};

	const handleCreateConfig = async () => {
		if (!createName.trim()) { toast.error("Config name is required"); return; }
		try {
			setIsSaving(true);
			const newConfig = await apiClient.createJudgeConfig({
				name: createName,
				system_prompt: createSystemPrompt,
				user_prompt_template_batched: DEFAULT_BATCHED_TEMPLATE,
				user_prompt_template_single: DEFAULT_SINGLE_TEMPLATE,
				scoring_mode: "binary",
				rubric: [],
			});
			toast.success("Config created");
			setIsCreating(false);
			setCreateName("");
			setCreateSystemPrompt(DEFAULT_SYSTEM_PROMPT);
			await fetchConfigs();
			await handleSelectConfig(newConfig.id);
		} catch { toast.error("Failed to create config"); }
		finally { setIsSaving(false); }
	};

	const handleSaveNewVersion = async () => {
		if (!editState.name.trim()) { toast.error("Config name is required"); return; }
		try {
			setIsSaving(true);
			const createData: JudgeConfigCreate = {
				name: editState.name,
				notes: editState.notes,
				system_prompt: editState.system_prompt,
				user_prompt_template_batched: editState.user_prompt_template_batched,
				user_prompt_template_single: editState.user_prompt_template_single,
				scoring_mode: editState.scoring_mode,
				pass_threshold: editState.pass_threshold,
				rubric: editState.rubric,
			};
			await apiClient.createJudgeConfig(createData);
			toast.success("New version saved");
			if (selectedConfigId) await handleSelectConfig(selectedConfigId);
		} catch { toast.error("Failed to save version"); }
		finally { setIsSaving(false); }
	};

	const handleActivate = async () => {
		if (!selectedConfigId || versions.length === 0) return;
		try {
			setIsActivating(true);
			const latestVersion = versions[0].version;
			await apiClient.activateJudgeConfig(selectedConfigId, latestVersion);
			toast.success("Config activated");
			await fetchConfigs();
			await handleSelectConfig(selectedConfigId);
		} catch { toast.error("Failed to activate config"); }
		finally { setIsActivating(false); }
	};

	// ─── Rubric handlers ─────────────────────────────────────────────

	const handleUpdateCriterion = (index: number, field: "name" | "description", value: string) => {
		const newRubric = [...editState.rubric];
		if (field === "name") newRubric[index].name = value;
		else newRubric[index].description = value;
		setEditState({ ...editState, rubric: newRubric });
	};

	const handleUpdateLevel = (criterionIndex: number, levelIndex: number, description: string) => {
		const newRubric = [...editState.rubric];
		newRubric[criterionIndex].levels[levelIndex].description = description;
		setEditState({ ...editState, rubric: newRubric });
	};

	const handleAddCriterion = () => {
		const newRubric = [
			...editState.rubric,
			{
				name: "New Criterion",
				description: "",
				levels: [
					{ score: 1, description: "Does not satisfy" },
					{ score: 2, description: "Partially satisfies" },
					{ score: 3, description: "Satisfies" },
					{ score: 4, description: "Exceeds" },
					{ score: 5, description: "Far exceeds" },
				],
			},
		];
		setEditState({ ...editState, rubric: newRubric });
		setExpandedCriteria((prev) => new Set([...prev, newRubric.length - 1]));
	};

	const handleRemoveCriterion = (index: number) => {
		const newRubric = editState.rubric.filter((_, i) => i !== index);
		setEditState({ ...editState, rubric: newRubric });
	};

	// ═════════════════════════════════════════════════════════════════
	// Loading
	// ═════════════════════════════════════════════════════════════════

	if (loading) {
		return (
			<Flex direction="column" align="center" justify="center" style={{ minHeight: "60vh" }}>
				<CircleNotch size={48} className="animate-spin text-primary" style={{ marginBottom: 16 }} />
				<Text size="2" style={{ color: "var(--muted-foreground)" }}>Loading judge configs…</Text>
			</Flex>
		);
	}

	// ═════════════════════════════════════════════════════════════════
	// LIST VIEW
	// ═════════════════════════════════════════════════════════════════

	if (!selectedConfigId) {
		return (
			<Flex direction="column" gap="5">
				{/* Header */}
				<Flex justify="between" align="start" gap="4">
					<Flex direction="column" gap="1">
						<Text size="6" weight="bold" style={{ color: "var(--foreground)" }}>
							Judge Configurations
						</Text>
						<Text size="2" style={{ color: "var(--muted-foreground)" }}>
							Configure how the LLM judge evaluates agent responses
						</Text>
					</Flex>
					<Button onClick={() => setIsCreating(true)} className="gap-2">
						<Plus size={16} weight="bold" /> New Config
					</Button>
				</Flex>

				{/* Config cards */}
				{configs.length === 0 ? (
					<Card style={CARD_STYLE}>
						<Flex direction="column" align="center" justify="center" py="8">
							<Box style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
								<Gavel size={20} style={{ color: "var(--muted-foreground)" }} />
							</Box>
							<Text size="2" weight="medium" style={{ color: "var(--muted-foreground)" }}>No judge configurations yet</Text>
							<Text size="1" style={{ color: "var(--muted-foreground)", marginTop: 4 }}>
								Create one to configure how the judge evaluates responses
							</Text>
							<Button onClick={() => setIsCreating(true)} className="gap-2 mt-4" size="sm">
								<Plus size={14} /> New Config
							</Button>
						</Flex>
					</Card>
				) : (
					<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
						{configs.map((config) => (
							<Card
								key={config.id}
								style={{
									...CARD_STYLE,
									cursor: "pointer",
									transition: "border-color 0.15s, background 0.15s",
									...(config.is_active ? { borderColor: `${COLORS.green}40` } : {}),
								}}
								className="hover:bg-secondary/50"
								onClick={() => handleSelectConfig(config.id)}
							>
								<Box p="3">
									<Flex align="center" gap="2" mb="2">
										<Box style={{
											width: 28, height: 28, borderRadius: 6,
											background: config.is_active ? `${COLORS.green}15` : `${COLORS.blue}15`,
											display: "flex", alignItems: "center", justifyContent: "center",
										}}>
											{config.is_active
												? <CheckCircle size={14} weight="fill" style={{ color: COLORS.green }} />
												: <Gavel size={14} style={{ color: COLORS.blue }} />
											}
										</Box>
										<Text size="3" weight="bold" style={{ color: "var(--foreground)", flex: 1 }}>
											{config.name}
										</Text>
									</Flex>

									<Flex gap="2" align="center" mb="2">
										<Badge variant="soft" color="gray" size="1">v{config.version}</Badge>
										<Badge variant="soft" color={config.scoring_mode === "binary" ? "blue" : "purple"} size="1">
											{config.scoring_mode === "binary" ? "Binary" : "Rubric"}
										</Badge>
										{config.is_active && <Badge variant="soft" color="green" size="1">Active</Badge>}
									</Flex>

									{config.system_prompt && (
										<Text size="1" style={{
											color: "var(--muted-foreground)",
											display: "-webkit-box",
											WebkitLineClamp: 2,
											WebkitBoxOrient: "vertical" as any,
											overflow: "hidden",
											lineHeight: "1.4",
											marginBottom: 8,
										}}>
											{config.system_prompt}
										</Text>
									)}

									<Text size="1" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
										Updated {relativeTime(config.created_at)}
									</Text>
								</Box>
							</Card>
						))}
					</div>
				)}

				{/* System Prompts — collapsible, secondary content */}
				{systemPrompts.length > 0 && (
					<Card style={{ ...CARD_STYLE, overflow: "hidden" }}>
						<button
							onClick={toggleSystemPrompts}
							style={{
								width: "100%", display: "flex", alignItems: "center", gap: 8,
								padding: "10px 14px", cursor: "pointer",
								background: "transparent", border: "none", color: "var(--foreground)",
								fontSize: 13, fontWeight: 600, fontFamily: "inherit",
							}}
						>
							<CaretDown
								size={14} weight="bold"
								style={{
									transition: "transform 0.2s ease",
									transform: systemPromptsExpanded ? "rotate(0deg)" : "rotate(-90deg)",
									color: "var(--muted-foreground)",
								}}
							/>
							AI System Prompts
							<Text size="1" style={{ color: "var(--muted-foreground)", marginLeft: 4, fontWeight: 400 }}>
								Internal prompts for proposal generation & analysis
							</Text>
							<Badge variant="soft" color="gray" size="1" style={{ marginLeft: "auto" }}>
								{systemPrompts.length}
							</Badge>
						</button>

						<div style={{
							maxHeight: systemPromptsExpanded ? 3000 : 0,
							opacity: systemPromptsExpanded ? 1 : 0,
							overflow: "hidden",
							transition: "max-height 0.3s ease, opacity 0.2s ease",
							padding: systemPromptsExpanded ? "0 14px 14px" : "0 14px",
						}}>
							<Flex direction="column" gap="3">
								{systemPrompts.map((sp) => (
									<div key={sp.key} style={{
										background: "var(--secondary)",
										borderRadius: 8,
										padding: "12px 14px",
									}}>
										<Flex align="center" justify="between" mb="1">
											<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>{sp.name}</Text>
											{editingPromptKey === sp.key ? (
												<Flex gap="2">
													<Button variant="outline" size="sm" onClick={() => setEditingPromptKey(null)}>Cancel</Button>
													<Button size="sm" onClick={() => handleSaveSystemPrompt(sp.key)} disabled={savingPrompt} className="gap-1">
														<FloppyDisk size={12} />
														{savingPrompt ? "…" : "Save"}
													</Button>
												</Flex>
											) : (
												<Button variant="ghost" size="sm" onClick={() => { setEditingPromptKey(sp.key); setEditingPromptContent(sp.content); }} className="gap-1">
													<PencilSimple size={12} /> Edit
												</Button>
											)}
										</Flex>
										<Text size="1" style={{ color: "var(--muted-foreground)", display: "block", marginBottom: 6 }}>{sp.description}</Text>

										{editingPromptKey === sp.key ? (
											<Textarea
												value={editingPromptContent}
												onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEditingPromptContent(e.target.value)}
												style={{ fontFamily: "monospace", fontSize: 11, minHeight: 200 }}
											/>
										) : (
											<pre style={{
												background: "var(--card)",
												borderRadius: 6, padding: "8px 10px",
												fontSize: 11, fontFamily: "monospace",
												whiteSpace: "pre-wrap",
												color: "var(--muted-foreground)",
												maxHeight: 60, overflow: "hidden",
												lineHeight: 1.5, margin: 0,
												display: "-webkit-box",
												WebkitLineClamp: 3,
												WebkitBoxOrient: "vertical" as const,
											}}>
												{sp.content}
											</pre>
										)}
									</div>
								))}
							</Flex>
						</div>
					</Card>
				)}

				{/* Create dialog */}
				<Dialog open={isCreating} onOpenChange={setIsCreating}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create Judge Config</DialogTitle>
							<DialogDescription>Create a new judge configuration with a system prompt</DialogDescription>
						</DialogHeader>
						<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
							<div>
								<Label htmlFor="config-name">Config Name</Label>
								<Input id="config-name" value={createName}
									onChange={(e) => setCreateName(e.target.value)}
									placeholder="e.g., Tool Usage Evaluator" style={{ marginTop: 6 }} />
							</div>
							<div>
								<Label htmlFor="system-prompt">System Prompt</Label>
								<Textarea id="system-prompt" value={createSystemPrompt}
									onChange={(e) => setCreateSystemPrompt(e.target.value)}
									placeholder="System prompt"
									style={{ fontFamily: "monospace", fontSize: 12, minHeight: 120, marginTop: 6 }} />
							</div>
						</div>
						<DialogFooter>
							<Button variant="outline" onClick={() => setIsCreating(false)}>Cancel</Button>
							<Button onClick={handleCreateConfig} disabled={isSaving}>
								{isSaving ? "Creating…" : "Create"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</Flex>
		);
	}

	// ═════════════════════════════════════════════════════════════════
	// EDITOR VIEW — Tabbed layout (Prompts | Scoring | Versions)
	// ═════════════════════════════════════════════════════════════════

	const currentVersion = versions[0];

	return (
		<Flex direction="column" gap="4">
			{/* Header */}
			<Flex justify="between" align="start" gap="4">
				<Flex direction="column" gap="1" style={{ flex: 1 }}>
					<button
						onClick={() => { setSelectedConfigId(null); setVersions([]); fetchConfigs(); }}
						className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-1 bg-transparent border-none cursor-pointer p-0"
					>
						<ArrowLeft size={14} /> Back to Configurations
					</button>
					<Flex align="center" gap="3">
						<Text size="6" weight="bold" style={{ color: "var(--foreground)" }}>
							{editState.name || "Untitled Config"}
						</Text>
						{currentVersion && (
							<Flex gap="2" align="center">
								<Badge variant="soft" color="gray" size="2">v{currentVersion.version}</Badge>
								<Badge variant="soft" color={editState.scoring_mode === "binary" ? "blue" : "purple"} size="1">
									{editState.scoring_mode === "binary" ? "Binary" : "Rubric"}
								</Badge>
								{currentVersion.is_active && <Badge variant="soft" color="green" size="1">Active</Badge>}
							</Flex>
						)}
					</Flex>
				</Flex>
				<Flex gap="2" style={{ paddingTop: 20 }}>
					<Button variant="outline" onClick={handleActivate}
						disabled={isActivating || !currentVersion || currentVersion.is_active}>
						{isActivating ? <><CircleNotch size={14} className="animate-spin mr-2" />Activating…</> : "Activate"}
					</Button>
					<Button onClick={handleSaveNewVersion} disabled={isSaving} className="gap-2">
						{isSaving
							? <><CircleNotch size={14} className="animate-spin" />Saving…</>
							: <><FloppyDisk size={14} />Save New Version</>
						}
					</Button>
				</Flex>
			</Flex>

			{/* Tabs */}
			<Tabs.Root defaultValue="prompts">
				<Tabs.List>
					<Tabs.Trigger value="prompts" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<Lightning size={14} /> Prompts
						</Flex>
					</Tabs.Trigger>
					<Tabs.Trigger value="scoring" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<ListChecks size={14} /> Scoring
							{editState.scoring_mode === "rubric" && editState.rubric.length > 0 && (
								<Badge variant="soft" color="gray" size="1" style={{ marginLeft: 4 }}>
									{editState.rubric.length}
								</Badge>
							)}
						</Flex>
					</Tabs.Trigger>
					<Tabs.Trigger value="versions" style={{ cursor: "pointer" }}>
						<Flex align="center" gap="1">
							<ClockCounterClockwise size={14} /> Versions
							<Badge variant="soft" color="gray" size="1" style={{ marginLeft: 4 }}>
								{versions.length}
							</Badge>
						</Flex>
					</Tabs.Trigger>
				</Tabs.List>

				{/* ───── Tab: Prompts ─────────────────────── */}
				<Tabs.Content value="prompts">
					<Flex direction="column" gap="4" pt="3">
						{/* Config name + notes (compact row) */}
						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
							<div>
								<Label htmlFor="edit-name" style={{ display: "block", marginBottom: 4, fontSize: 12 }}>Config Name</Label>
								<Input id="edit-name" value={editState.name}
									onChange={(e) => setEditState({ ...editState, name: e.target.value })}
									placeholder="Config name" />
							</div>
							<div>
								<Label htmlFor="edit-notes" style={{ display: "block", marginBottom: 4, fontSize: 12 }}>Version Notes</Label>
								<Input id="edit-notes" value={editState.notes}
									onChange={(e) => setEditState({ ...editState, notes: e.target.value })}
									placeholder="Optional notes about this version" />
							</div>
						</div>

						{/* System Prompt */}
						<Card style={CARD_STYLE}>
							<Box p="3">
								<Flex align="center" gap="2" mb="2">
									<Box style={{
										width: 22, height: 22, borderRadius: 5,
										background: `${COLORS.purple}18`,
										display: "flex", alignItems: "center", justifyContent: "center",
									}}>
										<Lightning size={12} style={{ color: COLORS.purple }} />
									</Box>
									<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>System Prompt</Text>
									<Text size="1" style={{ color: "var(--muted-foreground)" }}>
										Instructions sent to the judge LLM
									</Text>
								</Flex>
								<Textarea
									value={editState.system_prompt}
									onChange={(e) => setEditState({ ...editState, system_prompt: e.target.value })}
									placeholder="System prompt for the judge LLM"
									style={{
										fontFamily: "monospace", fontSize: 12, minHeight: 140,
										backgroundColor: "var(--code-bg, var(--secondary))",
										color: "#e6edf3", border: "1px solid var(--border)",
										borderRadius: 6, padding: 12, lineHeight: 1.6,
									}}
								/>
							</Box>
						</Card>

						{/* User Prompt Template */}
						<Card style={CARD_STYLE}>
							<Box p="3">
								<Flex align="center" justify="between" mb="2">
									<Flex align="center" gap="2">
										<Box style={{
											width: 22, height: 22, borderRadius: 5,
											background: `${COLORS.blue}18`,
											display: "flex", alignItems: "center", justifyContent: "center",
										}}>
											<Code size={12} style={{ color: COLORS.blue }} />
										</Box>
										<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>User Prompt Template</Text>
									</Flex>
									<Flex gap="2" align="center">
										<button
											onClick={() => setShowVariables(!showVariables)}
											style={{
												background: "none", border: "none", cursor: "pointer",
												display: "flex", alignItems: "center", gap: 4,
												color: "var(--muted-foreground)", fontSize: 12,
											}}
										>
											{showVariables ? <CaretDown size={12} /> : <CaretRight size={12} />}
											Variables
										</button>
										{(["batched", "single"] as const).map((t) => (
											<Button key={t} size="sm"
												variant={activeTemplate === t ? "default" : "outline"}
												onClick={() => setActiveTemplate(t)}>
												{t === "batched" ? "Batched" : "Single"}
											</Button>
										))}
									</Flex>
								</Flex>

								{/* Variables */}
								{showVariables && (
									<div style={{
										background: "rgba(48,54,61,0.3)", borderRadius: 6,
										padding: 10, border: "1px solid var(--border)", marginBottom: 8,
									}}>
										<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
											{AVAILABLE_VARIABLES.map((v) => (
												<span key={v} style={{
													background: "rgba(88,166,255,0.08)",
													border: "1px solid rgba(88,166,255,0.15)",
													color: "#79c0ff", padding: "3px 8px",
													borderRadius: 4, fontSize: 11, fontFamily: "monospace",
												}}>
													{v}
												</span>
											))}
										</div>
									</div>
								)}

								<Textarea
									value={activeTemplate === "batched" ? editState.user_prompt_template_batched : editState.user_prompt_template_single}
									onChange={(e) =>
										setEditState({
											...editState,
											[activeTemplate === "batched" ? "user_prompt_template_batched" : "user_prompt_template_single"]: e.target.value,
										})
									}
									placeholder={`${activeTemplate === "batched" ? "Batched" : "Single"} assertion template`}
									style={{
										fontFamily: "monospace", fontSize: 12, minHeight: 280,
										backgroundColor: "var(--code-bg, var(--secondary))",
										color: "#e6edf3", border: "1px solid var(--border)",
										borderRadius: 6, padding: 12, lineHeight: 1.6,
									}}
								/>
							</Box>
						</Card>
					</Flex>
				</Tabs.Content>

				{/* ───── Tab: Scoring ─────────────────────── */}
				<Tabs.Content value="scoring">
					<Flex direction="column" gap="4" pt="3">
						{/* Scoring Mode */}
						<Card style={CARD_STYLE}>
							<Box p="3">
								<Flex align="center" gap="2" mb="3">
									<Box style={{
										width: 22, height: 22, borderRadius: 5,
										background: `${COLORS.blue}18`,
										display: "flex", alignItems: "center", justifyContent: "center",
									}}>
										<Gavel size={12} style={{ color: COLORS.blue }} />
									</Box>
									<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Scoring Mode</Text>
								</Flex>

								<Flex gap="3" mb="3">
									{(["binary", "rubric"] as const).map((mode) => (
										<div key={mode}
											onClick={() => setEditState({ ...editState, scoring_mode: mode })}
											style={{
												flex: 1, padding: "12px 16px", borderRadius: 8, cursor: "pointer",
												border: `1px solid ${editState.scoring_mode === mode
													? (mode === "binary" ? COLORS.blue : COLORS.purple)
													: "var(--border)"}`,
												background: editState.scoring_mode === mode
													? (mode === "binary" ? `${COLORS.blue}08` : `${COLORS.purple}08`)
													: "transparent",
												transition: "all 0.15s",
											}}
										>
											<Text size="2" weight="bold" style={{
												color: editState.scoring_mode === mode
													? (mode === "binary" ? COLORS.blue : COLORS.purple)
													: "var(--foreground)",
												display: "block", marginBottom: 4,
											}}>
												{mode === "binary" ? "Binary (Pass / Fail)" : "Rubric (Scored)"}
											</Text>
											<Text size="1" style={{ color: "var(--muted-foreground)" }}>
												{mode === "binary"
													? "Each assertion is either passed or failed"
													: "Score assertions on multiple criteria with levels"}
											</Text>
										</div>
									))}
								</Flex>

								{editState.scoring_mode === "rubric" && (
									<div style={{ maxWidth: 240 }}>
										<Label htmlFor="pass-threshold" style={{ display: "block", marginBottom: 4, fontSize: 12 }}>
											Pass Threshold
										</Label>
										<Input id="pass-threshold" type="number" min="0" step="0.1"
											value={editState.pass_threshold ?? ""}
											onChange={(e) => setEditState({
												...editState,
												pass_threshold: e.target.value ? parseFloat(e.target.value) : null,
											})}
											placeholder="e.g., 3.5" />
										<Text size="1" style={{ color: "var(--muted-foreground)", marginTop: 4, display: "block" }}>
											Average score at or above this value passes
										</Text>
									</div>
								)}
							</Box>
						</Card>

						{/* Rubric Criteria */}
						{editState.scoring_mode === "rubric" && (
							<Card style={CARD_STYLE}>
								<Box p="3">
									<Flex align="center" justify="between" mb="3">
										<Flex align="center" gap="2">
											<Box style={{
												width: 22, height: 22, borderRadius: 5,
												background: `${COLORS.green}18`,
												display: "flex", alignItems: "center", justifyContent: "center",
											}}>
												<ListChecks size={12} style={{ color: COLORS.green }} />
											</Box>
											<Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>Rubric Criteria</Text>
											{editState.rubric.length > 0 && (
												<Badge variant="soft" color="gray" size="1">{editState.rubric.length}</Badge>
											)}
										</Flex>
										<Button size="sm" variant="outline" onClick={handleAddCriterion} className="gap-1">
											<Plus size={12} weight="bold" /> Add Criterion
										</Button>
									</Flex>

									{editState.rubric.length === 0 ? (
										<Flex align="center" justify="center" direction="column" gap="2" py="4">
											<Text size="2" style={{ color: "var(--muted-foreground)" }}>No criteria defined yet</Text>
											<Button size="sm" variant="outline" onClick={handleAddCriterion} className="gap-1">
												<Plus size={12} /> Add first criterion
											</Button>
										</Flex>
									) : (
										<Flex direction="column" gap="2">
											{editState.rubric.map((criterion, ci) => (
												<div key={ci} style={{
													background: "var(--secondary)",
													border: "1px solid var(--border)",
													borderRadius: 8, overflow: "hidden",
												}}>
													{/* Criterion header */}
													<div
														onClick={() => toggleCriterion(ci)}
														style={{
															display: "flex", alignItems: "center", gap: 8,
															padding: "10px 12px", cursor: "pointer",
														}}
														className="hover:bg-secondary/80 transition-colors"
													>
														<CaretDown size={12} weight="bold"
															style={{
																transition: "transform 0.2s ease",
																transform: expandedCriteria.has(ci) ? "rotate(0deg)" : "rotate(-90deg)",
																color: "var(--muted-foreground)",
															}}
														/>
														<Text size="2" weight="bold" style={{ color: "var(--foreground)", flex: 1 }}>
															{criterion.name || "Unnamed"}
														</Text>
														<Flex gap="1" align="center" style={{ marginRight: 8 }}>
															{criterion.levels.map((level, li) => (
																<span key={li} title={`${level.score}: ${level.description}`}
																	style={{
																		width: 8, height: 8, borderRadius: "50%",
																		background: LEVEL_COLORS[Math.min(li, LEVEL_COLORS.length - 1)],
																		opacity: 0.8,
																	}} />
															))}
														</Flex>
														<div onClick={(e) => e.stopPropagation()}>
															<Button variant="ghost" size="sm" onClick={() => handleRemoveCriterion(ci)}
																className="h-7 w-7 p-0 text-destructive">
																<Trash size={14} />
															</Button>
														</div>
													</div>

													{/* Criterion body */}
													{expandedCriteria.has(ci) && (
														<div style={{ padding: "0 12px 12px", borderTop: "1px solid var(--border)" }}>
															<Flex direction="column" gap="3" pt="3">
																<div>
																	<Label style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Name</Label>
																	<Input value={criterion.name}
																		onChange={(e) => handleUpdateCriterion(ci, "name", e.target.value)}
																		placeholder="e.g., Correctness" />
																</div>
																<div>
																	<Label style={{ display: "block", marginBottom: 4, fontSize: 11 }}>Description</Label>
																	<Textarea value={criterion.description}
																		onChange={(e) => handleUpdateCriterion(ci, "description", e.target.value)}
																		placeholder="What this criterion measures"
																		style={{ minHeight: 50, fontSize: 12 }} />
																</div>
																<div>
																	<Label style={{ display: "block", marginBottom: 8, fontSize: 11 }}>Scoring Levels</Label>
																	<Flex direction="column" gap="2">
																		{criterion.levels.map((level, li) => (
																			<Flex key={li} align="center" gap="2">
																				<span style={{
																					width: 28, height: 28, borderRadius: 6,
																					display: "flex", alignItems: "center", justifyContent: "center",
																					fontSize: 12, fontWeight: 700, color: "#fff",
																					background: LEVEL_COLORS[Math.min(li, LEVEL_COLORS.length - 1)],
																					flexShrink: 0,
																				}}>
																					{level.score}
																				</span>
																				<Input value={level.description}
																					onChange={(e) => handleUpdateLevel(ci, li, e.target.value)}
																					placeholder={`Description for score ${level.score}`}
																					style={{ fontSize: 12 }} />
																			</Flex>
																		))}
																	</Flex>
																</div>
															</Flex>
														</div>
													)}
												</div>
											))}
										</Flex>
									)}
								</Box>
							</Card>
						)}
					</Flex>
				</Tabs.Content>

				{/* ───── Tab: Versions ────────────────────── */}
				<Tabs.Content value="versions">
					<Flex direction="column" gap="3" pt="3">
						{versions.length === 0 ? (
							<Card style={CARD_STYLE}>
								<Flex direction="column" align="center" justify="center" py="6">
									<Text size="2" style={{ color: "var(--muted-foreground)" }}>No versions yet</Text>
								</Flex>
							</Card>
						) : (
							versions.map((version, index) => (
								<Card key={version.version} style={{
									...CARD_STYLE,
									...(version.is_active ? { borderColor: `${COLORS.green}40` } : {}),
								}}>
									<Flex align="center" gap="3" p="3">
										<Badge variant={version.is_active ? "soft" : "outline"}
											color={version.is_active ? "green" : "gray"} size="2">
											v{version.version}
										</Badge>

										<Flex direction="column" gap="0" style={{ flex: 1, minWidth: 0 }}>
											<Flex align="center" gap="2">
												{version.is_active && (
													<Text size="1" weight="bold" style={{ color: COLORS.green }}>Active</Text>
												)}
												{index === 0 && !version.is_active && (
													<Text size="1" weight="bold" style={{ color: COLORS.yellow }}>Latest</Text>
												)}
												<Text size="1" style={{ color: "var(--muted-foreground)" }}>
													{relativeTime(version.created_at)}
												</Text>
											</Flex>
											{version.notes && (
												<Text size="1" style={{
													color: "var(--muted-foreground)",
													overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
												}}>
													{version.notes}
												</Text>
											)}
										</Flex>

										<Flex gap="2" align="center">
											<Text size="1" style={{ color: "var(--muted-foreground)" }}>
												{version.scoring_mode === "binary" ? "Binary" : "Rubric"}
											</Text>
											{index === 0 && !version.is_active && (
												<Button size="sm" variant="outline" onClick={handleActivate}
													disabled={isActivating}>
													Activate
												</Button>
											)}
										</Flex>
									</Flex>
								</Card>
							))
						)}
					</Flex>
				</Tabs.Content>
			</Tabs.Root>
		</Flex>
	);
}
