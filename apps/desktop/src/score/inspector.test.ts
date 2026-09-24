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
  key: (fifths, mode) => keyLabelJa(fifths, mode),
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
        composer: null,
        arranger: null,
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: -1,
        keyChanges: [],
tempoChanges: [],
        keyMode: null,
        swingFeel: false,
        omittedIssueCount: 0,
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
        composer: null,
        arranger: null,
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: 0,
        keyChanges: [
          { measure: 1, fifths: 0, mode: null },
          { measure: 17, fifths: -5, mode: null },
        ],
        tempoChanges: [],
        keyMode: null,
        swingFeel: false,
        omittedIssueCount: 0,
        measureCount: 32,
        noteCount: 100,
      },
      0,
      copy,
    );
    expect(model.keyLabel).toBe("ハ長調 → 変ニ長調（第17小節）");
  });

  it("labels minor keys with the minor name (#252)", () => {
    const model = buildScoreInspector(
      {
        title: "Minor Piece",
        composer: null,
        arranger: null,
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: 0,
        keyChanges: [{ measure: 1, fifths: 0, mode: "minor" }],
tempoChanges: [],
        keyMode: "minor",
        swingFeel: false,
        omittedIssueCount: 0,
        measureCount: 8,
        noteCount: 20,
      },
      0,
      copy,
    );
    expect(model.keyLabel).toBe("イ短調");
  });

  it("projects signatures +1 fifth in the written horn view (#270)", () => {
    const meta = {
      title: "Horn Piece",
        composer: null,
        arranger: null,
      tempoBpm: 100,
      meter: "4/4",
      keyFifths: -1,
      keyChanges: [],
tempoChanges: [],
      keyMode: null,
      swingFeel: false,
      omittedIssueCount: 0,
      measureCount: 8,
      noteCount: 20,
    };
    const concert = buildScoreInspector(meta, 0, copy, "concert");
    const horn = buildScoreInspector(meta, 0, copy, "hornF");
    expect(concert.keyLabel).toBe("ヘ長調");
    expect(horn.keyLabel).toBe("ハ長調");
    expect(horn.keyFifths).toBe(0);
    // Fold: concert +7 (嬰ハ長調) writes as -4 (変イ長調).
    const sharp = buildScoreInspector({ ...meta, keyFifths: 7 }, 0, copy, "hornF");
    expect(sharp.keyFifths).toBe(-4);
    expect(sharp.keyLabel).toBe("変イ長調");
  });

  it("carries the key-change map for the boundary editor (#145)", () => {
    const model = buildScoreInspector(
      {
        title: "Modulating Piece",
        composer: null,
        arranger: null,
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: 0,
        keyChanges: [
          { measure: 1, fifths: 0, mode: null },
          { measure: 17, fifths: -5, mode: "minor" },
        ],
        tempoChanges: [],
        keyMode: null,
        swingFeel: false,
        omittedIssueCount: 0,
        measureCount: 32,
        noteCount: 100,
      },
      0,
      copy,
    );
    expect(model.keyChanges).toEqual([
      { measure: 1, fifths: 0, mode: null },
      { measure: 17, fifths: -5, mode: "minor" },
    ]);
    expect(model.measureCount).toBe(32);
    // Written view projects every boundary +1 fifth, folded.
    const horn = buildScoreInspector(
      {
        title: "Modulating Piece",
        composer: null,
        arranger: null,
        tempoBpm: 100,
        meter: "4/4",
        keyFifths: 0,
        keyChanges: [
          { measure: 1, fifths: 7, mode: null },
          { measure: 9, fifths: -5, mode: null },
        ],
        tempoChanges: [],
        keyMode: null,
        swingFeel: false,
        omittedIssueCount: 0,
        measureCount: 16,
        noteCount: 50,
      },
      0,
      copy,
      "hornF",
    );
    expect(horn.keyChanges).toEqual([
      { measure: 1, fifths: -4, mode: null },
      { measure: 9, fifths: -4, mode: null },
    ]);
  });
});

describe("buildNoteInspector", () => {
  const concert = [
    note({
      exportId: "hs-sn-000012",
      canonicalId: "sn-000012",
      step: "C",
      octave: 4,
      type: "quarter",
      measure: 4,
    }),
    note({
      exportId: "hs-sn-000012-2",
      canonicalId: "sn-000012",
      step: "C",
      octave: 4,
      type: "whole",
      measure: 5,
      tied: true,
    }),
  ];
  const written = [
    note({
      exportId: "hs-sn-000012",
      canonicalId: "sn-000012",
      step: "G",
      octave: 4,
      type: "quarter",
      measure: 4,
    }),
    note({
      exportId: "hs-sn-000012-2",
      canonicalId: "sn-000012",
      step: "G",
      octave: 4,
      type: "whole",
      measure: 5,
      tied: true,
    }),
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
      concert: [
        note({ canonicalId: null, isRest: true, exportId: "hs-rest-000001" }),
      ],
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
  it("names minor signatures when mode is minor (#252)", () => {
    expect(keyLabelJa(0, "minor")).toBe("イ短調");
    expect(keyLabelJa(-1, "minor")).toBe("ニ短調");
    expect(keyLabelJa(1, "minor")).toBe("ホ短調");
    expect(keyLabelJa(-3, "minor")).toBe("ハ短調");
    expect(keyLabelJa(0, null)).toBe("ハ長調");
  });
});
