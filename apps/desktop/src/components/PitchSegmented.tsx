import { ja } from "../strings/ja";
import {
  SegmentedControl,
  type SegmentedOption,
} from "./primitives/SegmentedControl";

export type PitchView = "concert" | "hornF";

const OPTIONS: readonly SegmentedOption<PitchView>[] = [
  { value: "concert", label: ja.pitch.concert },
  { value: "hornF", label: ja.pitch.hornF },
];

/**
 * コンサートピッチ / F管ホルン selector (DESIGN_SYSTEM §11) — thin binding of
 * the SegmentedControl primitive to the pitch-view domain. Keyboard:
 * ArrowLeft/Right inside the group; Ctrl+1 / Ctrl+2 globally via the command
 * registry (GUI_UX_SPEC §7).
 */
export function PitchSegmented({
  value,
  onChange,
}: {
  value: PitchView;
  onChange: (v: PitchView) => void;
}) {
  return (
    <SegmentedControl
      options={OPTIONS}
      value={value}
      onChange={onChange}
      ariaLabel={ja.pitch.regionLabel}
    />
  );
}
