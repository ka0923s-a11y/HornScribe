/**
 * devFixtureAudio — DEV-only fixture for the forced screen states
 * (#/dev/state/*, #/dev/transcribing). Since #219 the 採譜 command is
 * gated on a live audio slot (importState.audio != null); a forced
 * screen never imported one, so dev-state transcription was a dead
 * click and the UI-070 dogfood harness timed out on Task A (#148).
 *
 * The fixture is a real 16-bit PCM WAV so the media transport decodes
 * and plays it exactly like an imported file — /__engine/stage staging
 * and the mock-engine job path stay identical to production.
 */

import type { LoadedAudio } from "./types";

const SAMPLE_RATE = 22050;
const DURATION_SECONDS = 6;

/** Serialize mono 16-bit PCM into a RIFF/WAV blob. */
function wavBlob(samples: Float32Array): Blob {
  const count = samples.length;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** A short melodic phrase (A4 - C#5 - E5 - A5 - E5 - C#5, one second
 *  per note, soft decay + a touch of the third harmonic) so the waveform
 *  strip and transport show/play a melody rather than a flat tone. */
function synthSamples(): Float32Array {
  const total = SAMPLE_RATE * DURATION_SECONDS;
  const samples = new Float32Array(total);
  const noteFreqs = [440, 554.37, 659.25, 880, 659.25, 554.37];
  const noteLen = Math.floor(total / noteFreqs.length);
  for (let i = 0; i < total; i += 1) {
    const note = Math.min(noteFreqs.length - 1, Math.floor(i / noteLen));
    const localT = (i % noteLen) / SAMPLE_RATE;
    const env = Math.exp(-1.2 * localT) * Math.min(1, localT * 30);
    const f = noteFreqs[note];
    const t = i / SAMPLE_RATE;
    samples[i] =
      0.6 *
      env *
      (Math.sin(2 * Math.PI * f * t) +
        0.3 * Math.sin(2 * Math.PI * f * 3 * t));
  }
  return samples;
}

/** Normalized peaks (~60 ms buckets) matching the synth envelope. */
function synthPeaks(): number[] {
  const buckets = 96;
  const samplesPerBucket = (SAMPLE_RATE * DURATION_SECONDS) / buckets;
  const noteLen = (SAMPLE_RATE * DURATION_SECONDS) / 6;
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const localT = ((b * samplesPerBucket) % noteLen) / SAMPLE_RATE;
    peaks.push(Math.min(1, 0.7 * Math.exp(-1.2 * localT) + 0.05));
  }
  return peaks;
}

/** A fresh LoadedAudio per call — Blob/File identity must not be shared
 *  across seeds or a re-seed would alias the previous source. */
export function devFixtureAudio(): LoadedAudio {
  const blob = wavBlob(synthSamples());
  const name = "dev-fixture.wav";
  const file = new File([blob], name, { type: "audio/wav" });
  return {
    ref: { kind: "file", file, name },
    fileName: name,
    format: "wav",
    sizeBytes: blob.size,
    durationSeconds: DURATION_SECONDS,
    sampleRate: SAMPLE_RATE,
    peaks: synthPeaks(),
    mediaSource: { kind: "blob", blob },
  };
}
