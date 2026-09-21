/**
 * Screen-state machine mapping tests (GUI_UX_SPEC §27; UI-020 added
 * openingAudio / audioError / sourceMissing). Asserts which regions and
 * command gates each state produces so shells/features cannot drift.
 */

import { describe, expect, it } from "vitest";
import {
  SCREEN_STATES,
  commandStateFor,
  hasWorkspaceRegions,
  regionVisibility,
  type ScreenState,
} from "./screen";

const ALL: readonly ScreenState[] = SCREEN_STATES;

describe("SCREEN_STATES", () => {
  it("contains the five UI-020 import states plus the score-side ones", () => {
    for (const s of [
      "empty",
      "openingAudio",
      "audioReady",
      "audioError",
      "sourceMissing",
    ]) {
      expect(ALL).toContain(s);
    }
  });
});

describe("hasWorkspaceRegions", () => {
  it("is false only for empty and the two full-card error states", () => {
    expect(hasWorkspaceRegions("empty")).toBe(false);
    expect(hasWorkspaceRegions("audioError")).toBe(false);
    expect(hasWorkspaceRegions("sourceMissing")).toBe(false);
    // OPENING_AUDIO already mounts the waveform strip (loading line).
    expect(hasWorkspaceRegions("openingAudio")).toBe(true);
    expect(hasWorkspaceRegions("audioReady")).toBe(true);
    expect(hasWorkspaceRegions("transcribing")).toBe(true);
    expect(hasWorkspaceRegions("scoreReady")).toBe(true);
  });
});

describe("regionVisibility", () => {
  it("empty hides waveform/transport/properties", () => {
    const v = regionVisibility("empty");
    expect(v).toMatchObject({
      waveform: false,
      score: true,
      properties: false,
      transport: false,
    });
  });

  it("openingAudio shows the waveform but not transport/properties", () => {
    const v = regionVisibility("openingAudio");
    expect(v).toMatchObject({
      waveform: true,
      properties: false,
      transport: false,
    });
  });

  it("audioReady+ mounts everything", () => {
    for (const s of ["audioReady", "transcribing", "scoreReady"] as const) {
      const v = regionVisibility(s);
      expect(v.waveform).toBe(true);
      expect(v.transport).toBe(true);
      expect(v.properties).toBe(true);
    }
  });

  it("error states mount only the score region", () => {
    for (const s of ["audioError", "sourceMissing"] as const) {
      const v = regionVisibility(s);
      expect(v.score).toBe(true);
      expect(v.waveform).toBe(false);
      expect(v.transport).toBe(false);
      expect(v.properties).toBe(false);
    }
  });
});

describe("commandStateFor", () => {
  it("hasAudio is false for empty/openingAudio and the error states", () => {
    for (const s of [
      "empty",
      "openingAudio",
      "audioError",
      "sourceMissing",
    ] as const) {
      expect(commandStateFor(s).hasAudio).toBe(false);
    }
    expect(commandStateFor("audioReady").hasAudio).toBe(true);
    expect(commandStateFor("transcribing").hasAudio).toBe(true);
  });

  it("isTranscribing only during transcribing; hasScore from scoreReady on", () => {
    expect(commandStateFor("transcribing").isTranscribing).toBe(true);
    expect(commandStateFor("audioReady").isTranscribing).toBe(false);
    expect(commandStateFor("scoreReady").hasScore).toBe(true);
    expect(commandStateFor("reviewing").hasScore).toBe(true);
    expect(commandStateFor("reviewing").reviewOpen).toBe(true);
    expect(commandStateFor("audioReady").hasScore).toBe(false);
  });
});
