// @vitest-environment node
// #401: a failed renderer init must not poison the lazy singleton —
// every getScoreRenderer() after a rejection starts a fresh WASM
// init attempt, so the error surface's 再試行 is a real retry.
import { describe, expect, it, vi } from "vitest";

const wasm = vi.hoisted(() => ({ calls: 0, fail: true }));

vi.mock("verovio/wasm", () => ({
  default: () => {
    wasm.calls += 1;
    return wasm.fail
      ? Promise.reject(
          new Error("WebAssembly.instantiate(): magic word mismatch"),
        )
      : Promise.resolve({});
  },
}));

vi.mock("verovio/esm", () => ({
  VerovioToolkit: class {
    setOptions(): void {}
    getVersion(): string {
      return "test";
    }
  },
}));

import { getScoreRenderer } from "./verovio";

describe("getScoreRenderer init resilience (#401)", () => {
  it("re-inits after rejection instead of replaying it, then caches success", async () => {
    await expect(getScoreRenderer()).rejects.toThrow("magic word");
    await expect(getScoreRenderer()).rejects.toThrow("magic word");
    // Two calls, two real init attempts — the rejected promise was
    // dropped from the singleton, not replayed.
    expect(wasm.calls).toBe(2);

    wasm.fail = false;
    await expect(getScoreRenderer()).resolves.toBeTruthy();
    await expect(getScoreRenderer()).resolves.toBeTruthy();
    // Success caches normally — no fourth init.
    expect(wasm.calls).toBe(3);
  });
});