import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ReactNode } from "react";
import { DatasetsPage } from "./components/datasets/DatasetsPage";
import { DatasetDetailPage } from "./components/datasets/DatasetDetailPage";
import { TestCaseDetailPage } from "./components/datasets/TestCaseDetailPage";
import { AgentsPage } from "./components/agents/AgentsPage";
import { AgentDetailPage } from "./components/agents/AgentDetailPage";
import { EvaluationResultsPage } from "./components/results/EvaluationResultsPage";
import { EvaluationComparisonPage } from "./components/results/EvaluationComparisonPage";
import { TestCaseResultPage } from "./components/results/TestCaseResultPage";
import { AnnotationQueuePage } from "./components/annotations/AnnotationQueuePage";
import { AnnotationsPage } from "./components/annotations/AnnotationsPage";
import { UnifiedAnnotationsPage } from "./components/annotations/UnifiedAnnotationsPage";
import { Navigation } from "./components/layout/Navigation";
import { Toaster } from "@/components/ui/sonner";
import { Theme } from "@radix-ui/themes";
import { PromptLabPage } from "./components/prompts/PromptLabPage";
import { PromptLabHubPage } from "./components/prompts/PromptLabHubPage";
import { AnalyticsPage } from "./components/analytics/AnalyticsPage";
import { EvalLifecyclePage } from "./components/guide/EvalLifecyclePage";
import { DemoModeProvider } from "./contexts/DemoModeContext";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { GuidedEvalLoop } from "./components/shared/GuidedEvalLoop";
import { GuideSidecar } from "./components/guide/GuideSidecar";
import { GuideSidecarProvider } from "./contexts/GuideSidecarContext";
import { JudgeConfigPage } from "./components/judge-config/JudgeConfigPage";
import { EvaluationsPage } from "./components/evaluations/EvaluationsPageNew";
import { ProductionTracesPage } from "./components/traces/ProductionTracesPageNew";
import { ProductionAnnotationsPage } from "./components/traces/ProductionAnnotationsPage";

/**
 * Standard page shell — provides consistent padding for all pages
 * except full-bleed layouts (like the annotation workspace).
 */
function PageShell({ children }: { children: ReactNode }) {
	return (
		<div style={{ padding: "48px 64px 64px" }}>
			{children}
		</div>
	);
}

function ThemedApp() {
	const { resolved } = useTheme();
	return (
		<Theme appearance={resolved} accentColor="blue" grayColor="slate" radius="medium" scaling="100%">
			<DemoModeProvider>
			<GuideSidecarProvider>
			<BrowserRouter>
				<div
					className="bg-background"
					style={{
						height: "100vh",
						width: "100vw",
						display: "flex",
						overflow: "hidden",
					}}
				>
					<Navigation />
					<main
						className="flex-1"
						style={{
							overflow: "auto",
							height: "100vh",
						}}
					>
						<GuidedEvalLoop />
						<Routes>
							<Route path="/" element={<Navigate to="/analytics" replace />} />
							<Route path="/dashboard" element={<Navigate to="/analytics" replace />} />
							{/* Full-bleed: annotation workspace manages its own chrome */}
							<Route path="/evaluations/:id/annotate" element={<AnnotationsPage />} />
							{/* Standard padded pages */}
							<Route path="/prompt-lab" element={<PageShell><PromptLabHubPage /></PageShell>} />
							<Route path="/agents/:id/prompts" element={<PageShell><PromptLabPage /></PageShell>} />
							<Route path="/analytics" element={<PageShell><AnalyticsPage /></PageShell>} />
							<Route path="/datasets" element={<PageShell><DatasetsPage /></PageShell>} />
							<Route path="/datasets/:id" element={<PageShell><DatasetDetailPage /></PageShell>} />
							<Route path="/datasets/:id/testcases/:testcase_id" element={<PageShell><TestCaseDetailPage /></PageShell>} />
							<Route path="/agents" element={<PageShell><AgentsPage /></PageShell>} />
							<Route path="/agents/:id" element={<PageShell><AgentDetailPage /></PageShell>} />
							<Route path="/evaluations" element={<PageShell><EvaluationsPage /></PageShell>} />
							<Route path="/evaluations/:id" element={<PageShell><EvaluationResultsPage /></PageShell>} />
							<Route path="/evaluations/:id1/compare/:id2" element={<PageShell><EvaluationComparisonPage /></PageShell>} />
							<Route path="/evaluations/:eval_id/testcases/:testcase_id" element={<PageShell><TestCaseResultPage /></PageShell>} />
							{/* Unified annotations page with tabs */}
							<Route path="/annotations" element={<PageShell><UnifiedAnnotationsPage /></PageShell>} />
							{/* Redirect old routes to unified page */}
							<Route path="/annotations/evaluation" element={<Navigate to="/annotations?tab=evaluation" replace />} />
							<Route path="/annotations/production" element={<Navigate to="/annotations?tab=production" replace />} />
							<Route path="/production-annotations" element={<Navigate to="/annotations?tab=production" replace />} />
							<Route path="/judge-config" element={<PageShell><JudgeConfigPage /></PageShell>} />
							<Route path="/guide" element={<PageShell><EvalLifecyclePage /></PageShell>} />
							<Route path="/production-traces" element={<PageShell><ProductionTracesPage /></PageShell>} />
						</Routes>
					</main>
					<GuideSidecar />
					<Toaster />
				</div>
			</BrowserRouter>
			</GuideSidecarProvider>
			</DemoModeProvider>
		</Theme>
	);
}

function App() {
	return (
		<ThemeProvider>
			<ThemedApp />
		</ThemeProvider>
	);
}

export default App;
