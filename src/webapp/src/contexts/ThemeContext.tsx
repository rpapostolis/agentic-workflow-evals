import {
	createContext,
	useContext,
	useState,
	useEffect,
	useCallback,
	ReactNode,
} from "react";

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "agenteval_theme";

interface ThemeContextType {
	mode: ThemeMode;
	resolved: ResolvedTheme;
	setMode: (mode: ThemeMode) => void;
	toggle: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
	mode: "dark",
	resolved: "dark",
	setMode: () => {},
	toggle: () => {},
});

function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
	if (mode === "system") return getSystemTheme();
	return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [mode, setModeState] = useState<ThemeMode>(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored === "light" || stored === "dark" || stored === "system") {
				return stored;
			}
		} catch {}
		return "dark";
	});

	const [resolved, setResolved] = useState<ResolvedTheme>(() =>
		resolveTheme(mode)
	);

	// Apply theme class to document
	useEffect(() => {
		const r = resolveTheme(mode);
		setResolved(r);

		const root = document.documentElement;
		if (r === "dark") {
			root.classList.add("dark");
		} else {
			root.classList.remove("dark");
		}
	}, [mode]);

	// Listen for system theme changes when in "system" mode
	useEffect(() => {
		if (mode !== "system") return;

		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = () => {
			const r = resolveTheme("system");
			setResolved(r);
			if (r === "dark") {
				document.documentElement.classList.add("dark");
			} else {
				document.documentElement.classList.remove("dark");
			}
		};

		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, [mode]);

	const setMode = useCallback((newMode: ThemeMode) => {
		setModeState(newMode);
		try {
			localStorage.setItem(STORAGE_KEY, newMode);
		} catch {}
	}, []);

	const toggle = useCallback(() => {
		setModeState((prev) => {
			const next = resolveTheme(prev) === "dark" ? "light" : "dark";
			try {
				localStorage.setItem(STORAGE_KEY, next);
			} catch {}
			return next;
		});
	}, []);

	return (
		<ThemeContext.Provider value={{ mode, resolved, setMode, toggle }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	return useContext(ThemeContext);
}
