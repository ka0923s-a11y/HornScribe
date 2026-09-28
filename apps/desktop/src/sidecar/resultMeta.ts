/**
 * `result.meta` safe extractors (#81).
 *
 * The completed job's `result.meta` block carries engine self-reports —
 * pipeline.py emits them per transcription; older engines and
 * non-transcription jobs may omit keys entirely. Every extractor here
 * degrades to `null` rather than throwing, so the presentation
 * surfaces that read meta (diagnostics sheet, error-dialog dump) stay
 * honest on partial payloads without knowing engine internals.
 */

/**
 * The onset-lattice timing correction the quantizer applied
 * (`meta.alignmentShiftSec` + `meta.alignmentMeterResolved`).
 */
export interface TimingCorrection {
  /** Applied shift in seconds (`+` = performed onsets moved later
   *  onto the notated grid). */
  readonly shiftSec: number;
  /** True when competing phase hypotheses were disambiguated by
   *  metrical evidence (#78 metrical tie-break) rather than a plain
   *  residual minimum. */
  readonly meterResolved: boolean;
}

/**
 * Extract the applied timing correction from a completed job's result.
 * `null` when meta is absent, the shift is not a finite number, or it
 * is exactly zero — zero means "nothing was applied", which is the
 * normal case, not information a diagnostics surface should print.
 */
export function extractTimingCorrection(
  result: unknown,
): TimingCorrection | null {
  if (typeof result !== "object" || result === null) return null;
  const meta = (result as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return null;
  const m = meta as Record<string, unknown>;
  const shift = m.alignmentShiftSec;
  if (typeof shift !== "number" || !Number.isFinite(shift) || shift === 0) {
    return null;
  }
  return {
    shiftSec: shift,
    meterResolved: m.alignmentMeterResolved === true,
  };
}
