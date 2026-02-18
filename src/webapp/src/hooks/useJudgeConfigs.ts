import { useState, useEffect, useCallback } from "react";
import { apiClient, JudgeConfig } from "@/lib/api";

export function useJudgeConfigs() {
	const [configs, setConfigs] = useState<JudgeConfig[]>([]);
	const [activeConfig, setActiveConfig] = useState<JudgeConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchAll = useCallback(async () => {
		try {
			setError(null);
			const [allConfigs, active] = await Promise.all([
				apiClient.listJudgeConfigs(),
				apiClient.getActiveJudgeConfig(),
			]);
			setConfigs(allConfigs);
			setActiveConfig(active);
		} catch (err) {
			console.error("Failed to fetch judge configs:", err);
			setError(err instanceof Error ? err.message : "Failed to fetch judge configs");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchAll();
	}, [fetchAll]);

	const refetch = () => {
		setLoading(true);
		fetchAll();
	};

	return { configs, activeConfig, loading, error, refetch };
}
