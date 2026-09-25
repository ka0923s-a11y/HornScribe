// @vitest-environment node
/** #400: close-request priority — dirty data first (only thing a save
 *  preserves), then recording, then a running job; dirty+transcribing
 *  is its own combined dialog, never two prompts. */
import { describe, expect, it } from "vitest";
import { closeGuardKind } from "./closeGuard";

describe("closeGuardKind (#400)", () => {
  it("idle/clean close needs no confirmation", () => {
    expect(
      closeGuardKind({ dirty: false, recording: false, transcribing: false }),
    ).toBeNull();
  });

  it("a running transcription alone confirms — the job dies on exit", () => {
    expect(
      closeGuardKind({ dirty: false, recording: false, transcribing: true }),
    ).toBe("transcribing");
  });

  it("dirty score keeps the existing guard", () => {
    expect(
      closeGuardKind({ dirty: true, recording: false, transcribing: false }),
    ).toBe("dirty");
  });

  it("recording alone keeps its guard", () => {
    expect(
      closeGuardKind({ dirty: false, recording: true, transcribing: false }),
    ).toBe("recording");
  });

  it("dirty + transcribing is ONE combined confirmation", () => {
    expect(
      closeGuardKind({ dirty: true, recording: false, transcribing: true }),
    ).toBe("dirtyTranscribing");
  });

  it("dirty + recording is ONE combined confirmation — the take", () => {
    // #301 re-review: a dirty-only dialog would silently destroy the
    // live take on 保存して閉じる / 保存せずに閉じる alike.
    expect(
      closeGuardKind({ dirty: true, recording: true, transcribing: false }),
    ).toBe("dirtyRecording");
  });

  it("all three hazards still resolve to the recording-owning dialog", () => {
    // A take cannot be re-captured; a transcription can be re-run, so
    // dirtyRecording owns the close even while a job is in flight.
    expect(
      closeGuardKind({ dirty: true, recording: true, transcribing: true }),
    ).toBe("dirtyRecording");
  });

  it("recording beats a bare transcribing guard", () => {
    expect(
      closeGuardKind({ dirty: false, recording: true, transcribing: true }),
    ).toBe("recording");
  });
});
