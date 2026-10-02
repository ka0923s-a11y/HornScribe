import { ja } from "../strings/ja";
import {
  SegmentedControl,
  type SegmentedOption,
} from "./primitives/SegmentedControl";

export type PitchView = "concert" | "hornF" | "bFlat";

const OPTIONS: readonly SegmentedOption<PitchView>[] = [
  { value: "concert", label: ja.pitch.concert },
  { value: "hornF", label: ja.pitch.hornF },
  { value: "bFlat", label: ja.pitch.bFlat },
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
  bFlatAvailable = true,
}: {
  value: PitchView;
  onChange: (v: PitchView) => void;
  /** #156: false disables the B♭ segment with a reason (documents
   *  without a B♭ presentation - e.g. mock/fixture sources - can
   *  never show written-Bb pitches, so the option stays honest). */
  bFlatAvailable?: boolean;
}) {
  const options = OPTIONS.map((o) =>
    o.value === "bFlat" && !bFlatAvailable
      ? { ...o, disabled: true, ariaLabel: ja.pitch.bFlatUnavailable }
      : o,
  );
  return (
    <SegmentedControl
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={ja.pitch.regionLabel}
    />
  );
}
