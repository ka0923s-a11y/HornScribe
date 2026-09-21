import { useCallback, useRef } from "react";
import { ja } from "../strings/ja";

export type PitchView = "concert" | "hornF";

const ORDER: PitchView[] = ["concert", "hornF"];
const LABEL: Record<PitchView, string> = {
  concert: ja.pitch.concert,
  hornF: ja.pitch.hornF,
};

/**
 * コンサートピッチ / F管ホルン segmented control (DESIGN_SYSTEM §11).
 *
 * Text labels only — icon-only segments are forbidden. The selected state
 * combines fill + weight + border cues. Keyboard: Left/Right move selection
 * (roving tabindex), Ctrl+1 / Ctrl+2 are the global shortcuts (GUI_UX_SPEC §7).
 */
export function PitchSegmented({
  value,
  onChange,
}: {
  value: PitchView;
  onChange: (v: PitchView) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0;
      if (e.key === "ArrowLeft") delta = -1;
      else if (e.key === "ArrowRight") delta = 1;
      else return;
      e.preventDefault();
      const idx = ORDER.indexOf(value);
      const next = ORDER[(idx + delta + ORDER.length) % ORDER.length];
      onChange(next);
      // Move focus with selection (roving tabindex).
      const items = groupRef.current?.querySelectorAll<HTMLButtonElement>(
        ".hs-segmented__item",
      );
      items?.[ORDER.indexOf(next)]?.focus();
    },
    [value, onChange],
  );

  return (
    <div
      ref={groupRef}
      className="hs-segmented"
      role="radiogroup"
      aria-label={ja.pitch.regionLabel}
      onKeyDown={onKeyDown}
    >
      {ORDER.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          tabIndex={value === v ? 0 : -1}
          className="hs-segmented__item"
          onClick={() => onChange(v)}
        >
          {LABEL[v]}
        </button>
      ))}
    </div>
  );
}
