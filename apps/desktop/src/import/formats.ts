/**
 * Supported audio container formats (UI-020).
 *
 * The empty state advertises exactly this list (GUI_UX_SPEC §3:
 * WAV・MP3・FLAC・M4A・OGG), so detection is extension-based and honest —
 * anything outside the list gets the actionable 対応していない形式 error
 * instead of a decoder shrug. Keep in sync with
 * `AUDIO_EXTENSIONS` in src-tauri/src/lib.rs (the read command allowlist).
 */
import type { AudioFormat } from "./types";

export const AUDIO_EXTENSIONS: readonly AudioFormat[] = [
  "wav",
  "mp3",
  "flac",
  "m4a",
  "ogg",
];

/** HornScribe project document suffix (project schema v1, FND-001). */
export const PROJECT_FILE_SUFFIX = ".hornscribe.json";

/** Lowercase extension without the dot ("" when absent). */
export function fileExtension(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Detect the audio format from a file name; null when unsupported. */
export function audioFormatOf(name: string): AudioFormat | null {
  const ext = fileExtension(name);
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as AudioFormat)
    : null;
}

/** Basename for both `/` and `\` separators (Windows paths). */
export function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** Display name for a project file: basename minus .hornscribe.json. */
export function projectDisplayName(path: string): string {
  const base = baseName(path);
  return base.toLowerCase().endsWith(PROJECT_FILE_SUFFIX)
    ? base.slice(0, base.length - PROJECT_FILE_SUFFIX.length)
    : base;
}
