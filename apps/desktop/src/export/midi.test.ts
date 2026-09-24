// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildMidiFile, midiNotesFromMusicXml } from "./midi";

const SCALE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <movement-title>Test</movement-title>
  <part-list><score-part id="P1"><part-name>Horn</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <sound tempo="120"/>
      <note id="hs-sn-000001-1"><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="hs-sn-000002-1"><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="hs-sn-000003-1"><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

const TIED_XML = `<?xml version="1.0"?>
<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>2</divisions></attributes>
      <sound tempo="60"/>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note>
      <note><rest/><duration>1</duration></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>
    </measure>
  </part>
</score-partwise>`;

describe("midiNotesFromMusicXml", () => {
  it("maps quarter/half durations to 480-tick onsets", () => {
    const { notes, tempoBpm, meter } = midiNotesFromMusicXml(SCALE_XML);
    expect(tempoBpm).toBe(120);
    expect(meter).toBe("4/4");
    expect(notes).toEqual([
      { on: 0, off: 480, midi: 60 },
      { on: 480, off: 960, midi: 64 },
      { on: 960, off: 1920, midi: 67 },
    ]);
  });

  it("merges tie start/stop pairs into one sustained note", () => {
    const { notes, tempoBpm } = midiNotesFromMusicXml(TIED_XML);
    expect(tempoBpm).toBe(60);
    // divisions=2: D4 spans 4 divisions = 960 ticks; F#4 follows a rest.
    expect(notes).toEqual([
      { on: 0, off: 960, midi: 62 },
      { on: 1200, off: 1440, midi: 66 },
    ]);
  });

  it("throws on malformed XML", () => {
    expect(() => midiNotesFromMusicXml("<score-partwise><part>")).toThrow();
  });
});

describe("buildMidiFile", () => {
  it("emits a valid SMF header and track chunk", () => {
    const bytes = buildMidiFile(SCALE_XML);
    // MThd, len 6, format 0, 1 track, 480 tpq
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64]);
    expect(Array.from(bytes.slice(4, 8))).toEqual([0, 0, 0, 6]);
    expect(Array.from(bytes.slice(8, 14))).toEqual([0, 0, 0, 1, 0x01, 0xe0]);
    expect(Array.from(bytes.slice(14, 18))).toEqual([0x4d, 0x54, 0x72, 0x6b]);
    const trackLen =
      (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
    expect(trackLen).toBe(bytes.length - 22);
    // End-of-track meta event is the last three bytes.
    expect(Array.from(bytes.slice(-3))).toEqual([0xff, 0x2f, 0x00]);
  });

  it("contains a tempo meta event for 120bpm (500000us/qn)", () => {
    const bytes = buildMidiFile(SCALE_XML);
    const body = Array.from(bytes);
    const idx = body.findIndex(
      (_, i) =>
        body[i] === 0xff && body[i + 1] === 0x51 && body[i + 2] === 0x03,
    );
    expect(idx).toBeGreaterThan(-1);
    const us = (body[idx + 3] << 16) | (body[idx + 4] << 8) | body[idx + 5];
    expect(us).toBe(500000);
  });

  it("emits program change + note on/off pairs", () => {
    const bytes = buildMidiFile(SCALE_XML);
    const body = Array.from(bytes);
    expect(body).toContain(0xc0);
    const noteOns = body.filter((b, i) => b === 0x90 && body[i + 2] === 80);
    const noteOffs = body.filter((b) => b === 0x80);
    expect(noteOns.length).toBe(3);
    expect(noteOffs.length).toBe(3);
  });
});
