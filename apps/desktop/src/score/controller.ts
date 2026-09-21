/**
 * Imperative handle the score workspace exposes to the app's command layer
 * (UI-030). Registry commands (Ctrl+= / Ctrl+- / Ctrl+0 zoom, Esc clear,
 * transport keys, review navigation) call these; the workspace implements
 * them — components never grow parallel key handling (GUI_UX_SPEC §23).
 */
export interface ScoreWorkspaceController {
  // ---- zoom (§15) ----
  zoomIn(): void;
  zoomOut(): void;
  /** Ctrl+0 — 幅に合わせる (fit page width). */
  zoomFit(): void;

  // ---- selection ----
  /** Esc — exits review mode first, then clears the note selection. */
  clearSelection(): void;

  // ---- transport (§9) — no-ops until a clock exists ----
  togglePlayPause(): void;
  stop(): void;
  seekToStart(): void;
  seekToEnd(): void;
  jumpBy(deltaMs: number): void;
  toggleLoop(): void;

  // ---- follow (§11) ----
  resumeFollow(): void;
  /** 再生位置追従 on/off (§18 playback setting; off clears any suspension). */
  setFollowEnabled(on: boolean): void;

  // ---- review (§12 minimal: navigate open issues on the score) ----
  openReview(): void;
  reviewNext(): void;
  reviewPrevious(): void;
}

/** Live workspace state mirrored up to the app for command predicates and
 *  status readouts (throttled — never at frame rate). */
export interface ScoreWorkspaceState {
  readonly hasSelection: boolean;
  readonly isPlaying: boolean;
  readonly loopEnabled: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly followEnabled: boolean;
  readonly followSuspended: boolean;
  readonly reviewOpen: boolean;
  readonly zoomPct: number;
}
