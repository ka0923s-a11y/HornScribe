/**
 * staging + staged-path param tests (#86): browser-held bytes are POSTed
 * to the dev bridge and the returned path wins in job.start params.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { stageAudioForEngine } from "./staging";
import { buildTranscriptionParams } from "./transcriptionParams";
import {
  DEFAULT_TRANSCRIPTION_OPTIONS,
  type LoadedAudio,
} from "./types";

function audio(partial: Partial<LoadedAudio>): LoadedAudio {
  return {
    ref: { kind: "file", file: new File(["x"], "a.wav"), name: "a.wav" },
    fileName: "a.wav",
    format: "wav",
    sizeBytes: 1,
    durationSeconds: 1,
    sampleRate: 44100,
    peaks: [],
    mediaSource: { kind: "blob", blob: new Blob(["x"]) },
    ...partial,
  };
}

describe("stageAudioForEngine", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => vi.stubGlobal("fetch", realFetch));

  it("returns null for on-disk refs (nothing to stage)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const a = audio({
      ref: { kind: "path", path: "C:/a.wav", name: "a.wav" },
    });
    expect(await stageAudioForEngine(a)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null for recordings already persisted on disk", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const a = audio({
      ref: {
        kind: "recording",
        name: "r.wav",
        source: "microphone",
        path: "C:/rec/r.wav",
        blob: new Blob(["x"]),
      },
    });
    expect(await stageAudioForEngine(a)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("POSTs kind:file bytes and returns the staged path", async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ path: "C:/tmp/staged-1-a.wav" }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", spy);
    const a = audio({});
    expect(await stageAudioForEngine(a)).toBe("C:/tmp/staged-1-a.wav");
    expect(spy).toHaveBeenCalledWith(
      "/__engine/stage?name=a.wav",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POSTs pathless recording blobs", async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ path: "C:/tmp/staged-2-r.wav" })),
      ),
    );
    vi.stubGlobal("fetch", spy);
    const a = audio({
      ref: {
        kind: "recording",
        name: "r.wav",
        source: "loopback",
        blob: new Blob(["x"]),
      },
    });
    expect(await stageAudioForEngine(a)).toBe("C:/tmp/staged-2-r.wav");
  });

  it("returns null when the bridge is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no bridge"))),
    );
    expect(await stageAudioForEngine(audio({}))).toBeNull();
  });
});

describe("buildTranscriptionParams staged path", () => {
  it("staged path wins over ref-derived paths", () => {
    const a = audio({
      ref: { kind: "path", path: "C:/orig.wav", name: "orig.wav" },
    });
    const p = buildTranscriptionParams(
      a,
      DEFAULT_TRANSCRIPTION_OPTIONS,
      "C:/tmp/staged.wav",
    );
    expect(p.audioPath).toBe("C:/tmp/staged.wav");
  });

  it("null staged path keeps the ref-derived path", () => {
    const a = audio({
      ref: { kind: "path", path: "C:/orig.wav", name: "orig.wav" },
    });
    const p = buildTranscriptionParams(a, DEFAULT_TRANSCRIPTION_OPTIONS, null);
    expect(p.audioPath).toBe("C:/orig.wav");
  });

  it("texture pins mono/melody and omits auto", () => {
    const a = audio({
      ref: { kind: "path", path: "C:/orig.wav", name: "orig.wav" },
    });
    expect(
      buildTranscriptionParams(a, DEFAULT_TRANSCRIPTION_OPTIONS, null)
        .texture,
    ).toBeUndefined();
    expect(
      buildTranscriptionParams(
        a,
        { ...DEFAULT_TRANSCRIPTION_OPTIONS, texture: "melody" },
        null,
      ).texture,
    ).toBe("melody");
    expect(
      buildTranscriptionParams(
        a,
        { ...DEFAULT_TRANSCRIPTION_OPTIONS, texture: "mono" },
        null,
      ).texture,
    ).toBe("mono");
  });

  it("per-job backend pin wins over the global setting (#189)", () => {
    const a = audio({
      ref: { kind: "path", path: "C:/orig.wav", name: "orig.wav" },
    });
    // Job option pins pyin even though the global setting says
    // basicPitch; "auto" inherits the global choice.
    expect(
      buildTranscriptionParams(
        a,
        { ...DEFAULT_TRANSCRIPTION_OPTIONS, backend: "pyin" },
        null,
        "basicPitch",
      ).backend,
    ).toBe("pyin");
    expect(
      buildTranscriptionParams(
        a,
        DEFAULT_TRANSCRIPTION_OPTIONS,
        null,
        "basicPitch",
      ).backend,
    ).toBe("basicPitch");
    expect(
      buildTranscriptionParams(a, DEFAULT_TRANSCRIPTION_OPTIONS, null, "auto")
        .backend,
    ).toBeUndefined();
  });
});
