/**
 * reviewEvidence formatter contracts — the copy deck's function
 * leaves, where the QA gate can only see shapes, not semantics.
 */
import { describe, expect, it } from "vitest";
import { ja } from "./ja";

describe("reviewEvidence.chordUncertain", () => {
  it("a negative margin names the smoother/raw disagreement — never a negative '差'", () => {
    // Viterbi smoothing can pick a chord whose per-segment similarity
    // is BELOW another candidate (margin = best - strongest_other <
    // 0). "次点との差が-5%しかありません" read as nonsense on a real
    // device run; the copy must name what actually happened.
    const text = ja.reviewEvidence.chordUncertain({
      suggested: "A",
      runnerUp: "C#m",
      confidencePct: 95,
      marginPct: -5,
    });
    expect(text).not.toContain("-5%");
    expect(text).toContain("C#m");
    expect(text).toContain("A");
    expect(text).toContain("類似度");
  });

  it("a positive thin margin keeps the runner-up wording", () => {
    const text = ja.reviewEvidence.chordUncertain({
      suggested: "A",
      runnerUp: "Esus4",
      confidencePct: 96,
      marginPct: 2,
    });
    expect(text).toContain("次点のEsus4との差が2%しかありません");
  });
});
