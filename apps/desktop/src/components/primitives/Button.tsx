import { forwardRef, type ReactElement, type ReactNode } from "react";
import {
  Button as FluentButton,
  Spinner,
  mergeClasses,
} from "@fluentui/react-components";

/**
 * HsButton — HornScribe button primitive over Fluent v9 Button
 * (DESIGN_SYSTEM §9).
 *
 * Variants:
 * - `primary`   — the single primary action of a surface (§9: 原則1つ)
 * - `secondary` — default neutral command
 * - `subtle`    — borderless, low-emphasis command
 * - `danger`    — destructive actions only (§20); fill uses the palette-red
 *                 --hs-danger* semantic tokens, never the status-error
 *                 signal color on its own
 *
 * `loading` shows an inline spinner, disables interaction and marks the
 * control aria-busy while keeping the Japanese label visible.
 *
 * forwardRef so Fluent Tooltip / Menu / Popover / Dialog triggers can
 * anchor to the underlying <button>.
 */
export type HsButtonVariant = "primary" | "secondary" | "subtle" | "danger";

const APPEARANCE: Record<
  HsButtonVariant,
  "primary" | "secondary" | "subtle"
> = {
  primary: "primary",
  secondary: "secondary",
  subtle: "subtle",
  // danger renders on the primary fill slot; the --hs-danger* tokens in
  // styles.css re-tint it to the destructive red family.
  danger: "primary",
};

export interface HsButtonProps {
  variant?: HsButtonVariant;
  icon?: ReactElement;
  /** Spinner + disabled + aria-busy while keeping the label. */
  loading?: boolean;
  disabled?: boolean;
  size?: "small" | "medium" | "large";
  type?: "button" | "submit";
  onClick?: () => void;
  /** Extra accessible name when the visible label needs context. */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

export const HsButton = forwardRef<HTMLButtonElement, HsButtonProps>(
  function HsButton(
    {
      variant = "secondary",
      icon,
      loading = false,
      disabled = false,
      size = "medium",
      type = "button",
      onClick,
      ariaLabel,
      className,
      children,
    },
    ref,
  ) {
    return (
      <FluentButton
        ref={ref}
        appearance={APPEARANCE[variant]}
        className={mergeClasses(
          "hs-button",
          `hs-button--${variant}`,
          className,
        )}
        icon={loading ? <Spinner size="tiny" /> : icon}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-label={ariaLabel}
        size={size}
        type={type}
        onClick={onClick}
      >
        {children}
      </FluentButton>
    );
  },
);
