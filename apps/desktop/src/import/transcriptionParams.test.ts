/** #264: project transcription.settings -> 採譜オプション restore mapping. */
import { describe, expect, it } from "vitest";
import {
  buildTranscriptionParams,
  transcriptionOptionsFromSettings,
} from "./transcriptionParams";
import { DEFAULT_TRANSCRIPTION_OPTIONS } from "./types";
import type { LoadedAudio } from "./types";

function audioOf(fileName: string): LoadedAudio {
  return {
    ref: { kind: "file", file: new File([], fileName), name: fileName },
    fileName,
    format: "wav",
    sizeBytes: 0,
    durationSeconds: 8,
    sampleRate: 22050,
    peaks: [],
    mediaSource: { kind: "blob", blob: new Blob() },
  };
}

describe("buildTranscriptionParams", () => {
  it("#305: sends the user file name as displayName, not the staged path", () => {
    const p = buildTranscriptionParams(
      audioOf("take.wav"),
      DEFAULT_TRANSCRIPTION_OPTIONS,
      "C:/Temp/hornscribe-dev/staged-1-take.wav",
    );
    expect(p.audioPath).toBe("C:/Temp/hornscribe-dev/staged-1-take.wav");
    expect(p.displayName).toBe("take.wav");
  });

  it("#305: displayName is the file name even for a path ref", () => {
    const audio = audioOf("song.wav");
    audio.ref = { kind: "path", path: "C:/music/song.wav", name: "song.wav" };
    const p = buildTranscriptionParams(audio, DEFAULT_TRANSCRIPTION_OPTIONS);
    expect(p.audioPath).toBe("C:/music/song.wav");
    expect(p.displayName).toBe("song.wav");
  });
});

describe("transcriptionOptionsFromSettings", () => {
  it("restores the full engine settings echo", () => {
    const o = transcriptionOptionsFromSettings({
      tempoBpm: 96,
      meter: "6/8",
      minDurationQl: "1/8",
      triplets: "always",
      simplicity: "detailed",
      range: "selection",
      selectionStartSec: 12.5,
      selectionEndSec: 40,
      backend: "basicPitch",
      texture: "melody",
      vocalIsolation: true,
    });
    expect(o).toEqual({
      tempo: "manual",
      tempoBpm: 96,
      meter: "6/8",
      // 1/8 ql = 32分音符
      minDuration: "32",
      triplets: "allow",
      simplicity: "detailed",
      range: "selection",
      texture: "melody",
      backend: "basicPitch",
      vocalIsolation: true,
      selectionStartSec: 12.5,
      selectionEndSec: 40,
    });
  });

  it("#187: vocalIsolation restores only from an explicit true", () => {
    expect(
      transcriptionOptionsFromSettings({ vocalIsolation: true })
        .vocalIsolation,
    ).toBe(true);
    // Absent/false/other values stay off — the option is opt-in.
    expect(
      transcriptionOptionsFromSettings({ vocalIsolation: "yes" })
        .vocalIsolation,
    ).toBe(false);
    expect(transcriptionOptionsFromSettings(null).vocalIsolation).toBe(false);
  });

  it("maps engine triplet policy names to UI values", () => {
    expect(
      transcriptionOptionsFromSettings({ triplets: "never" }).triplets,
    ).toBe("none");
    expect(
      transcriptionOptionsFromSettings({ triplets: "auto" }).triplets,
    ).toBe("auto");
  });

  it("minDurationQl fractions map to UI denominators", () => {
    expect(
      transcriptionOptionsFromSettings({ minDurationQl: "1/2" }).minDuration,
    ).toBe("8");
    expect(
      transcriptionOptionsFromSettings({ minDurationQl: "1/4" }).minDuration,
    ).toBe("16");
    // A value outside the UI's three choices falls back to default.
    expect(
      transcriptionOptionsFromSettings({ minDurationQl: "1/64" }).minDuration,
    ).toBe(DEFAULT_TRANSCRIPTION_OPTIONS.minDuration);
  });

  it("auto tempo (null tempoBpm) restores the auto mode", () => {
    const o = transcriptionOptionsFromSettings({ tempoBpm: null });
    expect(o.tempo).toBe("auto");
    expect(o.tempoBpm).toBeNull();
  });

  it("unknown/newer values fall back to defaults per key", () => {
    const o = transcriptionOptionsFromSettings({
      meter: "13/16",
      texture: "orchestral",
      backend: "demucs-v9",
      triplets: "sometimes",
      minDurationQl: "abc",
      futureKey: true,
    });
    expect(o.meter).toBe("auto");
    expect(o.texture).toBe("auto");
    expect(o.backend).toBe("auto");
    expect(o.triplets).toBe("auto");
    expect(o.minDuration).toBe(DEFAULT_TRANSCRIPTION_OPTIONS.minDuration);
  });

  it("null settings yield the defaults", () => {
    expect(transcriptionOptionsFromSettings(null)).toEqual(
      DEFAULT_TRANSCRIPTION_OPTIONS,
    );
  });
});
