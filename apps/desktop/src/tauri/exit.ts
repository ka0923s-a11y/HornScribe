/**
 * #407: confirmed exit — destroy() bypasses onCloseRequested, so a
 * confirmed close never re-prompts. The window command is ACL-gated
 * (core:window:allow-destroy); if that grant ever regresses, the
 * app-owned `exit_app` command still terminates the process because
 * app-defined commands live outside the plugin ACL.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function requestAppExit(): void {
  void getCurrentWindow()
    .destroy()
    .catch(() => invoke("exit_app").catch(() => undefined));
}
