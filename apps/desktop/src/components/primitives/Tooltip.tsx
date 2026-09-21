import type { ReactElement } from "react";
import { Tooltip as FluentTooltip } from "@fluentui/react-components";

/**
 * HsTooltip — thin wrapper over Fluent v9 Tooltip.
 *
 * - `content` is a required string: tooltips are Japanese copy from
 *   strings/ja.ts, never English fallback (JAPANESE_UI_COPY §9).
 * - `relationship` defaults to "label" so the tooltip doubles as the
 *   accessible name of the wrapped control.
 * - `visible` (Fluent prop) is exposed for the dev gallery, which pins a
 *   tooltip open as a visual-regression fixture.
 */
export interface HsTooltipProps {
  content: string;
  relationship?: "label" | "description" | "inaccessible";
  positioning?: "above" | "below" | "before" | "after";
  /** Pin the tooltip open (gallery fixtures only — not for product UI). */
  visible?: boolean;
  /** Mount the tooltip surface into this node (gallery fixture cells). */
  mountNode?: HTMLElement | null;
  children: ReactElement;
}

export function HsTooltip({
  content,
  relationship = "label",
  positioning = "above",
  visible,
  mountNode,
  children,
}: HsTooltipProps) {
  return (
    <FluentTooltip
      content={content}
      relationship={relationship}
      positioning={positioning}
      visible={visible}
      mountNode={mountNode}
    >
      {children}
    </FluentTooltip>
  );
}
