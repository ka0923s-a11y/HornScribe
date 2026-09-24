import { useMemo, useState } from "react";
import { ja } from "../strings/ja";
import { HsButton } from "./primitives/Button";
import { HsDialog } from "./primitives/Dialog";
import { HsSelect } from "./primitives/Select";

/* #130 (§14): quantization-settings dialog for the finished score.
 *
 * The engine's requantize edit replays the canonical notes through the
 * DP with the merged profile — the dialog edits the three profile
 * knobs (min duration / triplets / simplicity), seeded from the
 * payload's stored quantizationSettings. Applying is a normal undoable
 * score.edit, so Ctrl+Z restores the previous notation.
 */

export interface RequantizeSettings {
  minDurationQl: string;
  triplets: string;
  simplicity: string;
}

/** Read the stored quantization settings off a canonical payload. */
export function requantizeSeed(
  scoreDocument: unknown,
): RequantizeSettings | null {
  if (typeof scoreDocument !== "object" || scoreDocument === null) {
    return null;
  }
  const content = (scoreDocument as Record<string, unknown>).content;
  if (typeof content !== "object" || content === null) return null;
  const qs = (content as Record<string, unknown>).quantizationSettings;
  if (typeof qs !== "object" || qs === null) return null;
  const q = qs as Record<string, unknown>;
  return {
    minDurationQl:
      typeof q.minDurationQl === "string" ? q.minDurationQl : "1/4",
    triplets: typeof q.triplets === "string" ? q.triplets : "auto",
    simplicity:
      typeof q.simplicity === "string" ? q.simplicity : "standard",
  };
}

const MIN_DURATION_OPTIONS = [
  { value: "1/2", label: ja.import.audioOptions.minDuration8 },
  { value: "1/4", label: ja.import.audioOptions.minDuration16 },
  { value: "1/8", label: ja.import.audioOptions.minDuration32 },
] as const;

const TRIPLET_OPTIONS = [
  { value: "auto", label: ja.import.audioOptions.tripletsAuto },
  { value: "allow", label: ja.import.audioOptions.tripletsAllow },
  { value: "none", label: ja.import.audioOptions.tripletsNone },
] as const;

const SIMPLICITY_OPTIONS = [
  { value: "standard", label: ja.import.audioOptions.simplicityStandard },
  { value: "simple", label: ja.import.audioOptions.simplicitySimple },
  { value: "detailed", label: ja.import.audioOptions.simplicityDetailed },
] as const;

export function RequantizeDialog({
  open,
  seed,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  /** Settings read off the canonical payload when the dialog opened. */
  seed: RequantizeSettings | null;
  onOpenChange(open: boolean): void;
  /** Overrides that differ from the seed — empty means "no change". */
  onApply(overrides: Record<string, unknown>): void;
}) {
  const d = ja.requantizeDialog;
  const [minDurationQl, setMinDurationQl] = useState(
    seed?.minDurationQl ?? "1/4",
  );
  const [triplets, setTriplets] = useState(seed?.triplets ?? "auto");
  const [simplicity, setSimplicity] = useState(
    seed?.simplicity ?? "standard",
  );
  const [seeded, setSeeded] = useState(open);
  // Re-seed the form every time the dialog opens (score/settings may
  // have changed since the last open).
  if (open && !seeded) {
    setMinDurationQl(seed?.minDurationQl ?? "1/4");
    setTriplets(seed?.triplets ?? "auto");
    setSimplicity(seed?.simplicity ?? "standard");
    setSeeded(true);
  } else if (!open && seeded) {
    setSeeded(false);
  }

  const overrides = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (minDurationQl !== (seed?.minDurationQl ?? "1/4")) {
      out.minDurationQl = minDurationQl;
    }
    if (triplets !== (seed?.triplets ?? "auto")) out.triplets = triplets;
    if (simplicity !== (seed?.simplicity ?? "standard")) {
      out.simplicity = simplicity;
    }
    return out;
  }, [minDurationQl, triplets, simplicity, seed]);

  const changed = Object.keys(overrides).length > 0;
  const minValues = MIN_DURATION_OPTIONS.some(
    (o) => o.value === minDurationQl,
  )
    ? MIN_DURATION_OPTIONS
    : [
        { value: minDurationQl, label: minDurationQl },
        ...MIN_DURATION_OPTIONS,
      ];

  return (
    <HsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={d.title}
      actions={
        <>
          <HsButton onClick={() => onOpenChange(false)}>
            {d.cancel}
          </HsButton>
          <HsButton
            variant="primary"
            disabled={!changed}
            onClick={() => {
              onApply(overrides);
              onOpenChange(false);
            }}
          >
            {d.apply}
          </HsButton>
        </>
      }
    >
      <p>{d.body}</p>
      <HsSelect
        label={ja.import.audioOptions.minDuration}
        value={minDurationQl}
        options={minValues}
        onChange={setMinDurationQl}
      />
      <HsSelect
        label={ja.import.audioOptions.triplets}
        value={triplets}
        options={TRIPLET_OPTIONS}
        onChange={setTriplets}
      />
      <HsSelect
        label={ja.import.audioOptions.simplicity}
        value={simplicity}
        options={SIMPLICITY_OPTIONS}
        onChange={setSimplicity}
      />
      {!changed ? <p>{d.unchanged}</p> : null}
    </HsDialog>
  );
}
