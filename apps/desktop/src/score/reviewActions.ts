/**
 * Review action capability model (UI-050 follow-up).
 *
 * The ReviewBar must not guess from reason names which remedy button to
 * show, and it must not offer note edits for issues that target no notes.
 * This module builds the capability the bar renders:
 *
 *   - canEditNotes:  canonical note targets exist -> pitch +/- and
 *                    delete/restore do real work (whole-piece issues like
 *                    meter_conflict or monophonic_backend get disabled
 *                    buttons instead of silent no-ops);
 *   - canPlaySource: the issue has an audible range (timeRange or a
 *                    canonical note onset on the playback table);
 *   - primary:       the reason-specific remedy {label, tooltip, run},
 *                    built in ONE place so label and handler can never
 *                    drift apart (previously two parallel IIFE chains
 *                    disagreed, e.g. the range issue showed an octave
 *                    button with no handler on whole-piece issues), and
 *                    every remedy gets its own Japanese tooltip instead
 *                    of the fixed retranscribe-voices copy.
 */
import { ja } from "../strings/ja";
import type { RhythmEditOp } from "./rhythmEdits";
import type { ScoreReviewIssue } from "./review";

export interface ReviewPrimaryAction {
  readonly label: string;
  readonly tooltip: string;
  run(): void;
}

export interface ReviewActionHandlers {
  /** #148: re-run the job with the voices texture (mix detected). */
  retranscribeVoices?(): void;
  /** #314: re-run with vocal isolation + melody (lead-vocal mix). */
  retranscribeVocalIsolation?(): void;
  /** #181: re-run the job with the Basic Pitch backend. */
  retranscribeBasicPitch?(): void;
  /** #209: open the properties panel (meter select lives there). */
  openProperties?(): void;
  /** #176/#204: flip the selected note's enharmonic spelling. */
  toggleEnharmonic?(): boolean;
  /** Engine score.edit invoker: op + feedback + on-applied hook. */
  applyEdit?(
    op: () => RhythmEditOp,
    feedback: string,
    onApplied?: () => void,
  ): void;
  /** Mark the issue resolved after a successful remedy. */
  markFixed?(issueId: string): void;
}

/** True when the issue targets concrete notes (pitch/delete apply). */
export function issueHasNoteTargets(
  issue: ScoreReviewIssue | null,
): boolean {
  return (issue?.canonicalNoteIds.length ?? 0) > 0;
}

/** Build the reason-specific remedy for the issue, or null when none of
 *  the known remedies applies / its handler is unavailable. */
export function buildReviewAction(
  issue: ScoreReviewIssue | null,
  handlers: ReviewActionHandlers,
): ReviewPrimaryAction | null {
  if (!issue) return null;
  const r = ja.review;

  // #314: a lead-vocal mix (the common JPOP case) wants the melody
  // isolated, not every detected line — vocal isolation is the
  // product's primary remedy and wins over the voices offer.
  if (
    issue.evidence["suggestVocalIsolation"] === true &&
    handlers.retranscribeVocalIsolation
  ) {
    return {
      label: r.retranscribeVocalIsolation,
      tooltip: r.retranscribeVocalIsolationTip,
      run: () => handlers.retranscribeVocalIsolation?.(),
    };
  }

  // #148: detected a mix -> retry with the voices texture.
  if (
    issue.evidence["suggestVoicesTexture"] === true &&
    handlers.retranscribeVoices
  ) {
    return {
      label: r.retranscribeVoices,
      tooltip: r.retranscribeVoicesTip,
      run: () => handlers.retranscribeVoices?.(),
    };
  }

  // #176: spelling issues resolve with the enharmonic toggle, not the
  // pitch +/- buttons (those change sounding pitch). #204: resolving
  // marks the issue fixed.
  if (issue.reason === "pitch_spelling_ambiguous") {
    const toggle = handlers.toggleEnharmonic;
    if (!toggle) return null;
    return {
      label: ja.commands.noteEnharmonic,
      tooltip: r.enharmonicTip,
      run: () => {
        if (toggle()) handlers.markFixed?.(issue.id);
      },
    };
  }

  // #181: monophonic backend -> retry with the polyphonic-capable one.
  if (
    issue.reason === "monophonic_backend" &&
    issue.evidence["suggestBasicPitch"] === true &&
    handlers.retranscribeBasicPitch
  ) {
    return {
      label: r.retranscribeBasicPitch,
      tooltip: r.retranscribeBasicPitchTip,
      run: () => handlers.retranscribeBasicPitch?.(),
    };
  }

  // #188/#198: tempo-uncertain -> scaleTempo (note values rescale with
  // the BPM so playback seconds stay invariant).
  if (
    issue.reason === "tempo_uncertain" &&
    typeof issue.evidence["suggestedBpm"] === "number" &&
    handlers.applyEdit
  ) {
    const bpm = issue.evidence["suggestedBpm"] as number;
    const factor = issue.evidence["direction"] === "halve" ? 0.5 : 2;
    return {
      label: r.applyTempoSuggestion(bpm),
      tooltip: r.applyTempoSuggestionTip,
      run: () =>
        handlers.applyEdit?.(
          () => ({ kind: "scaleTempo", noteId: "", factor }),
          ja.commandFeedback.tempoChanged,
          () => handlers.markFixed?.(issue.id),
        ),
    };
  }

  // #209: meter_conflict cannot auto-resolve - the remedy is the meter
  // select in the properties panel.
  if (issue.reason === "meter_conflict" && handlers.openProperties) {
    return {
      label: r.openMeterEditor,
      tooltip: r.openMeterEditorTip,
      run: () => handlers.openProperties?.(),
    };
  }

  // #352: key_uncertain cannot auto-resolve either - the engine's
  // best candidate stays written; the remedy is the key-map editor
  // in the properties panel.
  if (issue.reason === "key_uncertain" && handlers.openProperties) {
    return {
      label: r.openKeyEditor,
      tooltip: r.openKeyEditorTip,
      run: () => handlers.openProperties?.(),
    };
  }

  // #208: ambiguous quantization -> swap in the runner-up spans.
  if (
    issue.reason === "quantization_ambiguous" &&
    Array.isArray(issue.evidence["alternativeNotes"]) &&
    handlers.applyEdit
  ) {
    const alt = issue.evidence["alternativeNotes"] as {
      id: string;
      startBeat: string;
      durationBeats: string;
    }[];
    return {
      label: r.applyAlternative,
      tooltip: r.applyAlternativeTip,
      run: () =>
        handlers.applyEdit?.(
          () => ({ kind: "applyAlternative", noteId: "", notes: alt }),
          ja.commandFeedback.rhythmEdited,
          () => handlers.markFixed?.(issue.id),
        ),
    };
  }

  // #212: possible triplet -> rewrite the flagged beat as triplets.
  if (
    issue.reason === "possible_triplet" &&
    typeof issue.evidence["beatStartBeats"] === "string" &&
    handlers.applyEdit
  ) {
    const startBeat = issue.evidence["beatStartBeats"] as string;
    return {
      label: r.applyTriplet,
      tooltip: r.applyTripletTip,
      run: () =>
        handlers.applyEdit?.(
          () => ({ kind: "applyTriplet", noteId: "", startBeat }),
          ja.commandFeedback.rhythmEdited,
          () => handlers.markFixed?.(issue.id),
        ),
    };
  }

  // #261: outside the preferred horn range -> one canonical
  // transposeNote, direction from the pitch evidence. Requires a note
  // target AND the edit channel - a whole-piece range issue no longer
  // shows a dead button.
  if (
    issue.reason === "outside_preferred_horn_range" &&
    typeof issue.evidence["pitchMidi"] === "number" &&
    issue.canonicalNoteIds.length > 0 &&
    handlers.applyEdit
  ) {
    const noteId = issue.canonicalNoteIds[0];
    const high = (issue.evidence["pitchMidi"] as number) > 79;
    const semitones = high ? -12 : 12;
    return {
      label: high ? r.octaveDown : r.octaveUp,
      tooltip: r.octaveShiftTip,
      run: () =>
        handlers.applyEdit?.(
          () => ({ kind: "transposeNote", noteId, semitones }),
          ja.commandFeedback.octaveShifted,
          () => handlers.markFixed?.(issue.id),
        ),
    };
  }

  return null;
}
