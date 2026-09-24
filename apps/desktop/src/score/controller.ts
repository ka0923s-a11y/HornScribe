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
  /** Esc - exits review mode first, then clears the note selection. */
  clearSelection(): void;
  /** #114 (spec 10): move the selection to the previous/next note in
   *  document order. No-op without a score or at the edges. */
  selectAdjacentNote?(direction: 1 | -1): void;
  /** #114 (spec 13): shift the selected note by `delta` semitones
   *  (undoable, outside the review workspace). */
  editSelectedPitch?(delta: number): void;
  /** #114 (spec 13): toggle the selected note's deleted flag. */
  toggleSelectedDeleted?(): void;
  /** #114 (spec 13 異名同音): respell the selected note in the other
   *  accidental family (sounding pitch unchanged). */
  toggleSelectedEnharmonic?(): void;
  /** #115 (spec 13): engine rhythm edits on the selected note —
   *  duration ×2/÷2 (power ±1), onset shift by min-grid steps, tie
   *  toggle. Async internally; the workspace announces the outcome. */
  noteDurationScale?(power: number): void;
  shiftSelectedOnset?(steps: number): void;
  toggleSelectedTie?(): void;
  /** #115 (spec 14): set the piece tempo (BPM) — undoable engine edit. */
  setTempo?(bpm: number): void;
  /** #129 (spec 14): set the piece meter — full re-tile engine edit. */
  setMeter?(beatsPerMeasure: number, beatUnit: number): void;
  /** #145 (spec 14): set the piece key signature — undoable engine
   *  edit. Modulating scores collapse to the new single key. */
  setKey?(fifths: number): void;
  /** #130 (spec 14): re-quantize the whole score under changed
   *  quantization settings — undoable engine edit. */
  requantize?(settings: Record<string, unknown>): void;
  /** #131 (spec 13 post-MVP): split the selected note at its grid-snapped
   *  midpoint / merge it with the contiguous next same-pitch note. */
  splitSelectedNote?(): void;
  mergeSelectedNotes?(): void;

  // ---- transport (§9) — no-ops until a clock exists ----
  togglePlayPause(): void;
  stop(): void;
  seekToStart(): void;
  seekToEnd(): void;
  jumpBy(deltaMs: number): void;
  toggleLoop(): void;
  /** #113: armed A-B loop range (ms), or null - lets the app mirror the
   *  score loop onto the media transport so audio loops too. */
  loopRange?(): { startMs: number; endMs: number } | null;

  // ---- follow (§11) ----
  resumeFollow(): void;
  /** 再生位置追従 on/off (§18 playback setting; off clears any suspension). */
  setFollowEnabled(on: boolean): void;

  // ---- FEAT-001 (#60): score audition ----
  /** "楽譜を演奏" toggle. When on, the score clock drives WebAudio. */
  toggleAudition(): void;

  // ---- review (§12 minimal: navigate open issues on the score) ----
  openReview(): void;
  reviewNext(): void;
  reviewPrevious(): void;

  // ---- review decisions & corrections (UI-050, §12/§13) ----
  /** 問題なし — mark the focused issue accepted. */
  reviewAccept(): void;
  /** 対応不要にする — dismiss the focused issue. */
  reviewDismiss(): void;
  /** 元音源を再生 — loop-play the issue's source range. */
  reviewPlaySource(): void;
  /** 音高修正: shift the issue's note(s) by ±1 semitone. */
  reviewPitch(delta: number): void;
  /** 削除/復元: toggle deletion of the issue's note(s). */
  reviewDeleteOrRestore(): void;
  /** Leave the review workspace (→ SCORE_READY, §27). */
  exitReview(): void;

  // ---- undo/redo (§14: review decisions and corrections are commands) ----
  undo(): void;
  redo(): void;
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
  /** UI-050: undo/redo availability + live open-issue count so the command
   *  bar (要確認（n）) and Ctrl+Z/Y enablement track review decisions. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly openIssueCount: number;
  /** FEAT-001: score audition enabled (drives the transport toggle). */
  readonly auditionEnabled: boolean;
}
