/**
 * Production Traces Page - Radix UI Themes Edition
 *
 * Aligned with Evaluations UX pattern using Radix UI Themes components
 */

import { useState, useMemo, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Box, Flex, Text, Card, Button, Badge, TextField, Select, Table, Dialog, ScrollArea } from "@radix-ui/themes";
import { RefreshCw, Upload, Lock, Eye, Edit, AlertTriangle, CheckCircle2, X, ArrowRight, Play, Loader } from "lucide-react";
import { useProductionTraces, ProductionTrace } from "../../hooks/useProductionTraces";
import { apiClient } from "../../lib/api";
import { API_BASE_URL } from "../../lib/config";

export function ProductionTracesPage() {
  // Routing
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // State
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [selectedStatus, setSelectedStatus] = useState<string | undefined>();
  const [showOnlyAnnotated, setShowOnlyAnnotated] = useState(false);
  const [detailTrace, setDetailTrace] = useState<ProductionTrace | null>(null);
  const [showAnnotationPanel, setShowAnnotationPanel] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [agents, setAgents] = useState<any[]>([]);
  const [uploadAgent, setUploadAgent] = useState<string>("");
  const [searchTerm, setSearchTerm] = useState("");

  // Annotation state (matches TraceAnnotation model)
  const [outcome, setOutcome] = useState<number | null>(null);
  const [efficiency, setEfficiency] = useState<string>("");
  const [issues, setIssues] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [testcaseCandidate, setTestcaseCandidate] = useState<boolean>(false);
  const [conversionNotes, setConversionNotes] = useState<string>("");
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [annotatedTraces, setAnnotatedTraces] = useState<Set<string>>(new Set());

  // Run Task state
  const [runTaskDialogOpen, setRunTaskDialogOpen] = useState(false);
  const [runTaskAgent, setRunTaskAgent] = useState<string>("");
  const [runTaskInput, setRunTaskInput] = useState<string>("");
  const [runTaskLoading, setRunTaskLoading] = useState(false);
  const [runTaskError, setRunTaskError] = useState<string | null>(null);

  // Conversion state
  const [conversionDialogOpen, setConversionDialogOpen] = useState(false);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [converting, setConverting] = useState(false);
  const [conversionSuccess, setConversionSuccess] = useState(false);
  const [conversionResult, setConversionResult] = useState<any>(null);

  // Data
  const { traces, loading, error, fetchTraces } = useProductionTraces(selectedAgent, selectedStatus);

  // Load agents and datasets
  useEffect(() => {
    apiClient.listAgents().then(setAgents).catch(console.error);
    apiClient.getDatasets().then(setDatasets).catch(console.error);
  }, []);

  // Auto-open trace from URL parameter (for navigation from annotations page)
  useEffect(() => {
    const traceId = searchParams.get("trace");
    if (traceId && traces.length > 0) {
      const trace = traces.find(t => t.id === traceId);
      if (trace) {
        setDetailTrace(trace);
        setShowAnnotationPanel(false); // Default to view mode
        // Clean up URL after opening
        navigate("/production-traces", { replace: true });
      }
    }
  }, [searchParams, traces, navigate]);

  // Load annotation status for all traces on mount
  useEffect(() => {
    const loadAnnotations = async () => {
      const annotatedIds = new Set<string>();
      for (const trace of traces) {
        try {
          const annotation = await apiClient.getTraceAnnotation(trace.id);
          if (annotation) {
            annotatedIds.add(trace.id);
          }
        } catch {
          // No annotation, skip
        }
      }
      setAnnotatedTraces(annotatedIds);
    };

    if (traces.length > 0) {
      loadAnnotations();
    }
  }, [traces]);

  // Load annotation when trace is opened
  useEffect(() => {
    if (detailTrace) {
      setAnnotationLoading(true);
      setSaveSuccess(false); // Reset save success state
      apiClient.getTraceAnnotation(detailTrace.id)
        .then(annotation => {
          if (annotation) {
            setOutcome(annotation.outcome || null);
            setEfficiency(annotation.efficiency || "");
            setIssues(annotation.issues || []);
            setNotes(annotation.notes || "");
            setTestcaseCandidate(annotation.testcase_candidate || false);
            setConversionNotes(annotation.conversion_notes || "");
            setAnnotatedTraces(prev => new Set(prev).add(detailTrace.id)); // Mark as annotated
          } else {
            // No annotation yet, reset to defaults
            setOutcome(null);
            setEfficiency("");
            setIssues([]);
            setNotes("");
            setTestcaseCandidate(false);
            setConversionNotes("");
          }
        })
        .catch(err => {
          console.error("Failed to load annotation:", err);
          // Reset to defaults on error (404 means no annotation exists yet)
          setOutcome(null);
          setEfficiency("");
          setIssues([]);
          setNotes("");
          setTestcaseCandidate(false);
          setConversionNotes("");
        })
        .finally(() => setAnnotationLoading(false));
    }
  }, [detailTrace]);

  // Build agent map
  const agentMap = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((a: any) => (m[a.id] = a.name));
    return m;
  }, [agents]);

  // Filter traces
  const filteredTraces = useMemo(() => {
    let filtered = traces;

    // Filter by annotation status
    if (showOnlyAnnotated) {
      filtered = filtered.filter(t => annotatedTraces.has(t.id));
    }

    // Filter by search term
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      filtered = filtered.filter(t =>
        t.input.toLowerCase().includes(lower) ||
        t.output.toLowerCase().includes(lower) ||
        (t.model || "").toLowerCase().includes(lower)
      );
    }

    return filtered;
  }, [traces, searchTerm, showOnlyAnnotated, annotatedTraces]);

  // Stats
  const stats = useMemo(() => ({
    total: traces.length,
    annotated: annotatedTraces.size,
    pii: traces.filter(t => t.pii_detected).length,
    pending: traces.filter(t => t.status === "pending").length,
    avgLatency: traces.length ? Math.round(traces.reduce((sum, t) => sum + (t.latency_ms || 0), 0) / traces.length) : 0,
  }), [traces, annotatedTraces]);

  // Helpers
  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const formatLatency = (ms?: number | null) => {
    if (!ms) return "—";
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTokens = (tokensIn?: number | null, tokensOut?: number | null) => {
    if (!tokensIn && !tokensOut) return "—";
    return `${((tokensIn || 0) + (tokensOut || 0)).toLocaleString()}`;
  };

  const statusColor = (status: string) => {
    const map: Record<string, any> = {
      pending: "gray",
      annotated: "green",
      converted_to_testcase: "blue",
      archived: "gray",
    };
    return map[status] || "gray";
  };

  // Annotation color scheme (matching AnnotationsPage)
  const annotationColors = {
    green: "#3fb950",
    greenBg: "rgba(63, 185, 80, 0.12)",
    red: "#f85149",
    redBg: "rgba(248, 81, 73, 0.12)",
    amber: "#d29922",
    amberBg: "rgba(210, 153, 34, 0.12)",
  };

  // Pill chip component for annotations
  const Pill = ({ label, selected, color, bg, onClick }: {
    label: string; selected: boolean; color: string; bg: string; onClick: () => void;
  }) => (
    <button onClick={onClick} style={{
      padding: "4px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600,
      cursor: "pointer", transition: "all 0.15s", textTransform: "capitalize",
      border: selected ? `1px solid ${color}` : "1px solid var(--gray-7)",
      background: selected ? bg : "transparent",
      color: selected ? color : "var(--gray-11)",
    }}>
      {label}
    </button>
  );

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

  // PII highlighter
  const highlightPII = (text: string, piiFlags: string[]) => {
    if (!piiFlags || piiFlags.length === 0) return text;

    // Define PII patterns matching backend detector
    const patterns: Record<string, RegExp> = {
      email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      phone: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
      ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
      credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
      api_key: /\b[A-Za-z0-9]{32,64}\b/g,
      url_with_token: /https?:\/\/[^\s]+[\?&](?:token|key|api_key|auth|secret)=[A-Za-z0-9_-]+/g,
      ipv4: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    };

    // Collect all matches with their positions
    const matches: Array<{ start: number; end: number; text: string }> = [];

    piiFlags.forEach(flag => {
      const pattern = patterns[flag];
      if (pattern) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
          });
        }
      }
    });

    // Sort matches by position
    matches.sort((a, b) => a.start - b.start);

    // Build highlighted text
    if (matches.length === 0) return text;

    const parts: JSX.Element[] = [];
    let lastIndex = 0;

    matches.forEach((match, idx) => {
      // Add text before match
      if (match.start > lastIndex) {
        parts.push(
          <span key={`text-${idx}`}>{text.slice(lastIndex, match.start)}</span>
        );
      }

      // Add highlighted match
      parts.push(
        <mark
          key={`pii-${idx}`}
          style={{
            backgroundColor: "var(--orange-4)",
            color: "var(--orange-11)",
            padding: "2px 4px",
            borderRadius: "3px",
            fontWeight: 600,
          }}
        >
          {match.text}
        </mark>
      );

      lastIndex = match.end;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(<span key="text-end">{text.slice(lastIndex)}</span>);
    }

    return <>{parts}</>;
  };

  // Upload handler
  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !uploadAgent) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(
        `${API_BASE_URL}/production-traces/bulk-upload?agent_id=${uploadAgent}`,
        { method: "POST", body: formData }
      );

      if (!response.ok) throw new Error("Upload failed");

      const result = await response.json();
      alert(result.errors?.length > 0
        ? `Uploaded ${result.traces_created} traces with ${result.errors.length} errors`
        : `✓ Uploaded ${result.traces_created} traces`
      );

      setUploadDialogOpen(false);
      setUploadAgent("");
      fetchTraces();
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  // Conversion handler
  async function handleConvertToTestCase() {
    if (!detailTrace || !selectedDataset) return;

    setConverting(true);
    setConversionSuccess(false);
    try {
      const response = await fetch(
        `${API_BASE_URL}/production-traces/${detailTrace.id}/convert-to-testcase?dataset_id=${selectedDataset}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Trace ${detailTrace.id.slice(0, 8)}`,
            description: conversionNotes || `Converted from production trace`,
            conversion_type: "manual",
            reason: notes || "",
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
      setConversionSuccess(true);
      setConversionDialogOpen(false);
      fetchTraces(); // Refresh to show updated status
    } catch (err) {
      console.error("Failed to convert trace:", err);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to convert trace:\n\n${errorMsg}`);
    } finally {
      setConverting(false);
    }
  }

  if (error) {
    return (
      <Box p="6">
        <Text color="red">Failed to load traces: {error}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Flex direction="column" gap="4">
        {/* Header */}
        <Flex justify="between" align="center">
          <Box>
            <Text size="6" weight="bold">Production Traces</Text>
            <Text size="2" color="gray" style={{ display: "block", marginTop: 4 }}>
              Review and annotate production agent runs with automatic PII detection
            </Text>
          </Box>
          <Flex gap="2">
            <Button variant="soft" onClick={() => navigate("/annotations?tab=production")}>
              <Eye size={18} style={{ marginRight: 6 }} />
              View Annotations
            </Button>
            <Button variant="soft" onClick={() => fetchTraces()} disabled={loading}>
              <RefreshCw size={18} style={{ marginRight: 6 }} />
              Refresh
            </Button>
            <Button onClick={() => setRunTaskDialogOpen(true)} color="green">
              <Play size={18} style={{ marginRight: 6 }} />
              Run Task
            </Button>
            <Button onClick={() => setUploadDialogOpen(true)}>
              <Upload size={18} style={{ marginRight: 6 }} />
              Upload Traces
            </Button>
          </Flex>
        </Flex>

        {/* Stats */}
        <Flex gap="3">
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Total Traces</Text>
            <Text size="6" weight="bold">{stats.total}</Text>
          </Card>
          <Card
            style={{ flex: 1, padding: "16px", cursor: "pointer", transition: "all 0.15s" }}
            onClick={() => navigate("/annotations?tab=production")}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--green-2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = ""; }}
          >
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Annotated</Text>
            <Flex align="center" gap="2">
              <Text size="6" weight="bold" color="green">{stats.annotated}</Text>
              <Text size="1" color="green">→</Text>
            </Flex>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>PII Detected</Text>
            <Text size="6" weight="bold" color="orange">{stats.pii}</Text>
          </Card>
          <Card style={{ flex: 1, padding: "16px" }}>
            <Text size="1" color="gray" style={{ display: "block", marginBottom: 4 }}>Avg Latency</Text>
            <Text size="6" weight="bold">{formatLatency(stats.avgLatency)}</Text>
          </Card>
        </Flex>

        {/* Filters */}
        <Flex gap="3" align="center">
          <TextField.Root
            placeholder="Search traces..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ flex: 1 }}
          />
          <Select.Root value={selectedAgent} onValueChange={(v) => setSelectedAgent(v === "all" ? undefined : v)}>
            <Select.Trigger placeholder="Filter by agent" style={{ width: 200 }} />
            <Select.Content>
              <Select.Item value="all">All Agents</Select.Item>
              {agents.map(a => (
                <Select.Item key={a.id} value={a.id}>{a.name}</Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Select.Root value={selectedStatus} onValueChange={(v) => setSelectedStatus(v === "all" ? undefined : v)}>
            <Select.Trigger placeholder="Filter by status" style={{ width: 200 }} />
            <Select.Content>
              <Select.Item value="all">All Statuses</Select.Item>
              <Select.Item value="pending">Pending</Select.Item>
              <Select.Item value="annotated">Annotated</Select.Item>
              <Select.Item value="converted_to_testcase">Converted</Select.Item>
            </Select.Content>
          </Select.Root>
        </Flex>

        {/* Table */}
        {loading ? (
          <Flex justify="center" align="center" style={{ minHeight: 200 }}>
            <Text color="gray">Loading traces...</Text>
          </Flex>
        ) : filteredTraces.length === 0 ? (
          <Card>
            <Flex align="center" justify="center" style={{ minHeight: 200 }} direction="column" gap="2">
              <Text color="gray">No production traces yet</Text>
              <Flex gap="2">
                <Button color="green" onClick={() => setRunTaskDialogOpen(true)}>
                  <Play size={16} style={{ marginRight: 4 }} /> Run Task
                </Button>
                <Button variant="soft" onClick={() => setUploadDialogOpen(true)}>Upload Traces</Button>
              </Flex>
            </Flex>
          </Card>
        ) : (
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Trace</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Input</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Agent</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Model</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Metrics</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredTraces.map(trace => (
                  <Table.Row key={trace.id} style={{ cursor: "pointer" }} onClick={() => setDetailTrace(trace)}>
                    <Table.Cell>
                      <Flex direction="column" gap="1">
                        <Flex align="center" gap="2" wrap="wrap">
                          <Text size="1" style={{ fontFamily: "monospace" }}>
                            {trace.id.slice(0, 12)}
                          </Text>
                          {trace.pii_detected && (
                            <Badge color="orange" size="1">
                              <Lock size={12} style={{ marginRight: 4 }} />
                              PII
                            </Badge>
                          )}
                          {annotatedTraces.has(trace.id) && (
                            <Badge color="green" size="1">
                              <CheckCircle2 size={12} style={{ marginRight: 4 }} />
                              Annotated
                            </Badge>
                          )}
                        </Flex>
                        <Text size="1" color="gray">{timeAgo(trace.timestamp)}</Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" style={{ maxWidth: 300, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {trace.input}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge color={statusColor(trace.status)}>{trace.status}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2">{agentMap[trace.agent_id] || trace.agent_id.slice(0, 12)}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" color="gray">{trace.model || "—"}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex direction="column" gap="1">
                        <Text size="1" style={{ fontFamily: "monospace" }}>{formatLatency(trace.latency_ms)}</Text>
                        <Text size="1" color="gray">{formatTokens(trace.tokens_in, trace.tokens_out)} tok</Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex gap="2">
                        <Button
                          size="1"
                          variant="soft"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowAnnotationPanel(false);
                            setDetailTrace(trace);
                          }}
                        >
                          <Eye size={14} style={{ marginRight: 4 }} />
                          View
                        </Button>
                        <Button
                          size="1"
                          variant="soft"
                          color={annotatedTraces.has(trace.id) ? "green" : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowAnnotationPanel(true);
                            setDetailTrace(trace);
                          }}
                        >
                          <Edit size={14} style={{ marginRight: 4 }} />
                          Annotate
                        </Button>
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        )}

        {/* Run Task Dialog */}
        <Dialog.Root open={runTaskDialogOpen} onOpenChange={(open) => {
          setRunTaskDialogOpen(open);
          if (!open) { setRunTaskError(null); }
        }}>
          <Dialog.Content style={{ maxWidth: 500 }}>
            <Dialog.Title>Run Task in Production</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              Execute a task against your agent and store the result as a production trace.
              This may take several minutes for browser automation tasks.
            </Dialog.Description>

            <Flex direction="column" gap="3">
              <Box>
                <Text as="label" size="2" weight="bold">Agent *</Text>
                <Select.Root value={runTaskAgent} onValueChange={setRunTaskAgent} disabled={runTaskLoading}>
                  <Select.Trigger placeholder="Select agent..." style={{ width: "100%", marginTop: 4 }} />
                  <Select.Content>
                    {agents.map(a => (
                      <Select.Item key={a.id} value={a.id}>{a.name}</Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Box>

              <Box>
                <Text as="label" size="2" weight="bold">Task Instructions *</Text>
                <textarea
                  value={runTaskInput}
                  onChange={(e) => setRunTaskInput(e.target.value)}
                  disabled={runTaskLoading}
                  placeholder='e.g. "Go to wikipedia.org and find the population of Japan"'
                  rows={4}
                  style={{
                    width: "100%", marginTop: 4, padding: "8px 12px",
                    borderRadius: 6, border: "1px solid var(--gray-6)",
                    fontFamily: "inherit", fontSize: 14, resize: "vertical",
                    backgroundColor: "var(--color-background)",
                  }}
                />
              </Box>

              {runTaskError && (
                <Flex align="center" gap="2" style={{ padding: "8px 12px", borderRadius: 6, backgroundColor: "var(--red-2)" }}>
                  <AlertTriangle size={16} color="var(--red-9)" />
                  <Text size="2" color="red">{runTaskError}</Text>
                </Flex>
              )}

              {runTaskLoading && (
                <Flex align="center" gap="2" style={{ padding: "12px", borderRadius: 6, backgroundColor: "var(--blue-2)" }}>
                  <Loader size={16} style={{ animation: "spin 1s linear infinite" }} />
                  <Text size="2" color="blue">Running task... this may take a few minutes.</Text>
                </Flex>
              )}
            </Flex>

            <Flex gap="3" mt="4" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray" disabled={runTaskLoading}>Cancel</Button>
              </Dialog.Close>
              <Button
                color="green"
                disabled={!runTaskAgent || !runTaskInput.trim() || runTaskLoading}
                onClick={async () => {
                  setRunTaskLoading(true);
                  setRunTaskError(null);
                  try {
                    const trace = await apiClient.runTaskInProduction(runTaskAgent, runTaskInput.trim());
                    setRunTaskDialogOpen(false);
                    setRunTaskInput("");
                    setRunTaskAgent("");
                    await fetchTraces();
                    // Auto-select the new trace in the detail panel
                    if (trace?.id) {
                      setDetailTrace(trace);
                    }
                  } catch (err: any) {
                    setRunTaskError(err.message || "Failed to run task");
                  } finally {
                    setRunTaskLoading(false);
                  }
                }}
              >
                {runTaskLoading ? (
                  <><Loader size={16} style={{ marginRight: 6, animation: "spin 1s linear infinite" }} /> Running...</>
                ) : (
                  <><Play size={16} style={{ marginRight: 6 }} /> Run Task</>
                )}
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>

        {/* Upload Dialog */}
        <Dialog.Root open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
          <Dialog.Content style={{ maxWidth: 450 }}>
            <Dialog.Title>Upload Production Traces</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              Upload a JSON or CSV file containing production traces. Each trace will be scanned for PII.
            </Dialog.Description>

            <Flex direction="column" gap="3">
              <Box>
                <Text as="label" size="2" weight="bold">Agent *</Text>
                <Select.Root value={uploadAgent} onValueChange={setUploadAgent}>
                  <Select.Trigger placeholder="Select agent..." style={{ width: "100%", marginTop: 4 }} />
                  <Select.Content>
                    {agents.map(a => (
                      <Select.Item key={a.id} value={a.id}>{a.name}</Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Box>

              <Box>
                <Text as="label" size="2" weight="bold">File *</Text>
                <input
                  type="file"
                  accept=".json,.csv"
                  onChange={handleUpload}
                  disabled={!uploadAgent || uploading}
                  style={{ marginTop: 4, width: "100%" }}
                />
                <Text size="1" color="gray" style={{ display: "block", marginTop: 4 }}>
                  JSON (array of traces) or CSV format
                </Text>
              </Box>
            </Flex>

            <Flex gap="3" mt="4" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>

        {/* Conversion Dialog */}
        <Dialog.Root open={conversionDialogOpen} onOpenChange={setConversionDialogOpen}>
          <Dialog.Content style={{ maxWidth: 500 }}>
            <Dialog.Title>Convert to Test Case</Dialog.Title>
            <Dialog.Description size="2" mb="4">
              Convert this annotated production trace into a test case and add it to a dataset.
              {detailTrace?.pii_detected && (
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

              {detailTrace && (
                <Box style={{ padding: 12, background: "var(--gray-2)", borderRadius: 8 }}>
                  <Text size="1" weight="bold" style={{ display: "block", marginBottom: 8 }}>
                    Preview:
                  </Text>
                  <Flex direction="column" gap="2">
                    <Flex justify="between">
                      <Text size="1" color="gray">Input:</Text>
                      <Text size="1" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {detailTrace.input.slice(0, 50)}...
                      </Text>
                    </Flex>
                    <Flex justify="between">
                      <Text size="1" color="gray">Expected Output:</Text>
                      <Text size="1" style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {detailTrace.output.slice(0, 50)}...
                      </Text>
                    </Flex>
                    {parseToolCalls(detailTrace.tool_calls).length > 0 && (
                      <Flex justify="between">
                        <Text size="1" color="gray">Tools Used:</Text>
                        <Text size="1">
                          {parseToolCalls(detailTrace.tool_calls).length} tool calls
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
        <Dialog.Root open={conversionSuccess} onOpenChange={setConversionSuccess}>
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
                <Button
                  style={{ flex: 1 }}
                  onClick={() => {
                    setConversionSuccess(false);
                    navigate("/annotations?tab=production");
                  }}
                >
                  View Annotations
                  <ArrowRight size={16} style={{ marginLeft: 6 }} />
                </Button>
              </Flex>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>

        {/* Detail Dialog */}
        {detailTrace && (
          <Dialog.Root open={!!detailTrace} onOpenChange={(open) => !open && setDetailTrace(null)}>
            <Dialog.Content style={{ maxWidth: 1200, maxHeight: "90vh" }}>
              <Dialog.Title>Trace Details</Dialog.Title>
              <Dialog.Description size="1" style={{ fontFamily: "monospace" }}>
                {detailTrace.id}
              </Dialog.Description>

              {/* Two-column layout: Content on left, Annotation on right */}
              <Flex gap="4" mt="4" style={{ maxHeight: "70vh" }}>
                {/* Left: Main content (scrollable) */}
                <ScrollArea style={{ flex: 1, minWidth: 0, maxHeight: "70vh" }}>
                  <Flex direction="column" gap="4" pr="3" style={{ overflow: "hidden" }}>
                  {/* Metadata */}
                  <Box>
                    <Text size="2" weight="bold" style={{ marginBottom: 8, display: "block" }}>Metadata</Text>
                    <Flex direction="column" gap="2">
                      <Flex justify="between">
                        <Text size="2" color="gray">Agent:</Text>
                        <Text size="2" weight="bold">{agentMap[detailTrace.agent_id]}</Text>
                      </Flex>
                      <Flex justify="between">
                        <Text size="2" color="gray">Model:</Text>
                        <Text size="2">{detailTrace.model || "—"}</Text>
                      </Flex>
                      <Flex justify="between">
                        <Text size="2" color="gray">Latency:</Text>
                        <Text size="2" style={{ fontFamily: "monospace" }}>{formatLatency(detailTrace.latency_ms)}</Text>
                      </Flex>
                      <Flex justify="between">
                        <Text size="2" color="gray">Tokens:</Text>
                        <Text size="2" style={{ fontFamily: "monospace" }}>{formatTokens(detailTrace.tokens_in, detailTrace.tokens_out)}</Text>
                      </Flex>
                    </Flex>
                  </Box>

                  {/* PII Warning */}
                  {detailTrace.pii_detected && (
                    <Card style={{ background: "var(--orange-3)", border: "1px solid var(--orange-6)" }}>
                      <Flex gap="2" align="center">
                        <AlertTriangle size={20} color="var(--orange-9)" />
                        <Box>
                          <Text size="2" weight="bold" color="orange">PII Detected</Text>
                          <Flex gap="1" mt="1">
                            {detailTrace.pii_flags.map(flag => (
                              <Badge key={flag} size="1">{flag}</Badge>
                            ))}
                          </Flex>
                        </Box>
                      </Flex>
                    </Card>
                  )}

                  {/* Input/Output */}
                  <Box>
                    <Text size="2" weight="bold" style={{ marginBottom: 8, display: "block" }}>Input</Text>
                    <Card style={{ background: "var(--gray-3)" }}>
                      <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                        {detailTrace.pii_detected
                          ? highlightPII(detailTrace.input, detailTrace.pii_flags)
                          : detailTrace.input
                        }
                      </Text>
                    </Card>
                  </Box>

                  <Box>
                    <Text size="2" weight="bold" style={{ marginBottom: 8, display: "block" }}>Output</Text>
                    <Card style={{ background: "var(--gray-3)" }}>
                      <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                        {detailTrace.pii_detected
                          ? highlightPII(detailTrace.output, detailTrace.pii_flags)
                          : detailTrace.output
                        }
                      </Text>
                    </Card>
                  </Box>

                  {/* Tool Calls */}
                  {parseToolCalls(detailTrace.tool_calls).length > 0 && (
                    <Box>
                      <Text size="2" weight="bold" style={{ marginBottom: 8, display: "block" }}>
                        Tool Calls ({parseToolCalls(detailTrace.tool_calls).length})
                      </Text>
                      <Flex direction="column" gap="2">
                        {parseToolCalls(detailTrace.tool_calls).map((call: any, idx: number) => {
                          const argsString = JSON.stringify(call.arguments, null, 2);
                          return (
                            <Card key={idx} style={{ background: "var(--gray-3)" }}>
                              <Text size="1" weight="bold" style={{ fontFamily: "monospace", display: "block", marginBottom: 4 }}>
                                {call.name}
                              </Text>
                              <Text size="1" color="gray" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", overflow: "hidden", display: "block", maxHeight: 200, overflowY: "auto" }}>
                                {detailTrace.pii_detected
                                  ? highlightPII(argsString, detailTrace.pii_flags)
                                  : argsString
                                }
                              </Text>
                            </Card>
                          );
                        })}
                      </Flex>
                    </Box>
                  )}
                  </Flex>
                </ScrollArea>

                {/* Right: Annotation Panel (fixed width) - Only shown when annotating */}
                {showAnnotationPanel && (
                  <Box style={{ width: 320, flexShrink: 0, borderLeft: "1px solid var(--gray-6)", paddingLeft: 16 }}>
                  <ScrollArea style={{ maxHeight: "70vh" }}>
                    <Flex direction="column" gap="3">
                      <Flex justify="between" align="center" style={{ marginBottom: 12 }}>
                        <Text size="2" weight="bold">Annotation</Text>
                        {annotationLoading && <Text size="1" color="gray">Loading...</Text>}
                      </Flex>
                      {/* Outcome (1-5 scale) */}
                      <Box>
                        <Text size="2" weight="medium" style={{ display: "block", marginBottom: 8, color: "var(--gray-11)" }}>
                          Correct?
                        </Text>
                        <Flex gap="2" wrap="wrap">
                          {[
                            { value: 5, label: "Yes", color: annotationColors.green, bg: annotationColors.greenBg },
                            { value: 4, label: "Mostly", color: annotationColors.green, bg: annotationColors.greenBg },
                            { value: 3, label: "Partly", color: annotationColors.amber, bg: annotationColors.amberBg },
                            { value: 2, label: "No", color: annotationColors.red, bg: annotationColors.redBg },
                            { value: 1, label: "Failed", color: annotationColors.red, bg: annotationColors.redBg },
                          ].map((o) => (
                            <Pill
                              key={o.value}
                              label={o.label}
                              selected={outcome === o.value}
                              color={o.color}
                              bg={o.bg}
                              onClick={() => setOutcome(o.value)}
                            />
                          ))}
                        </Flex>
                      </Box>

                      {/* Efficiency */}
                      <Box>
                        <Text size="2" weight="medium" style={{ display: "block", marginBottom: 8, color: "var(--gray-11)" }}>
                          Efficiency
                        </Text>
                        <Flex gap="2" wrap="wrap">
                          {[
                            { value: "efficient", color: annotationColors.green, bg: annotationColors.greenBg },
                            { value: "acceptable", color: annotationColors.amber, bg: annotationColors.amberBg },
                            { value: "wasteful", color: annotationColors.red, bg: annotationColors.redBg },
                          ].map((e) => (
                            <Pill
                              key={e.value}
                              label={e.value}
                              selected={efficiency === e.value}
                              color={e.color}
                              bg={e.bg}
                              onClick={() => setEfficiency(e.value)}
                            />
                          ))}
                        </Flex>
                      </Box>

                      {/* Testcase Candidate */}
                      <Box>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={testcaseCandidate}
                            onChange={(e) => setTestcaseCandidate(e.target.checked)}
                            style={{ width: 16, height: 16, cursor: "pointer" }}
                          />
                          <Flex align="center" gap="1">
                            <CheckCircle2 size={16} color={testcaseCandidate ? annotationColors.green : "var(--gray-9)"} />
                            <Text size="2" weight="medium">Test Case Candidate</Text>
                          </Flex>
                        </label>
                        <Text size="1" color="gray" style={{ display: "block", marginTop: 4, marginLeft: 24 }}>
                          Mark this trace for conversion into an evaluation test case
                        </Text>
                      </Box>

                      {/* Notes */}
                      <Box>
                        <Text as="label" size="2" weight="medium" style={{ display: "block", marginBottom: 4 }}>
                          Notes
                        </Text>
                        <textarea
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder="Add notes, observations, or issues..."
                          rows={4}
                          style={{
                            width: "100%",
                            padding: "8px",
                            fontFamily: "inherit",
                            fontSize: "14px",
                            borderRadius: "4px",
                            border: "1px solid var(--gray-7)",
                            backgroundColor: "var(--color-background)",
                            color: "var(--gray-12)",
                            resize: "vertical",
                          }}
                        />
                      </Box>

                      {/* Conversion Notes (if testcase candidate) */}
                      {testcaseCandidate && (
                        <Box>
                          <Text as="label" size="2" weight="medium" style={{ display: "block", marginBottom: 4 }}>
                            Conversion Notes
                          </Text>
                          <textarea
                            value={conversionNotes}
                            onChange={(e) => setConversionNotes(e.target.value)}
                            placeholder="Notes about converting this trace to a test case..."
                            rows={2}
                            style={{
                              width: "100%",
                              padding: "8px",
                              fontFamily: "inherit",
                              fontSize: "14px",
                              borderRadius: "4px",
                              border: "1px solid var(--gray-7)",
                              backgroundColor: "var(--color-background)",
                              color: "var(--gray-12)",
                              resize: "vertical",
                            }}
                          />
                        </Box>
                      )}
                    </Flex>
                  </ScrollArea>
                </Box>
                )}
              </Flex>

              {/* Action Buttons */}
              <Flex gap="3" mt="4" justify="between" align="center" wrap="wrap" style={{ borderTop: "1px solid var(--gray-5)", paddingTop: 12 }}>
                <Box>
                  {annotatedTraces.has(detailTrace.id) && (
                    <Button
                      variant="ghost"
                      size="1"
                      onClick={() => navigate("/annotations?tab=production")}
                    >
                      View in Annotations
                      <ArrowRight size={14} style={{ marginLeft: 4 }} />
                    </Button>
                  )}
                  {saveSuccess && (
                    <Text size="1" weight="bold" style={{ color: annotationColors.green }}>
                      ✓ Annotation saved
                    </Text>
                  )}
                </Box>
                <Flex gap="2" align="center">
                  <Dialog.Close>
                    <Button variant="soft" color="gray">Close</Button>
                  </Dialog.Close>
                  {!showAnnotationPanel && (
                    <Button
                      onClick={() => setShowAnnotationPanel(true)}
                      color={annotatedTraces.has(detailTrace.id) ? "green" : undefined}
                    >
                      <Edit size={16} style={{ marginRight: 6 }} />
                      {annotatedTraces.has(detailTrace.id) ? "View Annotation" : "Add Annotation"}
                    </Button>
                  )}
                  {showAnnotationPanel && (
                    <>
                      <Button
                        disabled={annotationLoading}
                        onClick={async () => {
                          if (!detailTrace) return;

                          setAnnotationLoading(true);
                          setSaveSuccess(false);
                          try {
                            const annotationData = {
                              trace_id: detailTrace.id,
                              outcome,
                              efficiency: efficiency || null,
                              issues,
                              notes: notes || null,
                              testcase_candidate: testcaseCandidate,
                              conversion_notes: conversionNotes || null,
                            };

                            await apiClient.upsertTraceAnnotation(detailTrace.id, annotationData);

                            setSaveSuccess(true);
                            setAnnotatedTraces(prev => new Set(prev).add(detailTrace.id));
                            fetchTraces();

                            setTimeout(() => setSaveSuccess(false), 5000);
                          } catch (err) {
                            console.error("Failed to save annotation:", err);
                            const errorMsg = err instanceof Error ? err.message : "Unknown error";
                            alert(`Failed to save annotation:\n\n${errorMsg}`);
                          } finally {
                            setAnnotationLoading(false);
                          }
                        }}
                      >
                        {annotationLoading ? "Saving..." : saveSuccess ? "✓ Saved!" : "Save Annotation"}
                      </Button>
                      {testcaseCandidate && (
                        <Button
                          color="blue"
                          disabled={!annotatedTraces.has(detailTrace.id)}
                          onClick={() => {
                            setConversionDialogOpen(true);
                          }}
                        >
                          <ArrowRight size={16} style={{ marginRight: 6 }} />
                          Convert to Test Case
                        </Button>
                      )}
                    </>
                  )}
                </Flex>
              </Flex>
            </Dialog.Content>
          </Dialog.Root>
        )}
      </Flex>
    </Box>
  );
}
