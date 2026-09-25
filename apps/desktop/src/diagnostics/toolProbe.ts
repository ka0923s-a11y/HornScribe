/**
 * Override-aware tool probing (#363).
 *
 * `withPathOverride` trusts a user-specified path blindly — it predates
 * the shell's ability to verify paths, so a typo'd MuseScore path showed
 * 検出済み until the export subprocess failed. Inside the Tauri webview
 * the real path is now probed (`probe_tool_path`) and a bad override
 * reports 未検出 with the offending path attached; the blind merge
 * remains only as the fallback where no fs bridge exists (vite dev in
 * a plain browser).
 */
import { invoke } from "@tauri-apps/api/core";
import { withPathOverride, type ToolInfo } from "./types";

interface ToolProbeWire {
  status: string;
  path?: string;
}

interface DetectedToolsWire {
  museScore: ToolProbeWire;
  ffmpeg: ToolProbeWire;
}

function toToolInfo(wire: ToolProbeWire): ToolInfo {
  return wire.status === "found"
    ? { status: "found", path: wire.path }
    : { status: "missing" };
}

/**
 * `detect_tools` probe — null when the bridge/command is unavailable.
 * The caller picks the honest fallback: "missing" for export gating,
 * "unknown" for diagnostics display.
 */
export async function detectTools(): Promise<{
  museScore: ToolInfo;
  ffmpeg: ToolInfo;
} | null> {
  try {
    const wire = await invoke<DetectedToolsWire>("detect_tools");
    return {
      museScore: toToolInfo(wire.museScore),
      ffmpeg: toToolInfo(wire.ffmpeg),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve one tool row: a non-empty user override is verified against
 * the filesystem instead of being reported found unconditionally. The
 * probed path stays on the result even when missing so the UI can show
 * where it looked. When the probe itself is unavailable (no bridge),
 * falls back to trusting the override.
 */
export async function resolveToolWithOverride(
  probed: ToolInfo,
  overridePath: string | undefined,
): Promise<ToolInfo> {
  const path = overridePath?.trim();
  if (!path) return probed;
  try {
    const wire = await invoke<ToolProbeWire>("probe_tool_path", { path });
    return wire.status === "found"
      ? { ...probed, status: "found", path }
      : { ...probed, status: "missing", path };
  } catch {
    return withPathOverride(probed, path);
  }
}
