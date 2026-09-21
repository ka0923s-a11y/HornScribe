import {
  Field,
  ProgressBar as FluentProgressBar,
  mergeClasses,
} from "@fluentui/react-components";

/**
 * HsProgress — task progress (採譜の進捗, 書き出しています…).
 *
 * - `value` is a 0–1 fraction. Omit it (or pass undefined) for an honest
 *   indeterminate bar — JAPANESE_UI_COPY §5 forbids fabricating percents.
 * - `description` renders the active stage line under the bar.
 * - `error` switches the bar+field to the error state with a Japanese
 *   recovery message (GUI_UX_SPEC §20 shape is the caller's job).
 */
export interface HsProgressProps {
  /** Japanese label — also the bar's accessible name. */
  label?: string;
  /** 0–1 progress fraction; undefined → indeterminate. */
  value?: number;
  /** Stage description shown under the bar (e.g. 音を解析しています). */
  description?: string;
  /** Japanese error message — marks the task failed. */
  error?: string;
  thickness?: "medium" | "large";
  className?: string;
}

export function HsProgress({
  label,
  value,
  description,
  error,
  thickness = "medium",
  className,
}: HsProgressProps) {
  const message = error ?? description;
  return (
    <Field
      label={label}
      validationState={error ? "error" : "none"}
      validationMessage={message}
      className={mergeClasses("hs-field", "hs-progress", className)}
    >
      <FluentProgressBar
        value={value}
        max={1}
        thickness={thickness}
        aria-label={label}
      />
    </Field>
  );
}
