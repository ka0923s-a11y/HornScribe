/**
 * Deterministic PCM synthesis for the UI-005 sync fixtures.
 *
 * The audio is generated *through the warp*: each canonical note's [onsetQl,
 * offsetQl) span is mapped to seconds via `warp.qlToSeconds`, so click
 * transients land exactly where the score says the note starts — including
 * under the non-linear beat-map warp. Same idea as UI-004's synth (pure
 * formula + LCG noise), reused deliberately; spikes may duplicate.
 *
 *  - every canonical note -> decaying sine at its (concert) midi pitch for
 *    its full sounding span — tie fragments produce ONE continuous tone
 *  - every onset -> short bright click transient (visible on the waveform)
 *  - rests -> silence (plus a hair of deterministic noise floor)
 */
import type { TimeWarp } from '../sync/timewarp'
import type { CanonicalSpan } from '../sync/syncMap'

export const FIXTURE_SAMPLE_RATE = 44100

const CLICK_S = 0.012
const CLICK_HZ = 2600
const ATTACK_S = 0.015
const RELEASE_S = 0.05
const MASTER_AMP = 0.6
const NOISE_AMP = 0.006

function lcg(seed: number): number {
  return (Math.imul(1103515245, seed) + 12345) >>> 0
}

const midiHz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

export interface SynthInput {
  /** canonical spans with midi pitch (concert presentation), pre-warp */
  notes: { span: CanonicalSpan; midi: number }[]
  warp: TimeWarp
  /** trailing silence after the last offset, seconds */
  tailSec?: number
  sampleRate?: number
}

/** Total audio length needed for a fixture (score end + tail). */
export function fixtureDurationSec(warp: TimeWarp, durationQl: import('../sync/rational').Rational, tailSec = 0.8): number {
  return warp.qlToSeconds(durationQl) + tailSec
}

export function synthScoreAudio(input: SynthInput): Float32Array {
  const sampleRate = input.sampleRate ?? FIXTURE_SAMPLE_RATE
  const tail = input.tailSec ?? 0.8
  // End of the last canonical span (or zero for an empty map).
  let lastEnd = 0
  const placed = input.notes.map(({ span, midi }) => {
    const start = input.warp.qlToSeconds(span.onsetQl)
    const end = input.warp.qlToSeconds(span.offsetQl)
    lastEnd = Math.max(lastEnd, end)
    return { start, end, midi }
  })
  const total = Math.floor((lastEnd + tail) * sampleRate)
  const out = new Float32Array(total)
  const twoPi = 2 * Math.PI

  for (const { start, end, midi } of placed) {
    const f = midiHz(midi)
    const i0 = Math.max(0, Math.round(start * sampleRate))
    const i1 = Math.min(total, Math.round(end * sampleRate))
    const attackN = Math.max(1, Math.round(ATTACK_S * sampleRate))
    const relN = Math.max(1, Math.round(RELEASE_S * sampleRate))
    for (let i = i0; i < i1; i += 1) {
      const t = i / sampleRate
      const phase = twoPi * f * t
      // fast attack, sustained body, short release — no click inside ties
      const a = Math.min(1, (i - i0) / attackN)
      const r = Math.min(1, (i1 - i) / relN)
      const env = a * r
      out[i] += (Math.sin(phase) + 0.3 * Math.sin(2 * phase)) * env * 0.45
    }
    // onset click: decaying high ping, clearly visible in the waveform
    const clickN = Math.min(total - i0, Math.round(CLICK_S * sampleRate))
    for (let i = 0; i < clickN; i += 1) {
      const u = i / clickN
      out[i0 + i] += Math.sin(twoPi * CLICK_HZ * (i / sampleRate)) * (1 - u) * 0.7
    }
  }

  // deterministic low noise floor so rests read as "quiet room", not digital zero
  let seed = 0x5157a9
  for (let i = 0; i < total; i += 1) {
    seed = lcg(seed)
    out[i] = Math.max(-1, Math.min(1, out[i] + (seed / (1 << 31) - 1) * NOISE_AMP))
  }
  for (let i = 0; i < total; i += 1) out[i] *= MASTER_AMP
  return out
}
