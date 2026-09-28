/**
 * ScoreCursorClock tests (UI-030). The clock is driven by an injectable
 * rAF so tests are deterministic — the production binding is the media
 * clock (UI-005 "one clock" contract).
 */
import { describe, expect, it, vi } from "vitest";
import { ScoreCursorClock } from "./clock";

/** Manual rAF driver: queued callbacks run when `step(now)` is called. */
function fakeRaf() {
  let nextId = 1;
  const queue = new Map<number, (t: number) => void>();
  const raf = (cb: (t: number) => void) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  const caf = (id: number) => {
    queue.delete(id);
  };
  const step = (now: number) => {
    const pending = [...queue.values()];
    queue.clear();
    for (const cb of pending) cb(now);
  };
  return { raf, caf, step };
}

describe("ScoreCursorClock", () => {
  it("advances position with rAF ticks while playing", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.play();
    step(100);
    step(600); // +500ms
    step(1100); // +500ms
    expect(clock.positionMs()).toBeCloseTo(1000);
    expect(clock.isPlaying()).toBe(true);
    clock.dispose();
  });

  it("pauses and resumes at the current position", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.play();
    step(100);
    step(600);
    clock.pause();
    step(1200); // ignored while paused
    expect(clock.positionMs()).toBeCloseTo(500);
    clock.play();
    step(1300);
    step(1600);
    expect(clock.positionMs()).toBeCloseTo(800);
    clock.dispose();
  });

  it("stop resets to 0 and pauses", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.play();
    step(100);
    step(600);
    clock.stop();
    expect(clock.positionMs()).toBe(0);
    expect(clock.isPlaying()).toBe(false);
    clock.dispose();
  });

  it("clamps seek into [0, duration]", () => {
    const clock = new ScoreCursorClock(4000, { raf: () => 0, caf: () => {} });
    clock.seek(-50);
    expect(clock.positionMs()).toBe(0);
    clock.seek(99999);
    expect(clock.positionMs()).toBe(4000);
    clock.jumpBy(-1000);
    expect(clock.positionMs()).toBe(3000);
    clock.dispose();
  });

  it("wraps inside the armed loop range", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.setLoop({ startMs: 1000, endMs: 2000 });
    clock.seek(1500);
    clock.play();
    step(100);
    step(800); // +700 → 2200 wraps to 1200
    expect(clock.positionMs()).toBeCloseTo(1200);
    expect(clock.isPlaying()).toBe(true);
    clock.dispose();
  });

  it("clears an invalid loop range", () => {
    const clock = new ScoreCursorClock(4000, { raf: () => 0, caf: () => {} });
    clock.setLoop({ startMs: 2000, endMs: 1000 });
    expect(clock.loopRange()).toBeNull();
    clock.dispose();
  });

  it("stops at the duration end", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(1000, { raf, caf });
    clock.play();
    step(100);
    step(1200); // +1100 → past end
    expect(clock.positionMs()).toBe(1000);
    expect(clock.isPlaying()).toBe(false);
    clock.dispose();
  });

  it("emits snapshots on transitions and throttles steady-state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    const seen: number[] = [];
    clock.subscribe((s) => seen.push(s.positionMs));
    expect(seen).toEqual([0]); // initial snapshot
    clock.play(); // forced transition emit
    expect(seen.length).toBe(2);
    step(100);
    step(200);
    step(300); // all within the throttle window
    expect(seen.length).toBe(2);
    vi.setSystemTime(200); // past the 100ms interval
    step(400);
    expect(seen.length).toBe(3);
    clock.dispose();
    vi.useRealTimers();
  });

  it("setDuration clamps position and loop into the new span (#170)", () => {
    const { raf, caf } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.seek(3500);
    clock.setLoop({ startMs: 1000, endMs: 3000 });
    // Shrink below the position + loop end: both re-clamp.
    clock.setDuration(2000);
    expect(clock.durationMs()).toBe(2000);
    expect(clock.positionMs()).toBe(2000);
    expect(clock.loopRange()).toEqual({ startMs: 1000, endMs: 2000 });
    // Growing restores headroom; a fully out-of-range loop drops.
    clock.setDuration(500);
    expect(clock.loopRange()).toBeNull();
    expect(clock.positionMs()).toBe(500);
    clock.dispose();
  });

  it("setDuration ignores invalid input", () => {
    const { raf, caf } = fakeRaf();
    const clock = new ScoreCursorClock(4000, { raf, caf });
    clock.setDuration(Number.NaN);
    clock.setDuration(-5);
    expect(clock.durationMs()).toBe(4000);
    clock.dispose();
  });

  /* #101: count-in — play(countInMs) freezes the position for that much
   *  score-time before playback advances. */
  it("count-in holds the position, then advances normally", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(8000, { raf, caf });
    clock.play(1000);
    expect(clock.isPlaying()).toBe(true);
    step(100); // rAF arm
    step(600); // +500 real -> hold 500 remains
    expect(clock.positionMs()).toBe(0);
    step(1100); // +500 -> hold exactly consumed
    expect(clock.positionMs()).toBe(0);
    step(1600); // now the score advances
    expect(clock.positionMs()).toBeCloseTo(500);
    clock.dispose();
  });

  it("count-in leftover flows into the position mid-tick", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(8000, { raf, caf });
    clock.play(400);
    step(100);
    step(600); // +500 -> 400 to hold, 100 to the position
    expect(clock.positionMs()).toBeCloseTo(100);
    clock.dispose();
  });

  it("snapshot reports countingIn + remaining; its end force-emits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(8000, { raf, caf });
    const seen: boolean[] = [];
    clock.subscribe((s) => seen.push(s.countingIn));
    clock.play(1000);
    step(100);
    step(600);
    const beforeEnd = seen.length;
    step(1100); // hold consumed here -> transition must emit at once
    expect(seen.length).toBe(beforeEnd + 1);
    expect(seen[seen.length - 1]).toBe(false);
    clock.dispose();
    vi.useRealTimers();
  });

  it("pause and seek during the count-in cancel the hold", () => {
    const { raf, caf, step } = fakeRaf();
    const clock = new ScoreCursorClock(8000, { raf, caf });
    clock.play(1000);
    step(100);
    clock.pause();
    clock.play(); // plain play — no count-in budget
    step(200);
    step(700);
    // Had the old hold survived, pos would still sit at 0.
    expect(clock.positionMs()).toBeCloseTo(500);
    clock.dispose();
  });
});
