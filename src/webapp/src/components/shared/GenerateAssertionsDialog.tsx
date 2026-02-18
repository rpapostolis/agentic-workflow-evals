import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CircleNotch,
  Lightning,
  Brain,
  ChatCircle,
  Check,
  Warning,
} from "@phosphor-icons/react";
import { apiClient, type BehaviorAssertion, type ResponseQualityAssertion, type BackendTestCase } from "@/lib/api";
import { toast } from "sonner";

interface GenerateAssertionsDialogProps {
  evaluationId: string;
  testcaseId: string;
  /** The dataset-level test case (needed for applying assertions) */
  testCase: BackendTestCase | null;
  /** Called after assertions are successfully applied */
  onApplied?: () => void;
}

interface ProposedAssertions {
  behavior_assertions: BehaviorAssertion[];
  response_quality_expectation: ResponseQualityAssertion | null;
}

type SelectionState = {
  behaviors: Set<number>;   // indices
  responseQuality: boolean;
};

export function GenerateAssertionsDialog({
  evaluationId,
  testcaseId,
  testCase,
  onApplied,
}: GenerateAssertionsDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState<ProposedAssertions | null>(null);
  const [selection, setSelection] = useState<SelectionState>({
    behaviors: new Set(),
    responseQuality: false,
  });

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setProposed(null);
    setOpen(true);

    try {
      const result = await apiClient.generateAssertions(evaluationId, testcaseId);
      setProposed(result);

      // Select all by default
      const behaviorIndices = new Set<number>(
        result.behavior_assertions.map((_, i) => i)
      );

      setSelection({
        behaviors: behaviorIndices,
        responseQuality: !!result.response_quality_expectation,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate assertions");
    } finally {
      setLoading(false);
    }
  };

  const toggleBehavior = (idx: number) => {
    setSelection((prev) => {
      const next = new Set(prev.behaviors);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return { ...prev, behaviors: next };
    });
  };

  const toggleResponseQuality = () => {
    setSelection((prev) => ({
      ...prev,
      responseQuality: !prev.responseQuality,
    }));
  };

  const selectAll = () => {
    if (!proposed) return;
    setSelection({
      behaviors: new Set(proposed.behavior_assertions.map((_, i) => i)),
      responseQuality: !!proposed.response_quality_expectation,
    });
  };

  const selectNone = () => {
    setSelection({ behaviors: new Set(), responseQuality: false });
  };

  const selectedCount = selection.behaviors.size + (selection.responseQuality ? 1 : 0);

  const handleApply = async () => {
    if (!proposed || !testCase) return;

    setApplying(true);
    try {
      const filteredBehaviorAssertions = proposed.behavior_assertions.filter(
        (_, i) => selection.behaviors.has(i)
      );

      // Determine the assertion mode based on what was selected
      let assertionMode: "response_only" | "hybrid" = "response_only";
      if (filteredBehaviorAssertions.length > 0) {
        assertionMode = "hybrid";
      }

      // Merge with existing test case
      const updated: BackendTestCase = {
        ...testCase,
        assertion_mode: assertionMode,
        behavior_assertions: filteredBehaviorAssertions.length > 0
          ? [...(testCase.behavior_assertions || []), ...filteredBehaviorAssertions]
          : testCase.behavior_assertions,
        response_quality_expectation:
          selection.responseQuality && proposed.response_quality_expectation
            ? proposed.response_quality_expectation
            : testCase.response_quality_expectation,
      };

      await apiClient.updateTestCase(testCase.dataset_id, testCase.id, updated);
      toast.success(`Applied ${selectedCount} assertion(s) to test case`);
      setOpen(false);
      onApplied?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply assertions");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleGenerate}
        className="gap-2"
        disabled={loading}
      >
        {loading ? (
          <CircleNotch size={14} className="animate-spin" />
        ) : (
          <Lightning size={14} />
        )}
        Generate Assertions
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lightning size={18} />
              Generated Assertion Proposals
            </DialogTitle>
            <DialogDescription>
              Select which assertions to apply to this test case. Assertions are generated from the actual tool calls and response from this evaluation run.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 py-2" style={{ minHeight: 0 }}>
            {loading && (
              <div className="flex flex-col items-center justify-center py-12">
                <CircleNotch size={32} className="animate-spin text-primary mb-3" />
                <p className="text-sm text-muted-foreground">Analyzing trace and generating assertions...</p>
              </div>
            )}

            {error && (
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: 8,
                  backgroundColor: "rgba(248, 81, 73, 0.1)",
                  border: "1px solid rgba(248, 81, 73, 0.25)",
                  color: "#f85149",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <Warning size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                <div>{error}</div>
              </div>
            )}

            {proposed && !loading && (
              <>
                {/* Select all/none controls */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {selectedCount} assertion{selectedCount !== 1 ? "s" : ""} selected
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={selectAll}
                      className="text-xs text-primary hover:underline"
                    >
                      Select All
                    </button>
                    <span className="text-xs text-muted-foreground">|</span>
                    <button
                      onClick={selectNone}
                      className="text-xs text-primary hover:underline"
                    >
                      Select None
                    </button>
                  </div>
                </div>

                {/* Behavior Assertions */}
                {proposed.behavior_assertions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Brain size={14} className="text-muted-foreground" />
                      <h4 className="text-sm font-semibold">Behavior Assertions</h4>
                      <Badge variant="secondary" className="text-xs">hybrid</Badge>
                    </div>
                    <div className="space-y-1 pl-1">
                      {proposed.behavior_assertions.map((ba, idx) => (
                        <label
                          key={idx}
                          className="flex items-start gap-2 cursor-pointer hover:bg-muted/30 rounded p-2 -ml-1 border"
                        >
                          <Checkbox
                            checked={selection.behaviors.has(idx)}
                            onCheckedChange={() => toggleBehavior(idx)}
                            className="mt-0.5"
                          />
                          <span className="text-sm">{ba.assertion}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Response Quality Assertion */}
                {proposed.response_quality_expectation && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <ChatCircle size={14} className="text-muted-foreground" />
                      <h4 className="text-sm font-semibold">Response Quality</h4>
                      <Badge variant="secondary" className="text-xs">response_only</Badge>
                    </div>
                    <label className="flex items-start gap-2 cursor-pointer hover:bg-muted/30 rounded p-2 -ml-1 border">
                      <Checkbox
                        checked={selection.responseQuality}
                        onCheckedChange={toggleResponseQuality}
                        className="mt-0.5"
                      />
                      <span className="text-sm">
                        {proposed.response_quality_expectation.assertion}
                      </span>
                    </label>
                  </div>
                )}

                {/* Empty state */}
                {proposed.behavior_assertions.length === 0 &&
                  !proposed.response_quality_expectation && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    No assertions could be generated from this trace. The test case may not have enough data.
                  </div>
                )}
              </>
            )}
          </div>

          {proposed && !loading && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleApply}
                disabled={selectedCount === 0 || applying || !testCase}
                className="gap-2"
              >
                {applying ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <Check size={14} weight="bold" />
                )}
                Apply {selectedCount} Assertion{selectedCount !== 1 ? "s" : ""}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
