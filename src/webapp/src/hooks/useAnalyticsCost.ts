import { useState, useEffect, useCallback } from "react";
import { apiClient, CostSummary, CostByAgent, CostTrend } from "@/lib/api";

export function useAnalyticsCost(days: number = 30) {
	const [summary, setSummary] = useState<CostSummary | null>(null);
	const [byAgent, setByAgent] = useState<CostByAgent[]>([]);
	const [trends, setTrends] = useState<CostTrend[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchAll = useCallback(async () => {
		try {
			setError(null);
			const [s, a, t] = await Promise.all([
				apiClient.getCostSummary(),
				apiClient.getCostByAgent(),
				apiClient.getCostTrends(days),
			]);
			setSummary(s);
			setByAgent(a);
			setTrends(t);
		} catch (err) {
			console.error("Failed to fetch cost analytics:", err);
			setError(err instanceof Error ? err.message : "Failed to fetch cost data");
		} finally {
			setLoading(false);
		}
	}, [days]);

	useEffect(() => {
		fetchAll();
	}, [fetchAll]);

	const refetch = () => {
		setLoading(true);
		fetchAll();
	};

	return { summary, byAgent, trends, loading, error, refetch };
}
