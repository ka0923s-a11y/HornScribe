/**
 * Format-detection tests (UI-020). The advertised list (GUI_UX_SPEC §3:
 * WAV・MP3・FLAC・M4A・OGG) is the ONLY accepted set — anything else must
 * surface the actionable 対応していない形式 error upstream.
 */

import { describe, expect, it } from "vitest";
import {
  AUDIO_EXTENSIONS,
  audioFormatOf,
  baseName,
  fileExtension,
  projectDisplayName,
} from "./formats";

describe("AUDIO_EXTENSIONS", () => {
  it("advertises exactly the §3 format list", () => {
    expect([...AUDIO_EXTENSIONS]).toEqual([
      "wav",
      "mp3",
      "flac",
      "m4a",
      "ogg",
    ]);
  });
});

describe("audioFormatOf", () => {
  it.each(["wav", "mp3", "flac", "m4a", "ogg"])(
    "accepts .%s (the advertised formats)",
    (ext) => {
      expect(audioFormatOf(`take-03.${ext}`)).toBe(ext);
    },
  );

  it("is case-insensitive", () => {
    expect(audioFormatOf("SOLO.WAV")).toBe("wav");
    expect(audioFormatOf("Solo.FlAc")).toBe("flac");
  });

  it("rejects unsupported extensions", () => {
    expect(audioFormatOf("memo.txt")).toBeNull();
    expect(audioFormatOf("track.aac")).toBeNull();
    expect(audioFormatOf("song.aiff")).toBeNull();
    expect(audioFormatOf("movie.mp4")).toBeNull();
    expect(audioFormatOf("etude.hornscribe.json")).toBeNull();
  });

  it("rejects names without an extension", () => {
    expect(audioFormatOf("README")).toBeNull();
    expect(audioFormatOf(".wav")).toBeNull(); // dotfile, not an extension
    expect(audioFormatOf("trailing.")).toBeNull();
  });

  it("uses only the last extension (a.wav.txt is not audio)", () => {
    expect(audioFormatOf("a.wav.txt")).toBeNull();
    expect(audioFormatOf("a.txt.wav")).toBe("wav");
  });
});

describe("fileExtension", () => {
  it("lowercases the extension", () => {
    expect(fileExtension("A.FLAC")).toBe("flac");
  });
  it("handles Windows and POSIX separators", () => {
    expect(fileExtension("C:\\audio\\take.MP3")).toBe("mp3");
    expect(fileExtension("/home/u/take.ogg")).toBe("ogg");
  });
});

describe("baseName", () => {
  it("returns the last path segment for both separators", () => {
    expect(baseName("C:\\Users\\u\\Music\\horn.wav")).toBe("horn.wav");
    expect(baseName("/home/u/Music/horn.wav")).toBe("horn.wav");
    expect(baseName("horn.wav")).toBe("horn.wav");
  });
  it("handles mixed separators", () => {
    expect(baseName("C:\\dir/sub\\horn.wav")).toBe("horn.wav");
  });
});

describe("projectDisplayName", () => {
  it("strips the .hornscribe.json suffix", () => {
    expect(projectDisplayName("C:\\p\\etude.hornscribe.json")).toBe("etude");
  });
  it("keeps other names untouched", () => {
    expect(projectDisplayName("C:\\p\\etude.json")).toBe("etude.json");
    expect(projectDisplayName("etude")).toBe("etude");
  });
});
