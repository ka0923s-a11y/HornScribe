import { describe, expect, it, vi } from "vitest";
import { ja } from "../strings/ja";
import {
  buildReviewAction,
  buildSecondaryReviewAction,
  issueHasNoteTargets,
  type ReviewActionHandlers,
} from "./reviewActions";
import type { ScoreReviewIssue } from "./review";

function issue(over: Partial<ScoreReviewIssue> = {}): ScoreReviewIssue {
  return {
    id: "ri-000001",
    scoreRevision: "rev-test",
    canonicalNoteIds: ["sn-000001"],
    reason: "low_model_confidence",
    severity: "caution",
    evidence: {},
    status: "open",
    ...over,
  };
}

function handlers(over: Partial<ReviewActionHandlers> = {}) {
  return {
    retranscribeVoices: vi.fn(),
    retranscribeVocalIsolation: vi.fn(),
    retranscribeBasicPitch: vi.fn(),
    openProperties: vi.fn(),
    toggleEnharmonic: vi.fn(() => true),
    applyEdit: vi.fn(),
    markFixed: vi.fn(),
    ...over,
  } satisfies ReviewActionHandlers;
}

describe("issueHasNoteTargets", () => {
  it("is false for whole-piece issues and null", () => {
    expect(issueHasNoteTargets(null)).toBe(false);
    expect(issueHasNoteTargets(issue({ canonicalNoteIds: [] }))).toBe(
      false,
    );
  });
  it("is true when canonical notes are attached", () => {
    expect(issueHasNoteTargets(issue())).toBe(true);
  });
});

describe("buildReviewAction", () => {
  it("returns null with no issue or no matching remedy", () => {
    expect(buildReviewAction(null, handlers())).toBeNull();
    expect(buildReviewAction(issue(), handlers())).toBeNull();
  });

  it("voices retry: label + tooltip + handler all agree", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({ evidence: { suggestVoicesTexture: true } }),
      h,
    );
    expect(a?.label).toBe(ja.review.retranscribeVoices);
    expect(a?.tooltip).toBe(ja.review.retranscribeVoicesTip);
    a?.run();
    expect(h.retranscribeVoices).toHaveBeenCalledOnce();
  });

  it("voices retry hides without the handler", () => {
    const a = buildReviewAction(
      issue({ evidence: { suggestVoicesTexture: true } }),
      handlers({ retranscribeVoices: undefined }),
    );
    expect(a).toBeNull();
  });

  it("#314: vocal-isolation retry wins over voices on a lead-vocal mix", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({
        evidence: { suggestVoicesTexture: true, suggestVocalIsolation: true },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.retranscribeVocalIsolation);
    expect(a?.tooltip).toBe(ja.review.retranscribeVocalIsolationTip);
    a?.run();
    expect(h.retranscribeVocalIsolation).toHaveBeenCalledOnce();
    expect(h.retranscribeVoices).not.toHaveBeenCalled();
  });

  it("#314: vocal-isolation retry hides without the handler", () => {
    const a = buildReviewAction(
      issue({ evidence: { suggestVocalIsolation: true } }),
      handlers({ retranscribeVocalIsolation: undefined }),
    );
    expect(a).toBeNull();
  });

  it("Basic Pitch retry gets its OWN tooltip (not the voices copy)", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({
        reason: "monophonic_backend",
        canonicalNoteIds: [],
        evidence: { suggestBasicPitch: true },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.retranscribeBasicPitch);
    expect(a?.tooltip).toBe(ja.review.retranscribeBasicPitchTip);
    expect(a?.tooltip).not.toBe(ja.review.retranscribeVoicesTip);
    a?.run();
    expect(h.retranscribeBasicPitch).toHaveBeenCalledOnce();
  });

  it("spelling issue: enharmonic label/tooltip, marks fixed on success", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({ reason: "pitch_spelling_ambiguous" }),
      h,
    );
    expect(a?.label).toBe(ja.commands.noteEnharmonic);
    expect(a?.tooltip).toBe(ja.review.enharmonicTip);
    a?.run();
    expect(h.toggleEnharmonic).toHaveBeenCalledOnce();
    expect(h.markFixed).toHaveBeenCalledWith("ri-000001");
  });

  it("spelling issue does not mark fixed when the toggle fails", () => {
    const h = handlers({ toggleEnharmonic: vi.fn(() => false) });
    buildReviewAction(issue({ reason: "pitch_spelling_ambiguous" }), h)
      ?.run();
    expect(h.markFixed).not.toHaveBeenCalled();
  });

  it("tempo issue: suggestion label + scaleTempo op via applyEdit", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "tempo_uncertain",
        canonicalNoteIds: [],
        evidence: { suggestedBpm: 120.4, direction: "halve" },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.applyTempoSuggestion(120.4));
    expect(a?.tooltip).toBe(ja.review.applyTempoSuggestionTip);
    a?.run();
    expect(applyEdit).toHaveBeenCalledOnce();
    const [op, feedback, onApplied] = applyEdit.mock.calls[0];
    expect(op()).toEqual({ kind: "scaleTempo", noteId: "", factor: 0.5 });
    expect(feedback).toBe(ja.commandFeedback.tempoChanged);
    onApplied();
    expect(h.markFixed).toHaveBeenCalledWith("ri-000001");
  });

  it("tempo issue hides without the edit channel", () => {
    const a = buildReviewAction(
      issue({
        reason: "tempo_uncertain",
        evidence: { suggestedBpm: 60 },
      }),
      handlers({ applyEdit: undefined }),
    );
    expect(a).toBeNull();
  });

  it("meter conflict: opens the properties panel", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({ reason: "meter_conflict", canonicalNoteIds: [] }),
      h,
    );
    expect(a?.label).toBe(ja.review.openMeterEditor);
    expect(a?.tooltip).toBe(ja.review.openMeterEditorTip);
    a?.run();
    expect(h.openProperties).toHaveBeenCalledOnce();
  });

  it("#358: pickup suggestion applies setPickup via applyEdit", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "pickup_uncertain",
        canonicalNoteIds: [],
        evidence: { suggestedPickupBeats: 1 },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.applyPickupSuggestion(1));
    expect(a?.tooltip).toBe(ja.review.applyPickupSuggestionTip);
    a?.run();
    expect(applyEdit).toHaveBeenCalledOnce();
    const [op, feedback, onApplied] = applyEdit.mock.calls[0];
    expect(op()).toEqual({
      kind: "setPickup",
      noteId: "",
      pickupBeats: "1/1",
    });
    expect(feedback).toBe(ja.commandFeedback.pickupChanged);
    onApplied();
    expect(h.markFixed).toHaveBeenCalledWith("ri-000001");
  });

  it("#358: a zero-beat suggestion still offers the fix", () => {
    // suggestedPickupBeats 0 means "remove the phantom pickup" — a
    // truthiness check would silently drop the remedy entirely.
    const a = buildReviewAction(
      issue({
        reason: "pickup_uncertain",
        canonicalNoteIds: [],
        evidence: { suggestedPickupBeats: 0 },
      }),
      handlers(),
    );
    expect(a?.label).toBe(ja.review.applyPickupSuggestion(0));
  });

  it("#358: no suggestion falls back to the properties pickup field", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({
        reason: "pickup_uncertain",
        canonicalNoteIds: [],
        evidence: { suggestedPickupBeats: null },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.openPickupEditor);
    expect(a?.tooltip).toBe(ja.review.openPickupEditorTip);
    a?.run();
    expect(h.openProperties).toHaveBeenCalledOnce();
  });

  it("#352: key uncertain opens the properties key editor", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({ reason: "key_uncertain", canonicalNoteIds: [] }),
      h,
    );
    expect(a?.label).toBe(ja.review.openKeyEditor);
    expect(a?.tooltip).toBe(ja.review.openKeyEditorTip);
    a?.run();
    expect(h.openProperties).toHaveBeenCalledOnce();
  });

  it("quantization ambiguous: applyAlternative op", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const alt = [{ id: "sn-1", startBeat: "1", durationBeats: "1/2" }];
    const a = buildReviewAction(
      issue({
        reason: "quantization_ambiguous",
        evidence: { alternativeNotes: alt },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.applyAlternative);
    expect(a?.tooltip).toBe(ja.review.applyAlternativeTip);
    a?.run();
    const [op] = applyEdit.mock.calls[0];
    expect(op()).toEqual({
      kind: "applyAlternative",
      noteId: "",
      notes: alt,
    });
  });

  it("possible triplet: applyTriplet op on the flagged beat", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "possible_triplet",
        evidence: { beatStartBeats: "9/4" },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.applyTriplet);
    expect(a?.tooltip).toBe(ja.review.applyTripletTip);
    a?.run();
    const [op] = applyEdit.mock.calls[0];
    expect(op()).toEqual({
      kind: "applyTriplet",
      noteId: "",
      startBeat: "9/4",
    });
  });

  it("range issue: octave direction follows the pitch evidence", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const high = buildReviewAction(
      issue({
        reason: "outside_preferred_horn_range",
        evidence: { pitchMidi: 84 },
      }),
      h,
    );
    expect(high?.label).toBe(ja.review.octaveDown);
    expect(high?.tooltip).toBe(ja.review.octaveShiftTip);
    high?.run();
    expect(applyEdit.mock.calls[0][0]()).toEqual({
      kind: "transposeNote",
      noteId: "sn-000001",
      semitones: -12,
    });

    const low = buildReviewAction(
      issue({
        reason: "outside_preferred_horn_range",
        evidence: { pitchMidi: 40 },
      }),
      h,
    );
    expect(low?.label).toBe(ja.review.octaveUp);
    low?.run();
    expect(applyEdit.mock.calls[1][0]()).toEqual({
      kind: "transposeNote",
      noteId: "sn-000001",
      semitones: 12,
    });
  });

  it("range issue without note targets shows NO dead button", () => {
    const a = buildReviewAction(
      issue({
        reason: "outside_preferred_horn_range",
        canonicalNoteIds: [],
        evidence: { pitchMidi: 84 },
      }),
      handlers(),
    );
    expect(a).toBeNull();
  });

  it("#264: octave flag transposes by the suggested delta", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "octave_uncertain",
        evidence: { pitchMidi: 66, suggestedMidi: 54 },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.octaveDown);
    expect(a?.tooltip).toBe(ja.review.octaveShiftTip);
    a?.run();
    expect(applyEdit.mock.calls[0][0]()).toEqual({
      kind: "transposeNote",
      noteId: "sn-000001",
      semitones: -12,
    });
  });

  it("#264: octave flag without a suggestion shows no dead button", () => {
    expect(
      buildReviewAction(
        issue({ reason: "octave_uncertain", evidence: {} }),
        handlers(),
      ),
    ).toBeNull();
    // Missing edit channel likewise disables the remedy.
    const h: ReviewActionHandlers = { markFixed: vi.fn() };
    expect(
      buildReviewAction(
        issue({
          reason: "octave_uncertain",
          evidence: { pitchMidi: 66, suggestedMidi: 54 },
        }),
        h,
      ),
    ).toBeNull();
  });

  it("#264: pitch-dip flag transposes onto the suggested neighbour", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "pitch_uncertain",
        evidence: { pitchMidi: 53, suggestedMidi: 54 },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.pitchUp);
    expect(a?.tooltip).toBe(ja.review.pitchShiftTip);
    a?.run();
    expect(applyEdit.mock.calls[0][0]()).toEqual({
      kind: "transposeNote",
      noteId: "sn-000001",
      semitones: 1,
    });
  });

  it("#423: merge flag offers mergeNotes on the first note", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "boundary_uncertain",
        canonicalNoteIds: ["sn-000001", "sn-000002"],
        evidence: { suggestedKind: "merge", boundarySec: 1.0 },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.mergeBoundary);
    expect(a?.tooltip).toBe(ja.review.mergeBoundaryTip);
    a?.run();
    const [op, feedback, onApplied] = applyEdit.mock.calls[0];
    expect(op()).toEqual({ kind: "mergeNotes", noteId: "sn-000001" });
    expect(feedback).toBe(ja.commandFeedback.notesMerged);
    onApplied();
    expect(h.markFixed).toHaveBeenCalledWith("ri-000001");
  });

  it("#423: split flag lands splitNote on the heard onset", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit });
    const a = buildReviewAction(
      issue({
        reason: "boundary_uncertain",
        evidence: {
          suggestedKind: "split",
          boundarySec: 1.0,
          suggestedSplitBeat: "2",
        },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.splitBoundary);
    expect(a?.tooltip).toBe(ja.review.splitBoundaryTip);
    a?.run();
    const [op, feedback] = applyEdit.mock.calls[0];
    expect(op()).toEqual({
      kind: "splitNote",
      noteId: "sn-000001",
      startBeat: "2",
    });
    expect(feedback).toBe(ja.commandFeedback.noteSplit);
  });

  it("#423: uncertain flag and missing split beat offer no fix", () => {
    const h = handlers();
    expect(
      buildReviewAction(
        issue({
          reason: "boundary_uncertain",
          evidence: { suggestedKind: "uncertain" },
        }),
        h,
      ),
    ).toBeNull();
    expect(
      buildReviewAction(
        issue({
          reason: "boundary_uncertain",
          evidence: { suggestedKind: "split" },
        }),
        h,
      ),
    ).toBeNull();
  });  it("#222: buried lead offers the precision-tier retry when one exists", () => {
    const h = handlers();
    const a = buildReviewAction(
      issue({
        reason: "low_lead_level",
        canonicalNoteIds: [],
        evidence: { suggestPrecisionIsolation: true },
      }),
      h,
    );
    expect(a?.label).toBe(ja.review.retranscribePrecisionIsolation);
    expect(a?.tooltip).toBe(
      ja.review.retranscribePrecisionIsolationTip,
    );
    a?.run();
    expect(h.retranscribeVocalIsolation).toHaveBeenCalledOnce();
  });

  it("#222: buried lead hides the retry without flag or handler", () => {
    expect(
      buildReviewAction(
        issue({ reason: "low_lead_level", canonicalNoteIds: [] }),
        handlers(),
      ),
    ).toBeNull();
    expect(
      buildReviewAction(
        issue({
          reason: "low_lead_level",
          canonicalNoteIds: [],
          evidence: { suggestPrecisionIsolation: true },
        }),
        handlers({ retranscribeVocalIsolation: undefined }),
      ),
    ).toBeNull();
  });

  it("#80-3: low-confidence / very-short flags lead with delete", () => {
    const h = handlers({ deleteNote: vi.fn() });
    for (const reason of [
      "low_model_confidence",
      "very_short_detection",
    ] as const) {
      const a = buildReviewAction(issue({ reason }), h);
      expect(a?.label).toBe(ja.review.deletePhantomNote);
      expect(a?.tooltip).toBe(ja.review.deletePhantomNoteTip);
      expect(a?.hideWhenNoteDeleted).toBe(true);
      a?.run();
    }
    expect(h.deleteNote).toHaveBeenCalledTimes(2);
    expect(h.deleteNote).toHaveBeenCalledWith("ri-000001");
  });

  it("#80-3: phantom flags hide the remedy without the delete handler", () => {
    expect(
      buildReviewAction(
        issue({ reason: "very_short_detection" }),
        handlers(),
      ),
    ).toBeNull();
  });

  it("#80-3: EXTREME range flag leads with delete, octave rides second", () => {
    const applyEdit = vi.fn();
    const h = handlers({ applyEdit, deleteNote: vi.fn() });
    const iss = issue({
      reason: "outside_preferred_horn_range",
      severity: "warning",
      evidence: { pitchMidi: 88 },
    });
    const primary = buildReviewAction(iss, h);
    expect(primary?.label).toBe(ja.review.deletePhantomNote);
    primary?.run();
    expect(h.deleteNote).toHaveBeenCalledWith("ri-000001");

    const secondary = buildSecondaryReviewAction(iss, h);
    expect(secondary?.label).toBe(ja.review.octaveDown);
    secondary?.run();
    expect(applyEdit.mock.calls[0][0]()).toEqual({
      kind: "transposeNote",
      noteId: "sn-000001",
      semitones: -12,
    });
  });

  it("#80-3: CAUTION range flag keeps octave primary, delete second", () => {
    const h = handlers({ deleteNote: vi.fn() });
    const iss = issue({
      reason: "outside_preferred_horn_range",
      severity: "caution",
      evidence: { pitchMidi: 84 },
    });
    const primary = buildReviewAction(iss, h);
    expect(primary?.label).toBe(ja.review.octaveDown);

    const secondary = buildSecondaryReviewAction(iss, h);
    expect(secondary?.label).toBe(ja.review.deletePhantomNote);
    secondary?.run();
    expect(h.deleteNote).toHaveBeenCalledWith("ri-000001");
  });

  it("#80-3: secondary slot empties when the alternate remedy is gone", () => {
    const iss = issue({
      reason: "outside_preferred_horn_range",
      severity: "warning",
      evidence: { pitchMidi: 88 },
    });
    // No deleteNote handler -> octave already owns the primary slot.
    expect(
      buildSecondaryReviewAction(iss, handlers()),
    ).toBeNull();
    // No edit channel -> delete owns the primary slot, nothing remains.
    expect(
      buildSecondaryReviewAction(
        issue({
          reason: "outside_preferred_horn_range",
          severity: "caution",
          evidence: { pitchMidi: 84 },
        }),
        { deleteNote: vi.fn() },
      ),
    ).toBeNull();
    // Other reasons never get a second slot.
    expect(
      buildSecondaryReviewAction(
        issue({ reason: "octave_uncertain" }),
        handlers({ deleteNote: vi.fn() }),
      ),
    ).toBeNull();
  });

});
