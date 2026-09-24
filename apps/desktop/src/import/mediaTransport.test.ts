/**
 * MediaElementTransport tests (UI-020 adapter over the UI-004 contract).
 * A FakePort stands in for HTMLAudioElement — the adapter's state machine,
 * snapshot emission and loop/seek/rate rules are what get asserted.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MediaElementTransport,
  MIN_LOOP_SECONDS,
  type MediaPort,
  type MediaPortHandlers,
  type TransportSnapshot,
} from "./mediaTransport";
import type { MediaSource } from "./types";

class FakePort implements MediaPort {
  time = 0;
  duration = 120;
  rate = 1;
  preservePitch = true;
  playing = false;
  loaded: MediaSource | null = null;
  seekCalls: number[] = [];
  failLoad = false;
  private handlers = new Set<MediaPortHandlers>();

  async load(source: MediaSource): Promise<void> {
    if (this.failLoad) throw new Error("load failed");
    this.loaded = source;
  }
  async play(): Promise<void> {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  seekTo(seconds: number): void {
    this.time = seconds;
    this.seekCalls.push(seconds);
  }
  setRate(rate: number): void {
    this.rate = rate;
  }
  setPreservePitch(on: boolean): void {
    this.preservePitch = on;
  }
  muted = false;
  setMuted(on: boolean): void {
    this.muted = on;
  }
  getTime(): number {
    return this.time;
  }
  getDuration(): number {
    return this.duration;
  }
  subscribe(handlers: MediaPortHandlers): () => void {
    this.handlers.add(handlers);
    return () => this.handlers.delete(handlers);
  }
  emit(key: keyof MediaPortHandlers): void {
    for (const h of this.handlers) h[key]?.();
  }
}

function makeTransport(failLoad = false) {
  const port = new FakePort();
  port.failLoad = failLoad;
  const transport = new MediaElementTransport(port);
  const snaps: TransportSnapshot[] = [];
  transport.subscribe((s) => snaps.push(s));
  return { port, transport, snaps };
}

const SRC: MediaSource = { kind: "blob", blob: new Blob(["x"]) };

describe("load", () => {
  it("empty → loading → ready with snapshots on each step", async () => {
    const { transport, snaps } = makeTransport();
    await transport.load(SRC);
    expect(transport.getSnapshot().status).toBe("ready");
    expect(snaps.map((s) => s.status)).toEqual(["loading", "ready"]);
  });

  it("a failed load flips to error and rejects", async () => {
    const { transport, snaps } = makeTransport(true);
    await expect(transport.load(SRC)).rejects.toThrow();
    expect(transport.getSnapshot().status).toBe("error");
    expect(snaps.map((s) => s.status)).toEqual(["loading", "error"]);
  });
});

describe("play / pause / stop / ended", () => {
  it("play → playing; pause → paused; play after ended rewinds first", async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    await transport.play();
    expect(transport.getSnapshot().status).toBe("playing");

    transport.pause();
    expect(transport.getSnapshot().status).toBe("paused");

    // `ended` only fires while playing (a paused element never ends).
    await transport.play();
    port.time = 42;
    port.emit("onEnded");
    expect(transport.getSnapshot().status).toBe("ended");

    await transport.play();
    expect(port.seekCalls.at(-1)).toBe(0); // rewind before replay
    expect(transport.getSnapshot().status).toBe("playing");
  });

  it("stop pauses and seeks to 0 (loop start when armed)", async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    await transport.play();
    transport.setLoop({ start: 10, end: 20 });
    port.time = 15;
    transport.stop();
    expect(port.playing).toBe(false);
    expect(port.time).toBe(10);
    expect(transport.getSnapshot().status).toBe("ready");
  });

  it("no-ops while empty/loading (no source yet)", async () => {
    const { transport } = makeTransport();
    await transport.play(); // status empty — silently ignored
    transport.pause();
    transport.stop();
    expect(transport.getSnapshot().status).toBe("empty");
  });
});

describe("seek / rate / loop", () => {
  it("seek clamps into [0, duration] and unsticks 'ended'", async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    await transport.play();
    port.emit("onEnded");
    await transport.seek(50);
    expect(port.time).toBe(50);
    expect(transport.getSnapshot().status).toBe("paused");
    await transport.seek(999);
    expect(port.time).toBe(120);
    await transport.seek(-3);
    expect(port.time).toBe(0);
  });

  it("setRate clamps to [0.25, 4] and emits", async () => {
    const { port, transport } = makeTransport();
    transport.setRate(2);
    expect(port.rate).toBe(2);
    transport.setRate(0.01);
    expect(port.rate).toBe(0.25);
    transport.setRate(99);
    expect(port.rate).toBe(4);
  });

  it("setLoop validates the range and clears on null", async () => {
    const { transport } = makeTransport();
    await transport.load(SRC);
    transport.setLoop({ start: 5, end: 5 + MIN_LOOP_SECONDS / 2 });
    expect(transport.getSnapshot().loop).toBeNull(); // too short → rejected
    transport.setLoop({ start: 5, end: 30 });
    expect(transport.getSnapshot().loop).toEqual({ start: 5, end: 30 });
    transport.setLoop(null);
    expect(transport.getSnapshot().loop).toBeNull();
  });

  it("playback past loop.end wraps to loop.start (A-B via media seek)", async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    await transport.play();
    transport.setLoop({ start: 10, end: 20 });
    port.time = 20.5;
    port.emit("onTimeUpdate");
    expect(port.seekCalls.at(-1)).toBe(10);
  });

  it("load clears a previously armed loop", async () => {
    const { transport } = makeTransport();
    await transport.load(SRC);
    transport.setLoop({ start: 1, end: 2 });
    await transport.load(SRC);
    expect(transport.getSnapshot().loop).toBeNull();
  });

  it("playRange seeks to the range start, plays once, then pauses (#113)",
     async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    await transport.playRange(10, 20);
    expect(port.seekCalls.at(-1)).toBe(10);
    expect(transport.getSnapshot().status).toBe("playing");
    port.time = 20.5;
    port.emit("onTimeUpdate");
    expect(port.playing).toBe(false);
    expect(transport.getSnapshot().status).toBe("paused");
  });

  it("playRange clears an armed loop and is cleared by seek/stop/setLoop",
     async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    transport.setLoop({ start: 1, end: 2 });
    await transport.playRange(10, 20);
    expect(transport.getSnapshot().loop).toBeNull();
    // seek cancels the pending one-shot range
    await transport.seek(0);
    await transport.play();
    port.time = 25;
    port.emit("onTimeUpdate");
    expect(port.playing).toBe(true); // no pause at the old range end
    // setLoop also clears it
    await transport.playRange(30, 40);
    transport.setLoop({ start: 1, end: 2 });
    port.time = 41;
    port.emit("onTimeUpdate");
    expect(port.seekCalls.at(-1)).toBe(1); // loop wrap, not one-shot
  });
});

describe("snapshots / listeners", () => {
  it("revision bumps per emit; time mirrors the audio clock", async () => {
    const { port, transport, snaps } = makeTransport();
    await transport.load(SRC);
    port.time = 33;
    port.emit("onTimeUpdate");
    const last = snaps.at(-1)!;
    expect(last.time).toBe(33);
    expect(last.revision).toBe(snaps.length);
    expect(last.duration).toBe(120);
  });

  it("unsubscribe stops notifications; dispose pauses the port", async () => {
    const { port, transport } = makeTransport();
    await transport.load(SRC);
    const spy = vi.fn();
    const off = transport.subscribe(spy);
    transport.pause();
    transport.setRate(1.5);
    expect(spy).toHaveBeenCalled();
    off();
    const calls = spy.mock.calls.length;
    transport.setRate(1.25);
    expect(spy.mock.calls.length).toBe(calls);

    await transport.play();
    transport.dispose();
    expect(port.playing).toBe(false);
  });
});
