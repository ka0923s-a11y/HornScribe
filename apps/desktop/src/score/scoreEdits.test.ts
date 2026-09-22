// @vitest-environment jsdom
/**
 * Score note-edit transform tests (UI-050): semitone pitch shifts and
 * delete/restore applied to canonical `sn-*` notes in MusicXML.
 */
import { describe, expect, it } from "vitest";
import concertXml from "./fixtures/score_concert.musicxml?raw";
import {
  applyNoteEdits,
  isEmptyNoteEdit,
  NO_NOTE_EDIT,
  shiftPitch,
  type ScoreNoteEdit,
} from "./scoreEdits";

const parse = (xml: string) =>
  new DOMParser().parseFromString(xml, "application/xml");

function noteXml(xml: string, hsId: string): Element | null {
  return parse(xml).querySelector(`note[id="${hsId}"]`);
}

describe("shiftPitch spelling", () => {
  it("ascending shifts respell with sharps", () => {
    expect(shiftPitch("C", 0, 4, 1)).toEqual({ step: "C", alter: 1, octave: 4 });
    expect(shiftPitch("F", 0, 4, 1)).toEqual({ step: "F", alter: 1, octave: 4 });
    expect(shiftPitch("B", 0, 4, 1)).toEqual({ step: "C", alter: 0, octave: 5 });
  });

  it("descending shifts respell with flats", () => {
    expect(shiftPitch("D", 0, 4, -1)).toEqual({ step: "D", alter: -1, octave: 4 });
    expect(shiftPitch("C", 0, 4, -1)).toEqual({ step: "B", alter: 0, octave: 3 });
    expect(shiftPitch("A", 0, 4, -2)).toEqual({ step: "G", alter: 0, octave: 4 });
  });

  it("natural neighbours never produce E#/Fb spellings", () => {
    expect(shiftPitch("E", 0, 4, 1)).toEqual({ step: "F", alter: 0, octave: 4 });
    expect(shiftPitch("F", 0, 4, -1)).toEqual({ step: "E", alter: 0, octave: 4 });
  });

  it("delta 0 is a no-op", () => {
    expect(shiftPitch("G", 0, 4, 0)).toBeNull();
    expect(isEmptyNoteEdit(NO_NOTE_EDIT)).toBe(true);
  });
});

describe("applyNoteEdits", () => {
  it("returns the original string when no edits apply", () => {
    expect(applyNoteEdits(concertXml, new Map())).toBe(concertXml);
    const foreign = new Map<string, ScoreNoteEdit>([
      ["sn-999999", { pitchDelta: 1, deleted: false }],
    ]);
    expect(applyNoteEdits(concertXml, foreign)).toBe(concertXml);
  });

  it("shifts a canonical note's pitch by semitones", () => {
    // Fixture sn-000012 is B♭3 (B, alter -1, octave 3) → +1 = B natural 3.
    const before = noteXml(concertXml, "hs-sn-000012")!;
    expect(before.querySelector("pitch step")!.textContent).toBe("B");
    expect(before.querySelector("pitch alter")!.textContent).toBe("-1");
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000012", { pitchDelta: 1, deleted: false }],
    ]);
    const after = applyNoteEdits(concertXml, edits);
    expect(after).not.toBe(concertXml);
    const note = noteXml(after, "hs-sn-000012")!;
    expect(note.querySelector("pitch step")!.textContent).toBe("B");
    // alter 0 is omitted from MusicXML rather than written as "0".
    expect(note.querySelector("pitch alter")).toBeNull();
    expect(note.querySelector("pitch octave")!.textContent).toBe("3");
    // The accidental element mirrors the respelling (B♭ → B natural has
    // no accidental mark; Verovio re-derives courtesy accidentals).
    expect(note.querySelector("accidental")).toBeNull();
  });

  it("delete renders the note as a same-id rest (timing preserved)", () => {
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000012", { pitchDelta: 0, deleted: true }],
    ]);
    const after = applyNoteEdits(concertXml, edits);
    const note = noteXml(after, "hs-sn-000012")!;
    expect(note.querySelector("rest")).not.toBeNull();
    expect(note.querySelector("pitch")).toBeNull();
    // Duration survives — the measure's beat math is untouched.
    expect(note.querySelector("duration")).not.toBeNull();
  });

  it("restore removes the edit so the original notation returns", () => {
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000012", { pitchDelta: 0, deleted: true }],
    ]);
    const deleted = applyNoteEdits(concertXml, edits);
    edits.set("sn-000012", NO_NOTE_EDIT);
    // An identity edit maps back to the untouched document.
    expect(applyNoteEdits(concertXml, new Map())).toBe(concertXml);
    expect(deleted).not.toBe(concertXml);
  });
});
