/**
 * @vitest-environment node
 *
 * #407: the packaged shell lost every exit path once because
 * plugin:window|destroy was ACL-denied. requestAppExit keeps an
 * app-owned fallback so a capability regression can never again make
 * the window impossible to close.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { destroy, invokeMock } = vi.hoisted(() => ({
  destroy: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

import { requestAppExit } from "./exit";

describe("requestAppExit (#407)", () => {
  beforeEach(() => {
    destroy.mockReset();
    invokeMock.mockReset();
  });

  it("destroys the current window on the happy path", async () => {
    destroy.mockResolvedValue(undefined);
    requestAppExit();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to exit_app when destroy is denied", async () => {
    destroy.mockRejectedValue(new Error("window.destroy not allowed"));
    invokeMock.mockResolvedValue(undefined);
    requestAppExit();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("exit_app");
  });

  it("never throws when both paths fail", async () => {
    destroy.mockRejectedValue(new Error("denied"));
    invokeMock.mockRejectedValue(new Error("no command"));
    requestAppExit();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("exit_app");
  });
});
