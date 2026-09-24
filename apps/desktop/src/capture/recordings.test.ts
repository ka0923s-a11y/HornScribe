import { describe, expect, it } from "vitest";
import {
  collectReferencedRecordingNames,
  recordingNameUnder,
} from "./recordings";

/* #132: retention must not delete recordings a saved project still
 * references. The collector reads each recent project's sourceAudio
 * path and keeps only names inside the recordings dir. */

const blobOf = (text: string) => new Blob([text], { type: "application/json" });

const projectJson = (sourcePath: string | null) =>
  JSON.stringify({
    schemaVersion: 1,
    projectId: "p1",
    sourceAudio: sourcePath
      ? { originalPath: sourcePath, contentHash: "h" }
      : null,
  });

const sourcePathOf = async (blob: Blob) => {
  const data = JSON.parse(await blob.text()) as {
    sourceAudio?: { originalPath?: string } | null;
  };
  return data.sourceAudio?.originalPath ?? null;
};

const DIR = "C:\\Users\\me\\recordings";

describe("collectReferencedRecordingNames", () => {
  it("keeps recording-dir sources, ignores outside paths", async () => {
    const keep = await collectReferencedRecordingNames({
      readProjectBytes: async (path) =>
        path === "a.json"
          ? blobOf(projectJson(DIR + "\\take1.wav"))
          : blobOf(projectJson("D:\\Music\\song.mp3")),
      entries: [{ path: "a.json" }, { path: "b.json" }],
      dir: DIR,
      sourcePathOf,
    });
    expect(keep).toEqual(new Set(["take1.wav"]));
  });

  it("fails open on unreadable projects", async () => {
    const keep = await collectReferencedRecordingNames({
      readProjectBytes: async () => {
        throw new Error("gone");
      },
      entries: [{ path: "dead.json" }],
      dir: DIR,
      sourcePathOf,
    });
    expect(keep.size).toBe(0);
  });

  it("protects nothing when the dir is unknown", async () => {
    const keep = await collectReferencedRecordingNames({
      readProjectBytes: async () => blobOf(projectJson(DIR + "\\x.wav")),
      entries: [{ path: "a.json" }],
      dir: null,
      sourcePathOf,
    });
    expect(keep.size).toBe(0);
  });

  it("matches dir prefix case-insensitively, slash-insensitively", async () => {
    const keep = await collectReferencedRecordingNames({
      readProjectBytes: async () =>
        blobOf(projectJson(DIR.replaceAll("\\", "/") + "/Rec 2.wav")),
      entries: [{ path: "a.json" }],
      dir: DIR.toUpperCase(),
      sourcePathOf,
    });
    expect(keep).toEqual(new Set(["Rec 2.wav"]));
  });

  it("a sibling dir with a similar name is not protected", async () => {
    const keep = await collectReferencedRecordingNames({
      readProjectBytes: async () =>
        blobOf(projectJson(DIR + "2\\evil.wav")),
      entries: [{ path: "a.json" }],
      dir: DIR,
      sourcePathOf,
    });
    expect(keep.size).toBe(0);
  });
});

describe("recordingNameUnder", () => {
  it("returns the bare name for a path inside the dir", () => {
    expect(recordingNameUnder(DIR + "\\Rec 1.wav", DIR)).toBe("Rec 1.wav");
  });

  it("keeps the original case and accepts forward slashes", () => {
    expect(
      recordingNameUnder(DIR.replaceAll("\\", "/") + "/Rec 2.WAV", DIR),
    ).toBe("Rec 2.WAV");
  });

  it("is case-insensitive on the dir prefix", () => {
    expect(recordingNameUnder(DIR + "\\a.wav", DIR.toUpperCase())).toBe(
      "a.wav",
    );
  });

  it("rejects paths outside the dir", () => {
    expect(recordingNameUnder("D:\\else\\a.wav", DIR)).toBeNull();
    // Sibling dir sharing the prefix must not match.
    expect(recordingNameUnder(DIR + "2\\a.wav", DIR)).toBeNull();
  });
});
