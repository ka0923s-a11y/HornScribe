import { describe, expect, it } from "vitest";
import { scoreHandoffFromResult } from "./jobResult";
import { issueConfidence } from "./review";

describe("scoreHandoffFromResult (UI-040 → UI-030 handoff)", () => {
  it("returns undefined for non-object results (fixture fallback path)", () => {
    expect(scoreHandoffFromResult(null)).toBeUndefined();
    expect(scoreHandoffFromResult(undefined)).toBeUndefined();
    expect(scoreHandoffFromResult("sr-1")).toBeUndefined();
    expect(scoreHandoffFromResult(42)).toBeUndefined();
  });

  it("maps the mock transcription result into typed score issues", () => {
    // Shape mirrors sidecar/mockPort.ts transcriptionResult().
    const result = {
      scoreRevision: "sr-mock-0001",
      reviewIssues: [
        {
          id: "ri-000001",
          scoreRevision: "sr-mock-0001",
          canonicalNoteIds: ["sn-000004"],
          timeRange: { startSec: 4.02, endSec: 4.51 },
          reason: "quantization_ambiguous",
          severity: "caution",
          evidence: { modelConfidence: 0.61 },
          status: "open",
        },
        {
          id: "ri-000002",
          scoreRevision: "sr-mock-0001",
          canonicalNoteIds: ["sn-000009"],
          timeRange: { startSec: 9.87, endSec: 10.34 },
          reason: "low_model_confidence",
          severity: "warning",
          evidence: { modelConfidence: 0.44 },
          status: "open",
        },
      ],
    };
    const handoff = scoreHandoffFromResult(result);
    expect(handoff?.revisionId).toBe("sr-mock-0001");
    expect(handoff?.issues).toHaveLength(2);
    const [a, b] = handoff!.issues;
    expect(a.reason).toBe("quantization_ambiguous");
    expect(a.canonicalNoteIds).toEqual(["sn-000004"]);
    expect(a.timeRange).toEqual({ startSec: 4.02, endSec: 4.51 });
    // The engine's `modelConfidence` evidence key surfaces as confidence.
    expect(issueConfidence(a)).toBeCloseTo(0.61);
    expect(b.severity).toBe("warning");
  });

  it("honestly reports an empty issue list (a clean transcription is not a fallback)", () => {
    const handoff = scoreHandoffFromResult({
      scoreRevision: "sr-9",
      reviewIssues: [],
    });
    expect(handoff?.revisionId).toBe("sr-9");
    expect(handoff?.issues).toEqual([]);
  });

  it("coerces unknown severity/status and keeps unknown reason codes verbatim", () => {
    const handoff = scoreHandoffFromResult({
      scoreRevision: "sr-x",
      reviewIssues: [
        {
          id: "ri-1",
          canonicalNoteIds: ["sn-000001"],
          reason: "engine_reason_from_the_future",
          severity: "extreme",
          status: "mystery",
          evidence: {},
        },
      ],
    });
    const issue = handoff!.issues[0];
    // Verbatim reason — the copy layer maps it to ja.reviewReasons.other.
    expect(issue.reason as string).toBe("engine_reason_from_the_future");
    expect(issue.severity).toBe("info");
    expect(issue.status).toBe("open");
  });

  it("drops malformed issue entries and non-string canonical ids", () => {
    const handoff = scoreHandoffFromResult({
      reviewIssues: [
        "not-an-issue",
        { reason: "low_model_confidence" }, // no id → dropped by extractor
        {
          id: "ri-7",
          reason: "low_model_confidence",
          canonicalNoteIds: ["sn-000010", 5, null],
          severity: "info",
          status: "open",
          evidence: {},
        },
      ],
    });
    expect(handoff!.issues).toHaveLength(1);
    expect(handoff!.issues[0].canonicalNoteIds).toEqual(["sn-000010"]);
  });
});
