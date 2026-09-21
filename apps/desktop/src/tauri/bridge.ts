import { invoke } from "@tauri-apps/api/core";

/**
 * Shell↔Rust boundary.
 *
 * App-defined commands are invoked over Tauri's built-in IPC channel and are
 * NOT governed by capabilities/ACL (those apply to plugin/core commands).
 * No plugin permissions are required for `shell_info`.
 */
export interface ShellInfo {
  appName: string;
  version: string;
  rustTargetEnv: string;
}

/**
 * Returns null instead of throwing when the app runs outside the Tauri
 * webview (e.g. plain `vite dev` in a browser) so the shell still renders.
 */
export async function getShellInfo(): Promise<ShellInfo | null> {
  try {
    return await invoke<ShellInfo>("shell_info");
  } catch {
    return null;
  }
}
