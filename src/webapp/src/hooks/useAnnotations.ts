import { useState, useEffect, useCallback } from "react";
import { apiClient, RunAnnotation, ActionAnnotation, AnnotationSummary } from "@/lib/api";

export function useAnnotations(evaluationId: string | undefined) {
	const [runAnnotations, setRunAnnotations] = useState<RunAnnotation[]>([]);
	const [actionAnnotations, setActionAnnotations] = useState<ActionAnnotation[]>([]);
	const [summary, setSummary] = useState<AnnotationSummary | null>(null);
	const [issueTags, setIssueTags] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchAll = useCallback(async () => {
		if (!evaluationId) return;
		setLoading(true);
		try {
			const [runs, actions, sum, tags] = await Promise.all([
				apiClient.listRunAnnotations(evaluationId),
				apiClient.listActionAnnotations(evaluationId),
				apiClient.getAnnotationSummary(evaluationId),
				apiClient.getIssueTags(),
			]);
			setRunAnnotations(runs);
			setActionAnnotations(actions);
			setSummary(sum);
			setIssueTags(tags);
		} catch (err) {
			console.error("Failed to load annotations:", err);
		} finally {
			setLoading(false);
		}
	}, [evaluationId]);

	useEffect(() => {
		fetchAll();
	}, [fetchAll]);

	const saveRunAnnotation = useCallback(
		async (runId: string, data: Partial<RunAnnotation>) => {
			if (!evaluationId) return;
			const saved = await apiClient.upsertRunAnnotation(evaluationId, runId, data);
			setRunAnnotations((prev) => {
				const idx = prev.findIndex((a) => a.run_id === runId);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = saved;
					return next;
				}
				return [...prev, saved];
			});
			// Refresh summary
			const sum = await apiClient.getAnnotationSummary(evaluationId);
			setSummary(sum);
			return saved;
		},
		[evaluationId]
	);

	const saveActionAnnotation = useCallback(
		async (runId: string, actionIndex: number, data: Partial<ActionAnnotation>) => {
			if (!evaluationId) return;
			const saved = await apiClient.upsertActionAnnotation(evaluationId, runId, actionIndex, data);
			setActionAnnotations((prev) => {
				const idx = prev.findIndex((a) => a.run_id === runId && a.action_index === actionIndex);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = saved;
					return next;
				}
				return [...prev, saved];
			});
			const sum = await apiClient.getAnnotationSummary(evaluationId);
			setSummary(sum);
			return saved;
		},
		[evaluationId]
	);

	const getRunAnnotation = useCallback(
		(runId: string) => runAnnotations.find((a) => a.run_id === runId) ?? null,
		[runAnnotations]
	);

	const getActionAnnotation = useCallback(
		(runId: string, actionIndex: number) =>
			actionAnnotations.find((a) => a.run_id === runId && a.action_index === actionIndex) ?? null,
		[actionAnnotations]
	);

	const deleteRunAnnotation = useCallback(
		async (runId: string) => {
			if (!evaluationId) return;
			await apiClient.deleteRunAnnotation(evaluationId, runId);
			setRunAnnotations((prev) => prev.filter((a) => a.run_id !== runId));
			// Also remove any action annotations for this run
			setActionAnnotations((prev) => prev.filter((a) => a.run_id !== runId));
			const sum = await apiClient.getAnnotationSummary(evaluationId);
			setSummary(sum);
		},
		[evaluationId]
	);

	const deleteActionAnnotation = useCallback(
		async (runId: string, actionIndex: number) => {
			if (!evaluationId) return;
			await apiClient.deleteActionAnnotation(evaluationId, runId, actionIndex);
			setActionAnnotations((prev) =>
				prev.filter((a) => !(a.run_id === runId && a.action_index === actionIndex))
			);
			const sum = await apiClient.getAnnotationSummary(evaluationId);
			setSummary(sum);
		},
		[evaluationId]
	);

	const clearAllAnnotations = useCallback(
		async () => {
			if (!evaluationId) return;
			await apiClient.clearAllAnnotations(evaluationId);
			setRunAnnotations([]);
			setActionAnnotations([]);
			const sum = await apiClient.getAnnotationSummary(evaluationId);
			setSummary(sum);
		},
		[evaluationId]
	);

	return {
		runAnnotations,
		actionAnnotations,
		summary,
		issueTags,
		loading,
		saveRunAnnotation,
		saveActionAnnotation,
		getRunAnnotation,
		getActionAnnotation,
		deleteRunAnnotation,
		deleteActionAnnotation,
		clearAllAnnotations,
		refetch: fetchAll,
	};
}
