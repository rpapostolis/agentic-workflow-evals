import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, AgentPrompt, CreatePromptRequest } from "../lib/api";

export function usePrompts(agentId: string | undefined) {
	const queryClient = useQueryClient();

	const promptsQuery = useQuery<AgentPrompt[]>({
		queryKey: ["agent-prompts", agentId],
		queryFn: () => apiClient.getAgentPrompts(agentId!),
		enabled: !!agentId,
	});

	const activePromptQuery = useQuery<AgentPrompt | null>({
		queryKey: ["active-prompt", agentId],
		queryFn: () => apiClient.getActivePrompt(agentId!),
		enabled: !!agentId,
	});

	const createMutation = useMutation({
		mutationFn: (data: CreatePromptRequest) => apiClient.createPrompt(agentId!, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["agent-prompts", agentId] });
			queryClient.invalidateQueries({ queryKey: ["active-prompt", agentId] });
		},
	});

	const activateMutation = useMutation({
		mutationFn: (version: number) => apiClient.activatePrompt(agentId!, version),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["agent-prompts", agentId] });
			queryClient.invalidateQueries({ queryKey: ["active-prompt", agentId] });
		},
	});

	return {
		prompts: promptsQuery.data || [],
		activePrompt: activePromptQuery.data,
		isLoading: promptsQuery.isLoading || activePromptQuery.isLoading,
		error: promptsQuery.error || activePromptQuery.error,
		createPrompt: createMutation.mutateAsync,
		activatePrompt: activateMutation.mutateAsync,
		isCreating: createMutation.isPending,
		isActivating: activateMutation.isPending,
	};
}
