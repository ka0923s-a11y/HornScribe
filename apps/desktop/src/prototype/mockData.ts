/**
 * UI-009 prototype pack — deterministic mock data (issue #31).
 *
 * Everything here is fixed sample data: no audio decoding, no engine, no
 * randomness. The shapes mirror the future canonical model (note ids,
 * ReviewIssue reasons, concert-vs-written pitch) closely enough to validate
 * the information hierarchy in GUI_UX_SPEC.
 */

export type PitchView = "concert" | "hornF";

export interface MockNote {
  /** Canonical note id — selection survives the concert/F管ホルン switch. */
  id: string;
  /** 1-based measure number. */
  measure: number;
  /** 1-based beat position inside the measure. */
  beat: number;
  /** Concert-pitch MIDI number (what was played / what sounds). */
  midiConcert: number;
  durationBeats: number;
  durationLabel: string;
  onsetSec: number;
  confidence: number;
  deleted: boolean;
}

/** Mock score: 4/4, 100 BPM → 1 beat = 0.6 s, 1 measure = 2.4 s. */
export const BPM = 100;
export const BEAT_SEC = 60 / BPM;
export const MEASURE_SEC = BEAT_SEC * 4;
export const MEASURE_COUNT = 12;
export const DURATION_SEC = MEASURE_COUNT * MEASURE_SEC; // 28.8 s

/** Loop range used by the mocked transport (measures 5–8). */
export const LOOP_RANGE = { startSec: 4 * MEASURE_SEC, endSec: 8 * MEASURE_SEC };

const DURATION_LABEL: Record<number, string> = {
  4: "全音符",
  2: "二分音符",
  1: "四分音符",
  0.5: "八分音符",
};

/** Fixed melody, [concert midi, beats] per note, one array per measure. */
const MELODY: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[60, 1], [62, 1], [64, 1], [65, 1]],
  [[67, 2], [65, 1], [64, 1]],
  [[64, 1], [62, 1], [60, 2]],
  [[62, 1], [64, 1], [62, 1], [55, 1]],
  [[60, 2], [64, 2]],
  [[65, 1], [67, 1], [69, 2]],
  [[67, 1], [65, 1], [64, 1], [62, 1]],
  [[60, 4]],
  [[67, 1], [69, 1], [71, 1], [72, 1]],
  [[72, 2], [71, 1], [69, 1]],
  [[67, 1], [65, 1], [64, 1], [62, 1]],
  [[60, 4]],
];

/** Confidence is fixed per measure to give review markers variety. */
const CONFIDENCE = [88, 72, 91, 66, 95, 58, 84, 97, 76, 63, 81, 99];

export const NOTES: MockNote[] = (() => {
  let seq = 0;
  return MELODY.flatMap((measure, m) => {
    let beat = 1;
    return measure.map(([midi, beats]) => {
      const note: MockNote = {
        id: `n${String(seq++).padStart(3, "0")}`,
        measure: m + 1,
        beat,
        midiConcert: midi,
        durationBeats: beats,
        durationLabel: DURATION_LABEL[beats] ?? `${beats}拍`,
        onsetSec: m * MEASURE_SEC + (beat - 1) * BEAT_SEC,
        confidence: CONFIDENCE[m],
        deleted: false,
      };
      beat += beats;
      return note;
    });
  });
})();

/* ------------------------- pitch helpers ------------------------- */

const PC_SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const PC_FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
/** pitch class → diatonic step inside the octave (sharp spelling). */
const DIATONIC_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

export function noteName(midi: number): string {
  return `${PC_SHARP[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Enharmonic display for accidentals: 「F♯4（G♭4）」; naturals stay bare. */
export function spellingLabel(midi: number): string {
  const pc = midi % 12;
  const octave = Math.floor(midi / 12) - 1;
  const sharp = `${PC_SHARP[pc]}${octave}`;
  const flat = `${PC_FLAT[pc]}${octave}`;
  return sharp === flat ? sharp : `${sharp}（${flat}）`;
}

/** Horn in F: written pitch sounds a perfect fifth below → add 7 semitones. */
export function writtenMidi(midiConcert: number, view: PitchView): number {
  return view === "hornF" ? midiConcert + 7 : midiConcert;
}

/** Diatonic staff step (sharp spelling) for placing the notehead. */
export function diatonicStep(midi: number): number {
  return (Math.floor(midi / 12) - 1) * 7 + DIATONIC_STEP[midi % 12];
}

/** True when the sharp spelling carries an accidental sign. */
export function hasAccidental(midi: number): boolean {
  return PC_SHARP[midi % 12].includes("♯");
}

/* ------------------------- review issues ------------------------- */

export type IssueReason =
  | "quantizationAmbiguous"
  | "beatAlignmentUncertain"
  | "possibleTriplet"
  | "outsideHornRange"
  | "offsetAmbiguous";

export type IssueStatus = "pending" | "accepted" | "fixed" | "deleted";

export interface MockIssue {
  id: string;
  noteId: string;
  reason: IssueReason;
  confidence: number;
  status: IssueStatus;
}

function noteAt(measure: number, beat: number): MockNote {
  const n = NOTES.find((n) => n.measure === measure && n.beat === beat);
  if (!n) throw new Error(`mock: no note at m${measure} b${beat}`);
  return n;
}

/** Five deterministic ReviewIssues (P4) spread across the score. */
export function buildIssues(): MockIssue[] {
  const pick = (measure: number, beat: number, reason: IssueReason, confidence: number) => ({
    id: `ri-${measure}${String(beat).padStart(2, "0")}`,
    noteId: noteAt(measure, beat).id,
    reason,
    confidence,
    status: "pending" as IssueStatus,
  });
  return [
    pick(2, 1, "quantizationAmbiguous", 72),
    pick(4, 4, "outsideHornRange", 66),
    pick(6, 3, "possibleTriplet", 58),
    pick(9, 3, "beatAlignmentUncertain", 76),
    pick(11, 3, "offsetAmbiguous", 63),
  ];
}

/* ------------------------- misc helpers ------------------------- */

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function noteAtTime(sec: number): MockNote | null {
  let hit: MockNote | null = null;
  for (const n of NOTES) {
    if (n.deleted) continue;
    if (n.onsetSec <= sec && sec < n.onsetSec + n.durationBeats * BEAT_SEC) {
      hit = n;
      break;
    }
  }
  return hit;
}

export function measureAtTime(sec: number): number {
  return Math.min(MEASURE_COUNT, Math.max(1, Math.floor(sec / MEASURE_SEC) + 1));
}

/** Deterministic pseudo-waveform heights (0..1), 120 bars. */
export const WAVE_BARS: number[] = Array.from({ length: 120 }, (_, i) => {
  const v = Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.13));
  return 0.15 + v * 0.85;
});
