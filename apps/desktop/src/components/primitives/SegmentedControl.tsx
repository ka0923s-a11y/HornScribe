import { forwardRef, useCallback, useRef } from "react";

/** Merge an internal ref with a forwarded ref (callback refs only — the
 *  forwarded ref is either a callback or a MutableRefObject). */
function mergeRefs<T>(
  ...refs: (React.Ref<T> | undefined)[]
): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/**
 * SegmentedControl — text-label segment picker (DESIGN_SYSTEM §11).
 *
 * Generalized from the UI-001 コンサートピッチ/F管ホルン selector:
 * - text labels only — icon-only segments are forbidden (§11)
 * - selected state = fill + weight + border cues combined
 * - keyboard: ArrowLeft/ArrowRight move selection (roving tabindex,
 *   disabled segments are skipped); segment-specific global shortcuts
 *   live in commands/registry.ts, not here
 */
export interface SegmentedOption<T extends string> {
  value: T;
  /** Japanese text label — required, never icon-only. */
  label: string;
  disabled?: boolean;
  /** Optional per-segment accessible name when the label needs context. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Required Japanese name for the radiogroup (e.g. 表示音高の切り替え). */
  ariaLabel: string;
  disabled?: boolean;
}

function SegmentedControlInner<T extends string>(
  {
    options,
    value,
    onChange,
    ariaLabel,
    disabled = false,
  }: SegmentedControlProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>,
) {
  const groupRef = useRef<HTMLDivElement>(null);

  const enabledValues = options.filter((o) => !o.disabled).map((o) => o.value);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0;
      if (e.key === "ArrowLeft") delta = -1;
      else if (e.key === "ArrowRight") delta = 1;
      else return;
      e.preventDefault();
      if (enabledValues.length === 0) return;
      const idx = enabledValues.indexOf(value);
      const next =
        enabledValues[
          (idx + delta + enabledValues.length) % enabledValues.length
        ] ?? enabledValues[0];
      onChange(next);
      // Move focus with selection (roving tabindex).
      const items = groupRef.current?.querySelectorAll<HTMLButtonElement>(
        ".hs-segmented__item",
      );
      const domIdx = options.findIndex((o) => o.value === next);
      if (domIdx >= 0) items?.[domIdx]?.focus();
    },
    [value, onChange, enabledValues, options],
  );

  return (
    <div
      ref={mergeRefs(groupRef, ref)}
      className="hs-segmented"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const isDisabled = disabled || option.disabled === true;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={option.ariaLabel}
            disabled={isDisabled}
            tabIndex={isSelected && !isDisabled ? 0 : -1}
            className="hs-segmented__item"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * forwardRef (so Fluent triggers/tooltips can anchor to the group) with the
 * generic preserved — forwardRef alone erases the T type parameter.
 */
export const SegmentedControl = forwardRef(SegmentedControlInner) as <
  T extends string,
>(
  props: SegmentedControlProps<T> & { ref?: React.Ref<HTMLDivElement> },
) => React.ReactElement;
