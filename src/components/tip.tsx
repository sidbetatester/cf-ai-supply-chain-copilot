import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@cloudflare/kumo";

/**
 * Hover and keyboard-focus hint for a clickable element. The trigger is a
 * wrapper so the hint also shows on disabled controls (which get no pointer
 * events), where it explains why the control is unavailable.
 */
export function Tip({
  content,
  children,
  side = "top",
  block = false
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  /** Full-width trigger, for rows and list items. */
  block?: boolean;
}) {
  return (
    <Tooltip
      content={content}
      side={side}
      delay={400}
      render={
        <span className={block ? "flex w-full min-w-0" : "inline-flex"} />
      }
    >
      {children}
    </Tooltip>
  );
}
