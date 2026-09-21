/**
 * Canonical-id rule tests (UI-030). Mirrors FND-001 / ids.py: every
 * `hs-sn-*` export id resolves to exactly one `sn-*` canonical id;
 * rests and random Verovio ids never do.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalNoteIdFromMusicxml,
  isMusicxmlNoteId,
  isMusicxmlRestId,
  isReviewIssueId,
  isScoreNoteId,
  musicxmlNoteId,
} from "./ids";

describe("score ids", () => {
  it("recognizes canonical sn-* ids", () => {
    expect(isScoreNoteId("sn-000003")).toBe(true);
    expect(isScoreNoteId("sn-000003-2")).toBe(false);
    expect(isScoreNoteId("hs-sn-000003")).toBe(false);
    expect(isScoreNoteId("sn-3")).toBe(false);
    expect(isScoreNoteId("")).toBe(false);
  });

  it("recognizes MusicXML export ids incl. tie fragments", () => {
    expect(isMusicxmlNoteId("hs-sn-000003")).toBe(true);
    expect(isMusicxmlNoteId("hs-sn-000003-2")).toBe(true);
    expect(isMusicxmlNoteId("hs-sn-000003-12")).toBe(true);
    expect(isMusicxmlNoteId("hs-rest-000001")).toBe(false);
    expect(isMusicxmlNoteId("hs-sn-3")).toBe(false);
    expect(isMusicxmlNoteId("sn-000003")).toBe(false);
  });

  it("recognizes rest ids", () => {
    expect(isMusicxmlRestId("hs-rest-000001")).toBe(true);
    expect(isMusicxmlRestId("hs-sn-000001")).toBe(false);
  });

  it("recognizes review issue ids", () => {
    expect(isReviewIssueId("ri-000001")).toBe(true);
    expect(isReviewIssueId("ri-1")).toBe(false);
  });

  it("builds export ids from canonical ids", () => {
    expect(musicxmlNoteId("sn-000042")).toBe("hs-sn-000042");
    expect(musicxmlNoteId("sn-000042", 2)).toBe("hs-sn-000042-2");
    expect(musicxmlNoteId("sn-000042", 3)).toBe("hs-sn-000042-3");
    expect(() => musicxmlNoteId("sn-42")).toThrow();
    expect(() => musicxmlNoteId("sn-000042", 0)).toThrow();
  });

  it("resolves every hs-sn-* fragment to its canonical id", () => {
    expect(canonicalNoteIdFromMusicxml("hs-sn-000003")).toBe("sn-000003");
    expect(canonicalNoteIdFromMusicxml("hs-sn-000003-2")).toBe("sn-000003");
    expect(canonicalNoteIdFromMusicxml("hs-sn-000003-10")).toBe("sn-000003");
  });

  it("rejects non-canonical ids (rests, Verovio random ids)", () => {
    // UI-003 finding: Verovio-generated ids like `d1e123` are unstable —
    // they must never resolve to a canonical note.
    expect(canonicalNoteIdFromMusicxml("hs-rest-000001")).toBeNull();
    expect(canonicalNoteIdFromMusicxml("d1e123")).toBeNull();
    expect(canonicalNoteIdFromMusicxml("hs-sn-3")).toBeNull();
    expect(canonicalNoteIdFromMusicxml("")).toBeNull();
    expect(canonicalNoteIdFromMusicxml("sn-000003")).toBeNull();
  });
});
