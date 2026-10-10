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
  /** Delete remedies are meaningless once the note is already deleted
   *  (the issue is then resolved, but it stays browsable) - the bar
   *  hides the button instead of offering a dead click. */
  readonly hideWhenNoteDeleted?: boolean;
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
  /** #80-3: delete the issue's note as a phantom detection - rides the
   *  same setNoteDeleted path as the bar's generic 削除 button (marks
   *  the issue fixed and auto-advances). */
  deleteNote?(issueId: string): void;
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

  // #222: a buried lead under the standard demucs tier still has a
  // stronger tier to try — the vocal-isolation retry pins precision.
  // demucs-less installs emit no flag (the remedy there is the addon).
  if (
    issue.reason === "low_lead_level" &&
    issue.evidence["suggestPrecisionIsolation"] === true &&
    handlers.retranscribeVocalIsolation
  ) {
    return {
      label: r.retranscribePrecisionIsolation,
      tooltip: r.retranscribePrecisionIsolationTip,
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

  // #358: pickup_uncertain — when the accent/onset evidence names a
  // better anacrusis the bar offers the one-tap fix (setPickup
  // re-tiles every barline; note values stay put). Without a
  // suggestion the remedy is the pickup field in the properties
  // panel, same as meter/key.
  if (issue.reason === "pickup_uncertain") {
    const suggested = issue.evidence["suggestedPickupBeats"];
    if (typeof suggested === "number" && handlers.applyEdit) {
      return {
        label: r.applyPickupSuggestion(suggested),
        tooltip: r.applyPickupSuggestionTip,
        run: () =>
          handlers.applyEdit?.(
            () => ({
              kind: "setPickup",
              noteId: "",
              pickupBeats: `${suggested}/1`,
            }),
            ja.commandFeedback.pickupChanged,
            () => handlers.markFixed?.(issue.id),
          ),
      };
    }
    if (handlers.openProperties) {
      return {
        label: r.openPickupEditor,
        tooltip: r.openPickupEditorTip,
        run: () => handlers.openProperties?.(),
      };
    }
  }
  // #423: boundary_uncertain — the audio-evidence second opinion on
  // note edges. A "merge" flag means one held note was written as
  // two: mergeNotes on the first id rejoins the pair. A "split"
  // flag carries the missed onset's beat: splitNote lands there
  // instead of the midpoint. "uncertain" flags get no auto-fix —
  // highlighting both notes IS the answer.
  if (issue.reason === "boundary_uncertain" && handlers.applyEdit) {
    const kind = issue.evidence["suggestedKind"];
    const firstId = issue.canonicalNoteIds[0];
    if (kind === "merge" && firstId) {
      return {
        label: r.mergeBoundary,
        tooltip: r.mergeBoundaryTip,
        run: () =>
          handlers.applyEdit?.(
            () => ({ kind: "mergeNotes", noteId: firstId }),
            ja.commandFeedback.notesMerged,
            () => handlers.markFixed?.(issue.id),
          ),
      };
    }
    const splitBeat = issue.evidence["suggestedSplitBeat"];
    if (kind === "split" && firstId && typeof splitBeat === "string") {
      return {
        label: r.splitBoundary,
        tooltip: r.splitBoundaryTip,
        run: () =>
          handlers.applyEdit?.(
            () => ({
              kind: "splitNote",
              noteId: firstId,
              startBeat: splitBeat,
            }),
            ja.commandFeedback.noteSplit,
            () => handlers.markFixed?.(issue.id),
          ),
      };
    }
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

  // #261/#80-3: outside the preferred horn range -> the remedy depends
  // on severity. CAUTION (just past the band) is usually a real melody
  // note tracked an octave off -> the octave shift stays primary and
  // deletion rides as the secondary remedy. WARNING (EXTREME - hopelessly
  // above/below playable range, e.g. a hi-hat mistracked at E6) is far
  // more likely a phantom -> delete becomes primary and the octave
  // shift is the secondary option.
  if (
    issue.reason === "outside_preferred_horn_range" &&
    issue.canonicalNoteIds.length > 0
  ) {
    if (issue.severity === "warning" && handlers.deleteNote) {
      const id = issue.id;
      return {
        label: r.deletePhantomNote,
        tooltip: r.deletePhantomNoteTip,
        hideWhenNoteDeleted: true,
        run: () => handlers.deleteNote?.(id),
      };
    }
    const octave = buildRangeOctaveAction(issue, handlers);
    if (octave) return octave;
    // No edit channel (fixture/dev doc): delete is still a real remedy.
    if (handlers.deleteNote) {
      const id = issue.id;
      return {
        label: r.deletePhantomNote,
        tooltip: r.deletePhantomNoteTip,
        hideWhenNoteDeleted: true,
        run: () => handlers.deleteNote?.(id),
      };
    }
  }

  // #80-3: phantom-plausible detections with no better automated fix.
  // A very short blip or a low-confidence note is usually percussion /
  // noise mistracked as pitch — the honest remedy is deleting it (the
  // reviewer can still 元音源を再生 to check first). Rides the same
  // setNoteDeleted path as the generic 削除 button, so undo works.
  if (
    (issue.reason === "very_short_detection" ||
      issue.reason === "low_model_confidence") &&
    issue.canonicalNoteIds.length > 0 &&
    handlers.deleteNote
  ) {
    const id = issue.id;
    return {
      label: r.deletePhantomNote,
      tooltip: r.deletePhantomNoteTip,
      hideWhenNoteDeleted: true,
      run: () => handlers.deleteNote?.(id),
    };
  }

  // #264: octave_uncertain — the spectrum says the note sits an
  // octave too high; the remedy transposes by the suggested delta
  // (normally -12). Same requirements as the range remedy: a real
  // note target plus the edit channel.
  if (
    issue.reason === "octave_uncertain" &&
    typeof issue.evidence["suggestedMidi"] === "number" &&
    typeof issue.evidence["pitchMidi"] === "number" &&
    issue.canonicalNoteIds.length > 0 &&
    handlers.applyEdit
  ) {
    const semitones =
      (issue.evidence["suggestedMidi"] as number) -
      (issue.evidence["pitchMidi"] as number);
    if (semitones !== 0) {
      const noteId = issue.canonicalNoteIds[0];
      return {
        label: semitones < 0 ? r.octaveDown : r.octaveUp,
        tooltip: r.octaveShiftTip,
        run: () =>
          handlers.applyEdit?.(
            () => ({ kind: "transposeNote", noteId, semitones }),
            ja.commandFeedback.octaveShifted,
            () => handlers.markFixed?.(issue.id),
        ),
      };
    }
  }

  // #264: pitch_uncertain — an isolated chromatic semitone dip; the
  // remedy transposes by the suggested delta (normally ±1, onto the
  // diatonic neighbour the tracker likely bin-snapped from).
  if (
    issue.reason === "pitch_uncertain" &&
    typeof issue.evidence["suggestedMidi"] === "number" &&
    typeof issue.evidence["pitchMidi"] === "number" &&
    issue.canonicalNoteIds.length > 0 &&
    handlers.applyEdit
  ) {
    const semitones =
      (issue.evidence["suggestedMidi"] as number) -
      (issue.evidence["pitchMidi"] as number);
    if (semitones !== 0) {
      const noteId = issue.canonicalNoteIds[0];
      return {
        label: semitones < 0 ? r.pitchDown : r.pitchUp,
        tooltip: r.pitchShiftTip,
        run: () =>
          handlers.applyEdit?.(
            () => ({ kind: "transposeNote", noteId, semitones }),
            ja.commandFeedback.pitchShifted,
            () => handlers.markFixed?.(issue.id),
          ),
      };
    }
  }

  return null;
}

/** #261: the range issue's octave fix — one canonical transposeNote,
 *  direction from the pitch evidence. Shared by the primary slot
 *  (CAUTION) and the secondary slot (EXTREME, where delete leads). */
function buildRangeOctaveAction(
  issue: ScoreReviewIssue,
  handlers: ReviewActionHandlers,
): ReviewPrimaryAction | null {
  const r = ja.review;
  if (
    typeof issue.evidence["pitchMidi"] !== "number" ||
    issue.canonicalNoteIds.length === 0 ||
    !handlers.applyEdit
  ) {
    return null;
  }
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

/** #80-3: the second remedy slot for outside_preferred_horn_range —
 *  the bar shows BOTH plausible fixes for a range flag. CAUTION keeps
 *  the octave shift primary and offers delete; WARNING (EXTREME, the
 *  phantom-likely case) inverts them. Null when the alternate remedy
 *  is unavailable. */
export function buildSecondaryReviewAction(
  issue: ScoreReviewIssue | null,
  handlers: ReviewActionHandlers,
): ReviewPrimaryAction | null {
  if (!issue || issue.reason !== "outside_preferred_horn_range") {
    return null;
  }
  if (issue.canonicalNoteIds.length === 0) return null;
  if (issue.severity === "warning") {
    // Delete leads; the octave shift is the alternative — but only
    // when the primary actually took the delete slot (no deleteNote
    // handler means octave already owns the primary slot).
    if (!handlers.deleteNote) return null;
    return buildRangeOctaveAction(issue, handlers);
  }
  // CAUTION: octave leads; deletion is the alternative. When no edit
  // channel exists delete already took the primary slot.
  if (!handlers.applyEdit || !handlers.deleteNote) return null;
  const id = issue.id;
  return {
    label: ja.review.deletePhantomNote,
    tooltip: ja.review.deletePhantomNoteTip,
    hideWhenNoteDeleted: true,
    run: () => handlers.deleteNote?.(id),
  };
}
