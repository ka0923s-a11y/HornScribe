// Deterministic generator for the UI-005 sync fixtures.
// Emits fixtures/sync_concert.musicxml + fixtures/sync_horn_in_f.musicxml
// + fixtures/sync_b_flat.musicxml (#156)
// following the ENG-001 ID rules (python/hornscribe/domain/ids.py):
//   canonical note -> hs-sn-<6 digits>          (tie fragment k>1 -> hs-sn-<6 digits>-k)
//   rest           -> hs-rest-<6 digits>         (presentation-only)
//
// 12 bars, 4/4, 100 BPM, divisions=480 (1 ql = 480 ticks).
// Known onsets: every canonical note's onset in ql is derivable from the
// note table below — vitest asserts the parsed SyncMap against them.
// Horn fixture is the same canonical content in written pitch (concert +P5,
// key sig 0 -> 1 fifth, transpose diatonic -4 / chromatic -7); the B-flat
// fixture is concert +M2 (key sig 0 -> 2 fifths, transpose -1 / -2), so the
// trio exercises Concert<->F管<->B♭管 switches with identical hs-sn-* ids.
//
// Run: npm run gen:fixtures  (output is committed; regenerate only to change content)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');

const DIVISIONS = 480; // ticks per quarter note
const BPM = 100;
const E = DIVISIONS / 2;   // eighth
const Q = DIVISIONS;       // quarter
const DQ = DIVISIONS * 1.5; // dotted quarter
const H = DIVISIONS * 2;   // half

// ---- note table (concert pitch) ------------------------------------------
// type: whole/half/quarter/eighth; dots: n; tie: 'start'|'stop'|'stopstart';
// accidental: MusicXML accidental name when an explicit sign is needed.
// `rest: true` for rests (no canonical id).
const MEASURES = [
  // m1  ql 0–4
  [
    { step: 'C', octave: 4, dur: Q, type: 'quarter' },
    { step: 'E', octave: 4, dur: E, type: 'eighth' },
    { step: 'G', octave: 4, dur: E, type: 'eighth' },
    { step: 'C', octave: 5, dur: Q, type: 'quarter' },
    { step: 'G', octave: 4, dur: Q, type: 'quarter' },
  ],
  // m2  ql 4–8
  [
    { step: 'A', octave: 4, dur: Q, type: 'quarter' },
    { step: 'F', octave: 4, dur: E, type: 'eighth' },
    { step: 'G', octave: 4, dur: E, type: 'eighth' },
    { step: 'E', octave: 4, dur: H, type: 'half' },
  ],
  // m3  ql 8–12  — Bb3 tied across the barline (2 fragments)
  [
    { step: 'D', octave: 4, dur: Q, type: 'quarter' },
    { step: 'F', alter: 1, octave: 4, dur: Q, type: 'quarter', accidental: 'sharp' },
    { step: 'B', alter: -1, octave: 3, dur: DQ, type: 'quarter', dots: 1, tie: 'start', accidental: 'flat' },
    { step: 'A', octave: 3, dur: E, type: 'eighth' },
  ],
  // m4  ql 12–16
  [
    { step: 'B', alter: -1, octave: 3, dur: H, type: 'half', tie: 'stop', continueTie: true },
    { rest: true, dur: H, type: 'half' },
  ],
  // m5  ql 16–20
  [
    { step: 'C', octave: 4, dur: E, type: 'eighth' },
    { step: 'D', octave: 4, dur: E, type: 'eighth' },
    { step: 'E', octave: 4, dur: E, type: 'eighth' },
    { step: 'F', octave: 4, dur: E, type: 'eighth' },
    { step: 'G', octave: 4, dur: Q, type: 'quarter' },
    { step: 'A', octave: 4, dur: Q, type: 'quarter' },
  ],
  // m6  ql 20–24
  [
    { step: 'B', alter: -1, octave: 4, dur: DQ, type: 'quarter', dots: 1, accidental: 'flat' },
    { step: 'A', octave: 4, dur: E, type: 'eighth' },
    { step: 'G', octave: 4, dur: H, type: 'half' },
  ],
  // m7  ql 24–28 — D4 tied into m8 (2 fragments)
  [
    { step: 'F', octave: 4, dur: Q, type: 'quarter' },
    { step: 'E', octave: 4, dur: Q, type: 'quarter' },
    { step: 'D', octave: 4, dur: H, type: 'half', tie: 'start' },
  ],
  // m8  ql 28–32
  [
    { step: 'D', octave: 4, dur: E, type: 'eighth', tie: 'stop', continueTie: true },
    { step: 'E', octave: 4, dur: E, type: 'eighth' },
    { step: 'F', octave: 4, dur: H, type: 'half' },
    { rest: true, dur: Q, type: 'quarter' },
  ],
  // m9  ql 32–36
  [
    { step: 'G', octave: 4, dur: Q, type: 'quarter' },
    { step: 'A', octave: 4, dur: Q, type: 'quarter' },
    { step: 'B', octave: 4, dur: Q, type: 'quarter' },
    { step: 'C', octave: 5, dur: Q, type: 'quarter' },
  ],
  // m10  ql 36–40
  [
    { step: 'D', octave: 5, dur: H, type: 'half' },
    { step: 'C', octave: 5, dur: E, type: 'eighth' },
    { step: 'B', octave: 4, dur: E, type: 'eighth' },
    { step: 'G', octave: 4, dur: Q, type: 'quarter' },
  ],
  // m11  ql 40–44 — G4 tied into m12 (3 fragments total)
  [
    { step: 'A', octave: 4, dur: Q, type: 'quarter' },
    { step: 'F', octave: 4, dur: Q, type: 'quarter' },
    { step: 'G', octave: 4, dur: H, type: 'half', tie: 'start' },
  ],
  // m12  ql 44–48
  [
    { step: 'G', octave: 4, dur: Q, type: 'quarter', tie: 'stopstart', continueTie: true },
    { step: 'G', octave: 4, dur: E, type: 'eighth', tie: 'stop', continueTie: true },
    { step: 'F', octave: 4, dur: E, type: 'eighth' },
    { step: 'E', octave: 4, dur: H, type: 'half' },
  ],
];

// Written views (ENG-001 presentations): horn in F projects concert up a
// perfect 5th (+7 semitones, +4 diatonic, key +1 fifth, <transpose> -4/-7);
// horn in B♭ projects up a major 2nd (+2 semitones, +1 diatonic, key +2
// fifths, <transpose> -1/-2). Same projection shape as
// python/hornscribe/instruments/transposition.py — keep them in lockstep.
const STEP_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const INDEX_STEP = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

// Key signature -> implicit alter per step: sharp keys sharpen the first
// `fifths` of F,C,G,D,A,E,B; flat keys flatten the first |fifths| of
// B,E,A,D,G,C,F. (Fixture fifths stay within [-2, 2].)
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
function implicitAlter(step, fifths) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

const WRITTEN_VIEWS = {
  hornF: {
    semitones: 7,
    diatonic: 4,
    fifths: 1,
    transposeDiatonic: -4,
    transposeChromatic: -7,
    label: 'Horn in F',
    titleSuffix: ' (Horn in F)',
    movementSuffix: ' — F管ホルン',
  },
  bFlat: {
    semitones: 2,
    diatonic: 1,
    fifths: 2,
    transposeDiatonic: -1,
    transposeChromatic: -2,
    label: 'Horn in B♭',
    titleSuffix: ' (Horn in B♭)',
    movementSuffix: ' — B♭管ホルン',
  },
};

function toWrittenPitch(step, alter = 0, octave, view) {
  // Transpose sounding midi up the view's interval, then re-spell the
  // diatonic steps (written pitch sits above sounding pitch for both).
  const midi = (octave + 1) * 12 + STEP_SEMITONE[step] + alter + view.semitones;
  const newOctave = Math.floor(midi / 12) - 1;
  const pc = midi % 12;
  const newStep = INDEX_STEP[(STEP_INDEX[step] + view.diatonic) % 7];
  const newAlter = pc - STEP_SEMITONE[newStep];
  return { step: newStep, alter: newAlter, octave: newOctave };
}

// Accidental name for the *written* pitch under the view's key signature.
// Emit only when the written alter deviates from the signature — e.g.
// concert Bb -> written C natural in the B♭ view needs 'natural' (D
// major's C is sharp by default), concert F# -> written C# needs 'sharp'
// in the F view but is implicit in the B♭ view.
function writtenAccidental(step, alter, fifths) {
  if (alter === implicitAlter(step, fifths)) return null;
  if (alter === 1) return 'sharp';
  if (alter === -1) return 'flat';
  return 'natural';
}

let noteSeq = 0;
let restSeq = 0;
let openTieSeq = null; // canonical seq of the note with an open tie
let openTieFrag = 0;   // last fragment ordinal emitted for it

function noteXml(n, id, pitch /* {step, alter, octave} */, accidental) {
  const lines = [];
  lines.push(`      <note id="${id}">`);
  if (n.rest) {
    lines.push('        <rest />');
  } else {
    lines.push('        <pitch>');
    lines.push(`          <step>${pitch.step}</step>`);
    // Emit <alter> when non-zero, and explicitly as 0 when an accidental
    // documents a deviation from the key (golden fixture convention).
    if (pitch.alter || accidental) lines.push(`          <alter>${pitch.alter}</alter>`);
    lines.push(`          <octave>${pitch.octave}</octave>`);
    lines.push('        </pitch>');
  }
  lines.push(`        <duration>${n.dur}</duration>`);
  if (n.tie === 'stop' || n.tie === 'stopstart') lines.push('        <tie type="stop" />');
  if (n.tie === 'start' || n.tie === 'stopstart') lines.push('        <tie type="start" />');
  lines.push(`        <type>${n.type}</type>`);
  for (let i = 0; i < (n.dots ?? 0); i++) lines.push('        <dot />');
  if (accidental) lines.push(`        <accidental>${accidental}</accidental>`);
  if (n.tie) {
    lines.push('        <notations>');
    if (n.tie === 'stop' || n.tie === 'stopstart') lines.push('          <tied type="stop" />');
    if (n.tie === 'start' || n.tie === 'stopstart') lines.push('          <tied type="start" />');
    lines.push('        </notations>');
  }
  lines.push('      </note>');
  return lines.join('\n');
}

function emit(xmlNoteTable, viewId) {
  const view = WRITTEN_VIEWS[viewId] ?? null;
  noteSeq = 0;
  restSeq = 0;

  const measuresOut = [];
  xmlNoteTable.forEach((notes, mi) => {
    const body = [];
    if (mi === 0) {
      body.push(`      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key>
          <fifths>${view ? view.fifths : 0}</fifths>
        </key>
        <time>
          <beats>4</beats>
          <beat-type>4</beat-type>
        </time>
        <clef>
          <sign>G</sign>
          <line>2</line>
        </clef>${view ? `
        <transpose>
          <diatonic>${view.transposeDiatonic}</diatonic>
          <chromatic>${view.transposeChromatic}</chromatic>
        </transpose>` : ''}
      </attributes>`);
      body.push(`      <direction>
        <direction-type>
          <metronome parentheses="no">
            <beat-unit>quarter</beat-unit>
            <per-minute>${BPM}</per-minute>
          </metronome>
        </direction-type>
        <sound tempo="${BPM}" />
      </direction>`);
    }
    for (const n of notes) {
      let id;
      if (n.rest) {
        id = `hs-rest-${String(++restSeq).padStart(6, '0')}`;
      } else if (n.continueTie) {
        // Tie fragment k>=2 of the note that opened the tie. Fragments are
        // consecutive <note> elements of the same canonical note, but other
        // canonical notes (e.g. the A3 eighth in m.3) may intervene, so the
        // open tie is tracked separately from "previous note".
        if (openTieSeq === null) {
          throw new Error(`continueTie with no open tie (measure ${mi + 1})`);
        }
        openTieFrag += 1;
        id = `hs-sn-${String(openTieSeq).padStart(6, '0')}-${openTieFrag}`;
        if (n.tie === 'stop') openTieSeq = null; // 'stopstart' keeps it open
      } else {
        id = `hs-sn-${String(++noteSeq).padStart(6, '0')}`;
        if (n.tie === 'start' || n.tie === 'stopstart') {
          openTieSeq = noteSeq;
          openTieFrag = 1;
        }
      }
      const pitch = n.rest
        ? null
        : view
          ? toWrittenPitch(n.step, n.alter ?? 0, n.octave, view)
          : { step: n.step, alter: n.alter ?? 0, octave: n.octave };
      const accidental = n.rest
        ? null
        : view
          ? writtenAccidental(pitch.step, pitch.alter, view.fifths)
          : n.accidental ?? null;
      body.push(noteXml(n, id, pitch, accidental));
    }
    measuresOut.push(`    <measure implicit="no" number="${mi + 1}">\n${body.join('\n')}\n    </measure>`);
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Sync Fixture${view ? view.titleSuffix : ''}</work-title>
  </work>
  <movement-title>UI-005 Sync Fixture${view ? view.movementSuffix : ''}</movement-title>
  <identification>
    <creator type="composer">HornScribe spike generator</creator>
    <encoding>
      <software>apps/spikes/score-audio-sync/scripts/gen-fixtures.mjs</software>
      <supports element="beam" type="yes" />
      <supports element="stem" type="yes" />
      <supports element="accidental" type="yes" />
    </encoding>
  </identification>
  <defaults>
    <scaling>
      <millimeters>7</millimeters>
      <tenths>40</tenths>
    </scaling>
  </defaults>
  <part-list>
    <score-part id="P1">
      <part-name>${view ? view.label : 'Horn in F'}</part-name>${view ? `
      <score-instrument id="I1">
        <instrument-name>${view.label}</instrument-name>
      </score-instrument>
      <midi-instrument id="I1">
        <midi-channel>1</midi-channel>
        <midi-program>61</midi-program>
      </midi-instrument>` : ''}
    </score-part>
  </part-list>
  <part id="P1">
${measuresOut.join('\n')}
  </part>
</score-partwise>
`;
}

const concert = emit(MEASURES, 'concert');
const horn = emit(MEASURES, 'hornF');
const bFlat = emit(MEASURES, 'bFlat');
writeFileSync(join(outDir, 'sync_concert.musicxml'), concert, 'utf8');
writeFileSync(join(outDir, 'sync_horn_in_f.musicxml'), horn, 'utf8');
writeFileSync(join(outDir, 'sync_b_flat.musicxml'), bFlat, 'utf8');
console.log(`wrote sync_concert/horn_in_f/b_flat.musicxml (${noteSeq} canonical notes, ${restSeq} rests, ${MEASURES.length} measures, ${BPM} BPM)`);
