import {
  Field,
  SpinButton,
  mergeClasses,
} from "@fluentui/react-components";
import { ja } from "../../strings/ja";

/**
 * HsNumericField — labelled numeric input (BPM, 小節番号, 秒数…).
 *
 * Built on Fluent SpinButton (keyboard ↑/↓ + stepper buttons) inside Field,
 * which wires label → control and renders the validation message. `error`
 * carries a Japanese message string and flips the field to the error state;
 * `hint` renders neutral helper text. Unit suffixes are shown via
 * SpinButton's displayValue without polluting the numeric value.
 */
export interface HsNumericFieldProps {
  /** Japanese field label — doubles as the input's accessible name. */
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number | null) => void;
  /** Unit shown after the number, e.g. "BPM", "秒". */
  unit?: string;
  required?: boolean;
  disabled?: boolean;
  /** Japanese error message — sets the field's error state. */
  error?: string;
  /** Neutral helper text shown when there is no error. */
  hint?: string;
  className?: string;
}

export function HsNumericField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
  required = false,
  disabled = false,
  error,
  hint,
  className,
}: HsNumericFieldProps) {
  const message = error ?? hint;
  return (
    <Field
      label={label}
      required={required}
      validationState={error ? "error" : "none"}
      validationMessage={message}
      className={mergeClasses("hs-field", className)}
    >
      <SpinButton
        value={value}
        displayValue={
          value == null ? undefined : `${value}${unit ? ` ${unit}` : ""}`
        }
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        // Fluent's defaults ship English aria-labels; the copy contract
        // requires Japanese accessible names, derived from the field label.
        incrementButton={{ "aria-label": ja.a11y.numericIncrement(label) }}
        decrementButton={{ "aria-label": ja.a11y.numericDecrement(label) }}
        onChange={(_, data) => {
          if (data.value !== undefined) {
            onChange?.(data.value);
          } else if (data.displayValue !== undefined) {
            // Free-typed text: let the caller parse or reject it.
            const parsed = Number(data.displayValue.replace(/[^0-9.-]/g, ""));
            onChange?.(Number.isFinite(parsed) ? parsed : null);
          }
        }}
      />
    </Field>
  );
}
