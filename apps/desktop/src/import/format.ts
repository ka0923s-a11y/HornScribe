/**
 * Formatting helpers for the import/AUDIO_READY surfaces (UI-020).
 * Timecode follows GUI_UX_SPEC §9: MM:SS.t (03:17.8) with tabular digits.
 */

/** `MM:SS.t` transport timecode — matches the spec's `00:34.2 / 03:17.8`. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const whole = Math.floor(s);
  const tenths = Math.floor((s - whole) * 10);
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenths}`;
}

/** Human file size for the audio metadata line (1.4 MB / 512 KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/** Duration for metadata (03:17.8) — same shape as the transport readout. */
export function formatDuration(seconds: number): string {
  return formatTimecode(seconds);
}
