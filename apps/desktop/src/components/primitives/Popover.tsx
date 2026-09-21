import type { ReactElement, ReactNode } from "react";
import {
  Popover as FluentPopover,
  PopoverTrigger as FluentPopoverTrigger,
  PopoverSurface as FluentPopoverSurface,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

/**
 * HsPopover — anchored floating surface (DESIGN_SYSTEM §8 elevation tier).
 *
 * Surface chrome follows the Fluent theme tokens (context-correct inside
 * portals and in the gallery's dual-theme sections); HornScribe geometry is
 * applied through the --hs-radius-panel semantic token.
 *
 * `inline` renders the surface in-flow instead of a portal — used by the
 * dev gallery so fixtures live inside their light/dark theme section.
 */
const usePopoverStyles = makeStyles({
  surface: {
    borderRadius: "var(--hs-radius-panel)",
    boxShadow: tokens.shadow16,
    transitionDuration: "var(--hs-motion-panel)",
    transitionTimingFunction: "var(--hs-ease-decelerate)",
  },
});

export interface HsPopoverProps {
  /** The element the popover anchors to (wrapped in PopoverTrigger). */
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render in-flow (no portal) — dev gallery fixtures. */
  inline?: boolean;
  /** Mount the surface into this node instead of document.body. */
  mountNode?: HTMLElement | null;
  /** Accessible name for the surface when it carries structure. */
  ariaLabel?: string;
  positioning?: "above" | "below" | "before" | "after";
}

export function HsPopover({
  trigger,
  children,
  open,
  onOpenChange,
  inline = false,
  mountNode,
  ariaLabel,
  positioning = "below",
}: HsPopoverProps) {
  const styles = usePopoverStyles();
  return (
    <FluentPopover
      open={open}
      onOpenChange={(_, data) => onOpenChange?.(data.open)}
      inline={inline}
      mountNode={mountNode}
      positioning={positioning}
      withArrow
    >
      <FluentPopoverTrigger disableButtonEnhancement>
        {trigger}
      </FluentPopoverTrigger>
      <FluentPopoverSurface
        className={styles.surface}
        aria-label={ariaLabel}
      >
        {children}
      </FluentPopoverSurface>
    </FluentPopover>
  );
}
