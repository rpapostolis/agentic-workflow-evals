import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FileText, CircleNotch, DotsThree, Trash, Plus, Upload, DownloadSimple } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useDatasets } from "@/hooks/useDatasets";
import { apiClient } from "@/lib/api";
import { FolderOpen } from "@phosphor-icons/react";
import { DataTable, TableColumn } from "@/components/shared/DataTable";
import { SearchFilterControls } from "@/components/shared/SearchFilterControls";
import { NoDataCard } from "@/components/shared/NoDataCard";
import { HelpTooltip } from "@/components/shared/HelpTooltip";
import { useTableState } from "@/hooks/useTableState";

export function DatasetsPage() {
	const navigate = useNavigate();
	const { datasets, loading, error, refetch } = useDatasets();
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [datasetToDelete, setDatasetToDelete] = useState<any>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Create Dataset Dialog
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createGoal, setCreateGoal] = useState("");
	const [createDomain, setCreateDomain] = useState("");
	const [isCreatingDataset, setIsCreatingDataset] = useState(false);

	// Import Dataset Dialog
	const [importDialogOpen, setImportDialogOpen] = useState(false);
	const [isImportingDataset, setIsImportingDataset] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const {
		searchTerm,
		setSearchTerm,
		sortOrder,
		handleSort,
		filteredData: filteredDatasets,
	} = useTableState({
		data: datasets,
		customSearchFunction: (dataset, searchTerm) => dataset.seed?.name?.toLowerCase().includes(searchTerm.toLowerCase()) || false,
		customSortFunction: (a, b, sortOrder) => {
			const aName = a.seed?.name?.toLowerCase() || "";
			const bName = b.seed?.name?.toLowerCase() || "";
			const comparison = aName.localeCompare(bName);
			return sortOrder === "asc" ? comparison : -comparison;
		},
	});

	const columns: TableColumn[] = [
		{
			key: "name",
			header: "Dataset name",
			width: "60%",
			minWidth: "250px",
			render: (dataset: any) => (
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: "2px",
						paddingRight: "16.0%",
						boxSizing: "border-box",
					}}
				>
					<div style={{ fontWeight: 600, fontSize: "14px" }}>{dataset.seed.name}</div>
					<div
						style={{
							fontSize: "12px",
							color: "var(--muted-foreground)",
							display: "-webkit-box",
							WebkitLineClamp: 2,
							WebkitBoxOrient: "vertical",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{dataset.seed.goal}
					</div>
				</div>
			),
		},
		{
			key: "created",
			header: "Created",
			width: "15%",
			minWidth: "120px",
			render: (dataset: any) => new Date(dataset.metadata?.created_at || dataset.created_at).toLocaleDateString(),
		},
		{
			key: "testCases",
			header: "Test cases",
			width: "20%",
			minWidth: "140px",
			render: (dataset: any) => {
				const testCasesCount = dataset.test_case_ids?.length || 0;
				return (
					<Badge variant="secondary" className="text-xs">
						{testCasesCount} test cases
					</Badge>
				);
			},
		},
		{
			key: "actions",
			header: "",
			width: "5%",
			minWidth: "60px",
			render: (dataset: any) => (
				<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm" onClick={(e) => e.stopPropagation()}>
								<DotsThree size={16} />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onClick={(e) => {
									e.stopPropagation();
									handleOpenDataset(dataset);
								}}
							>
								<FolderOpen size={16} className="mr-2" />
								Open Dataset
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={(e) => {
									e.stopPropagation();
									handleDeleteDataset(dataset);
								}}
								variant="destructive"
							>
								<Trash size={16} className="mr-2" />
								Delete Dataset
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			),
		},
	];

	const handleOpenDataset = (dataset: any) => {
		navigate(`/datasets/${dataset.id}`);
	};

	const handleDeleteDataset = (dataset: any) => {
		setDatasetToDelete(dataset);
		// Delay opening the dialog until the DropdownMenu has fully closed.
		// With modal={false}, the dropdown's close event fires an "interact outside"
		// on the AlertDialog which immediately closes it if opened synchronously.
		requestAnimationFrame(() => setDeleteDialogOpen(true));
	};

	const confirmDeleteDataset = async () => {
		if (!datasetToDelete) return;

		setIsDeleting(true);
		try {
			await apiClient.deleteDataset(datasetToDelete.id);
			toast.success("Dataset deleted successfully");
			setDeleteDialogOpen(false);
			setDatasetToDelete(null);
			refetch();
		} catch (error) {
			console.error("Error deleting dataset:", error);
			toast.error("Failed to delete dataset");
		} finally {
			setIsDeleting(false);
		}
	};

	const handleCreateDataset = async () => {
		if (!createName.trim() || !createGoal.trim()) {
			toast.error("Name and Goal are required");
			return;
		}

		setIsCreatingDataset(true);
		try {
			await apiClient.createDatasetUI({
				name: createName.trim(),
				goal: createGoal.trim(),
				synthetic_domain: createDomain.trim() || undefined,
			});
			toast.success("Dataset created successfully");
			setCreateDialogOpen(false);
			setCreateName("");
			setCreateGoal("");
			setCreateDomain("");
			refetch();
		} catch (error) {
			console.error("Error creating dataset:", error);
			toast.error("Failed to create dataset");
		} finally {
			setIsCreatingDataset(false);
		}
	};

	const handleImportDataset = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file) return;

		if (!file.name.endsWith(".json")) {
			toast.error("Only JSON files are supported");
			return;
		}

		setIsImportingDataset(true);
		try {
			const content = await file.text();
			const jsonData = JSON.parse(content);
			await apiClient.importDataset(jsonData);
			toast.success("Dataset imported successfully");
			setImportDialogOpen(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
			refetch();
		} catch (error) {
			console.error("Error importing dataset:", error);
			if (error instanceof SyntaxError) {
				toast.error("Invalid JSON file");
			} else {
				toast.error("Failed to import dataset");
			}
		} finally {
			setIsImportingDataset(false);
		}
	};

	const handleDownloadTemplate = () => {
		const template = {
			id: "dataset_example_001",
			metadata: {
				generator_id: "manual",
				suite_id: "my_test_suite",
				created_at: new Date().toISOString(),
				version: "1.0",
				schema_hash: ""
			},
			seed: {
				name: "Customer Support Agent Tests",
				goal: "Evaluate a customer support agent that handles order inquiries, refunds, and product questions",
				synthetic_domain: "e-commerce",
				input: {}
			},
			test_cases: [
				{
					id: "tc_order_status_001",
					dataset_id: "dataset_example_001",
					name: "Order Status Lookup",
					description: "Customer asks about the status of their recent order",
					input: "Hi, I placed an order (#ORD-7890) two days ago. Can you tell me where it is?",
					expected_response: "The agent should look up order #ORD-7890 and provide the current shipping status with an estimated delivery date.",
					response_quality_expectation: {
						assertion: "Response should be polite, include the order number, and provide a clear status update"
					},
					behavior_assertions: [
						{ assertion: "The agent should look up order ORD-7890 before responding" }
					],
					assertion_mode: "hybrid",
					references_seed: {},
					is_holdout: false
				},
				{
					id: "tc_refund_request_002",
					dataset_id: "dataset_example_001",
					name: "Refund Request",
					description: "Customer requests a refund for a defective product",
					input: "I received my order but the item is broken. I'd like a refund for order #ORD-4521.",
					expected_response: "The agent should acknowledge the defective item, look up the order, and initiate a refund process.",
					response_quality_expectation: {
						assertion: "Response should be empathetic, confirm the refund will be processed, and provide a timeframe"
					},
					behavior_assertions: [
						{ assertion: "The agent should look up order ORD-4521" },
						{ assertion: "The agent should initiate a refund for the defective item" }
					],
					assertion_mode: "hybrid",
					references_seed: {},
					is_holdout: false
				},
				{
					id: "tc_product_question_003",
					dataset_id: "dataset_example_001",
					name: "Product Information Question",
					description: "Customer asks about product specifications before purchasing",
					input: "Does the UltraWidget Pro come in blue, and is it compatible with the Widget Dock v2?",
					expected_response: "The agent should search the product catalog and provide accurate color options and compatibility information.",
					response_quality_expectation: null,
					behavior_assertions: [
						{ assertion: "The agent should search for UltraWidget Pro product information" }
					],
					assertion_mode: "hybrid",
					references_seed: {},
					is_holdout: false
				}
			]
		};

		const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "dataset-template.json";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh]">
				<CircleNotch size={48} className="animate-spin text-primary mb-4" />
				<p className="text-muted-foreground">Loading evaluation datasets...</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-bold tracking-tight">Evaluation Datasets</h1>
						<p className="text-muted-foreground mt-1">Manage test datasets and evaluation criteria for AI agents</p>
					</div>
				</div>
				<NoDataCard
					icon={<FileText size={48} className="text-muted-foreground mb-4" />}
					title="Failed to load datasets"
					description={`Please try again later. ${error}`}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold tracking-tight">
						Evaluation Datasets{" "}
						<HelpTooltip
							text="A dataset is a collection of test cases that define how your agent should behave. Each test case has an input prompt, expected tool calls with assertions, and optional response quality checks. Mark test cases as holdout to use them for regression detection only."
							guidePath="/guide"
							size={16}
						/>
					</h1>
					<p className="text-muted-foreground mt-1">Manage test suites for evaluating AI agent capabilities</p>
				</div>
				<div className="flex gap-2">
					<Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
						<Button onClick={() => setCreateDialogOpen(true)} className="gap-2">
							<Plus size={16} />
							Create Dataset
						</Button>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Create New Dataset</DialogTitle>
								<DialogDescription>
									Create a new evaluation dataset with a name, goal, and optional domain.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="dataset-name">Name *</Label>
									<Input
										id="dataset-name"
										placeholder="e.g., Customer Support Agent Tests"
										value={createName}
										onChange={(e) => setCreateName(e.target.value)}
										disabled={isCreatingDataset}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="dataset-goal">Goal *</Label>
									<Textarea
										id="dataset-goal"
										placeholder="Describe the purpose of this dataset..."
										value={createGoal}
										onChange={(e) => setCreateGoal(e.target.value)}
										disabled={isCreatingDataset}
										rows={4}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="dataset-domain">Domain (optional)</Label>
									<Input
										id="dataset-domain"
										placeholder="e.g., customer-support"
										value={createDomain}
										onChange={(e) => setCreateDomain(e.target.value)}
										disabled={isCreatingDataset}
									/>
								</div>
							</div>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => setCreateDialogOpen(false)}
									disabled={isCreatingDataset}
								>
									Cancel
								</Button>
								<Button
									onClick={handleCreateDataset}
									disabled={isCreatingDataset || !createName.trim() || !createGoal.trim()}
								>
									{isCreatingDataset ? (
										<>
											<CircleNotch size={16} className="animate-spin mr-2" />
											Creating...
										</>
									) : (
										"Create Dataset"
									)}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>

					<Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
						<Button onClick={() => setImportDialogOpen(true)} variant="outline" className="gap-2">
							<Upload size={16} />
							Import Dataset
						</Button>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Import Dataset</DialogTitle>
								<DialogDescription>
									Upload a JSON file containing your dataset definition with test cases.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-4">
								<div className="flex items-center justify-center w-full">
									<label
										htmlFor="file-input"
										className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer bg-muted/50 hover:bg-muted transition-colors"
									>
										<div className="flex flex-col items-center justify-center pt-5 pb-6">
											<FileText size={32} className="text-muted-foreground mb-2" />
											<p className="text-sm font-semibold text-muted-foreground">Click to select JSON file</p>
											<p className="text-xs text-muted-foreground mt-1">or drag and drop</p>
										</div>
										<input
											ref={fileInputRef}
											id="file-input"
											type="file"
											accept=".json"
											onChange={handleImportDataset}
											disabled={isImportingDataset}
											className="hidden"
										/>
									</label>
								</div>
								<div className="flex items-center gap-2 px-1">
									<button
										onClick={handleDownloadTemplate}
										className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer underline underline-offset-2"
										type="button"
									>
										<DownloadSimple size={14} />
										Download template with sample data
									</button>
									<span className="text-xs text-muted-foreground">&mdash; edit and import back</span>
								</div>
							</div>
							<DialogFooter>
								<Button
									variant="outline"
									onClick={() => setImportDialogOpen(false)}
									disabled={isImportingDataset}
								>
									Cancel
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</div>
			</div>

			{datasets.length === 0 ? (
				<NoDataCard
					icon={
						<div className="bg-muted rounded-full p-6 mb-6">
							<FileText size={48} className="text-muted-foreground" />
						</div>
					}
					title="No datasets yet"
					description="Datasets define the test cases your agent will be evaluated against. Create one from scratch or import a JSON file to get started."
					action={
						<div className="flex gap-2">
							<Button onClick={() => setCreateDialogOpen(true)} className="gap-2">
								<Plus size={16} />
								Create Your First Dataset
							</Button>
							<Button onClick={() => setImportDialogOpen(true)} variant="outline" className="gap-2">
								<Upload size={16} />
								Import JSON
							</Button>
						</div>
					}
				/>
			) : (
				<>
					<SearchFilterControls
						searchValue={searchTerm}
						onSearchChange={setSearchTerm}
						searchPlaceholder="Search datasets"
						filters={[]}
						sortOrder={sortOrder}
						onSortChange={handleSort}
						sortLabel="Sort"
					/>
					<DataTable
						columns={columns}
						data={filteredDatasets}
						onRowClick={(dataset) => navigate(`/datasets/${dataset.id}`)}
						emptyState={
							<NoDataCard
								icon={<FileText size={48} className="text-muted-foreground mb-4" />}
								title={`No datasets found matching "${searchTerm}"`}
								description="Try adjusting your search terms"
							/>
						}
					/>
				</>
			)}

			{/* Delete Dataset Confirmation */}
			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Dataset</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete "{datasetToDelete?.seed?.name}"? This action cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							onClick={() => {
								setDeleteDialogOpen(false);
								setDatasetToDelete(null);
							}}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={confirmDeleteDataset}
							disabled={isDeleting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isDeleting ? (
								<>
									<CircleNotch size={16} className="animate-spin mr-2" />
									Deleting...
								</>
							) : (
								"Delete Dataset"
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
