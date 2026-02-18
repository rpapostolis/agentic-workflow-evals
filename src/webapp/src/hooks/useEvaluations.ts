import { useState, useEffect, useCallback, useRef } from "react";
import { apiClient, EvaluationRun } from "@/lib/api";

/**
 * useEvaluations — fetches the evaluation list and auto-polls every 3 s
 * whenever at least one evaluation is in a non-terminal state
 * ("pending" or "running").  Polling stops automatically once every
 * evaluation has reached "completed", "failed", or "cancelled".
 */
export function useEvaluations() {
	const [evaluations, setEvaluations] = useState<EvaluationRun[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchEvaluations = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.getEvaluations();
			setEvaluations(data);
		} catch (err) {
			console.error("Failed to fetch evaluations:", err);
			setError(err instanceof Error ? err.message : "Failed to fetch evaluations");
			setEvaluations([]);
		} finally {
			setLoading(false);
		}
	}, []);

	// Initial fetch
	useEffect(() => {
		fetchEvaluations();
	}, [fetchEvaluations]);

	// Auto-poll while any evaluation is active (pending / running)
	useEffect(() => {
		const hasActiveEvals = evaluations.some(
			(ev) => ev.status === "pending" || ev.status === "running"
		);

		if (hasActiveEvals) {
			// Start polling if not already running
			if (!intervalRef.current) {
				intervalRef.current = setInterval(() => {
					fetchEvaluations();
				}, 3000);
			}
		} else {
			// No active evals — clear polling
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		}

		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [evaluations, fetchEvaluations]);

	const refetch = () => {
		setLoading(true);
		fetchEvaluations();
	};

	return { evaluations, loading, error, refetch };
}