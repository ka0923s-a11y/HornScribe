import { describe, expect, it, vi } from "vitest";
import { ja } from "../strings/ja";
import {
  buildReviewAction,
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
});
