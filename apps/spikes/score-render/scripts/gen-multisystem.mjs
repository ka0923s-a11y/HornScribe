// Deterministic generator for the spike-only multi-system fixture.
// Emits fixtures/multisystem_concert.musicxml following the ENG-001 ID rules:
//   canonical note -> hs-sn-<6 digits>         (fragment k>1 -> hs-sn-<6 digits>-k)
//   rest           -> hs-rest-<6 digits>        (presentation-only)
// Run: npm run gen:multisystem   (output is committed; regenerate only to change content)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'fixtures', 'multisystem_concert.musicxml');

const DIVISIONS = 480; // ticks per quarter note
const MEASURES = 24;
const QUARTER = DIVISIONS;
const EIGHTH = DIVISIONS / 2;
const HALF = DIVISIONS * 2;
const WHOLE = DIVISIONS * 4;

let noteSeq = 0;
let restSeq = 0;
const snId = () => `hs-sn-${String(++noteSeq).padStart(6, '0')}`;
const restId = () => `hs-rest-${String(++restSeq).padStart(6, '0')}`;

function pitchNote({ id, step, alter = 0, octave, duration, type, dots = 0, tie = null, accidental = null }) {
  const lines = [];
  lines.push(`      <note id="${id}">`);
  lines.push('        <pitch>');
  lines.push(`          <step>${step}</step>`);
  if (alter !== 0) lines.push(`          <alter>${alter}</alter>`);
  lines.push(`          <octave>${octave}</octave>`);
  lines.push('        </pitch>');
  lines.push(`        <duration>${duration}</duration>`);
  if (tie === 'stop' || tie === 'stopstart') lines.push('        <tie type="stop" />');
  if (tie === 'start' || tie === 'stopstart') lines.push('        <tie type="start" />');
  lines.push(`        <type>${type}</type>`);
  for (let i = 0; i < dots; i++) lines.push('        <dot />');
  if (accidental) lines.push(`        <accidental>${accidental}</accidental>`);
  if (tie) {
    lines.push('        <notations>');
    if (tie === 'stop' || tie === 'stopstart') lines.push('          <tied type="stop" />');
    if (tie === 'start' || tie === 'stopstart') lines.push('          <tied type="start" />');
    lines.push('        </notations>');
  }
  lines.push('      </note>');
  return lines.join('\n');
}

function restNote({ duration, type, dots = 0 }) {
  return [
    `      <note id="${restId()}">`,
    '        <rest />',
    `        <duration>${duration}</duration>`,
    `        <type>${type}</type>`,
    ...(dots ? Array.from({ length: dots }, () => '        <dot />') : []),
    '      </note>',
  ].join('\n');
}

// Scale degree pattern in D major written pitch space (fixture is "concert" labelled,
// content only needs to be valid + deterministic for the rendering spike).
const STEPS = [
  { step: 'D', octave: 5 }, { step: 'E', octave: 5 }, { step: 'F', alter: 1, octave: 5 },
  { step: 'G', octave: 5 }, { step: 'A', octave: 5 }, { step: 'B', octave: 4 },
  { step: 'C', alter: 1, octave: 5 }, { step: 'D', octave: 5 },
];

const measures = [];
for (let m = 1; m <= MEASURES; m++) {
  const body = [];
  if (m === 1) {
    body.push(`      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key>
          <fifths>2</fifths>
        </key>
        <time>
          <beats>4</beats>
          <beat-type>4</beat-type>
        </time>
        <clef>
          <sign>G</sign>
          <line>2</line>
        </clef>
      </attributes>`);
    body.push(`      <direction>
        <direction-type>
          <metronome parentheses="no">
            <beat-unit>quarter</beat-unit>
            <per-minute>120</per-minute>
          </metronome>
        </direction-type>
        <sound tempo="120" />
      </direction>`);
  }
  if (m === 9) {
    // chromatic color: explicit G# and Bb accidentals in a G-major-ish bar
    body.push(pitchNote({ id: snId(), step: 'G', alter: 1, octave: 4, duration: QUARTER, type: 'quarter', accidental: 'sharp' }));
    body.push(pitchNote({ id: snId(), step: 'B', alter: -1, octave: 4, duration: QUARTER, type: 'quarter', accidental: 'flat' }));
    body.push(pitchNote({ id: snId(), step: 'A', octave: 4, duration: EIGHTH, type: 'eighth' }));
    body.push(pitchNote({ id: snId(), step: 'B', octave: 4, duration: EIGHTH, type: 'eighth' }));
    body.push(restNote({ duration: QUARTER, type: 'quarter' }));
  } else if (m === 11) {
    // canonical note tied across the barline: dotted quarter -> half + eighth (3 fragments)
    body.push(pitchNote({ id: snId(), step: 'A', octave: 4, duration: QUARTER, type: 'quarter' }));
    body.push(pitchNote({ id: snId(), step: 'B', octave: 4, duration: QUARTER, type: 'quarter' }));
    const tiedId = snId(); // fragment 1 carries the canonical export id
    body.push(pitchNote({ id: tiedId, step: 'D', octave: 5, duration: QUARTER + EIGHTH, type: 'quarter', dots: 1, tie: 'start' }));
    body.push(restNote({ duration: EIGHTH, type: 'eighth' }));
  } else if (m === 12) {
    const canonical = noteSeq; // continue the tie from m.11
    body.push(pitchNote({ id: `hs-sn-${String(canonical).padStart(6, '0')}-2`, step: 'D', octave: 5, duration: HALF, type: 'half', tie: 'stopstart' }));
    body.push(pitchNote({ id: `hs-sn-${String(canonical).padStart(6, '0')}-3`, step: 'D', octave: 5, duration: EIGHTH, type: 'eighth', tie: 'stop' }));
    body.push(pitchNote({ id: snId(), step: 'E', octave: 5, duration: EIGHTH, type: 'eighth' }));
    body.push(pitchNote({ id: snId(), step: 'D', octave: 5, duration: QUARTER, type: 'quarter' }));
    body.push(restNote({ duration: QUARTER, type: 'quarter' }));
  } else if (m === 16) {
    // full-measure rest
    body.push(restNote({ duration: WHOLE, type: 'whole' }));
  } else if (m === 20) {
    // half note tied across the barline into m.21 (2 fragments)
    body.push(pitchNote({ id: snId(), step: 'F', alter: 1, octave: 5, duration: QUARTER, type: 'quarter' }));
    body.push(pitchNote({ id: snId(), step: 'E', octave: 5, duration: QUARTER, type: 'quarter' }));
    const tiedId = snId(); // fragment 1 carries the canonical export id
    body.push(pitchNote({ id: tiedId, step: 'D', octave: 5, duration: HALF, type: 'half', tie: 'start' }));
  } else if (m === 21) {
    const canonical = noteSeq; // continue tie from m.20
    body.push(pitchNote({ id: `hs-sn-${String(canonical).padStart(6, '0')}-2`, step: 'D', octave: 5, duration: HALF, type: 'half', tie: 'stop' }));
    body.push(pitchNote({ id: snId(), step: 'C', alter: 1, octave: 5, duration: QUARTER, type: 'quarter' }));
    body.push(pitchNote({ id: snId(), step: 'D', octave: 5, duration: QUARTER, type: 'quarter' }));
  } else {
    // default: four eighth-pair + quarter pattern cycling STEPS
    const base = (m * 3) % STEPS.length;
    body.push(pitchNote({ id: snId(), ...STEPS[base % STEPS.length], duration: QUARTER, type: 'quarter' }));
    body.push(pitchNote({ id: snId(), ...STEPS[(base + 2) % STEPS.length], duration: EIGHTH, type: 'eighth' }));
    body.push(pitchNote({ id: snId(), ...STEPS[(base + 4) % STEPS.length], duration: EIGHTH, type: 'eighth' }));
    body.push(pitchNote({ id: snId(), ...STEPS[(base + 5) % STEPS.length], duration: QUARTER, type: 'quarter' }));
    body.push(pitchNote({ id: snId(), ...STEPS[(base + 6) % STEPS.length], duration: QUARTER, type: 'quarter' }));
  }
  measures.push(`    <measure implicit="no" number="${m}">\n${body.join('\n')}\n    </measure>`);
}

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Multisystem Fixture (spike)</work-title>
  </work>
  <movement-title>Multisystem Fixture</movement-title>
  <identification>
    <creator type="composer">HornScribe spike generator</creator>
    <encoding>
      <software>apps/spikes/score-render/scripts/gen-multisystem.mjs</software>
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
      <part-name>Horn in F</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${measures.join('\n')}
  </part>
</score-partwise>
`;

writeFileSync(outPath, xml, 'utf8');
console.log(`wrote ${outPath} (${noteSeq} canonical notes, ${restSeq} rests, ${MEASURES} measures)`);
