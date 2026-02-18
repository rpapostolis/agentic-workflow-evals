/**
 * HelpTooltip — Inline contextual help for domain-specific concepts.
 *
 * Renders a small "?" icon that shows a tooltip on hover with an
 * explanation of the concept.  Optionally links to the Eval Guide.
 */

import { useState, useRef, useEffect } from "react";
import { Question } from "@phosphor-icons/react";

export interface HelpTooltipProps {
  /** Short explanation of the concept (1–3 sentences) */
  text: string;
  /** Optional link path to the relevant guide section */
  guidePath?: string;
  /** Size of the icon (default 14) */
  size?: number;
}

export function HelpTooltip({ text, guidePath, size = 14 }: HelpTooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(true);
  };

  const hide = () => {
    timerRef.current = setTimeout(() => setVisible(false), 150);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label="More information"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size + 6,
          height: size + 6,
          borderRadius: "50%",
          cursor: "help",
          color: "var(--muted-foreground)",
          transition: "color 0.15s, background 0.15s",
          background: visible ? "var(--accent)" : "transparent",
        }}
      >
        <Question size={size} weight="bold" />
      </span>
      {visible && (
        <div
          ref={tooltipRef}
          onMouseEnter={show}
          onMouseLeave={hide}
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "10px 14px",
            width: 280,
            boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            zIndex: 9999,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--foreground)",
          }}
        >
          {text}
          {guidePath && (
            <a
              href={guidePath}
              style={{
                display: "block",
                marginTop: 6,
                fontSize: 11,
                color: "var(--blue-9, #58a6ff)",
                textDecoration: "none",
              }}
            >
              Learn more in the Eval Guide &rarr;
            </a>
          )}
          {/* Arrow */}
          <div
            style={{
              position: "absolute",
              bottom: -5,
              left: "50%",
              transform: "translateX(-50%) rotate(45deg)",
              width: 10,
              height: 10,
              background: "var(--card)",
              borderRight: "1px solid var(--border)",
              borderBottom: "1px solid var(--border)",
            }}
          />
        </div>
      )}
    </span>
  );
}
