/**
 * Score/transport timecode formatting (GUI_UX_SPEC §9: 現在時刻 / 総時間).
 * `mm:ss.t` — one decimal, matching the spec's "00:34.2" wireframes and the
 * transport bar's tabular-numeral styling.
 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return `${mm}:${ss}.${tenths}`;
}

/** `7.2` — one-decimal seconds for inline inspector labels. */
export function formatSecondsJa(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}
