// @vitest-environment jsdom
/**
 * Score note-edit transform tests (UI-050): semitone pitch shifts and
 * delete/restore applied to canonical `sn-*` notes in MusicXML.
 */
import { describe, expect, it } from "vitest";
import concertXml from "./fixtures/score_concert.musicxml?raw";
import {
  applyNoteEdits,
  enharmonicRespell,
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

  it("enharmonic respells the same sounding pitch (#114)", () => {
    // sn-000012 is Bb3 -> respelled as A#3 (same MIDI 58).
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000012", { pitchDelta: 0, deleted: false, enharmonic: true }],
    ]);
    const after = applyNoteEdits(concertXml, edits);
    const note = noteXml(after, "hs-sn-000012")!;
    expect(note.querySelector("pitch step")!.textContent).toBe("A");
    expect(note.querySelector("pitch alter")!.textContent).toBe("1");
    expect(note.querySelector("pitch octave")!.textContent).toBe("3");
    expect(note.querySelector("accidental")!.textContent).toBe("sharp");
  });

  it("enharmonic applies after a pitch shift", () => {
    // Bb3 +3 semitones = C#4 (shift respells sharp-side); respelled
    // -> Db4 (same MIDI 61).
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000012", { pitchDelta: 3, deleted: false, enharmonic: true }],
    ]);
    const after = applyNoteEdits(concertXml, edits);
    const note = noteXml(after, "hs-sn-000012")!;
    expect(note.querySelector("pitch step")!.textContent).toBe("D");
    expect(note.querySelector("pitch alter")!.textContent).toBe("-1");
    expect(note.querySelector("pitch octave")!.textContent).toBe("4");
  });

  /* #246: deleting chord members must keep the <chord/> structure valid. */

  const chordXml = `<?xml version="1.0"?><score-partwise><part><measure number="1">
    <note id="hs-sn-000001"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
    <note id="hs-sn-000002"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
    <note id="hs-sn-000003"><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>
    <note id="hs-sn-000004"><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note>
  </measure></part></score-partwise>`;

  const chordNotes = (xml: string) =>
    Array.from(parse(xml).querySelectorAll("measure > note"));

  it("deleting a non-root member drops it without a chord-rest", () => {
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000002", { pitchDelta: 0, deleted: true }],
    ]);
    const notes = chordNotes(applyNoteEdits(chordXml, edits));
    expect(notes).toHaveLength(3);
    expect(notes[0].querySelector("pitch step")!.textContent).toBe("C");
    expect(notes[0].querySelector("chord")).toBeNull();
    expect(notes[1].querySelector("chord")).not.toBeNull();
    expect(notes[1].querySelector("pitch step")!.textContent).toBe("G");
    // No chord-rest anywhere.
    expect(
      notes.some(
        (n) =>
          n.querySelector(":scope > chord") && n.querySelector(":scope > rest"),
      ),
    ).toBe(false);
  });

  it("deleting the root promotes the next pitched member", () => {
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000001", { pitchDelta: 0, deleted: true }],
    ]);
    const notes = chordNotes(applyNoteEdits(chordXml, edits));
    expect(notes).toHaveLength(3);
    // E4 is now the root: pitched, no <chord/> tag.
    expect(notes[0].querySelector("pitch step")!.textContent).toBe("E");
    expect(notes[0].querySelector("chord")).toBeNull();
    expect(notes[1].querySelector("chord")).not.toBeNull();
    expect(notes[1].querySelector("pitch step")!.textContent).toBe("G");
  });

  it("deleting every member collapses to a single rest", () => {
    const edits = new Map<string, ScoreNoteEdit>([
      ["sn-000001", { pitchDelta: 0, deleted: true }],
      ["sn-000002", { pitchDelta: 0, deleted: true }],
      ["sn-000003", { pitchDelta: 0, deleted: true }],
    ]);
    const notes = chordNotes(applyNoteEdits(chordXml, edits));
    expect(notes).toHaveLength(2);
    expect(notes[0].querySelector("rest")).not.toBeNull();
    expect(notes[0].querySelector("chord")).toBeNull();
    expect(notes[1].querySelector("pitch step")!.textContent).toBe("D");
  });
});

describe("enharmonicRespell", () => {
  it("flips sharp/flat families keeping the same pitch class", () => {
    expect(enharmonicRespell("C", 1, 4)).toEqual({
      step: "D",
      alter: -1,
      octave: 4,
    });
    expect(enharmonicRespell("B", -1, 3)).toEqual({
      step: "A",
      alter: 1,
      octave: 3,
    });
  });

  it("keeps the sounding octave across boundary spellings", () => {
    // B#3 (MIDI 60) -> C4; Cb4 (MIDI 59) -> B3.
    expect(enharmonicRespell("B", 1, 3)).toEqual({
      step: "C",
      alter: 0,
      octave: 4,
    });
    expect(enharmonicRespell("C", -1, 4)).toEqual({
      step: "B",
      alter: 0,
      octave: 3,
    });
  });

  it("returns null when the other family is the same spelling", () => {
    // Naturals have no single-accidental partner (E#/Cb spellings are
    // deliberately not produced), so respell is a no-op there.
    expect(enharmonicRespell("F", 0, 4)).toBeNull();
    expect(enharmonicRespell("C", 0, 4)).toBeNull();
  });
});
