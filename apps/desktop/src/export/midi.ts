/**
 * MusicXML → SMF (Standard MIDI File, format 0) builder for the
 * 再生用MIDI export (#99).
 *
 * Pure-JS: parses the concert-pitch MusicXML with DOMParser, walks the
 * note stream honouring <chord/>, <backup>/<forward>, per-measure
 * <divisions>, tie merge (start/stop pairs become one sustained note)
 * and the <sound tempo> / <time> meta events, then serializes a
 * single-track SMF at 480 ticks per quarter.
 *
 * Scope: single-part monophonic output (the engine's contract); chord
 * members and multi-voice <backup> content are still emitted correctly
 * since the walking algorithm is generic.
 */

const TICKS_PER_QUARTER = 480;
/** GM program 60 = French Horn (0-indexed program change byte). */
const HORN_PROGRAM = 60;
const DEFAULT_VELOCITY = 80;

interface MidiNote {
  /** Absolute onset in ticks. */
  on: number;
  /** Absolute release in ticks (> on). */
  off: number;
  midi: number;
}

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function noteMidi(el: Element): number | null {
  const pitch = el.querySelector(":scope > pitch");
  if (!pitch) return null;
  const step = pitch.querySelector("step")?.textContent ?? "";
  const base = STEP_TO_SEMITONE[step];
  const octaveText = pitch.querySelector("octave")?.textContent;
  if (base === undefined || octaveText == null) return null;
  const alter = Number(pitch.querySelector("alter")?.textContent ?? 0);
  const octave = Number(octaveText);
  if (!Number.isFinite(alter) || !Number.isFinite(octave)) return null;
  return base + alter + (octave + 1) * 12;
}

function varLen(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function u32(v: number): number[] {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Tempo BPM → microseconds-per-quarter meta event body. */
function tempoMeta(bpm: number): number[] {
  const us = Math.round(60_000_000 / bpm);
  return [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff];
}

/** Time-signature meta event body for "n/d" (d must be a power of 2). */
function timeSigMeta(meter: string | null): number[] | null {
  if (!meter) return null;
  const [n, d] = meter.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) {
    return null;
  }
  const dd = Math.round(Math.log2(d));
  if (2 ** dd !== d) return null;
  return [0xff, 0x58, 0x04, n & 0xff, dd & 0xff, 24, 8];
}

/**
 * Parse the concert MusicXML into absolute-tick note events.
 * Throws on malformed XML (same policy as parseScoreDoc).
 */
export function midiNotesFromMusicXml(xml: string): {
  notes: MidiNote[];
  tempoBpm: number;
  meter: string | null;
} {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("MusicXML parse failed");
  }
  const tempoText = doc.querySelector("sound[tempo]")?.getAttribute("tempo");
  const tempoBpm =
    tempoText != null && Number.isFinite(Number(tempoText)) && Number(tempoText) > 0
      ? Number(tempoText)
      : 120;
  const beats = doc.querySelector("time > beats")?.textContent?.trim();
  const beatType = doc.querySelector("time > beat-type")?.textContent?.trim();
  const meter = beats && beatType ? `${beats}/${beatType}` : null;

  const notes: MidiNote[] = [];
  // pitch → open tie note (start/stop chains merge into one event).
  const openTies = new Map<number, MidiNote>();
  // Per-part walk so <backup> only rewinds its own part's cursor.
  for (const part of Array.from(doc.querySelectorAll("part"))) {
    let divisions = 1; // quarter-note units per <duration> tick
    let cursor = 0;   // divisions
    for (const measure of Array.from(part.querySelectorAll(":scope > measure"))) {
      for (const el of Array.from(measure.children)) {
        if (el.tagName === "attributes") {
          const d = el.querySelector("divisions")?.textContent;
          if (d != null && Number.isFinite(Number(d)) && Number(d) > 0) {
            divisions = Number(d);
          }
          continue;
        }
        if (el.tagName === "backup" || el.tagName === "forward") {
          const dur = Number(el.querySelector("duration")?.textContent ?? 0);
          if (Number.isFinite(dur)) {
            cursor += el.tagName === "backup" ? -dur : dur;
            if (cursor < 0) cursor = 0;
          }
          continue;
        }
        if (el.tagName !== "note") continue;

        const isChord = el.querySelector(":scope > chord") !== null;
        const dur = Number(el.querySelector(":scope > duration")?.textContent ?? 0);
        const isRest = el.querySelector(":scope > rest") !== null;
        const isGrace = el.querySelector(":scope > grace") !== null;
        const midi = isRest || isGrace ? null : noteMidi(el);

        if (midi !== null && dur > 0) {
          const onTick = Math.round((cursor * TICKS_PER_QUARTER) / divisions);
          const offTick = Math.round(
            ((cursor + dur) * TICKS_PER_QUARTER) / divisions,
          );
          const tieStart =
            el.querySelector('tie[type="start"]') !== null;
          const tieStop = el.querySelector('tie[type="stop"]') !== null;
          const open = openTies.get(midi);
          if (tieStop && open && open.on < onTick) {
            // Continuation: extend the open note instead of re-striking.
            open.off = Math.max(open.off, offTick);
            if (!tieStart) openTies.delete(midi);
          } else {
            const note: MidiNote = { on: onTick, off: offTick, midi };
            notes.push(note);
            if (tieStart) openTies.set(midi, note);
          }
        }
        // Chord members share the previous note's onset: the cursor
        // only advances for non-chord notes.
        if (!isChord && Number.isFinite(dur)) cursor += dur;
      }
    }
  }
  notes.sort((a, b) => a.on - b.on || a.midi - b.midi);
  return { notes, tempoBpm, meter };
}

/** Serialize parsed notes into an SMF format-0 byte array. */
export function buildMidiFile(xml: string): Uint8Array {
  const { notes, tempoBpm, meter } = midiNotesFromMusicXml(xml);

  // Flatten into (tick, order, bytes) events; note-offs sort before
  // note-ons at the same tick so a boundary never overlaps itself.
  interface Ev { tick: number; order: number; bytes: number[] }
  const events: Ev[] = [];
  const meta = [tempoMeta(tempoBpm), timeSigMeta(meter)].filter(
    (m): m is number[] => m !== null,
  );
  for (const m of meta) events.push({ tick: 0, order: 0, bytes: m });
  events.push({ tick: 0, order: 1, bytes: [0xc0, HORN_PROGRAM] });
  for (const n of notes) {
    events.push({
      tick: n.on,
      order: 2,
      bytes: [0x90, n.midi & 0x7f, DEFAULT_VELOCITY],
    });
    events.push({
      tick: n.off,
      order: 1,
      bytes: [0x80, n.midi & 0x7f, 0],
    });
  }
  const lastTick = notes.reduce((m, n) => Math.max(m, n.off), 0);
  events.push({ tick: lastTick, order: 3, bytes: [0xff, 0x2f, 0x00] });
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let prev = 0;
  for (const ev of events) {
    track.push(...varLen(ev.tick - prev), ...ev.bytes);
    prev = ev.tick;
  }

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    ...u32(6),
    ...u16(0), // format 0
    ...u16(1), // one track
    ...u16(TICKS_PER_QUARTER),
  ];
  const trackChunk = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    ...u32(track.length),
    ...track,
  ];
  return new Uint8Array([...header, ...trackChunk]);
}
