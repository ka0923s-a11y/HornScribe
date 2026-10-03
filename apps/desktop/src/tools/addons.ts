/**
 * Optional addon drop-in (#190) -- the writable ``data_dir()/tools``
 * root where the user extracts the demucs separation bundle.
 *
 * The bundled app ships tools/ read-only under Program Files, so
 * user-installable addons live in appData (or ``data/tools`` next to
 * a portable exe). The engine child inherits this dir on PATH, and
 * the Python side probes ``<dir>/demucs/demucs.exe`` -- see
 * ``tools::bundled_tools_dirs`` and ``vocal._demucs_cmd``.
 *
 * Tauri-only: in the browser dev shell both calls degrade to
 * null/false, the same contract as the recordings helpers.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../tauri/bridge";

/** Absolute path of the addon drop-in folder (may not exist yet).
 *  Non-Tauri / failure -> null. */
export async function getAddonsDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<string>("addons_dir");
  } catch {
    return null;
  }
}

/** Create the drop-in folder if missing and reveal it in Explorer.
 *  Success -> true. */
export async function openAddonsDir(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    await invoke("open_addons_dir");
    return true;
  } catch {
    return false;
  }
}
