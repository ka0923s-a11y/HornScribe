/**
 * Precomputed playback-position table (score milliseconds → sounding
 * canonical notes) built once per document load from Verovio's timemap.
 *
 * UI-005 finding: `getElementsAtTime` is onset-exact but costs a WASM call
 * per lookup; the production path precomputes an onset→canonical table so
 * the rAF pump is an array scan / binary search, never a per-frame WASM
 * call and never a re-render.
 */
import type { VerovioTimemapEntry } from "verovio/esm";
import { canonicalNoteIdFromMusicxml } from "./ids";

/** Notes sounding during `[startMs, endMs)` (half-open). */
export interface PlaybackSegment {
  readonly startMs: number;
  readonly endMs: number;
  /** MusicXML export ids (`hs-sn-*`) starting/ending at the boundaries. */
  readonly exportIds: readonly string[];
  /** Resolved canonical `sn-*` ids sounding in this segment. */
  readonly canonicalIds: ReadonlySet<string>;
}

export interface PlaybackTable {
  readonly segments: readonly PlaybackSegment[];
  readonly durationMs: number;
  /** export id → onset ms (first timemap `on` occurrence). */
  readonly onsetMsByExportId: ReadonlyMap<string, number>;
  /** canonical id → onset ms (earliest fragment onset). */
  readonly onsetMsByCanonical: ReadonlyMap<string, number>;
  /** canonical id → export ids (all fragments, in `on` order). */
  readonly exportIdsByCanonical: ReadonlyMap<string, readonly string[]>;
}

/**
 * Build the playback table from `renderToTimemap()` output. Entries are
 * ordered by tstamp; each carries `on`/`off` id lists for that timestamp.
 * A note is "sounding" in segment i when its `on` was applied and its `off`
 * has not yet arrived — `off` is applied before `on` at equal timestamps so
 * a note ending exactly on the boundary does not bleed into the next
 * segment (a tied note's sounding span is covered by its fragments).
 */
export function buildPlaybackTable(timemap: readonly VerovioTimemapEntry[]): PlaybackTable {
  const segments: PlaybackSegment[] = [];
  const sounding = new Set<string>();
  const onsetMsByExportId = new Map<string, number>();
  const fragments = new Map<string, string[]>();

  for (let i = 0; i < timemap.length; i++) {
    const entry = timemap[i];
    for (const id of entry.off ?? []) sounding.delete(id);
    for (const id of entry.on ?? []) {
      sounding.add(id);
      if (!onsetMsByExportId.has(id)) onsetMsByExportId.set(id, entry.tstamp);
      const canonical = canonicalNoteIdFromMusicxml(id);
      if (canonical) {
        const list = fragments.get(canonical) ?? [];
        if (!list.includes(id)) list.push(id);
        fragments.set(canonical, list);
      }
    }
    const next = timemap[i + 1];
    const startMs = entry.tstamp;
    const endMs = next ? next.tstamp : startMs;
    if (sounding.size === 0) continue;
    segments.push({
      startMs,
      endMs,
      exportIds: [...sounding],
      canonicalIds: new Set(
        [...sounding]
          .map((id) => canonicalNoteIdFromMusicxml(id))
          .filter((id): id is string => id !== null),
      ),
    });
  }

  const onsetMsByCanonical = new Map<string, number>();
  for (const [canonicalId, ids] of fragments) {
    let min = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const t = onsetMsByExportId.get(id);
      if (t !== undefined && t < min) min = t;
    }
    if (Number.isFinite(min)) onsetMsByCanonical.set(canonicalId, min);
  }

  let durationMs = 0;
  for (const entry of timemap) durationMs = Math.max(durationMs, entry.tstamp);

  return {
    segments,
    durationMs,
    onsetMsByExportId,
    onsetMsByCanonical,
    exportIdsByCanonical: fragments,
  };
}

/** Binary search: segment containing `ms`, or null outside the table. */
export function segmentAt(table: PlaybackTable, ms: number): PlaybackSegment | null {
  const segments = table.segments;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (ms < seg.startMs) hi = mid - 1;
    else if (ms >= seg.endMs) lo = mid + 1;
    else return seg;
  }
  return null;
}

/** Canonical ids sounding at `ms` (empty set during rests/gaps). */
export function activeCanonicalsAt(table: PlaybackTable, ms: number): ReadonlySet<string> {
  return segmentAt(table, ms)?.canonicalIds ?? new Set<string>();
}

/** Canonical ids whose [onset,offset) overlaps `[startMs,endMs)` — used for
 *  the loop-passage mark on the score. Half-open overlap, matching the
 *  UI-005 semantics. */
export function canonicalsInRange(
  table: PlaybackTable,
  startMs: number,
  endMs: number,
): Set<string> {
  const out = new Set<string>();
  if (endMs <= startMs) return out;
  for (const seg of table.segments) {
    if (seg.endMs <= startMs) continue;
    if (seg.startMs >= endMs) break;
    for (const id of seg.canonicalIds) out.add(id);
  }
  return out;
}

/** Nearest canonical onset at-or-after `ms`, falling back to the previous
 *  sounding note when `ms` sits in a rest gap (matches the "nearest-note
 *  resolution" behavior verified in UI-005). */
export function nearestCanonicalAt(table: PlaybackTable, ms: number): string | null {
  const seg = segmentAt(table, ms);
  if (seg && seg.canonicalIds.size > 0) {
    // Deterministic: lowest onset first.
    let best: string | null = null;
    let bestOnset = Number.POSITIVE_INFINITY;
    for (const id of seg.canonicalIds) {
      const onset = table.onsetMsByCanonical.get(id) ?? Number.POSITIVE_INFINITY;
      if (onset < bestOnset) {
        bestOnset = onset;
        best = id;
      }
    }
    if (best) return best;
  }
  // Gap (rest): scan for the nearest onset either side.
  let bestId: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [id, onset] of table.onsetMsByCanonical) {
    const d = Math.abs(onset - ms);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}
