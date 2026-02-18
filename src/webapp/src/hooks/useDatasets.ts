import { useState, useEffect, useCallback } from "react";
import { apiClient, BackendDataset } from "@/lib/api";

export function useDatasets() {
	const [datasets, setDatasets] = useState<BackendDataset[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchDatasets = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const backendDatasets = await apiClient.getDatasets();
			setDatasets(backendDatasets);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to fetch datasets";
			console.error("Error in fetchDatasets:", err);
			console.error("Error stack:", err instanceof Error ? err.stack : "No stack trace");
			setError(errorMessage);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchDatasets();
	}, [fetchDatasets]);

	return { datasets, loading, error, refetch: fetchDatasets };
}

export function useDataset(datasetId: string | null) {
	const [dataset, setDataset] = useState<BackendDataset | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchDataset = useCallback(
		async (isInitialLoad = false) => {
			if (!datasetId) {
				setLoading(false);
				return;
			}

			try {
				// Only show loading state on initial load, not on refetch
				if (isInitialLoad) {
					setLoading(true);
				}
				setError(null);
				const backendDataset = await apiClient.getDataset(datasetId);
				setDataset(backendDataset);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to fetch dataset");
				console.error("Error fetching dataset:", err);
			} finally {
				if (isInitialLoad) {
					setLoading(false);
				}
			}
		},
		[datasetId]
	);

	const refetch = useCallback(() => fetchDataset(false), [fetchDataset]);

	useEffect(() => {
		fetchDataset(true);
	}, [fetchDataset]);

	return { dataset, loading, error, refetch };
}
