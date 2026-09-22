/**
 * Settings store tests (UI-060). `loadSettings`/`saveSettings` touch
 * window.localStorage which does not exist under the node test env —
 * both are best-effort guarded, so the pure `parseSettings` contract is
 * what these tests pin down.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_CATEGORIES,
  loadSettings,
  parseSettings,
  playbackRateOptions,
  saveSettings,
} from "./store";

describe("parseSettings", () => {
  it("returns defaults for null / empty / invalid JSON", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[1,2]")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and repairs invalid ones field by field", () => {
    const parsed = parseSettings(
      JSON.stringify({
        playbackRate: 1.5,
        skipSeconds: 999, // out of range → default
        followPlayback: false,
        tempoMode: "bogus", // unknown enum → default
        bpm: 90,
        meter: "6/8",
        museScorePath: "D:\\tools\\MuseScore4.exe",
        foreign: "ignored",
      }),
    );
    expect(parsed.playbackRate).toBe(1.5);
    expect(parsed.skipSeconds).toBe(DEFAULT_SETTINGS.skipSeconds);
    expect(parsed.followPlayback).toBe(false);
    expect(parsed.tempoMode).toBe("auto");
    expect(parsed.bpm).toBe(90);
    expect(parsed.meter).toBe("6/8");
    expect(parsed.museScorePath).toBe("D:\\tools\\MuseScore4.exe");
    expect("foreign" in parsed).toBe(false);
  });

  it("round-trips a full settings object", () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      playbackRate: 0.75,
      triplets: false,
      scoreInitialView: "page" as const,
      defaultExportDir: "C:\\Scores",
      backend: "basicPitch" as const,
    };
    expect(parseSettings(JSON.stringify(custom))).toEqual(custom);
  });
});

describe("storage guards", () => {
  it("loadSettings/saveSettings never throw without localStorage", () => {
    // node env: window is undefined — both must degrade silently.
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("categories", () => {
  it("lists the seven §18 categories in spec order", () => {
    expect(SETTINGS_CATEGORIES).toEqual([
      "appearance",
      "playback",
      "transcription",
      "score",
      "export",
      "tools",
      "advanced",
    ]);
    // No language category — the UI is Japanese-only by contract.
    expect(SETTINGS_CATEGORIES).not.toContain("language");
  });

  it("playback rate options stay inside the validated range", () => {
    for (const r of playbackRateOptions()) {
      expect(r).toBeGreaterThanOrEqual(0.5);
      expect(r).toBeLessThanOrEqual(2);
    }
  });
});
