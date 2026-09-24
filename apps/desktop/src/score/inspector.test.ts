/**
 * Inspector view-model tests (UI-030). All Japanese text is produced in
 * score/inspector.ts via a copy deck — these tests pin the model shape the
 * PropertiesPanel renders.
 */
import { describe, expect, it } from "vitest";
import {
  buildNoteInspector,
  buildScoreInspector,
  headlinePitch,
  keyLabelJa,
  type InspectorCopy,
} from "./inspector";
import type { ParsedNote } from "./scoreDoc";
import type { ScoreReviewIssue } from "./review";

const copy: InspectorCopy = {
  review: {
    reasonTitle: (r) => `title:${r}`,
    reasonDetail: (i) => `detail:${i.reason}`,
    severityLabel: (s) => `sev:${s}`,
    statusLabel: (s) => `status:${s}`,
  },
  measure: (n) => `第${n}小節`,
  scoreSeconds: (sec) => `スコア ${sec.toFixed(1)} 秒`,
  tieFragments: (n) => `タイで分割（${n}分割）`,
  tempo: (bpm) => `${bpm} BPM`,
  measureCount: (n) => `${n} 小節`,
  noteCount: (n) => `${n} 音`,
  openIssues: (n) => `${n} 件`,
  key: (fifths) => keyLabelJa(fifths),
};

const note = (over: Partial<ParsedNote>): ParsedNote => ({
  exportId: "hs-sn-000001",
  canonicalId: "sn-000001",
  isRest: false,
  chord: false,
  measure: 1,
  dots: 0,
  tied: false,
  ...over,
});

describe("buildScoreInspector", () => {
  it("summarizes the document for the nothing-selected state", () => {
    const model = buildScoreInspector(
      {
        title: "Test Piece",
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: -1,
        keyChanges: [],
        measureCount: 12,
        noteCount: 40,
      },
      3,
      copy,
    );
    expect(model.kind).toBe("score");
    expect(model.tempoLabel).toBe("100 BPM");
    expect(model.meterLabel).toBe("4/4");
    expect(model.keyLabel).toBe("ヘ長調");
    expect(model.measureLabel).toBe("12 小節");
    expect(model.noteLabel).toBe("40 音");
    expect(model.openIssueLabel).toBe("3 件");
  });

  it("shows key transitions when the piece modulates (#146)", () => {
    const model = buildScoreInspector(
      {
        title: "Modulating Piece",
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: 0,
        keyChanges: [
          { measure: 1, fifths: 0 },
          { measure: 17, fifths: -5 },
        ],
        measureCount: 32,
        noteCount: 100,
      },
      0,
      copy,
    );
    expect(model.keyLabel).toBe("ハ長調 → 変ニ長調（第17小節）");
  });
});

describe("buildNoteInspector", () => {
  const concert = [
    note({ exportId: "hs-sn-000012", canonicalId: "sn-000012", step: "C", octave: 4, type: "quarter", measure: 4 }),
    note({ exportId: "hs-sn-000012-2", canonicalId: "sn-000012", step: "C", octave: 4, type: "whole", measure: 5, tied: true }),
  ];
  const written = [
    note({ exportId: "hs-sn-000012", canonicalId: "sn-000012", step: "G", octave: 4, type: "quarter", measure: 4 }),
    note({ exportId: "hs-sn-000012-2", canonicalId: "sn-000012", step: "G", octave: 4, type: "whole", measure: 5, tied: true }),
  ];
  const issues: ScoreReviewIssue[] = [
    {
      id: "ri-000001",
      scoreRevision: "rev-x",
      canonicalNoteIds: ["sn-000012"],
      reason: "quantization_ambiguous",
      severity: "caution",
      evidence: { confidence: 0.713 },
      status: "open",
    },
  ];

  it("builds the note-selected model with both presentations", () => {
    const model = buildNoteInspector({
      canonicalId: "sn-000012",
      concert,
      written,
      onsetMs: 7200,
      issues,
      copy,
    });
    expect(model.kind).toBe("note");
    expect(model.canonicalId).toBe("sn-000012");
    expect(model.concertPitch).toBe("C4");
    expect(model.writtenPitch).toBe("G4");
    expect(model.measure).toBe(4);
    expect(model.onsetLabel).toBe("第4小節（スコア 7.2 秒）");
    expect(model.tieLabel).toBe("タイで分割（2分割）");
    expect(model.issues[0]?.reasonTitle).toBe("title:quantization_ambiguous");
    expect(model.issues[0]?.confidencePct).toBe(71);
  });

  it("omits the written row when both presentations spell the same", () => {
    const model = buildNoteInspector({
      canonicalId: "sn-000001",
      concert: [note({ step: "C", octave: 4 })],
      written: [note({ step: "C", octave: 4 })],
      onsetMs: null,
      issues: [],
      copy,
    });
    expect(model.writtenPitch).toBeNull();
    expect(model.tieLabel).toBeNull();
  });

  it("handles rests (no canonical id, no issues)", () => {
    const model = buildNoteInspector({
      canonicalId: null,
      concert: [note({ canonicalId: null, isRest: true, exportId: "hs-rest-000001" })],
      written: [],
      onsetMs: null,
      issues: [],
      copy,
    });
    expect(model.canonicalId).toBeNull();
    expect(model.concertPitch).toBe("");
  });
});

describe("headlinePitch", () => {
  const model = buildNoteInspector({
    canonicalId: "sn-000012",
    concert: [note({ step: "C", octave: 4 })],
    written: [note({ step: "G", octave: 4 })],
    onsetMs: null,
    issues: [],
    copy,
  });

  it("leads with the presentation the user is viewing", () => {
    expect(headlinePitch(model, "concert").primary).toBe("C4");
    expect(headlinePitch(model, "hornF").primary).toBe("G4");
    expect(headlinePitch(model, "hornF").secondary).toBe("C4");
  });
});

describe("keyLabelJa", () => {
  it("maps fifths to Japanese key names", () => {
    expect(keyLabelJa(0)).toBe("ハ長調");
    expect(keyLabelJa(-1)).toBe("ヘ長調");
    expect(keyLabelJa(1)).toBe("ト長調");
    expect(keyLabelJa(42)).toBe("42");
  });
});
