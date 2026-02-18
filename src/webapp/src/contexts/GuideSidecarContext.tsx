import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface GuideSidecarState {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

const GuideSidecarContext = createContext<GuideSidecarState>({
  isOpen: false,
  toggle: () => {},
  open: () => {},
  close: () => {},
});

export function GuideSidecarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(() => {
    try {
      return localStorage.getItem("eva-guide-panel-open") === "true";
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem("eva-guide-panel-open", String(next)); } catch {}
      return next;
    });
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    try { localStorage.setItem("eva-guide-panel-open", "true"); } catch {}
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    try { localStorage.setItem("eva-guide-panel-open", "false"); } catch {}
  }, []);

  return (
    <GuideSidecarContext.Provider value={{ isOpen, toggle, open, close }}>
      {children}
    </GuideSidecarContext.Provider>
  );
}

export function useGuideSidecar() {
  return useContext(GuideSidecarContext);
}
