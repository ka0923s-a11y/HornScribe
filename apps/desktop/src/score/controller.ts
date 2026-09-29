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
  /** #198: tempo-octave correction — scales the tempo map AND every
   *  note value by `factor` (playback seconds stay put). */
  scaleTempo?(factor: number): void;
  /** #129 (spec 14): set the piece meter — full re-tile engine edit. */
  setMeter?(beatsPerMeasure: number, beatUnit: number): void;
  /** #358 (spec 14): set the anacrusis length in beats — the engine
   *  re-tiles every barline; note values stay put. A fractional
   *  beats string ("1/2") is accepted for sub-beat pickups. */
  setPickup?(pickupBeats: string): void;
  /** #145 (spec 14): set the piece key signature — undoable engine
   *  edit. Modulating scores collapse to the new single key. */
  setKey?(fifths: number, mode?: "major" | "minor" | null): void;
  /** #145 (spec 14): insert or update a key-change boundary —
   *  `startBeat: "0/1"` rewrites the head key in place (the key map
   *  survives, unlike setKey); `startMeasure` names a barline the
   *  user sees and the engine resolves it to a beat. */
  keyChangeAt?(args: {
    fifths: number;
    mode?: "major" | "minor" | null;
    startBeat?: string;
    startMeasure?: number;
  }): void;
  /** #145 (spec 14): drop the key-change boundary at a measure —
   *  the head key cannot be removed (use setKey). */
  removeKeyChange?(startMeasure: number): void;
  /** #249 (spec 14): insert or update a tempo-map segment —
   *  startBeat edits the exact segment (auto-tracked marks can sit
   *  mid-measure); startMeasure names a barline and the engine snaps
   *  to the measure start. startBeat "0/1" rewrites the head tempo
   *  while keeping later segments. */
  tempoChangeAt?(args: {
    bpm: number;
    startBeat?: string;
    startMeasure?: number;
  }): void;
  /** #249 (spec 14): drop a tempo-map segment — the head tempo
   *  cannot be removed (use setTempo). startBeat is the segment's
   *  exact beat; startMeasure resolves to the barline. */
  removeTempoChange?(args: {
    startBeat?: string;
    startMeasure?: number;
  }): void;
  /** #271: notation metadata — title/composer/arranger edited in
   *  the score summary; the engine rewrites the MusicXML headers. */
  setMetadata?(metadata: {
    title?: string;
    composer?: string;
    arranger?: string;
  }): void;
  /** #267: whole-score arrangement transpose — canonical engine
   *  edit (transposeRange), one undo entry; ±12 for the octave
   *  actions. This changes REAL sounding pitch, unlike the F管
   *  written-pitch view. */
  transposeScore?(semitones: number): void;
  /** #130 (spec 14): re-quantize the whole score under changed
   *  quantization settings — undoable engine edit. */
  requantize?(settings: Record<string, unknown>): void;
  /** #123: fold voices/chords into the single playable melody line —
   *  top voice per simultaneity, extra parts dropped, one undoable
   *  canonical edit (collapseToMelody). */
  collapseToMelody?(): void;
  /** #131 (spec 13 post-MVP): split the selected note at its grid-snapped
   *  midpoint / merge it with the contiguous next same-pitch note. */
  splitSelectedNote?(): void;
  mergeSelectedNotes?(): void;
  /** #163: convert the selected rest glyph into a note (restToNote
   *  engine edit) — the missed-detection fix. */
  convertSelectedRest?(): void;

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

  /** #101: メトロノーム toggle — clicks the score's beat grid while the
   *  clock runs, independently of audition (e.g. over the source audio
   *  to check the detected meter/tempo). */
  toggleMetronome?(): void;
  /** #101: カウントイン toggle — when on, play() holds the position for
   *  one bar of clicks before the score advances. */
  toggleCountIn?(): void;

  /** #398: mixer row edit — volume (0..1), mute, solo for one canonical
   *  part. Applied live to the audition synth; mirrored into state. */
  updatePartMix?(
    index: number,
    patch: { volume?: number; muted?: boolean; solo?: boolean },
  ): void;
  /** #101: mixer row edit — the click layer's fader (0..1). */
  updateClickVolume?(volume: number): void;

  // ---- review (§12 minimal: navigate open issues on the score) ----
  openReview(): void;
  reviewNext(): void;
  reviewPrevious(): void;
  /** #361: toggle the 要確認一覧 navigator popover (一覧 button / I). */
  reviewToggleNavigator?(): void;
  /** #376: jump straight to the issue at index — opens the review bar
   *  when closed, then lands the shared cursor (score selection +
   *  source seek) on the issue. The waveform markers use this. */
  openReviewAt?(index: number): void;

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

  // ---- pending engine edits (#399) ----
  /** Engine edits are async — resolves once every queued score.edit
   *  has landed (or failed), so a snapshotting caller (Ctrl+S) saves
   *  the document in the user's true action order. */
  waitForPendingEdits?(): Promise<void>;
}

/** Live workspace state mirrored up to the app for command predicates and
 *  status readouts (throttled — never at frame rate). */
export interface ScoreWorkspaceState {
  readonly hasSelection: boolean;
  /** #163: the selection is a rest glyph (restToNote gate). */
  readonly hasRestSelection: boolean;
  readonly isPlaying: boolean;
  readonly loopEnabled: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly followEnabled: boolean;
  readonly followSuspended: boolean;
  readonly reviewOpen: boolean;
  /** The issue under the review cursor has canonical note targets, so
   *  pitch/delete review commands do real work (whole-piece issues like
   *  meter_conflict leave them disabled). */
  readonly reviewIssueEditable: boolean;
  readonly zoomPct: number;
  /** UI-050: undo/redo availability + live open-issue count so the command
   *  bar (要確認（n）) and Ctrl+Z/Y enablement track review decisions. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly openIssueCount: number;
  /** #361: total issues this revision (open + decided) — distinguishes
   *  "nothing to review" from "history exists" for the review.open
   *  gate, so a fully-resolved project can still re-enter review. */
  readonly totalIssueCount: number;
  /** FEAT-001: score audition enabled (drives the transport toggle). */
  readonly auditionEnabled: boolean;
  /** #101: metronome + count-in toggles (transport button states). */
  readonly metronomeEnabled: boolean;
  readonly countInEnabled: boolean;
  /** #101: click-layer fader 0..1 for the mixer popover. */
  readonly clickVolume: number;
  /** #398: per-part mixer rows (canonical part order) — name, fader 0..1,
   *  mute, solo. Empty until a score with parts loads. */
  readonly partMix: readonly {
    name: string;
    volume: number;
    muted: boolean;
    solo: boolean;
  }[];
  /** #399: in-flight serialized engine edits — >0 means committed
   *  content trails the user's actions; guards must treat this as
   *  unsaved work even though editVersion has not bumped yet. */
  readonly pendingEdits: number;
}
