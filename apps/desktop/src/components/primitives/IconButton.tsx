import { forwardRef, type ReactElement } from "react";
import {
  Button as FluentButton,
  Spinner,
  mergeClasses,
} from "@fluentui/react-components";
import { HsTooltip } from "./Tooltip";

/**
 * HsIconButton — icon-only command (DESIGN_SYSTEM §9, §24).
 *
 * The copy contract (docs/UI_COPY_CONTRACT.md §4) requires icon-only
 * buttons to carry BOTH a Japanese tooltip and an accessible name, so
 * `label` is a required prop: it feeds the Tooltip content AND aria-label.
 *
 * `selected` marks toggle-style buttons: it sets aria-pressed and switches
 * the appearance so the state reads through more than color alone.
 *
 * forwardRef so Fluent triggers/tooltips can anchor to the <button>.
 */
export interface HsIconButtonProps {
  /** Japanese label — used for the tooltip AND the accessible name. */
  label: string;
  icon: ReactElement;
  variant?: "subtle" | "secondary" | "primary";
  /** Toggle semantics: aria-pressed + filled appearance cue. */
  selected?: boolean;
  loading?: boolean;
  disabled?: boolean;
  size?: "small" | "medium" | "large";
  onClick?: () => void;
  className?: string;
}

export const HsIconButton = forwardRef<HTMLButtonElement, HsIconButtonProps>(
  function HsIconButton(
    {
      label,
      icon,
      variant = "subtle",
      selected,
      loading = false,
      disabled = false,
      size = "medium",
      onClick,
      className,
    },
    ref,
  ) {
    const appearance = selected ? "primary" : variant;
    return (
      <HsTooltip content={label}>
        <FluentButton
          ref={ref}
          appearance={appearance}
          className={mergeClasses(
            "hs-icon-button",
            `hs-icon-button--${variant}`,
            selected && "hs-icon-button--selected",
            className,
          )}
          icon={loading ? <Spinner size="tiny" /> : icon}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          aria-label={label}
          aria-pressed={selected}
          size={size}
          onClick={onClick}
        />
      </HsTooltip>
    );
  },
);
