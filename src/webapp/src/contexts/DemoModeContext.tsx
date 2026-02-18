import {
	createContext,
	useContext,
	useState,
	useCallback,
	ReactNode,
} from "react";
import { API_BASE_URL } from "@/lib/config";
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
import { CircleNotch, Play, Stop } from "@phosphor-icons/react";

const STORAGE_KEY = "agenteval_demo_mode";

interface DemoModeContextType {
	isDemoMode: boolean;
	isToggling: boolean;
	toggleDemoMode: () => void;
}

const DemoModeContext = createContext<DemoModeContextType>({
	isDemoMode: false,
	isToggling: false,
	toggleDemoMode: () => {},
});

export function DemoModeProvider({ children }: { children: ReactNode }) {
	const [isDemoMode, setIsDemoMode] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) === "true";
		} catch {
			return false;
		}
	});
	const [isToggling, setIsToggling] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogAction, setDialogAction] = useState<"on" | "off">("on");

	const toggleDemoMode = useCallback(() => {
		setDialogAction(isDemoMode ? "off" : "on");
		setDialogOpen(true);
	}, [isDemoMode]);

	const handleConfirm = useCallback(async () => {
		setDialogOpen(false);
		setIsToggling(true);

		try {
			if (dialogAction === "on") {
				// Turning ON: clear + seed
				const resetRes = await fetch(`${API_BASE_URL}/admin/reset`, {
					method: "DELETE",
				});
				if (!resetRes.ok)
					throw new Error(`Reset failed: ${resetRes.statusText}`);

				const seedRes = await fetch(`${API_BASE_URL}/admin/seed-demo`, {
					method: "POST",
				});
				if (!seedRes.ok)
					throw new Error(`Seed failed: ${seedRes.statusText}`);

				localStorage.setItem(STORAGE_KEY, "true");
				setIsDemoMode(true);
			} else {
				// Turning OFF: clear
				const resetRes = await fetch(`${API_BASE_URL}/admin/reset`, {
					method: "DELETE",
				});
				if (!resetRes.ok)
					throw new Error(`Reset failed: ${resetRes.statusText}`);

				localStorage.setItem(STORAGE_KEY, "false");
				setIsDemoMode(false);
			}

			// Reload to refresh all data
			window.location.reload();
		} catch (err) {
			console.error("Demo mode toggle failed:", err);
			alert(
				`Failed: ${err instanceof Error ? err.message : "Unknown error"}`
			);
			setIsToggling(false);
		}
	}, [dialogAction]);

	return (
		<DemoModeContext.Provider
			value={{ isDemoMode, isToggling, toggleDemoMode }}
		>
			{children}

			<AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<AlertDialogContent
					style={{
						background: "var(--card)",
						border: "1px solid var(--border)",
						maxWidth: 440,
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle
							style={{
								display: "flex",
								alignItems: "center",
								gap: 10,
								fontSize: 16,
							}}
						>
							{dialogAction === "on" ? (
								<>
									<Play
										size={18}
										weight="fill"
										style={{ color: "var(--blue-9)" }}
									/>
									Enter Demo Mode
								</>
							) : (
								<>
									<Stop
										size={18}
										weight="fill"
										style={{ color: "var(--muted-foreground)" }}
									/>
									Exit Demo Mode
								</>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription
							style={{
								color: "var(--muted-foreground)",
								fontSize: 13,
								lineHeight: 1.6,
								marginTop: 4,
							}}
						>
							{dialogAction === "on"
								? "This will clear all existing data and load a supply-chain demo dataset with 10 agents, 3 datasets, 26 test cases, and ~47 evaluations with full annotations."
								: "This will clear all demo data and return to a clean slate. You can re-enter demo mode at any time."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter style={{ marginTop: 8 }}>
						<AlertDialogCancel
							style={{
								background: "transparent",
								border: "1px solid var(--border)",
								color: "var(--muted-foreground)",
								cursor: "pointer",
							}}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirm}
							disabled={isToggling}
							style={{
								background:
									dialogAction === "on"
										? "var(--blue-9)"
										: "var(--destructive)",
								color: "white",
								cursor: isToggling ? "wait" : "pointer",
								display: "flex",
								alignItems: "center",
								gap: 6,
							}}
						>
							{isToggling ? (
								<>
									<CircleNotch
										size={14}
										className="animate-spin"
									/>
									Loading…
								</>
							) : dialogAction === "on" ? (
								"Load Demo Data"
							) : (
								"Clear & Exit"
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</DemoModeContext.Provider>
	);
}

export function useDemoMode() {
	return useContext(DemoModeContext);
}
