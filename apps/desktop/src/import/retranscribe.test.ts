// @vitest-environment node
/** #343: the option-mirror + job-start transaction semantics — a dirty
 *  score キャンセル must leave transcriptionOptions/settings untouched,
 *  and only the user's 続ける choice may commit them. */
import { describe, expect, it, vi } from "vitest";
import { requestRetranscription } from "./retranscribe";

function harness(
  over: Partial<Parameters<typeof requestRetranscription>[0]> = {},
) {
  return {
    audioLoaded: over.audioLoaded ?? true,
    dirty: over.dirty ?? false,
    commitOptions: vi.fn(over.commitOptions),
    startJob: vi.fn(over.startJob),
    queuePending: vi.fn(over.queuePending),
    onNoAudio: vi.fn(over.onNoAudio),
  };
}

describe("requestRetranscription (#343)", () => {
  it("clean score commits options and starts the job immediately", () => {
    const r = harness();
    requestRetranscription(r);
    expect(r.commitOptions).toHaveBeenCalledTimes(1);
    expect(r.startJob).toHaveBeenCalledWith(false);
    expect(r.queuePending).not.toHaveBeenCalled();
  });

  it("dirty score queues the WHOLE pair — cancel commits nothing", () => {
    const r = harness({ dirty: true });
    requestRetranscription(r);
    // The user pressing キャンセル simply never invokes the queued action.
    expect(r.queuePending).toHaveBeenCalledTimes(1);
    expect(r.commitOptions).not.toHaveBeenCalled();
    expect(r.startJob).not.toHaveBeenCalled();
  });

  it("dirty score 続ける commits options then starts with the guard answered", () => {
    const r = harness({ dirty: true });
    requestRetranscription(r);
    const pending = r.queuePending.mock.calls[0]?.[0];
    expect(pending).toBeTypeOf("function");
    pending!();
    expect(r.commitOptions).toHaveBeenCalledTimes(1);
    // skipGuard — the pending closure must not re-guard itself (#347).
    expect(r.startJob).toHaveBeenCalledWith(true);
    // Order matters: mirror lands before the job consumes options.
    expect(r.commitOptions.mock.invocationCallOrder[0]).toBeLessThan(
      r.startJob.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("no audio announces and mutates nothing", () => {
    const r = harness({ audioLoaded: false });
    requestRetranscription(r);
    expect(r.onNoAudio).toHaveBeenCalledTimes(1);
    expect(r.commitOptions).not.toHaveBeenCalled();
    expect(r.startJob).not.toHaveBeenCalled();
    expect(r.queuePending).not.toHaveBeenCalled();
  });
});
