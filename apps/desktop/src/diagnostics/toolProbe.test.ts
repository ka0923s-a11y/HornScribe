// @vitest-environment jsdom
/**
 * #363 tool-probe contract tests — a user-specified override path is
 * verified through `probe_tool_path` instead of being reported found
 * unconditionally; the blind merge survives only when no bridge exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectTools, resolveToolWithOverride } from "./toolProbe";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("resolveToolWithOverride", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("empty overrides return the probed result untouched", async () => {
    const probed = { status: "found" as const, path: "C:\\auto\\ms.exe" };
    expect(await resolveToolWithOverride(probed, undefined)).toBe(probed);
    expect(await resolveToolWithOverride(probed, "   ")).toBe(probed);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a verified override reports found with the trimmed path", async () => {
    invokeMock.mockResolvedValue({ status: "found", path: "D:\\ms.exe" });
    const info = await resolveToolWithOverride(
      { status: "missing" },
      "  D:\\ms.exe  ",
    );
    expect(info).toEqual({ status: "found", path: "D:\\ms.exe" });
    expect(invokeMock).toHaveBeenCalledWith("probe_tool_path", {
      path: "D:\\ms.exe",
    });
  });

  it("a bogus override reports missing and keeps the path it tried", async () => {
    invokeMock.mockResolvedValue({ status: "missing" });
    const info = await resolveToolWithOverride(
      { status: "found", path: "C:\\auto\\ms.exe" },
      "D:\\nope\\ms.exe",
    );
    expect(info.status).toBe("missing");
    expect(info.path).toBe("D:\\nope\\ms.exe");
  });

  it("falls back to trusting the override when the bridge cannot probe", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("no tauri");
    });
    const info = await resolveToolWithOverride(
      { status: "missing" },
      "D:\\ms.exe",
    );
    expect(info).toEqual({ status: "found", path: "D:\\ms.exe" });
  });
});

describe("detectTools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("maps the wire probe to ToolInfo rows", async () => {
    invokeMock.mockResolvedValue({
      museScore: { status: "found", path: "MuseScore4" },
      ffmpeg: { status: "missing" },
    });
    const tools = await detectTools();
    expect(tools?.museScore).toEqual({ status: "found", path: "MuseScore4" });
    expect(tools?.ffmpeg).toEqual({ status: "missing" });
  });

  it("resolves null when the command is unavailable", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("no tauri");
    });
    await expect(detectTools()).resolves.toBeNull();
  });
});
