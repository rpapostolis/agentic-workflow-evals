import { useParams, useNavigate } from "react-router-dom";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, CircleNotch, Wrench, Plus, Trash } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AIContentDisclaimer } from "@/components/shared/AIContentDisclaimer";
import { useDataset } from "@/hooks/useDatasets";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";

export function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { dataset, loading, error, refetch } = useDataset(id!);

  // Add Test Case Dialog
  const [addTestCaseDialogOpen, setAddTestCaseDialogOpen] = useState(false);
  const [testCaseName, setTestCaseName] = useState("");
  const [testCaseDescription, setTestCaseDescription] = useState("");
  const [testCaseInput, setTestCaseInput] = useState("");
  const [testCaseExpectedResponse, setTestCaseExpectedResponse] = useState("");
  const [testCaseQualityAssertion, setTestCaseQualityAssertion] = useState("");
  const [isAddingTestCase, setIsAddingTestCase] = useState(false);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <CircleNotch size={48} className="animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Loading dataset...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <Alert variant="destructive" className="max-w-md mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button
          onClick={() => navigate("/datasets")}
          variant="outline"
          className="gap-2"
        >
          <ArrowLeft size={18} />
          Back to Datasets
        </Button>
      </div>
    );
  }

  if (!dataset || !dataset.test_cases) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <h2 className="text-2xl font-bold mb-2">Dataset not found</h2>
        <p className="text-muted-foreground mb-6">
          The dataset you're looking for doesn't exist.
        </p>
        <Button
          onClick={() => navigate("/datasets")}
          variant="outline"
          className="gap-2"
        >
          <ArrowLeft size={18} />
          Back to Datasets
        </Button>
      </div>
    );
  }

  const handleAddTestCase = async () => {
    if (!testCaseInput.trim()) {
      toast.error("Input is required");
      return;
    }

    setIsAddingTestCase(true);
    try {
      await apiClient.createTestCaseUI(id!, {
        name: testCaseName.trim() || undefined,
        description: testCaseDescription.trim() || undefined,
        input: testCaseInput.trim(),
        expected_response: testCaseExpectedResponse.trim() || undefined,
      });
      toast.success("Test case created successfully");
      setAddTestCaseDialogOpen(false);
      setTestCaseName("");
      setTestCaseDescription("");
      setTestCaseInput("");
      setTestCaseExpectedResponse("");
      setTestCaseQualityAssertion("");
      refetch();
    } catch (error) {
      console.error("Error adding test case:", error);
      toast.error("Failed to add test case");
    } finally {
      setIsAddingTestCase(false);
    }
  };

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate("/datasets")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: "var(--muted-foreground)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "4px 0",
          fontSize: 13,
          marginBottom: 4,
        }}
      >
        <ArrowLeft size={16} />
        Back to Datasets
      </button>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {dataset.seed?.name || dataset.metadata?.suite_id || "Dataset"}
          </h1>
          <p className="text-muted-foreground text-sm">{dataset.seed?.goal}</p>
          <p className="text-muted-foreground text-xs">
            Generator: {dataset.metadata?.generator_id} • Version:{" "}
            {dataset.metadata?.version}
          </p>
          <AIContentDisclaimer />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Test Cases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {dataset.test_cases?.length || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Created
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">
              {new Date(
                dataset.metadata?.created_at || dataset.created_at
              ).toLocaleDateString()}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Test Cases</h2>
          <Dialog open={addTestCaseDialogOpen} onOpenChange={setAddTestCaseDialogOpen}>
            <Button onClick={() => setAddTestCaseDialogOpen(true)} className="gap-2">
              <Plus size={16} />
              Add Test Case
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Test Case</DialogTitle>
                <DialogDescription>
                  Create a new test case for this dataset.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="test-case-name">Name (optional)</Label>
                  <input
                    id="test-case-name"
                    type="text"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="Short name for the test case..."
                    value={testCaseName}
                    onChange={(e) => setTestCaseName(e.target.value)}
                    disabled={isAddingTestCase}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="test-case-input">Input *</Label>
                  <Textarea
                    id="test-case-input"
                    placeholder="Enter the agent prompt or input..."
                    value={testCaseInput}
                    onChange={(e) => setTestCaseInput(e.target.value)}
                    disabled={isAddingTestCase}
                    rows={4}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="test-case-response">Expected Response (optional)</Label>
                  <Textarea
                    id="test-case-response"
                    placeholder="Describe the expected response..."
                    value={testCaseExpectedResponse}
                    onChange={(e) => setTestCaseExpectedResponse(e.target.value)}
                    disabled={isAddingTestCase}
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="test-case-description">Description (optional)</Label>
                  <Textarea
                    id="test-case-description"
                    placeholder="Describe what this test case evaluates..."
                    value={testCaseDescription}
                    onChange={(e) => setTestCaseDescription(e.target.value)}
                    disabled={isAddingTestCase}
                    rows={2}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setAddTestCaseDialogOpen(false)}
                  disabled={isAddingTestCase}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAddTestCase}
                  disabled={isAddingTestCase || !testCaseInput.trim()}
                >
                  {isAddingTestCase ? (
                    <>
                      <CircleNotch size={16} className="animate-spin mr-2" />
                      Adding...
                    </>
                  ) : (
                    "Add Test Case"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {dataset.test_cases.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground">No test cases yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="w-full">
            <div
              className="grid items-center text-sm text-muted-foreground"
              style={{
                gridTemplateColumns: "1fr 1fr 100px 80px 40px",
                padding: "16px 8px",
              }}
            >
              <div>Name</div>
              <div>Description</div>
              <div>Assertions</div>
              <div>Mode</div>
              <div></div>
            </div>
            {(dataset.test_cases || []).map((testCase) => (
              <div
                key={testCase.id}
                className="grid items-center text-sm border-b border-border last:border-b-0 hover:bg-secondary/50 transition-colors"
                style={{
                  gridTemplateColumns: "1fr 1fr 100px 80px 40px",
                  padding: "16px 8px",
                  cursor: "pointer",
                }}
                onClick={() =>
                  navigate(`/datasets/${id}/testcases/${testCase.id}`)
                }
              >
                <div className="truncate font-medium">
                  {testCase.name || `Test Case ${testCase.id}`}
                </div>
                <div className="truncate text-muted-foreground">
                  {testCase.description || "—"}
                </div>
                <div className="text-center">
                  <Badge
                    variant="outline"
                    className="inline-flex"
                    style={{
                      fontSize: "12px",
                      padding: "2px 6px",
                    }}
                  >
                    {(testCase as any).behavior_assertions?.length || 0}
                  </Badge>
                </div>
                <div className="text-center">
                  <Badge variant="secondary" style={{ fontSize: "10px", padding: "1px 5px" }}>
                    {(testCase as any).assertion_mode || "response_only"}
                  </Badge>
                </div>
                <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="p-1 rounded hover:bg-destructive/10 transition-colors"
                    style={{ color: "var(--muted-foreground)" }}
                    title="Delete test case"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Delete test case "${testCase.name}"?`)) return;
                      try {
                        await apiClient.deleteTestCase(id!, testCase.id);
                        toast.success("Test case deleted");
                        refetch();
                      } catch (err) {
                        toast.error("Failed to delete test case");
                      }
                    }}
                  >
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
