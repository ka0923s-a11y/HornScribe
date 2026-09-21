/**
 * Deterministic PCM synthesis for UI-004 fixtures — TypeScript port of
 * scripts/generate_audio_fixtures.py (same formula, same LCG noise).
 *
 * Used to synthesize the 3 min / 10 min fixtures on demand inside the app so
 * no large WAV binaries are committed. Yields Float32 samples in [-1, 1].
 */

export const FIXTURE_SAMPLE_RATE = 44100
const NOTE_SECONDS = 2.0
const SCALE_HZ = [220.0, 246.94, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25]
const ATTACK_S = 0.03
const DECAY = 5.0
const TICK_PERIOD_S = 10.0
const TICK_LEN_S = 0.06
const TICK_HZ = 1000.0
const NOISE_AMP = 0.015
const MASTER_AMP = 0.5

function lcg(seed: number): number {
  // uint32 arithmetic matching the Python `mod 2**32` implementation
  return (Math.imul(1103515245, seed) + 12345) >>> 0
}

/** Synthesize `seconds` of the fixture signal into a Float32Array. */
export function synthFixture(seconds: number, sampleRate = FIXTURE_SAMPLE_RATE): Float32Array {
  const total = Math.floor(seconds * sampleRate)
  const out = new Float32Array(total)
  let seed = 0x1234abcd
  const twoPi = 2 * Math.PI
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate
    const noteIdx = Math.floor(t / NOTE_SECONDS)
    const u = (t - noteIdx * NOTE_SECONDS) / NOTE_SECONDS

    let sample = 0
    if (noteIdx % 8 !== 7) {
      const octave = Math.floor(noteIdx / 8) % 2 === 0 ? 1 : 0.5
      const freq = SCALE_HZ[noteIdx % SCALE_HZ.length] * octave
      const phase = twoPi * freq * t + 0.3 * Math.sin(twoPi * 5 * t)
      const envAttack = Math.min(1, (u * NOTE_SECONDS) / ATTACK_S)
      const env = envAttack * Math.exp(-DECAY * u)
      sample += (Math.sin(phase) + 0.3 * Math.sin(2 * phase)) * env
    }

    const tickPos = t % TICK_PERIOD_S
    if (tickPos < TICK_LEN_S) {
      const tickEnv = Math.sin((Math.PI * tickPos) / TICK_LEN_S)
      sample += 0.6 * Math.sin(twoPi * TICK_HZ * t) * tickEnv
    }

    seed = lcg(seed)
    const noise = (seed / (1 << 31) - 1) * NOISE_AMP
    out[i] = Math.max(-1, Math.min(1, (sample + noise) * MASTER_AMP))
  }
  return out
}
