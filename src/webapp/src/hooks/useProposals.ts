import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, PromptProposal } from "../lib/api";

export function useProposals(agentId: string | undefined) {
	const queryClient = useQueryClient();

	const proposalsQuery = useQuery<PromptProposal[]>({
		queryKey: ["proposals", agentId],
		queryFn: () => apiClient.listProposals(agentId!),
		enabled: !!agentId,
	});

	const generateMutation = useMutation({
		mutationFn: (evaluationIds?: string[]) => apiClient.generateProposals(agentId!, evaluationIds),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["proposals", agentId] });
		},
	});

	const applyMutation = useMutation({
		mutationFn: (proposalId: string) => apiClient.applyProposal(agentId!, proposalId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["proposals", agentId] });
			queryClient.invalidateQueries({ queryKey: ["agent-prompts", agentId] });
			queryClient.invalidateQueries({ queryKey: ["active-prompt", agentId] });
		},
	});

	const testMutation = useMutation({
		mutationFn: (proposalId: string) => apiClient.testProposal(agentId!, proposalId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["proposals", agentId] });
		},
	});

	const dismissMutation = useMutation({
		mutationFn: (proposalId: string) => apiClient.dismissProposal(agentId!, proposalId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["proposals", agentId] });
		},
	});

	return {
		proposals: proposalsQuery.data || [],
		isLoading: proposalsQuery.isLoading,
		error: proposalsQuery.error,
		generateProposals: generateMutation.mutateAsync,
		isGenerating: generateMutation.isPending,
		applyProposal: applyMutation.mutateAsync,
		isApplying: applyMutation.isPending,
		testProposal: testMutation.mutateAsync,
		isTesting: testMutation.isPending,
		dismissProposal: dismissMutation.mutateAsync,
		isDismissing: dismissMutation.isPending,
	};
}
