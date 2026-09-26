/**
 * DevBridgeSidecarPort tests (#86): the browser-dev transport must
 * (a) fall back to the in-process mock when the Vite bridge is absent,
 * (b) relay spawn/write/SSE faithfully when the bridge is up.
 * fetch and EventSource are stubbed — jsdom has no EventSource.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevBridgeSidecarPort } from "./devBridgePort";
import { SidecarError } from "./protocol";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  close(): void {
    this.closed = true;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DevBridgeSidecarPort", () => {
  const realFetch = globalThis.fetch;
  const realES = globalThis.EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.stubGlobal("fetch", realFetch);
    vi.stubGlobal("EventSource", realES);
  });

  it("falls back to the mock engine when the bridge is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection refused"))),
    );
    const port = new DevBridgeSidecarPort();
    const lines: string[] = [];
    const exits: Array<number | null> = [];
    port.onLine((l) => lines.push(l));
    port.onExit((c) => exits.push(c));

    await port.start();

    // The mock speaks the real NDJSON contract — a handshake request
    // produces a response line without any bridge involvement.
    port.writeLine(
      JSON.stringify({
        v: 1,
        kind: "request",
        id: "r1",
        method: "engine.ping",
        payload: { echo: "hi" },
      }),
    );
    expect(lines.some((l) => l.includes('"engine.ping"'))).toBe(true);

    port.closeStdin(); // mock: EOF -> exit 0
    expect(exits).toEqual([0]);
  });

  it("spawns through the bridge and relays SSE events", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/__engine/health") {
          return Promise.resolve(jsonResponse(200, { ok: true, python: "py" }));
        }
        if (url === "/__engine/spawn") {
          return Promise.resolve(jsonResponse(200, { ok: true }));
        }
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }),
    );
    const port = new DevBridgeSidecarPort();
    const lines: string[] = [];
    const stderrs: string[] = [];
    const exits: Array<number | null> = [];
    port.onLine((l) => lines.push(l));
    port.onStderr((l) => stderrs.push(l));
    port.onExit((c) => exits.push(c));

    await port.start();

    // SSE stream opened before the spawn POST (no lost early output).
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(calls.map((c) => c.url.split("?")[0])).toEqual([
      "/__engine/health",
      "/__engine/spawn",
    ]);
    // #23: the spawn carries the same client id as the SSE listener
    // so the bridge can tell our subscription from another session's.
    const spawnUrl = calls.find((c) => c.url.startsWith(
      "/__engine/spawn",
    ));
    const esUrl = FakeEventSource.instances[0].url;
    const spawnClient = new URL(
      "http://x/" + (spawnUrl?.url ?? ""),
    ).searchParams.get(
      "client",
    );
    const esClient = new URL(
      "http://x/" + esUrl,
    ).searchParams.get(
      "client",
    );
    expect(spawnClient).toBeTruthy();
    expect(spawnClient).toBe(esClient);

    const es = FakeEventSource.instances[0];
    es.emit({ kind: "line", line: '{"v":1}' });
    es.emit({ kind: "stderr", line: "INFO worker" });
    expect(lines).toEqual(['{"v":1}']);
    expect(stderrs).toEqual(["INFO worker"]);

    port.writeLine('{"v":1,"kind":"request"}');
    const write = calls.find((c) => c.url === "/__engine/write");
    expect(write?.init?.method).toBe("POST");
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      line: '{"v":1,"kind":"request"}',
    });

    es.emit({ kind: "exit", code: 0 });
    es.emit({ kind: "exit", code: 0 });
    expect(exits).toEqual([0]); // fires exactly once
    expect(es.closed).toBe(true);
  });

  it("rejects start() with ENGINE_UNAVAILABLE when spawn fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/__engine/health"
          ? Promise.resolve(jsonResponse(200, { ok: true }))
          : Promise.resolve(jsonResponse(500, { error: "no python" })),
      ),
    );
    const port = new DevBridgeSidecarPort();
    await expect(port.start()).rejects.toBeInstanceOf(SidecarError);
    // The SSE stream is cleaned up when spawn fails.
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
