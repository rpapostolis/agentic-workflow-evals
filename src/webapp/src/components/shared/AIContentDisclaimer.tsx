import { Warning } from "@phosphor-icons/react";

interface AIContentDisclaimerProps {
  className?: string;
  iconSize?: string;
  textSize?: string;
}

export function AIContentDisclaimer({
  className = "flex items-center gap-2 mt-1",
  iconSize = "14px",
  textSize = "text-xs",
}: AIContentDisclaimerProps) {
  return (
    <div className={className}>
      <Warning
        className="text-gray-500"
        size={parseInt(iconSize)}
      />
      <p className={`${textSize} text-muted-foreground`}>
        AI generated content may be incorrect
      </p>
    </div>
  );
}
