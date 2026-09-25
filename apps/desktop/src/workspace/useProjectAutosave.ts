import { useEffect, useRef, useState } from "react";

/**
 * #408: project autosave with a visible health contract.
 *
 * #221's recovery writer was best-effort-silent: a failed write left
 * the user editing under a safety net that no longer existed. This
 * hook keeps the "never block editing" rule but reports failure —
 * the caller surfaces the return value as a persistent statusbar
 * warning, cleared by the next successful write or by any path that
 * leaves the score clean (manual save, undo-to-baseline, open).
 *
 * Single-flight: one write at a time so a slow disk cannot stack
 * overlapping writes (the full sequence/stale-overwrite design is
 * #329's scope; this only keeps the UI side honest).
 */
export function useProjectAutosave(options: {
  /** Master switch — autosave only exists inside Tauri. */
  readonly enabled: boolean;
  /** Unsaved changes present (dirty fingerprint). */
  readonly dirty: boolean;
  /** Content version — edits bump it; a tick with no bump skips I/O. */
  readonly version: number | null;
  /** Serialize the current document; null = nothing worth saving. */
  readonly snapshot: () => Promise<string | null>;
  /** The recovery write itself (invoke seam — injectable for tests). */
  readonly write: (contents: string) => Promise<void>;
  /** Debounce cadence — defaults to the production 3 s. */
  readonly intervalMs?: number;
}): boolean {
  const [failed, setFailed] = useState(false);
  /** Last version actually persisted — the internal "as of" tracking
   *  the warning contract relies on (never mark on failure so the
   *  next tick retries the same content). */
  const savedVersionRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const snapshotRef = useRef(options.snapshot);
  snapshotRef.current = options.snapshot;
  const writeRef = useRef(options.write);
  writeRef.current = options.write;
  const intervalMs = options.intervalMs ?? 3000;

  useEffect(() => {
    if (!options.enabled || !options.dirty || options.version == null) {
      // A clean state (manual save landed, undo-to-baseline, fresh
      // project open) means the recovery file no longer trails real
      // edits — a lingering warning is stale and clears here.
      if (failed) setFailed(false);
      return;
    }
    const id = window.setInterval(() => {
      const version = options.version;
      if (version == null || version === savedVersionRef.current) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      void (async () => {
        try {
          const contents = await snapshotRef.current();
          if (contents == null) return;
          await writeRef.current(contents);
          savedVersionRef.current = version;
          setFailed(false);
        } catch (e) {
          /* Editing never blocks on a failed autosave, but the failure
           * is no longer silent — the warning stays until a write
           * lands or the work is saved another way. Raw detail is for
           * logs, never the UI surface. */
          console.error("[autosave] recovery write failed", e);
          setFailed(true);
        } finally {
          inFlightRef.current = false;
        }
      })();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [options.enabled, options.dirty, options.version, intervalMs, failed]);

  return failed;
}