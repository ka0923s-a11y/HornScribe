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

describe("reviewEvidence.keyUncertain", () => {
  it("harmony_override names the real arbitration — never a negative 差", () => {
    /* #151: the harmony re-rank displaces the melodic winner, which
     * makes the margin negative (-24%). 差が-24%しかありません is
     * nonsense copy; the text must say the detected chords outvoted
     * the melody-only read instead. */
    const text = ja.reviewEvidence.keyUncertain({
      details: ["harmony_override"],
      estimated: "イ短調",
      confidencePct: 49,
      noteCount: 38,
      runnerUp: "ホ短調",
      marginPct: -24,
      uncertainMeasures: [],
    });
    expect(text).not.toContain("-24%");
    expect(text).toContain("ホ短調");
    expect(text).toContain("イ短調");
    expect(text).toContain("和音");
  });

  it("an ordinary close call keeps the runner-up margin wording", () => {
    const text = ja.reviewEvidence.keyUncertain({
      details: ["close_candidates"],
      estimated: "ハ長調",
      confidencePct: 62,
      noteCount: 40,
      runnerUp: "ト長調",
      marginPct: 3,
      uncertainMeasures: [],
    });
    expect(text).toContain("次点のト長調との差が3%しかありません");
  });
});

describe("reviewEvidence.meterConflict", () => {
  /* #147: a refusal reports estimatedMeter:null — the written 4/4
   * is the fallback, NOT a rejected candidate. The copy must say
   * 'undecidable' without naming a fake candidate, or the flag reads
   * 'candidates: 4/4, wrote 4/4' (nonsense) on flat-accent pop. */
  it("a refusal names no candidate — never '4/4'", () => {
    const text = ja.reviewEvidence.meterConflict({
      estimated: null,
      runnerUp: null,
      confidencePct: 0,
    });
    expect(text).toContain("拍子を確定できませんでした");
    expect(text).not.toContain("候補");
    expect(text).not.toContain("推定");
  });

  it("a real dispute names both candidates", () => {
    const text = ja.reviewEvidence.meterConflict({
      estimated: "5/4",
      runnerUp: "3/4",
      confidencePct: 0,
    });
    expect(text).toContain("候補: 5/4 / 3/4");
  });

  it("a thin-margin guess names the estimate and runner-up", () => {
    const text = ja.reviewEvidence.meterConflict({
      estimated: "5/4",
      runnerUp: "2/4",
      confidencePct: 8,
    });
    expect(text).toContain("自動推定は 5/4");
    expect(text).toContain("次点: 2/4");
  });
});
