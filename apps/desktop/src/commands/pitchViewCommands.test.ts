// @vitest-environment jsdom
/**
 * #349 regression: the command-bar pitch segment collapsed "bFlat" into
 * "view.hornF", so choosing B♭ silently re-selected F (and the first tap
 * switched concert→F). Every pitch view must map to its own registered
 * command, and invoking it must pass the matching view to setPitchView.
 *
 * Pure logic — no DOM needed.
 */

import { describe, expect, it, vi } from "vitest";
import { PITCH_COMMAND } from "../components/CommandBar";
import type { PitchView } from "../components/PitchSegmented";
import { createCommandRegistry } from "./registry";
import type {
  CommandContext,
  CommandSnapshot,
} from "./types";

const SNAPSHOT_SCORE: CommandSnapshot = {
  hasAudio: true,
  hasScore: true,
  hasPolyphony: false,
  isTranscribing: false,
  isPlaying: false,
  loopEnabled: false,
  pitch: "hornF",
  bFlatAvailable: true,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasRestSelection: false,
  hasWaveformSelection: false,
  reviewOpen: false,
  reviewIssueEditable: false,
  reviewCount: 0,
  reviewTotal: 0,
  isRecording: false,
  isRecordingPaused: false,
  isRecordingStarting: false,
  auditionEnabled: false,
  view: "workspace",
};

const VIEWS: PitchView[] = ["concert", "hornF", "bFlat"];

describe("#349 pitch-view command mapping", () => {
  const registry = createCommandRegistry();

  it("maps every pitch view to a distinct registered command id", () => {
    const seen = new Set<string>();
    for (const view of VIEWS) {
      const id = PITCH_COMMAND[view];
      expect(id).toBeTruthy();
      expect(registry.list().some((c) => c.id === id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(VIEWS.length);
  });

  it("each mapped command applies its own pitch view", () => {
    for (const view of VIEWS) {
      const setPitchView = vi.fn();
      const ctx = { setPitchView } as unknown as CommandContext;
      const invoked = registry.invoke(
        PITCH_COMMAND[view],
        ctx,
        SNAPSHOT_SCORE,
      );
      expect(invoked).toBe(true);
      expect(setPitchView).toHaveBeenCalledWith(view);
    }
  });

  it("bFlat stays a no-op when the document lacks a B♭ projection", () => {
    const setPitchView = vi.fn();
    const ctx = { setPitchView } as unknown as CommandContext;
    const invoked = registry.invoke(PITCH_COMMAND.bFlat, ctx, {
      ...SNAPSHOT_SCORE,
      bFlatAvailable: false,
    });
    expect(invoked).toBe(false);
    expect(setPitchView).not.toHaveBeenCalled();
  });
});
