/**
 * Production Annotations Page
 *
 * Lists all annotated production traces with their annotation details
 */

import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Flex, Text, Card, Button, Badge, Table, Dialog, Select } from "@radix-ui/themes";
import { Eye, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { apiClient } from "../../lib/api";
import { API_BASE_URL } from "../../lib/config";
import { useProductionTraces } from "../../hooks/useProductionTraces";

interface AnnotatedTrace {
  trace_id: string;
  trace: any;
  annotation: any;
}

export function ProductionAnnotationsPage() {
  const navigate = useNavigate();
  const { traces, loading: tracesLoading } = useProductionTraces();
  const [annotatedTraces, setAnnotatedTraces] = useState<AnnotatedTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<any[]>([]);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [conversionDialogOpen, setConversionDialogOpen] = useState(false);
  const [selectedTrace, setSelectedTrace] = useState<any>(null);
  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [converting, setConverting] = useState(false);
  const [conversionSuccess, setConversionSuccess] = useState(false);
  const [conversionResult, setConversionResult] = useState<any>(null);

  // Load agents, datasets, and annotations
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const [agentsData, datasetsData] = await Promise.all([
          apiClient.listAgents(),
          apiClient.getDatasets()
        ]);
        setAgents(agentsData);
        setDatasets(datasetsData);

        // For each trace, try to load its annotation
        const annotated: AnnotatedTrace[] = [];
        for (const trace of traces) {
          try {
            const annotation = await apiClient.getTraceAnnotation(trace.id);
            if (annotation) {
              annotated.push({ trace_id: trace.id, trace, annotation });
            }
          } catch (err) {
            // No annotation for this trace, skip
          }
        }
        setAnnotatedTraces(annotated);
      } catch (err) {
        console.error("Failed to load annotations:", err);
      } finally {
        setLoading(false);
      }
    };

    if (traces.length > 0) {
      loadData();
    }
  }, [traces]);

  const agentMap = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((a: any) => (m[a.id] = a.name));
    return m;
  }, [agents]);

  const outcomeLabels = ["Failed", "No", "Partly", "Mostly", "Yes"];
  const annotationColors = {
    green: "#3fb950",
    greenBg: "rgba(63, 185, 80, 0.12)",
    red: "#f85149",
    redBg: "rgba(248, 81, 73, 0.12)",
    amber: "#d29922",
    amberBg: "rgba(210, 153, 34, 0.12)",
  };

  const getOutcomeColor = (outcome: number) => {
    if (outcome >= 4) return annotationColors.green;
    if (outcome === 3) return annotationColors.amber;
    return annotationColors.red;
  };

  // Helper to safely parse tool calls
  const parseToolCalls = (toolCalls: any) => {
    if (!toolCalls) return [];
    if (Array.isArray(toolCalls)) return toolCalls;
    if (typeof toolCalls === 'string') {
      try {
        const parsed = JSON.parse(toolCalls);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        console.warn("Failed to parse tool_calls:", toolCalls);
        return [];
      }
    }
    return [];
  };

  const handleConvertToTestCase = async () => {
    if (!selectedTrace || !selectedDataset) return;

    setConverting(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/production-traces/${selectedTrace.id}/convert-to-testcase?dataset_id=${selectedDataset}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Trace ${selectedTrace.id.slice(0, 8)}`,
            description: `Converted from production trace`,
            conversion_type: "manual",
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || "Conversion failed");
      }

      const result = await response.json();
      setConversionResult({
        ...result,
        datasetName: datasets.find(d => d.id === selectedDataset)?.seed.name || selectedDataset
      });
      setConversionDialogOpen(false);
      setConversionSuccess(true);
    } catch (err) {
      console.error("Failed to convert trace:", err);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to convert trace:\n\n${errorMsg}`);
    } finally {
      setConverting(false);
    }
  };

  if (loading || tracesLoading) {
    return (
      <Box p="6">
        <Text color="gray">Loading annotations...</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Flex direction="column" gap="4">
        {/* Header */}
        <Flex justify="between" align="center">
          <Box>
            <Text size="6" weight="bold">Production Trace Annotations</Text>
            <Text size="2" color="gray" style={{ display: "block", marginTop: 4 }}>
              All annotated production traces with outcome and efficiency ratings
            </Text>
          </Box>
          <Button variant="soft" onClick={() => navigate("/production-traces")}>
            ← Back to Traces
          </Button>
        </Flex>

        {/* Stats */}
        <Flex gap="3">
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Total Annotated</Text>
            <Text size="6" weight="bold">{annotatedTraces.length}</Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Test Candidates</Text>
            <Text size="6" weight="bold" color="green">
              {annotatedTraces.filter(a => a.annotation.testcase_candidate).length}
            </Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>With PII</Text>
            <Text size="6" weight="bold" color="orange">
              {annotatedTraces.filter(a => a.trace.pii_detected).length}
            </Text>
          </Card>
        </Flex>

        {/* Annotations Table */}
        {annotatedTraces.length === 0 ? (
          <Card>
            <Flex align="center" justify="center" style={{ minHeight: 200 }} direction="column" gap="2">
              <Text color="gray">No annotations yet</Text>
              <Button onClick={() => navigate("/production-traces")}>
                Go to Production Traces
              </Button>
            </Flex>
          </Card>
        ) : (
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Trace</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Agent</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Outcome</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Efficiency</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Notes</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Flags</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {annotatedTraces.map(({ trace, annotation }) => (
                  <Table.Row key={trace.id}>
                    <Table.Cell>
                      <Flex direction="column" gap="1">
                        <Text size="1" style={{ fontFamily: "monospace" }}>
                          {trace.id.slice(0, 12)}
                        </Text>
                        <a
                          href={`${API_BASE_URL}/production-traces/${trace.id}/annotations`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "11px", color: "var(--blue-9)", textDecoration: "underline" }}
                        >
                          View JSON →
                        </a>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2">{agentMap[trace.agent_id] || trace.agent_id.slice(0, 12)}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      {annotation.outcome ? (
                        <Badge style={{ backgroundColor: getOutcomeColor(annotation.outcome) + "20", color: getOutcomeColor(annotation.outcome) }}>
                          {outcomeLabels[annotation.outcome - 1]}
                        </Badge>
                      ) : (
                        <Text size="1" color="gray">—</Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {annotation.efficiency ? (
                        <Badge color={annotation.efficiency === "efficient" ? "green" : annotation.efficiency === "acceptable" ? "amber" : "red"}>
                          {annotation.efficiency}
                        </Badge>
                      ) : (
                        <Text size="1" color="gray">—</Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" style={{ maxWidth: 200, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {annotation.notes || "—"}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex gap="1" wrap="wrap">
                        {trace.pii_detected && (
                          <Badge color="orange" size="1">PII</Badge>
                        )}
                        {annotation.testcase_candidate && (
                          <Badge color="green" size="1">
                            <CheckCircle2 size={10} style={{ marginRight: 2 }} />
                            Test Case
                          </Badge>
                        )}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex gap="2">
                        <Button
                          size="1"
                          variant="soft"
                          onClick={() => navigate(`/production-traces?trace=${trace.id}`)}
                        >
                          <Eye size={14} style={{ marginRight: 4 }} />
                          View
                        </Button>
                        {annotation.testcase_candidate && trace.status !== "converted_to_testcase" && (
                          <Button
                            size="1"
                            color="blue"
                            onClick={() => {
                              setSelectedTrace(trace);
                              setConversionDialogOpen(true);
                            }}
                          >
                            <ArrowRight size={14} style={{ marginRight: 4 }} />
                            Convert
                          </Button>
                        )}
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        )}
      </Flex>

      {/* Conversion Dialog */}
      <Dialog.Root open={conversionDialogOpen} onOpenChange={setConversionDialogOpen}>
        <Dialog.Content style={{ maxWidth: 500 }}>
          <Dialog.Title>Convert to Test Case</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Convert this annotated production trace into a test case and add it to a dataset.
            {selectedTrace?.pii_detected && (
              <Text size="2" color="orange" style={{ display: "block", marginTop: 8 }}>
                ⚠️ PII will be automatically redacted during conversion
              </Text>
            )}
          </Dialog.Description>

          <Flex direction="column" gap="3">
            <Box>
              <Text as="label" size="2" weight="bold">Target Dataset *</Text>
              <Select.Root value={selectedDataset} onValueChange={setSelectedDataset}>
                <Select.Trigger placeholder="Select dataset..." style={{ width: "100%", marginTop: 4 }} />
                <Select.Content>
                  {datasets.map(d => (
                    <Select.Item key={d.id} value={d.id}>
                      {d.seed.name} ({d.test_case_ids?.length || 0} test cases)
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <Text size="1" color="gray" style={{ display: "block", marginTop: 4 }}>
                The test case will be added to this dataset
              </Text>
            </Box>

            {selectedTrace && (
              <Box style={{ padding: 12, background: "var(--gray-2)", borderRadius: 8 }}>
                <Text size="1" weight="bold" style={{ display: "block", marginBottom: 8 }}>
                  Preview:
                </Text>
                <Flex direction="column" gap="2">
                  <Flex justify="between">
                    <Text size="1" color="gray">Trace ID:</Text>
                    <Text size="1" style={{ fontFamily: "monospace" }}>
                      {selectedTrace.id.slice(0, 12)}
                    </Text>
                  </Flex>
                  <Flex justify="between">
                    <Text size="1" color="gray">Input:</Text>
                    <Text size="1" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedTrace.input.slice(0, 50)}...
                    </Text>
                  </Flex>
                  {parseToolCalls(selectedTrace.tool_calls).length > 0 && (
                    <Flex justify="between">
                      <Text size="1" color="gray">Tools Used:</Text>
                      <Text size="1">
                        {parseToolCalls(selectedTrace.tool_calls).length} tool calls
                      </Text>
                    </Flex>
                  )}
                </Flex>
              </Box>
            )}
          </Flex>

          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={converting}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              onClick={handleConvertToTestCase}
              disabled={!selectedDataset || converting}
            >
              {converting ? "Converting..." : "Convert to Test Case"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* Conversion Success Dialog */}
      <Dialog.Root open={conversionSuccess} onOpenChange={(open) => {
        setConversionSuccess(open);
        if (!open) {
          // Reload to show updated status
          window.location.reload();
        }
      }}>
        <Dialog.Content style={{ maxWidth: 500 }}>
          <Flex direction="column" gap="4" align="center" style={{ textAlign: "center", padding: "20px 0" }}>
            {/* Success Icon */}
            <Box style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: annotationColors.greenBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}>
              <CheckCircle2 size={36} color={annotationColors.green} />
            </Box>

            {/* Title */}
            <Box>
              <Dialog.Title style={{ fontSize: 24, marginBottom: 8 }}>
                Converted to Test Case!
              </Dialog.Title>
              <Dialog.Description size="2" color="gray">
                The production trace has been successfully converted and added to your dataset
              </Dialog.Description>
            </Box>

            {/* Details */}
            {conversionResult && (
              <Card style={{ width: "100%", background: "var(--gray-2)" }}>
                <Flex direction="column" gap="3">
                  <Flex justify="between" align="center">
                    <Text size="2" color="gray">Test Case ID:</Text>
                    <Text size="2" weight="bold" style={{ fontFamily: "monospace" }}>
                      {conversionResult.testcase.id}
                    </Text>
                  </Flex>
                  <Flex justify="between" align="center">
                    <Text size="2" color="gray">Dataset:</Text>
                    <Text size="2" weight="bold">
                      {conversionResult.datasetName}
                    </Text>
                  </Flex>
                  {conversionResult.pii_redacted && conversionResult.pii_redacted.length > 0 && (
                    <Box style={{ padding: "12px", background: "var(--orange-3)", borderRadius: 8 }}>
                      <Flex gap="2" align="center">
                        <AlertTriangle size={16} color="var(--orange-9)" />
                        <Box>
                          <Text size="2" weight="bold" color="orange">PII Redacted</Text>
                          <Text size="1" color="gray" style={{ display: "block", marginTop: 4 }}>
                            {conversionResult.pii_redacted.join(", ")}
                          </Text>
                        </Box>
                      </Flex>
                    </Box>
                  )}
                </Flex>
              </Card>
            )}

            {/* Actions */}
            <Flex gap="3" mt="2" style={{ width: "100%" }}>
              <Dialog.Close style={{ flex: 1 }}>
                <Button variant="soft" style={{ width: "100%" }}>
                  Close
                </Button>
              </Dialog.Close>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Box>
  );
}
