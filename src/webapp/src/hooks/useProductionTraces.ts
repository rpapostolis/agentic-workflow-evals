import { useState, useCallback, useEffect } from "react";
import { apiClient } from "../lib/api";

export interface ProductionTrace {
	id: string;
	agent_id: string;
	trace_id?: string;
	input: string;
	output: string;
	tool_calls?: any[];
	latency_ms?: number;
	model?: string;
	tokens_in?: number;
	tokens_out?: number;
	timestamp: string;
	metadata?: any;
	status: string;
	pii_detected: boolean;
	pii_flags: string[];
	pii_scan_completed: boolean;
	created_at: string;
	expires_at?: string;
	testcase_id?: string;
	dataset_id?: string;
}

export interface TraceAnnotation {
	trace_id: string;
	outcome?: number; // 1-5
	efficiency?: string; // efficient, acceptable, wasteful
	issues: string[];
	notes?: string;
	action_count: number;
	action_annotations: any[];
	pii_detected?: boolean;
	sensitive_content: string;
	testcase_candidate: boolean;
	conversion_notes?: string;
	annotated_by?: string;
	annotated_at?: string;
}

export function useProductionTraces(agentId?: string, status?: string) {
	const [traces, setTraces] = useState<ProductionTrace[]>([]);
	const [annotations, setAnnotations] = useState<Map<string, TraceAnnotation>>(new Map());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchTraces = useCallback(async () => {
		try {
			setLoading(true);
			setError(null);
			const data = await apiClient.listProductionTraces(agentId, status);
			setTraces(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch traces");
			console.error("Error fetching traces:", err);
		} finally {
			setLoading(false);
		}
	}, [agentId, status]);

	const fetchAnnotation = useCallback(async (traceId: string) => {
		try {
			const annotation = await apiClient.getTraceAnnotation(traceId);
			if (annotation) {
				setAnnotations((prev) => new Map(prev).set(traceId, annotation));
			}
			return annotation;
		} catch (err) {
			console.error(`Error fetching annotation for ${traceId}:`, err);
			return null;
		}
	}, []);

	const saveAnnotation = useCallback(
		async (traceId: string, annotationData: Partial<TraceAnnotation>) => {
			try {
				const saved = await apiClient.upsertTraceAnnotation(traceId, {
					trace_id: traceId,
					...annotationData,
				});
				setAnnotations((prev) => new Map(prev).set(traceId, saved));
				return saved;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to save annotation");
				throw err;
			}
		},
		[]
	);

	const convertToTestcase = useCallback(
		async (traceId: string, datasetId: string, options?: any) => {
			try {
				const result = await apiClient.convertTraceToTestcase(traceId, datasetId, options);
				// Update trace status locally
				setTraces((prev) =>
					prev.map((t) =>
						t.id === traceId || t.trace_id === traceId
							? { ...t, status: "converted_to_testcase", testcase_id: result.testcase.id }
							: t
					)
				);
				return result;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to convert trace");
				throw err;
			}
		},
		[]
	);

	useEffect(() => {
		fetchTraces();
	}, [fetchTraces]);

	return {
		traces,
		annotations,
		loading,
		error,
		fetchTraces,
		fetchAnnotation,
		saveAnnotation,
		convertToTestcase,
	};
}
