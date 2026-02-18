import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Box,
  Flex,
  Text,
  IconButton,
  Tooltip,
  ScrollArea,
} from "@radix-ui/themes";
import {
  Robot,
  Database,
  Flask,
  ChartBar,
  CaretLeft,
  CaretRight,
  Sparkle,
  PencilSimple,
  BookOpen,
  Flask as FlaskConical,
  CheckSquare,
  Play,
  Scales,
  WarningCircle,
  ListNumbers,
  Pulse,
} from "@phosphor-icons/react";
import { NotePencil, Sun, Moon, ListChecks } from "@phosphor-icons/react";
import { useDemoMode } from "@/contexts/DemoModeContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useGuideSidecar } from "@/contexts/GuideSidecarContext";

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<any>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "",
    items: [{ path: "/analytics", label: "Analytics", icon: ChartBar }],
  },
  {
    title: "Evaluate",
    items: [
      { path: "/evaluations", label: "Evaluations", icon: Play },
      { path: "/annotations", label: "Annotations", icon: CheckSquare },
      { path: "/prompt-lab", label: "Prompt Lab", icon: Sparkle },
    ],
  },
  {
    title: "Production",
    items: [
      { path: "/production-traces", label: "Traces", icon: Pulse },
    ],
  },
  {
    title: "Setup",
    items: [
      { path: "/agents", label: "Agents", icon: Robot },
      { path: "/datasets", label: "Datasets", icon: Database },
      { path: "/judge-config", label: "Judge Config", icon: Scales },
    ],
  },
  {
    title: "Learn",
    items: [{ path: "/guide", label: "Eval Guide", icon: BookOpen }],
  },
];

export function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(true);
  const { isDemoMode, isToggling, toggleDemoMode } = useDemoMode();
  const { resolved: theme, toggle: toggleTheme } = useTheme();
  const { isOpen: guideOpen, toggle: toggleGuide } = useGuideSidecar();

  const isActive = (path: string) => {
    if (path === "/analytics")
      return (
        location.pathname === "/analytics" ||
        location.pathname === "/" ||
        location.pathname === "/dashboard"
      );
    if (path === "/prompt-lab") return location.pathname.includes("/prompts");
    if (path === "/agents")
      return (
        location.pathname.startsWith("/agents") &&
        !location.pathname.includes("/prompts")
      );
    if (path === "/annotations")
      return location.pathname.startsWith("/annotations");
    return location.pathname.startsWith(path);
  };

  if (!isOpen) {
    return (
      <Box position="fixed" top="3" left="3" style={{ zIndex: 1000 }}>
        <Tooltip content="Open Navigation">
          <IconButton
            variant="surface"
            onClick={() => setIsOpen(true)}
            style={{ cursor: "pointer" }}
          >
            <CaretRight size={16} />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box
      style={{
        width: 220,
        background: "var(--card)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="between"
        px="3"
        py="3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Flex align="center" gap="2">
          <img
            src="/images/agenteval.svg"
            alt="AgentEval"
            style={{ width: 28, height: 28, borderRadius: 6 }}
          />
          <Text size="2" weight="bold" style={{ color: "var(--foreground)" }}>
            AgentEval
          </Text>
        </Flex>
        <Flex align="center" gap="1">
          <Tooltip content="Close Navigation">
            <IconButton
              variant="ghost"
              size="1"
              onClick={() => setIsOpen(false)}
              style={{ cursor: "pointer" }}
            >
              <CaretLeft size={14} />
            </IconButton>
          </Tooltip>
        </Flex>
      </Flex>

      {/* Nav Items */}
      <ScrollArea style={{ flex: 1 }}>
        <Flex direction="column" p="2" gap="1">
          {NAV_SECTIONS.map((section, si) => (
            <div key={section.title || si}>
              {section.title && (
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1.4,
                    textTransform: "uppercase",
                    color: "var(--muted-foreground)",
                    padding: "12px 12px 4px",
                    opacity: 0.6,
                  }}
                >
                  {section.title}
                </div>
              )}
              {section.items.map((item) => {
                const active = isActive(item.path);
                const Icon = item.icon;
                return (
                  <Box
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: active ? "var(--accent)" : "transparent",
                      color: active
                        ? "var(--foreground)"
                        : "var(--muted-foreground)",
                      fontSize: 13,
                      fontWeight: active ? 500 : 400,
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
                      if (!active)
                        (e.currentTarget as HTMLDivElement).style.background =
                          "var(--accent)";
                    }}
                    onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
                      if (!active)
                        (e.currentTarget as HTMLDivElement).style.background =
                          "transparent";
                    }}
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </Box>
                );
              })}
            </div>
          ))}
        </Flex>
      </ScrollArea>

      {/* Footer */}
      <Box p="3" style={{ borderTop: "1px solid var(--border)" }}>
        {/* E2E Guide Toggle */}
        <Flex
          align="center"
          gap="2"
          px="2"
          py="2"
          mb="2"
          onClick={toggleGuide}
          style={{
            borderRadius: 6,
            cursor: "pointer",
            background: guideOpen ? "rgba(59, 130, 246, 0.15)" : "transparent",
            border: guideOpen ? "1px solid rgba(59, 130, 246, 0.3)" : "1px solid transparent",
            transition: "all 0.2s",
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!guideOpen)
              (e.currentTarget as HTMLDivElement).style.background = "var(--accent)";
          }}
          onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!guideOpen)
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        >
          <ListChecks size={13} weight={guideOpen ? "fill" : "regular"}
            style={{ color: guideOpen ? "var(--blue-9)" : "var(--muted-foreground)" }}
          />
          <span style={{
            fontSize: 12,
            fontWeight: guideOpen ? 500 : 400,
            color: guideOpen ? "var(--blue-9)" : "var(--muted-foreground)",
          }}>
            E2E Guide
          </span>
          <span style={{
            marginLeft: "auto",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 0.5,
            padding: "2px 6px",
            borderRadius: 4,
            background: guideOpen ? "rgba(59, 130, 246, 0.2)" : "var(--accent)",
            color: guideOpen ? "var(--blue-9)" : "var(--muted-foreground)",
          }}>
            {guideOpen ? "ON" : "OFF"}
          </span>
        </Flex>

        {/* Theme Toggle */}
        <Flex
          align="center"
          gap="2"
          px="2"
          py="2"
          mb="2"
          onClick={toggleTheme}
          style={{
            borderRadius: 6,
            cursor: "pointer",
            background: "transparent",
            transition: "all 0.2s",
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
            (e.currentTarget as HTMLDivElement).style.background = "var(--accent)";
          }}
          onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
            (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        >
          {theme === "dark" ? (
            <Moon size={13} style={{ color: "var(--muted-foreground)" }} />
          ) : (
            <Sun size={13} weight="fill" style={{ color: "#ca8a04" }} />
          )}
          <span style={{
            fontSize: 12,
            fontWeight: 400,
            color: "var(--muted-foreground)",
          }}>
            {theme === "dark" ? "Dark" : "Light"} Mode
          </span>
          <span style={{
            marginLeft: "auto",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 0.5,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--accent)",
            color: "var(--muted-foreground)",
          }}>
            {theme === "dark" ? "DARK" : "LIGHT"}
          </span>
        </Flex>

        {/* Demo Mode Toggle */}
        <Flex
          align="center"
          gap="2"
          px="2"
          py="2"
          mb="2"
          onClick={isToggling ? undefined : toggleDemoMode}
          style={{
            borderRadius: 6,
            cursor: isToggling ? "wait" : "pointer",
            background: isDemoMode ? "rgba(59, 130, 246, 0.15)" : "transparent",
            border: isDemoMode ? "1px solid rgba(59, 130, 246, 0.3)" : "1px solid transparent",
            transition: "all 0.2s",
            opacity: isToggling ? 0.5 : 1,
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!isDemoMode)
              (e.currentTarget as HTMLDivElement).style.background = "var(--accent)";
          }}
          onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!isDemoMode)
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
          }}
        >
          <Play size={13} weight={isDemoMode ? "fill" : "regular"}
            style={{ color: isDemoMode ? "var(--blue-9)" : "var(--muted-foreground)" }}
          />
          <span style={{
            fontSize: 12,
            fontWeight: isDemoMode ? 500 : 400,
            color: isDemoMode ? "var(--blue-9)" : "var(--muted-foreground)",
          }}>
            {isToggling ? "Loading..." : "Demo Mode"}
          </span>
          <span style={{
            marginLeft: "auto",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: 0.5,
            padding: "2px 6px",
            borderRadius: 4,
            background: isDemoMode ? "rgba(59, 130, 246, 0.2)" : "var(--accent)",
            color: isDemoMode ? "var(--blue-9)" : "var(--muted-foreground)",
          }}>
            {isDemoMode ? "ON" : "OFF"}
          </span>
        </Flex>

      </Box>
    </Box>
  );
}
