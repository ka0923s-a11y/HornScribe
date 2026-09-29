/**
 * #123: does the canonical score hold playable-polyphonic content?
 *
 * True when the payload has more than one part (voices texture) or a
 * part contains same-onset live-note groups (chords texture / merged
 * layers). Gates the 単旋律にまとめる command — a monophonic score has
 * nothing to collapse, so the command stays disabled.
 *
 * Canonical-deleted notes do NOT count: they render as rests and the
 * collapse keeps them as tombstones anyway.
 */

interface CollapseNoteShape {
  readonly startBeat?: unknown;
  readonly deleted?: unknown;
}

interface CollapsePartShape {
  readonly notes?: unknown;
}

export function scoreHasPolyphony(canonical: unknown): boolean {
  if (canonical == null || typeof canonical !== "object") return false;
  const content = (canonical as { content?: unknown }).content;
  if (content == null || typeof content !== "object") return false;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;
  if (parts.length > 1) {
    // Only count a later part that still carries live notes.
    const extra = (parts as readonly CollapsePartShape[])
      .slice(1)
      .some((p) =>
        Array.isArray(p?.notes) &&
          (p.notes as readonly CollapseNoteShape[]).some(
            (n) => n?.deleted !== true,
          ),
      );
    if (extra) return true;
  }
  for (const part of parts as readonly CollapsePartShape[]) {
    const notes = part?.notes;
    if (!Array.isArray(notes)) continue;
    const seen = new Set<string>();
    for (const n of notes as readonly CollapseNoteShape[]) {
      if (n?.deleted === true) continue;
      const key = String(n?.startBeat ?? "");
      if (key === "") continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return false;
}
