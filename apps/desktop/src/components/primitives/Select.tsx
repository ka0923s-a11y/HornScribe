import {
  Field,
  Select as FluentSelect,
  mergeClasses,
} from "@fluentui/react-components";

/**
 * HsSelect — labelled single-choice picker (拍子, 初期表示, テーマ候補…).
 *
 * Uses the native-select Fluent Select so IME/keyboard behavior stays
 * platform-consistent; Field wires label → control and renders the error /
 * hint line. Options carry Japanese labels.
 */
export interface HsSelectOption {
  value: string;
  /** Japanese label. */
  label: string;
  disabled?: boolean;
}

export interface HsSelectProps {
  /** Japanese field label — doubles as the control's accessible name. */
  label: string;
  options: readonly HsSelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** Ghost option shown when nothing is selected (renders disabled). */
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Japanese error message — sets the field's error state. */
  error?: string;
  /** Neutral helper text shown when there is no error. */
  hint?: string;
  className?: string;
}

export function HsSelect({
  label,
  options,
  value,
  onChange,
  placeholder,
  required = false,
  disabled = false,
  error,
  hint,
  className,
}: HsSelectProps) {
  const message = error ?? hint;
  return (
    <Field
      label={label}
      required={required}
      validationState={error ? "error" : "none"}
      validationMessage={message}
      className={mergeClasses("hs-field", className)}
    >
      <FluentSelect
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </FluentSelect>
    </Field>
  );
}
