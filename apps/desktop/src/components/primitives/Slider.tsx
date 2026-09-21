import {
  Field,
  Slider as FluentSlider,
  mergeClasses,
} from "@fluentui/react-components";

/**
 * HsSlider — continuous value control (volume, zoom, rate candidates).
 *
 * The current value is rendered beside the track with tabular numerals
 * (§5 時間/BPM rule) and an optional unit suffix. The Fluent Slider inside
 * consumes the Field context, so `label` also becomes its accessible name.
 */
export interface HsSliderProps {
  /** Japanese field label — doubles as the slider's accessible name. */
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  disabled?: boolean;
  /** Unit appended to the value readout, e.g. "%", "秒", "×". */
  unit?: string;
  /** Hide the numeric readout when the value is shown elsewhere. */
  showValue?: boolean;
  /** Custom formatter for the value readout (must keep tabular output). */
  formatValue?: (value: number) => string;
  className?: string;
}

export function HsSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled = false,
  unit,
  showValue = true,
  formatValue,
  className,
}: HsSliderProps) {
  const display = formatValue ? formatValue(value) : `${value}${unit ?? ""}`;
  return (
    <Field label={label} className={mergeClasses("hs-field", className)}>
      <div className="hs-slider">
        <FluentSlider
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(_, data) => onChange?.(data.value)}
        />
        {showValue ? (
          <span className="hs-slider__value">{display}</span>
        ) : null}
      </div>
    </Field>
  );
}
