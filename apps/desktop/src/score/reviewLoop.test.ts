import { describe, expect, it } from "vitest";
import {
  armReviewLoop,
  emptyReviewLoopState,
  releaseReviewLoop,
  retargetReviewLoop,
  type LoopPort,
  type LoopRangeSec,
  type ReviewLoopState,
} from "./reviewLoop";

const MIN_LOOP = 0.01;

/** Mirrors the two real ports: setLoop clamps into [0, duration] and
 *  rejects degenerate ranges (keeps the previous loop). */
class FakePort implements LoopPort {
  loop: LoopRangeSec | null = null;

  constructor(private readonly duration = 60) {}

  loopRange(): LoopRangeSec | null {
    return this.loop ? { ...this.loop } : null;
  }

  setLoop(range: LoopRangeSec | null): void {
    if (range === null) {
      this.loop = null;
      return;
    }
    const start = Math.max(0, range.start);
    const end = Math.min(this.duration, range.end);
    if (end - start < MIN_LOOP) return;
    this.loop = { start, end };
  }
}

const A: LoopRangeSec = { start: 1.2, end: 2.4 };
const B: LoopRangeSec = { start: 5.0, end: 6.5 };

function setup() {
  const clock = new FakePort();
  const source = new FakePort();
  const ports = [clock, source];
  return { clock, source, ports };
}

describe("review audition loop lifecycle", () => {
  it("arm writes the issue range to every port", () => {
    const { clock, source, ports } = setup();
    const s = armReviewLoop(emptyReviewLoopState(), ports, A);
    expect(s.armed).toBe(true);
    expect(clock.loopRange()).toEqual(A);
    expect(source.loopRange()).toEqual(A);
  });

  it("retarget moves the loop to the next issue instead of rewinding", () => {
    const { clock, source, ports } = setup();
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    s = retargetReviewLoop(s, ports, B);
    expect(s.armed).toBe(true);
    expect(clock.loopRange()).toEqual(B);
    expect(source.loopRange()).toEqual(B);
  });

  it("retarget(null) clears the loop for a range-less issue but stays armed", () => {
    const { clock, ports } = setup();
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    s = retargetReviewLoop(s, ports, null);
    expect(s.armed).toBe(true);
    expect(clock.loopRange()).toBeNull();
    // ...and a later ranged issue re-arms it.
    s = retargetReviewLoop(s, ports, B);
    expect(clock.loopRange()).toEqual(B);
  });

  it("release clears the review loop when the user had none", () => {
    const { clock, source, ports } = setup();
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toBeNull();
    expect(source.loopRange()).toBeNull();
  });

  it("release restores the user's pre-review loop", () => {
    const { clock, source, ports } = setup();
    const userLoop: LoopRangeSec = { start: 0, end: 10 };
    clock.setLoop(userLoop);
    source.setLoop(userLoop);
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toEqual(userLoop);
    expect(source.loopRange()).toEqual(userLoop);
  });

  it("a user override on one port survives retarget and release", () => {
    const { clock, source, ports } = setup();
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    // User takes over the media transport loop mid-review.
    const userLoop: LoopRangeSec = { start: 20, end: 30 };
    source.setLoop(userLoop);
    s = retargetReviewLoop(s, ports, B);
    // Clock follows the new issue; the user-owned port is untouched.
    expect(clock.loopRange()).toEqual(B);
    expect(source.loopRange()).toEqual(userLoop);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toBeNull();
    expect(source.loopRange()).toEqual(userLoop);
  });

  it("user clearing the loop disarms that port without killing the review", () => {
    const { clock, source, ports } = setup();
    let s = armReviewLoop(emptyReviewLoopState(), ports, A);
    clock.setLoop(null); // user pressed toggleLoop on the score clock
    s = retargetReviewLoop(s, ports, B);
    expect(clock.loopRange()).toBeNull();
    expect(source.loopRange()).toEqual(B);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toBeNull();
    expect(source.loopRange()).toBeNull();
  });

  it("rejected writes (degenerate range) do not confuse release", () => {
    const { clock, ports } = setup();
    const userLoop: LoopRangeSec = { start: 0, end: 10 };
    clock.setLoop(userLoop);
    let s = armReviewLoop(emptyReviewLoopState(), ports, {
      start: 5,
      end: 5, // degenerate: rejected, the port keeps the user's loop
    });
    // The port still shows the user loop -> treated as user-owned, so a
    // retarget must not overwrite it and release must leave it alone.
    s = retargetReviewLoop(s, ports, B);
    expect(s.armed).toBe(true);
    expect(clock.loopRange()).toEqual(userLoop);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toEqual(userLoop);
  });

  it("release/retarget on a never-armed state is a no-op", () => {
    const { clock, source, ports } = setup();
    const s0 = emptyReviewLoopState();
    const s1 = retargetReviewLoop(s0, ports, A);
    const s2 = releaseReviewLoop(s1, ports);
    expect(clock.loopRange()).toBeNull();
    expect(source.loopRange()).toBeNull();
    expect(s2.armed).toBe(false);
  });

  it("re-arming mid-review keeps the ORIGINAL saved user loop", () => {
    const { clock, ports } = setup();
    const userLoop: LoopRangeSec = { start: 0, end: 10 };
    clock.setLoop(userLoop);
    let s: ReviewLoopState = armReviewLoop(
      emptyReviewLoopState(),
      ports,
      A,
    );
    // Play pressed again on another issue while still armed.
    s = armReviewLoop(s, ports, B);
    s = releaseReviewLoop(s, ports);
    expect(s.armed).toBe(false);
    expect(clock.loopRange()).toEqual(userLoop);
  });
});
