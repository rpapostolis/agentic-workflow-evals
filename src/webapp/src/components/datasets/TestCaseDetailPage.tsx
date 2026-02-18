import { useParams, useNavigate } from "react-router-dom";
import { useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeft,
  CircleNotch,
  Hash,
  File,
  ChatCircle,
  Check,
  ArrowsIn,
  ArrowsOut,
  PencilSimple,
  Plus,
  Trash,
  Brain,
  Lightning,
} from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useDataset } from "@/hooks/useDatasets";
import { SearchFilterControls } from "@/components/shared/SearchFilterControls";
import { NoDataCard } from "@/components/shared/NoDataCard";
import { useTableState } from "@/hooks/useTableState";
import { JsonEditor } from "@/components/shared/JsonEditor";
import { apiClient } from "@/lib/api";
import { toast } from "sonner";
import type {
  BackendTestCase,
  AssertionMode,
  BehaviorAssertion,
} from "@/lib/api";

interface CardItem {
  id: string;
  type: "id" | "description" | "input" | "expected_response";
  title: string;
  content: string;
}

export function TestCaseDetailPage() {
  const { id, testcase_id } = useParams<{ id: string; testcase_id: string }>();
  const navigate = useNavigate();
  const { dataset, loading, error, refetch } = useDataset(id!);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [isJsonEditMode, setIsJsonEditMode] = useState(false);

  const testCase = useMemo(() => {
    if (!dataset?.test_cases || !testcase_id) return null;
    return dataset.test_cases.find((tc) => tc.id === testcase_id);
  }, [dataset, testcase_id]);

  const [newBehaviorAssertion, setNewBehaviorAssertion] = useState("");
  const [savingMode, setSavingMode] = useState(false);

  const handleModeChange = useCallback(async (mode: AssertionMode) => {
    if (!testCase || !id || !testcase_id) return;
    setSavingMode(true);
    try {
      await apiClient.updateTestCase(id, testcase_id, {
        ...testCase,
        assertion_mode: mode,
      });
      await refetch();
      toast.success(`Assertion mode changed to ${mode}`);
    } catch (err) {
      toast.error("Failed to update assertion mode");
    } finally {
      setSavingMode(false);
    }
  }, [testCase, id, testcase_id, refetch]);

  const handleAddBehaviorAssertion = useCallback(async () => {
    if (!testCase || !id || !testcase_id || !newBehaviorAssertion.trim()) return;
    try {
      const updatedAssertions = [
        ...(testCase.behavior_assertions || []),
        { assertion: newBehaviorAssertion.trim() },
      ];
      await apiClient.updateTestCase(id, testcase_id, {
        ...testCase,
        behavior_assertions: updatedAssertions,
        assertion_mode: "hybrid",
      });
      setNewBehaviorAssertion("");
      await refetch();
      toast.success("Behavior assertion added");
    } catch (err) {
      toast.error("Failed to add behavior assertion");
    }
  }, [testCase, id, testcase_id, newBehaviorAssertion, refetch]);

  const handleRemoveBehaviorAssertion = useCallback(async (index: number) => {
    if (!testCase || !id || !testcase_id) return;
    try {
      const updatedAssertions = (testCase.behavior_assertions || []).filter((_, i) => i !== index);
      const newMode = updatedAssertions.length === 0
        ? "response_only"
        : testCase.assertion_mode;
      await apiClient.updateTestCase(id, testcase_id, {
        ...testCase,
        behavior_assertions: updatedAssertions,
        assertion_mode: newMode,
      });
      await refetch();
      toast.success("Behavior assertion removed");
    } catch (err) {
      toast.error("Failed to remove behavior assertion");
    }
  }, [testCase, id, testcase_id, refetch]);

  const handleUpdateTestCase = async (updatedTestCase: BackendTestCase) => {
    try {
      if (!testcase_id || !id) {
        throw new Error("Test case ID and dataset ID are required");
      }

      await apiClient.updateTestCase(id, testcase_id, updatedTestCase);
      await refetch(); // Refresh the dataset data to show updated test case
      toast.success("Test case updated successfully");
    } catch (error) {
      console.error("Error updating test case:", error);
      throw new Error(
        error instanceof Error ? error.message : "Failed to update test case"
      );
    }
  };

  const cardData = useMemo(() => {
    if (!testCase) return [];

    const items: CardItem[] = [];

    // Show assertion mode badge
    const mode = testCase.assertion_mode || "response_only";

    // Add behavior assertions
    if (testCase.behavior_assertions?.length) {
      testCase.behavior_assertions.forEach((ba, index) => {
        items.push({
          id: `behavior-${index}`,
          type: "description",
          title: `Behavior Assertion ${index + 1}`,
          content: ba.assertion,
        });
      });
    }

    return items;
  }, [testCase]);

  const [selectedFilters, setSelectedFilters] = useState<string[]>([]);
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(new Set());

  const getCardIcon = (type: string) => {
    switch (type) {
      case "id":
        return <Hash size={20} className="text-primary" />;
      case "description":
        return <File size={20} className="text-primary" />;
      case "input":
        return <ChatCircle size={20} className="text-primary" />;
      case "expected_response":
        return <Check size={20} className="text-primary" />;
      default:
        return null;
    }
  };

  const toggleCardCollapse = (cardId: string) => {
    setCollapsedCards((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(cardId)) {
        newSet.delete(cardId);
      } else {
        newSet.add(cardId);
      }
      return newSet;
    });
  };

  const {
    searchTerm,
    setSearchTerm,
    sortOrder,
    handleSort,
    filteredData: filteredCardData,
  } = useTableState({
    data: cardData,
    customSearchFunction: (item, searchTerm) =>
      item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.content.toLowerCase().includes(searchTerm.toLowerCase()),
    customSortFunction: (a, b, sortOrder) => {
      const comparison = a.title
        .toLowerCase()
        .localeCompare(b.title.toLowerCase());
      return sortOrder === "asc" ? comparison : -comparison;
    },
    filters: {
      type: {
        getValue: (item) => {
          switch (item.type) {
            case "id":
              return "Id";
            case "description":
              return "Description";
            case "input":
              return "Input (Agent Prompt)";
            case "expected_response":
              return "Expected Output";
            default:
              return undefined;
          }
        },
        selectedValues: selectedFilters,
      },
    },
  });

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  const renderCardContent = (item: CardItem) => {
    return (
      <div className="space-y-2">
        <div className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {item.content}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <CircleNotch size={48} className="animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Loading test case...</p>
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

  if (!dataset || !testCase) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <h2 className="text-2xl font-bold mb-2">Test case not found</h2>
        <p className="text-muted-foreground mb-6">
          The test case you're looking for doesn't exist.
        </p>
        <Button
          onClick={() => navigate(`/datasets/${id}`)}
          variant="outline"
          className="gap-2"
        >
          <ArrowLeft size={18} />
          Back to Dataset
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate(`/datasets/${id}`)}
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
        Back to {dataset.seed?.name || "Dataset"}
      </button>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {testCase.name || `Test Case ${testcase_id}`}
          </h1>
          <p className="text-muted-foreground text-sm">
            {testCase.description}
          </p>
          <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            Mode: {testCase.assertion_mode || "response_only"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isJsonEditMode ? "default" : "outline"}
            onClick={() => setIsJsonEditMode(!isJsonEditMode)}
            className="gap-2"
          >
            <PencilSimple size={14} />
            {isJsonEditMode ? "View Mode" : "JSON Edit Mode"}
          </Button>
        </div>
      </div>

      {isJsonEditMode ? (
        <div className="space-y-6">
          <JsonEditor
            title="Test Case JSON"
            data={testCase}
            onSave={handleUpdateTestCase}
            maxHeight="700px"
            protectedFields={["id", "dataset_id"]}
          />
          <Alert>
            <AlertDescription>
              You are editing the complete test case JSON. All changes will be
              saved when you click "Save Changes" in the editor. Note: The "id"
              and "dataset_id" fields cannot be modified.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Input (Agent Prompt)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap max-h-[300px] overflow-y-auto"
                  style={{ minHeight: "120px" }}
                >
                  {testCase.input}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Expected Response
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className="text-sm bg-muted/50 p-3 rounded-md whitespace-pre-wrap max-h-[300px] overflow-y-auto"
                  style={{ minHeight: "120px" }}
                >
                  {testCase.expected_response}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Assertion Mode Selector */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Lightning size={14} />
                Assertion Mode
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-3">
                {(["response_only", "hybrid"] as AssertionMode[]).map((mode) => {
                  const isActive = (testCase.assertion_mode || "response_only") === mode;
                  const labels: Record<string, string> = {
                    response_only: "Response Only",
                    hybrid: "Hybrid (Behavior)",
                  };
                  const descriptions: Record<string, string> = {
                    response_only: "Evaluate only the agent's final response",
                    hybrid: "Natural-language behavior assertions + response",
                  };
                  return (
                    <button
                      key={mode}
                      onClick={() => handleModeChange(mode)}
                      disabled={savingMode}
                      style={{
                        flex: 1,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: isActive ? "2px solid hsl(var(--primary))" : "1px solid var(--border)",
                        background: isActive ? "hsl(var(--primary) / 0.08)" : "transparent",
                        cursor: savingMode ? "wait" : "pointer",
                        textAlign: "left",
                        transition: "all 0.15s",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600, color: isActive ? "hsl(var(--primary))" : "var(--foreground)" }}>
                        {labels[mode]}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 2 }}>
                        {descriptions[mode]}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Behavior Assertions Editor (shown when mode is hybrid or has behavior assertions) */}
          {((testCase.assertion_mode === "hybrid") || (testCase.behavior_assertions && testCase.behavior_assertions.length > 0)) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Brain size={14} />
                  Behavior Assertions
                  <Badge variant="secondary" className="text-xs">{testCase.behavior_assertions?.length || 0}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {testCase.behavior_assertions?.map((ba, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2 p-2 rounded-md border bg-muted/30 group"
                  >
                    <div className="flex-1 text-sm">{ba.assertion}</div>
                    <button
                      onClick={() => handleRemoveBehaviorAssertion(index)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      title="Remove assertion"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}

                {/* Add new behavior assertion */}
                <div className="flex gap-2 pt-1">
                  <input
                    type="text"
                    value={newBehaviorAssertion}
                    onChange={(e) => setNewBehaviorAssertion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newBehaviorAssertion.trim()) {
                        handleAddBehaviorAssertion();
                      }
                    }}
                    placeholder="e.g., Agent should call sendMail with a valid recipient address"
                    className="flex-1 px-3 py-1.5 text-sm rounded-md border bg-background"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddBehaviorAssertion}
                    disabled={!newBehaviorAssertion.trim()}
                    className="gap-1"
                  >
                    <Plus size={12} />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Test Case Information</h2>

            {cardData.length === 0 ? (
              <NoDataCard
                icon={
                  <File size={48} className="text-muted-foreground mb-4" />
                }
                title="No information available"
                description="This test case has no available information."
              />
            ) : (
              <>
                <SearchFilterControls
                  searchValue={searchTerm}
                  onSearchChange={setSearchTerm}
                  searchPlaceholder="Search test case information"
                  filters={[
                    {
                      key: "type",
                      placeholder: "Filter by type",
                      options: [
                        "Id",
                        "Description",
                        "Input (Agent Prompt)",
                        "Expected Output",
                      ],
                      selectedOptions: selectedFilters,
                      onSelectionChange: setSelectedFilters,
                      multiselect: true,
                    },
                  ]}
                  sortOrder={sortOrder}
                  onSortChange={handleSort}
                  sortLabel="Sort"
                />
                <div className="space-y-3">
                  {filteredCardData.map((item) => {
                    const isCollapsed = collapsedCards.has(item.id);

                    return (
                      <Card
                        key={item.id}
                        className="transition-all hover:shadow-md hover:border-primary/50 cursor-pointer"
                        onClick={() => toggleCardCollapse(item.id)}
                      >
                        <CardHeader className="pb-1">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                {getCardIcon(item.type)}
                                <CardTitle className="text-lg">
                                  {item.title}
                                </CardTitle>
                              </div>
                                      </div>
                            <div className="text-muted-foreground transition-transform duration-200">
                              {isCollapsed ? (
                                <ArrowsOut size={14} />
                              ) : (
                                <ArrowsIn size={14} />
                              )}
                            </div>
                          </div>
                        </CardHeader>
                        {!isCollapsed && (
                          <CardContent>{renderCardContent(item)}</CardContent>
                        )}
                      </Card>
                    );
                  })}
                </div>
                {filteredCardData.length === 0 && (
                  <NoDataCard
                    icon={
                      <File
                        className="text-muted-foreground mb-4"
                        size={48}
                      />
                    }
                    title={`No items found matching "${searchTerm}"`}
                    description="Try adjusting your search terms or filters"
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
