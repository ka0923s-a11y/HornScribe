/**
 * UI-030 — production score workspace (SCORE_READY+, GUI_UX_SPEC §6–§11).
 *
 * Verovio-based SVG rendering driven by a `ScoreDocumentPort` (fixture
 * adapter today; engine data slots in later). Responsibilities:
 *
 * - render MusicXML → SVG pages (inlined WASM, fully offline);
 * - note click → canonical `sn-*` selection → properties inspector;
 * - Concert ↔ F管ホルン switch preserving selection, transport position,
 *   loop, playback state, zoom and an equivalent viewport position
 *   (UI-005 verified semantics);
 * - playback hierarchy: caret → current-measure wash → active-note outline,
 *   all DOM-only marks — zero `renderToSVG` on the frame path;
 * - follow playback with manual-scroll suspension + explicit 追従を再開;
 * - review 要確認 markers (dotted cue, warning tint — never error red);
 * - zoom controls bound to the same methods the registry commands call.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ja } from "../strings/ja";
import type { PitchViewSetting } from "../commands/types";
import type { ScoreDocumentPort } from "./document";
import { ScoreView } from "./ScoreView";
import {
  ACTIVE_CLASS,
  LOOP_CLASS,
  MEASURE_ACTIVE_CLASS,
  SELECTED_CLASS,
  buildElementIndex,
  clearCaret,
  drawCaret,
  markCanonical,
  markCanonicalSet,
  markMeasures,
  markReviewMarkers,
  measureElementOf,
  type ElementIndex,
} from "./domScore";
import { canonicalNoteIdFromMusicxml } from "./ids";
import {
  canonicalNoteOrder,
  describeNote,
  notesByCanonical,
  notesByExportId,
  parseScoreDoc,
  type ParsedNote,
  type ScoreDoc,
} from "./scoreDoc";
import {
  getScoreRenderer,
  clampScoreZoom,
  SCORE_ZOOM_STEP_PCT,
  type RenderedPage,
  type ScoreRenderer,
  type ScoreViewMode,
} from "./verovio";
import {
  readScoreSessionView,
  writeScoreSessionView,
} from "../workspace/layout";
import {
  buildPlaybackTable,
  canonicalsInRange,
  nextOnsetOrEnd,
  remapLoopRange,
  segmentAt,
  type PlaybackTable,
} from "./playbackTable";
import {
  ScoreCursorClock,
  type ClockSnapshot,
  type TransportClock,
} from "./clock";
import {
  ScorePlaybackSynth,
  velocityByCanonicalId,
  bendsByCanonicalId,
  effectivePartGains,
  partIndexByCanonicalId,
  partNames,
  type PartMixEntry,
} from "./playbackSynth";
import { buildSwingWarp } from "./swingWarp";
import { clickTrack, countInMs, countInPattern } from "./metronome";
import {
  allIssuesForCanonical,
  markedCanonicalIds,
  nextOpenIssueIndex,
  numEvidence,
  type ScoreReviewIssue,
} from "./review";
import {
  armReviewLoop,
  emptyReviewLoopState,
  releaseReviewLoop,
  retargetReviewLoop,
  type LoopPort,
  type LoopRangeSec,
  type ReviewLoopState,
} from "./reviewLoop";
import { ReviewSession, type ReviewEdit } from "./reviewSession";
import {
  buildReviewAction,
  issueHasNoteTargets,
} from "./reviewActions";
import { ReviewBar } from "./ReviewBar";
import { ReviewNavigator } from "./ReviewNavigator";
import {
  findCanonicalNote,
  formatFraction,
  scaleFraction,
  type RhythmEditInvoker,
  type RhythmEditOp,
  type ScoreEditResult,
} from "./rhythmEdits";
import {
  nextScoreNoteId,
  pitchBefore,
  restAtomAtOrdinal,
  restOrdinalOf,
} from "./restSpans";
import {
  buildNoteInspector,
  buildScoreInspector,
  keyLabelJa,
  type InspectorCopy,
  type InspectorModel,
} from "./inspector";
import type {
  ScoreWorkspaceController,
  ScoreWorkspaceState,
} from "./controller";
import { SegmentedControl } from "../components/primitives/SegmentedControl";
import { HsButton } from "../components/primitives/Button";
import { HsDialog } from "../components/primitives/Dialog";

interface Selection {
  exportId: string;
  canonicalId: string | null;
}

interface Props {
  document: ScoreDocumentPort;
  pitch: PitchViewSetting;
  onInspectorChange(model: InspectorModel): void;
  onStateChange?(state: ScoreWorkspaceState): void;
  controllerRef?(controller: ScoreWorkspaceController | null): void;
  announce(message: string): void;
  /** [UI-020 handoff] live media-transport mirror. When present the score
   *  clock follows it — the media element is the one audio clock (UI-005
   *  "one clock" contract); when absent (no source loaded, dev/fixture
   *  playback) the score's own ScoreCursorClock is the transport. */
  transport?: {
    readonly isPlaying: boolean;
    readonly positionSec: number;
    readonly rate?: number;
  } | null;
  /** [UI-050] 元音源を再生 / jump-to-issue: drive the real media transport
   *  (seek + A-B loop on the issue's source range) when audio is loaded.
   *  When absent, the score clock plays the range so the passage is still
   *  indicated on the score (dev/fixture playback). */
  sourceControl?: {
    seekTo(sec: number): void;
    play(): void;
    setLoop(range: { start: number; end: number } | null): void;
    loopRange(): { start: number; end: number } | null;
  } | null;
  /** 設定→楽譜 初期表示 — seeds viewMode on mount (document key
   *  remounts per revision, so this is a per-score default). */
  initialViewMode?: ScoreViewMode;
  /** 設定→再生 再生位置を追従 — seeds the follow toggle. */
  followPlayback?: boolean;
  /** #115 (spec 13): engine score.edit invoker — absent for fixture/dev
   *  documents, where rhythm edits announce as unavailable instead of
   *  pretending to work. */
  onRhythmEdit?: RhythmEditInvoker;
  /** #148: re-run the job with the voices texture — offered on the
   *  merged-overlap review issue when auto detected a mix. */
  onRetranscribeVoices?(): void;
  /** #314: re-run with vocal isolation + melody — the lead-vocal-mix
   *  remedy, offered alongside voices on the merged-overlap issue. */
  onRetranscribeVocalIsolation?(): void;
  /** #181: re-run the job with the Basic Pitch backend — offered on
   *  the monophonic-backend review issue. */
  onRetranscribeBasicPitch?(): void;
  /** #209: open the properties panel — offered on the meter-conflict
   *  issue so the user finds the meter select without hunting. */
  onOpenProperties?(): void;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/* #398: push the mixer's effective gains into the audition synth —
 *  solo/mute math lives in effectivePartGains (pure); this is the only
 *  place the synth hears about it. */
function pushPartGains(
  synth: ScorePlaybackSynth | null,
  mix: readonly PartMixEntry[],
): void {
  effectivePartGains(mix).forEach((g, i) => synth?.setPartGain(i, g));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Reason-code → copy deck. `ReviewReason` is forward-compatible
 *  (`string & {}`), so index through a plain record — unknown engine codes
 *  land on `other`. */
const REASON_DECK: Record<
  string,
  { readonly title: string; readonly detail: string }
> = ja.reviewReasons;

/** Inspector copy — bound to ja.ts so Japanese text stays in one place. */
function inspectorCopy(): InspectorCopy {
  const j = ja.inspector;
  return {
    review: {
      // `?? other`: engine reason codes may be newer than this UI's copy
      // deck — the issue stays visible with generic copy (sidecar/review.ts
      // uses the same fallback policy).
      reasonTitle: (r) => (REASON_DECK[r] ?? ja.reviewReasons.other).title,
      reasonDetail: (issue: ScoreReviewIssue) => {
        // #85 voices texture: surface the split counts the engine put in
        // evidence — "kept N notes as a second voice, dropped M beyond
        // two voices" — instead of the generic overlap copy.
        if (issue.reason === "overlapping_candidates") {
          const second =
            numEvidence(issue, "extraVoiceNotes") ??
            numEvidence(issue, "secondVoiceNotes");
          const dropped = numEvidence(issue, "droppedBeyondVoices");
          if (second != null || dropped != null) {
            return ja.reviewEvidence.secondVoice(second ?? 0, dropped ?? 0);
          }
          const merged = numEvidence(issue, "polyphonicOverlaps");
          if (merged != null) {
            // #148: auto detected a mix — the detail names the
            // one-click voices retry the review bar now exposes.
            if (issue.evidence["suggestVoicesTexture"] === true) {
              return ja.reviewEvidence.mergedOverlapsSuggest(merged);
            }
            return ja.reviewEvidence.mergedOverlaps(merged);
          }
        }
        // #134 swing feel: report the offbeat census the detector saw
        // so the user can judge whether the piece is really a shuffle.
        if (issue.reason === "swing_feel") {
          const offbeats = numEvidence(issue, "offbeatOnsets");
          const swing = numEvidence(issue, "swingOnsets");
          if (offbeats != null && swing != null) {
            return ja.reviewEvidence.swingFeel(offbeats, swing);
          }
        }
        // #352: name the estimated key plus every reason it is
        // unsure — the engine's `details` flags decide which clauses
        // the copy shows (few notes / low confidence / a close
        // runner-up / ambiguous mid-piece measures).
        if (issue.reason === "key_uncertain") {
          const fifths = numEvidence(issue, "keyFifths");
          const mode = issue.evidence["keyMode"];
          if (fifths != null) {
            const details = issue.evidence["details"];
            const runnerFifths = numEvidence(issue, "runnerUpFifths");
            const runnerMode = issue.evidence["runnerUpMode"];
            const margin = numEvidence(issue, "keyMargin");
            const conf = numEvidence(issue, "keyConfidence");
            const segs = issue.evidence["uncertainSegments"];
            return ja.reviewEvidence.keyUncertain({
              details: Array.isArray(details)
                ? details.filter(
                    (d): d is string => typeof d === "string",
                  )
                : [],
              estimated: keyLabelJa(
                fifths,
                mode === "minor" ? "minor" : "major",
              ),
              confidencePct:
                conf != null ? Math.round(conf * 100) : null,
              noteCount: numEvidence(issue, "noteCount") ?? 0,
              runnerUp:
                runnerFifths != null
                  ? keyLabelJa(
                      runnerFifths,
                      runnerMode === "minor" ? "minor" : "major",
                    )
                  : null,
              marginPct:
                margin != null ? Math.round(margin * 100) : null,
              uncertainMeasures: Array.isArray(segs)
                ? segs.filter(
                    (s): s is number => typeof s === "number",
                  )
                : [],
            });
          }
        }
        // #358: pickup-uncertainty evidence — name the inferred
        // anacrusis plus each flag that makes it unsure (accent phase
        // prefers another downbeat / a hairline-early first onset /
        // a mid-beat first onset). The properties pickup field or
        // the review bar's suggestion button is the fix.
        if (issue.reason === "pickup_uncertain") {
          const inferred = numEvidence(issue, "inferredPickupBeats");
          if (inferred != null) {
            const flags = issue.evidence["flags"];
            const suggested = numEvidence(issue, "suggestedPickupBeats");
            return ja.reviewEvidence.pickupUncertain({
              flags: Array.isArray(flags)
                ? flags.filter((f): f is string => typeof f === "string")
                : [],
              inferredBeats: inferred,
              suggestedBeats: suggested,
            });
          }
        }
        // #423: boundary-uncertainty — name the suggested fix kind
        // (merge/split/uncertain) with the expert's score so the
        // detail matches the action button the bar offers.
        if (issue.reason === "boundary_uncertain") {
          const kind = issue.evidence["suggestedKind"];
          if (typeof kind === "string") {
            return ja.reviewEvidence.boundaryUncertain({
              kind,
              score: numEvidence(issue, "boundaryScore"),
            });
          }
        }
        // #419: chord-uncertainty evidence - suggested chord, the
        // runner-up it nearly tied with, confidence + margin.
        if (issue.reason === "chord_uncertain") {
          const suggested = issue.evidence["suggestedChord"];
          const runnerUp = issue.evidence["runnerUpChord"];
          const conf = numEvidence(issue, "chordConfidence");
          const margin = numEvidence(issue, "chordMargin");
          return ja.reviewEvidence.chordUncertain({
            suggested:
              typeof suggested === "string" ? suggested : null,
            runnerUp: typeof runnerUp === "string" ? runnerUp : null,
            confidencePct:
              conf != null ? Math.round(conf * 100) : null,
            marginPct:
              margin != null ? Math.round(margin * 100) : null,
          });
        }
        // #322: isolation was skipped because voices/chords keep the
        // overlapping lines — say so instead of the generic mono/
        // decode-failure copy.
        if (
          issue.reason === "vocal_isolation_unavailable" &&
          issue.evidence["detail"] === "polyphonic_texture"
        ) {
          return ja.reviewEvidence.vocalIsolationPolyphonic;
        }
        return (REASON_DECK[issue.reason] ?? ja.reviewReasons.other).detail;
      },
      severityLabel: (s) => ja.reviewSeverity[s] ?? ja.reviewSeverity.info,
      statusLabel: (s) => ja.reviewStatus[s] ?? ja.reviewStatus.open,
    },
    measure: (n) => ja.scoreView.measureNth(n),
    scoreSeconds: (sec) => j.scoreSeconds(sec),
    tieFragments: (n) => j.tieFragments(n),
    tempo: (bpm) => j.tempoLabel(bpm),
    measureCount: (n) => j.measureCountLabel(n),
    noteCount: (n) => j.noteCountLabel(n),
    openIssues: (n) => j.openIssuesLabel(n),
    key: (fifths, mode) => j.keyLabel(keyLabelJa(fifths, mode)),
    // #358: anacrusis label for the score summary row.
    pickup: (label) =>
      label == null ? ja.inspector.pickupNone : ja.inspector.pickupLabel(label),
  };
}

export function ScoreReadyWorkspace({
  document: scoreDoc,
  pitch,
  initialViewMode = "continuous",
  followPlayback = true,
  onInspectorChange,
  onStateChange,
  controllerRef,
  announce,
  transport,
  sourceControl = null,
  onRhythmEdit,
  onRetranscribeVoices,
  onRetranscribeVocalIsolation,
  onRetranscribeBasicPitch,
  onOpenProperties,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ScoreRenderer | null>(null);
  const indexRef = useRef<ElementIndex | null>(null);
  const clockRef = useRef<TransportClock | null>(null);
  const tableRef = useRef<PlaybackTable | null>(null);

  const [pages, setPages] = useState<RenderedPage[]>([]);
  /** #247: total page count for the current render config — kept
   *  separate from `pages`, which in page mode only ever holds the
   *  lazily rendered visible page. */
  const [pageCount, setPageCount] = useState(0);
  const pageCountRef = useRef(0);
  /* §26: restore the previous session's score view (zoom + mode); the
   * settings "initial view" only applies when no session state exists. */
  const sessionViewRef = useRef(readScoreSessionView());
  const [viewMode, setViewMode] = useState<ScoreViewMode>(
    sessionViewRef.current.viewMode ?? initialViewMode,
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(sessionViewRef.current.zoomPct ?? 100);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState(false);
  /* #401: initError holds DIAGNOSTICS text (raw exception + context)
   *  for the 診断情報 dialog — the visible surface renders only the
   *  fixed Japanese copy. initDiagOpen/initDiagCopied drive that
   *  dialog; initAttempt re-arms the init effect for 再試行. */
  const [initError, setInitError] = useState<string | null>(null);
  const [initDiagOpen, setInitDiagOpen] = useState(false);
  const [initDiagCopied, setInitDiagCopied] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);
  const [followEnabled, setFollowEnabled] = useState(followPlayback);
  const [followSuspended, setFollowSuspended] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  // #361: the review navigator popover — opened from the 一覧 button
  // or the I key while review is open.
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const [clockSnap, setClockSnap] = useState<ClockSnapshot>({
    positionMs: 0,
    durationMs: 0,
    isPlaying: false,
    rate: 1,
    loop: null,
    countingIn: false,
    countInRemainingMs: 0,
  });
  // FEAT-001: score audition engine. Lazily created when the user turns
  // the audition toggle on; synced with the score clock below.
  const synthRef = useRef<ScorePlaybackSynth | null>(null);
  const [auditionEnabled, setAuditionEnabled] = useState(false);
  const auditionRef = useRef(false);
  /* #101: メトロノーム/カウントイン — audition とは独立したクリック
   *  レイヤ。ref はコントローラと sync 配線が最新値を読むための鏡。 */
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const metronomeRef = useRef(false);
  const [countInEnabled, setCountInEnabled] = useState(false);
  const countInRef = useRef(false);
  const [clickVolume, setClickVolume] = useState(0.8);

  /* #398: per-part mixer rows (canonical part order). Ref mirrors state so
   *  the controller + rebuild helpers always see the latest mix; the state
   *  copy feeds the onStateChange mirror for the transport-bar popover. */
  const [partMix, setPartMix] = useState<readonly PartMixEntry[]>([]);
  const partMixRef = useRef<readonly PartMixEntry[]>([]);

  /* Rebuild mixer rows from canonical parts, preserving fader/mute/solo by
   *  index so re-transcribing with a different part count keeps the user's
   *  settings where rows still exist. Returns canonicalId -> part index
   *  for synth.load. */
  const syncPartMix = useCallback((canonicalDoc: unknown) => {
    const names = partNames(canonicalDoc);
    const prev = partMixRef.current;
    const next: PartMixEntry[] = names.map((name, i) => ({
      name,
      volume: prev[i]?.volume ?? 1,
      muted: prev[i]?.muted ?? false,
      solo: prev[i]?.solo ?? false,
    }));
    partMixRef.current = next;
    setPartMix(next);
    pushPartGains(synthRef.current, next);
    return partIndexByCanonicalId(canonicalDoc);
  }, []);

  // Parsed presentations — identical canonical ids, different spelling.
  const docsRef = useRef<{
    concert: ScoreDoc;
    horn: ScoreDoc;
    bFlat: ScoreDoc | null;
    concertByCanonical: Map<string, ParsedNote[]>;
    hornByCanonical: Map<string, ParsedNote[]>;
    bFlatByCanonical: Map<string, ParsedNote[]>;
    concertByExport: Map<string, ParsedNote>;
    hornByExport: Map<string, ParsedNote>;
    bFlatByExport: Map<string, ParsedNote>;
  } | null>(null);

  // Refs mirrored so the rAF pump / layout effect always see fresh values.
  const selectionRef = useRef<Selection | null>(null);
  const activeRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const loopCanonicalsRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  /* #335: a user-armed loop marks a PASSAGE (canonical notes), not a
   *  clock window — remember its anchor so a table rebuild (tempo /
   *  swing / onset edits) can re-map it instead of drifting onto
   *  neighbouring notes. null = full-score loop or review-owned. */
  const loopAnchorRef = useRef<string | "full" | null>(null);
  /* #335: playback-table generation — bumps on every rebuild so the
   *  loop-passage marks recompute even when the ms range is unchanged. */
  const [tableGen, setTableGen] = useState(0);
  const followRef = useRef(true);
  const suspendedRef = useRef(false);
  const zoomRef = useRef(sessionViewRef.current.zoomPct ?? 100);
  const viewModeRef = useRef<ScoreViewMode>(
    sessionViewRef.current.viewMode ?? initialViewMode,
  );
  const currentPageRef = useRef(1);
  const pitchRef = useRef(pitch);
  /** The presentation actually loaded into Verovio — compared against the
   *  `pitch` prop to detect a real view switch (the prop ref alone is
   *  updated every render and would mask the change). */
  const renderedPitchRef = useRef<PitchViewSetting | null>(null);
  /** #247: per-render-config page SVG cache (page mode). Keyed by
   *  page number; a fresh Map per renderScore call invalidates it on
   *  any XML/pitch/zoom/mode change, and the key is only trusted
   *  because renderScore re-loads the toolkit first. */
  const pageCacheRef = useRef<Map<number, string> | null>(null);
  /** #247: the page number currently published in `pages` (page
   *  mode) — lets ensurePage skip redundant setPages on cache hits
   *  while still swapping the DOM when a prefetched page is visited. */
  const shownPageRef = useRef(0);
  const reviewIndexRef = useRef(0);
  const reviewOpenRef = useRef(false);
  const navOpenRef = useRef(false);
  const pendingScrollRef = useRef<{ ratio: number } | null>(null);
  /* Review-audition A-B loop (see reviewLoop.ts): owned by the review
   * session, retargeted on issue navigation, released on exit so it can
   * never leak into normal playback. */
  const reviewLoopRef = useRef<ReviewLoopState>(emptyReviewLoopState());
  const sourceControlRef = useRef(sourceControl);
  sourceControlRef.current = sourceControl;

  /** Loop-capable clocks for the review audition loop: the score cursor
   *  clock (ms -> sec adapter) plus the real media transport when a
   *  source is loaded. Stable identity - reads the live refs at call
   *  time. */
  const reviewLoopPorts = useCallback((): LoopPort[] => {
    const ports: LoopPort[] = [];
    const clock = clockRef.current;
    if (clock) {
      ports.push({
        loopRange: () => {
          const r = clock.loopRange();
          return r
            ? { start: r.startMs / 1000, end: r.endMs / 1000 }
            : null;
        },
        setLoop: (r: LoopRangeSec | null) =>
          clock.setLoop(
            r ? { startMs: r.start * 1000, endMs: r.end * 1000 } : null,
          ),
      });
    }
    const src = sourceControlRef.current;
    if (src) ports.push(src);
    return ports;
  }, []);
  /* Unmount: release the review loop against the CURRENT ports (the
   * media transport outlives this component - a leaked review loop
   * would keep looping the last issue's range behind a new document). */
  const reviewLoopPortsRef = useRef(reviewLoopPorts);
  reviewLoopPortsRef.current = reviewLoopPorts;
  useEffect(
    () => () => {
      reviewLoopRef.current = releaseReviewLoop(
        reviewLoopRef.current,
        reviewLoopPortsRef.current(),
      );
    },
    [],
  );

  /* ---- UI-050 review session ----
   * The document owns decisions + note edits (revision-bound); the session
   * owns the undo/redo command stack. `docVersion` bumps after every
   * mutation so memos/effects that read the document recompute. */
  const sessionRef = useRef<ReviewSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new ReviewSession(scoreDoc);
  }
  const session = sessionRef.current;
  const [docVersion, setDocVersion] = useState(0);
  const bumpDoc = useCallback(() => setDocVersion((v) => v + 1), []);
  /* #115: engine rhythm edits are async — serialize them on a promise
   *  chain so a fast key repeat builds on the newest content instead of
   *  racing two score.edit calls against the same revision. */
  const rhythmQueueRef = useRef<Promise<void>>(Promise.resolve());
  /* #399: queued engine edits count as unsaved work from enqueue,
   *  not from engine response — the app mirrors this count into its
   *  dirty/close guards so an in-flight edit is never dropped
   *  silently. mountedRef keeps a late engine response from mutating
   *  a document the app already swapped out. */
  const [pendingEdits, setPendingEdits] = useState(0);
  const mountedRef = useRef(true);
  /* onStateChange arrives as a fresh inline wrapper on every parent
   * render (App -> ScoreWorkspace -> here). Keeping it in the mirror
   * effect below made the effect re-fire on every commit — looping
   * effect -> setScoreState -> parent render -> new prop -> effect.
   * A ref keeps the latest callback callable without being a dep. */
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const allIssues = useMemo(
    () => session.issues(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, docVersion],
  );
  const pendingCount = useMemo(
    () => session.pendingCount(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, docVersion],
  );
  const copy = useMemo(inspectorCopy, []);

  followRef.current = followEnabled;
  suspendedRef.current = followSuspended;
  zoomRef.current = zoom;
  viewModeRef.current = viewMode;
  currentPageRef.current = currentPage;
  pageCountRef.current = pageCount;
  pitchRef.current = pitch;
  reviewIndexRef.current = reviewIndex;
  reviewOpenRef.current = reviewOpen;
  navOpenRef.current = navOpen;

  /* ------------------------- DOM-only mark appliers ------------------------- */

  const applyActiveDom = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current;
    const container = scrollRef.current;
    if (!idx || !container) return;
    markCanonicalSet(idx, canonicals, ACTIVE_CLASS);
    const els: Element[] = [];
    for (const id of canonicals) els.push(...(idx.byCanonical.get(id) ?? []));
    markMeasures(container, els, MEASURE_ACTIVE_CLASS, true);
    // Playback caret: thin bar at the onset of the earliest active fragment.
    clearCaret(container);
    const first = els[0];
    if (first) {
      const measure = measureElementOf(first);
      if (measure && typeof (first as SVGGElement).getBBox === "function") {
        try {
          const box = (first as SVGGElement).getBBox();
          drawCaret(measure, box.x);
        } catch {
          /* no geometry — caret skipped, marks still applied */
        }
      }
    }
  }, []);

  const applyLoopDom = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current;
    if (!idx) return;
    markCanonicalSet(idx, canonicals, LOOP_CLASS);
  }, []);

  const scrollCanonicalIntoView = useCallback(
    (canonicals: ReadonlySet<string>) => {
      const idx = indexRef.current;
      if (!idx || canonicals.size === 0) return;
      const table = tableRef.current;
      let target: Element | null = null;
      if (table) {
        // Earliest onset leads the scroll target.
        let best = Number.POSITIVE_INFINITY;
        for (const id of canonicals) {
          const onset =
            table.onsetMsByCanonical.get(id) ?? Number.POSITIVE_INFINITY;
          if (onset < best) {
            best = onset;
            target = idx.byCanonical.get(id)?.[0] ?? null;
          }
        }
      }
      target ??= idx.byCanonical.get([...canonicals][0])?.[0] ?? null;
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [],
  );

  /* ------------------------------ rendering ------------------------------ */

  /** #247: render a page into the current cache + state if it is not
   *  there yet. No-op outside page mode or before the first
   *  renderScore populated the cache. */
  const ensurePage = useCallback(
    (page: number) => {
      const r = rendererRef.current;
      const cache = pageCacheRef.current;
      if (!r || !cache || viewModeRef.current !== "page") return;
      // Verovio answers out-of-range pages with an empty stub SVG —
      // never let a prefetch past the last page pollute the cache.
      if (page < 1 || page > pageCountRef.current) return;
      if (!cache.has(page)) {
        try {
          cache.set(page, r.renderPage(page));
        } catch {
          return;
        }
      }
      // Only swap the DOM when the page the user is looking at just
      // resolved — prefetch fills the cache without touching `pages`.
      // The cache-hit path still must publish the page: navigating to
      // a prefetched neighbour would otherwise leave the old page
      // on screen.
      if (
        page === currentPageRef.current &&
        shownPageRef.current !== page
      ) {
        shownPageRef.current = page;
        setPages([{ page, svg: cache.get(page)! }]);
      }
    },
    [],
  );

  /** #247: idle prefetch of the neighbouring pages so the next/prev
   *  pager step is instant without eager-rendering the whole score. */
  const schedulePagePrefetch = useCallback(
    (center: number) => {
      const run = () => {
        ensurePage(center - 1);
        ensurePage(center + 1);
      };
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    },
    [ensurePage],
  );

  /** (Re)load + re-render the current presentation. Preserves the viewport
   *  ratio so the Concert↔F管 switch keeps an equivalent scroll position. */
  const renderScore = useCallback(
    (view: PitchViewSetting, opts: { keepScroll?: boolean } = {}) => {
      const r = rendererRef.current;
      const container = scrollRef.current;
      if (!r) return;
      if (opts.keepScroll && container) {
        const denom = Math.max(
          1,
          container.scrollHeight - container.clientHeight,
        );
        pendingScrollRef.current = { ratio: container.scrollTop / denom };
      }
      try {
        r.setViewMode(viewModeRef.current);
        r.setZoom(zoomRef.current);
        const xml = scoreDoc.musicXml(view);
        const ok = r.load(xml);
        const parsed = ok ? parseScoreDoc(xml) : null;
        // UI-003 finding: loadData returns true for truncated-but-parseable
        // XML — verify content, not just the flag.
        if (!ok || !parsed || parsed.notes.length === 0) {
          throw new Error("score load produced no content");
        }
        renderedPitchRef.current = view;
        if (viewModeRef.current === "page") {
          // #247: page mode renders only the visible page. The layout
          // pass happens on load, so getPageCount is already correct;
          // the clamped single renderToSVG replaces the old
          // render-every-page-then-show-one path.
          const cache = new Map<number, string>();
          pageCacheRef.current = cache;
          let count = r.pageCount();
          const target = Math.min(
            Math.max(1, currentPageRef.current),
            Math.max(1, count),
          );
          cache.set(target, r.renderPage(target));
          const recount = r.pageCount();
          if (recount !== count) {
            count = recount;
            const retarget = Math.min(target, Math.max(1, count));
            if (!cache.has(retarget)) {
              cache.set(retarget, r.renderPage(retarget));
            }
          }
          const shown = Math.min(target, Math.max(1, count));
          if (shown !== currentPageRef.current) setCurrentPage(shown);
          shownPageRef.current = shown;
          pageCountRef.current = count;
          setPageCount(count);
          setPages([{ page: shown, svg: cache.get(shown)! }]);
          schedulePagePrefetch(shown);
        } else {
          pageCacheRef.current = null;
          shownPageRef.current = 0;
          const all = r.renderAllPages();
          pageCountRef.current = all.length;
          setPageCount(all.length);
          setPages(all);
        }
        setRenderError(false);
        setLoading(false);
      } catch {
        setPages([]);
        pageCountRef.current = 0;
        setPageCount(0);
        shownPageRef.current = 0;
        setRenderError(true);
        setLoading(false);
      }
    },
    [scoreDoc, schedulePagePrefetch],
  );

  /** After every (re)render of the SVG: rebuild the element index and
   *  reapply selection/active/loop/caret marks — this is how all context
   *  survives zoom re-renders and Concert↔F管 switches (UI-005 pattern). */
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || pages.length === 0) return;
    indexRef.current = buildElementIndex(container);
    markReviewMarkers(
      container,
      indexRef.current,
      markedCanonicalIds(scoreDoc.reviewIssues()),
    );
    const sel = selectionRef.current;
    if (sel?.canonicalId) {
      markCanonical(indexRef.current, sel.canonicalId, SELECTED_CLASS);
    } else if (sel) {
      indexRef.current.byExportId
        .get(sel.exportId)
        ?.classList.add(SELECTED_CLASS);
    }
    markCanonicalSet(indexRef.current, activeRef.current, ACTIVE_CLASS);
    markCanonicalSet(indexRef.current, loopCanonicalsRef.current, LOOP_CLASS);
    const actEls: Element[] = [];
    for (const id of activeRef.current) {
      actEls.push(...(indexRef.current.byCanonical.get(id) ?? []));
    }
    markMeasures(container, actEls, MEASURE_ACTIVE_CLASS, true);

    // Page mode: clamp the current page when the document repaginates
    // (zoom / view switch can change the page count).
    if (
      viewModeRef.current === "page" &&
      currentPageRef.current > pageCount
    ) {
      setCurrentPage(pageCount);
    }

    // Equivalent viewport position (issue §Context preservation): a
    // selection re-reveals its note; otherwise the scroll ratio carries over.
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (sel?.canonicalId) {
      indexRef.current.byCanonical
        .get(sel.canonicalId)?.[0]
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else if (pending && viewModeRef.current === "continuous") {
      const denom = Math.max(
        1,
        container.scrollHeight - container.clientHeight,
      );
      container.scrollTop = pending.ratio * denom;
    }
    // viewMode/currentPage swap the rendered DOM in page mode — the element
    // index must be rebuilt or marks would land on detached nodes.
    // docVersion re-applies review marks after a decision resolves an issue
    // without re-rendering the SVG.
  }, [pages, pageCount, scoreDoc, viewMode, currentPage, docVersion]);

  /* ------------------------------ init ----------------------------------- */

  // Init per mounted document (App remounts on revision change via `key`).
  // StrictMode-safe: no "did init" latch — the cleanup's `cancelled` flag is
  // the guard, so the replayed effect initializes cleanly.
  useEffect(() => {
    let cancelled = false;
    getScoreRenderer()
      .then((r) => {
        if (cancelled) return;
        rendererRef.current = r;
        // Parse the presentations once - inspector reads written/concert
        // rows regardless of the current view (§22). #156: the B-flat
        // presentation is optional; an absent one parses as null maps.
        const concert = parseScoreDoc(scoreDoc.musicXml("concert"));
        const horn = parseScoreDoc(scoreDoc.musicXml("hornF"));
        const bFlat = scoreDoc.supportsPitchView?.("bFlat")
          ? parseScoreDoc(scoreDoc.musicXml("bFlat"))
          : null;
        docsRef.current = {
          concert,
          horn,
          bFlat,
          concertByCanonical: notesByCanonical(concert),
          hornByCanonical: notesByCanonical(horn),
          bFlatByCanonical: bFlat ? notesByCanonical(bFlat) : new Map(),
          concertByExport: notesByExportId(concert),
          hornByExport: notesByExportId(horn),
          bFlatByExport: bFlat ? notesByExportId(bFlat) : new Map(),
        };
        renderScore(pitchRef.current);
        // Canonical timing is identical across presentations (same
        // durations + tempo), so the playback table is built once.
        // #156: swing-marked scores get a written->sounding warp so
        // audition + follow land on the swung positions (Verovio's
        // timemap ignores <swing>).
        tableRef.current = buildPlaybackTable(
          r.timemap(),
          buildSwingWarp(scoreDoc.canonicalDocument?.() ?? null) ?? undefined,
        );
        const clock = new ScoreCursorClock(tableRef.current.durationMs);
        clockRef.current = clock;
        clock.subscribe(setClockSnap);
        // FEAT-001: audition engine follows the score clock. It consumes
        // the same PlaybackTable + the CONCERT ParsedNote map (sounding
        // pitch — the written horn view never drives pitch, because the
        // audition exists to check the transcribed *sounding* result).
        const synth = new ScorePlaybackSynth();
        synthRef.current = synth;
        synth.load(
          tableRef.current,
          notesByCanonical(concert),
          velocityByCanonicalId(scoreDoc.canonicalDocument?.() ?? null),
          bendsByCanonicalId(scoreDoc.canonicalDocument?.() ?? null),
          /* #398: canonicalId -> part index — voices route through
           *  per-part gain buses so the mixer can fade/mute/solo. */
          syncPartMix(scoreDoc.canonicalDocument?.() ?? null),
        );
        // #101: メトロノームのクリック列 — 拍グリッドは拍子/テンポマップ
        // 由来(warp 不動点なので swing ワープは不要)。
        synth.setClickTrack(
          clickTrack(scoreDoc.canonicalDocument?.() ?? null),
        );
        clock.subscribe((s) => {
          synth.setLoop(
            s.loop ? { startMs: s.loop.startMs, endMs: s.loop.endMs } : null,
          );
          synth.sync(
            s.positionMs,
            s.isPlaying,
            s.rate,
            s.countingIn,
            s.countInRemainingMs,
          );
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        /* #401: the raw exception is diagnostics-only (JAPANESE_UI_COPY
         * §7) — it never reaches the visible surface; it is kept here
         * for the 診断情報 dialog with the document context support
         * needs. */
        const err = e instanceof Error ? e : null;
        setInitError(
          [
            "score renderer init failure",
            `revision: ${scoreDoc.revisionId}`,
            `message: ${err?.message ?? String(e)}`,
            err?.stack ? `stack:\n${err.stack}` : "",
          ]
            .filter((line) => line !== "")
            .join("\n"),
        );
      });
    return () => {
      cancelled = true;
      clockRef.current?.dispose();
      clockRef.current = null;
      synthRef.current?.dispose();
      synthRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initAttempt]);

  /* ---- media transport handoff (UI-020 → UI-030) ----
   * The media element is the authoritative audio clock once a source is
   * loaded: the score clock follows its play state and snaps to its
   * position on real drift (seek, waveform click, rate change). Without a
   * live transport the score clock stays self-driven (fixture playback). */
  const extPlaying = transport?.isPlaying;
  const extSec = transport?.positionSec;
  const extRate = transport?.rate;
  useEffect(() => {
    if (extPlaying == null || extSec == null) return;
    const clock = clockRef.current;
    if (!clock) return;
    if (extPlaying !== clock.isPlaying()) {
      if (extPlaying) clock.play();
      else clock.pause();
    }
    if (extRate != null && extRate !== clock.rate()) clock.setRate(extRate);
    // Snap on real divergence only — the media timeupdate cadence is
    // coarser than the rAF clock, so small deltas are left alone.
    if (Math.abs(clock.positionMs() - extSec * 1000) > 200) {
      clock.seek(extSec * 1000);
    }
  }, [extPlaying, extSec, extRate]);

  /* --------------------- per-frame sync pump (DOM-only) -------------------- */
  /* Reads the transport clock each frame; DOM marks apply only when the     */
  /* active canonical set changes — React state never updates at frame rate. */

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const clock = clockRef.current;
      const table = tableRef.current;
      const idx = indexRef.current;
      if (clock && table && idx) {
        const seg = segmentAt(table, clock.positionMs());
        const set = seg?.canonicalIds ?? EMPTY_SET;
        if (!sameSet(set, activeRef.current)) {
          activeRef.current = set;
          applyActiveDom(set);
          if (
            followRef.current &&
            !suspendedRef.current &&
            clock.isPlaying() &&
            set.size > 0
          ) {
            if (viewModeRef.current === "page") {
              const r = rendererRef.current;
              const exportId = table.exportIdsByCanonical.get([...set][0])?.[0];
              const page = exportId && r ? r.pageWithElement(exportId) : 0;
              if (page > 0 && page !== currentPageRef.current) {
                setCurrentPage(page);
              }
            } else {
              scrollCanonicalIntoView(set);
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [applyActiveDom, scrollCanonicalIntoView]);

  // Loop range → score passage marks (UI-005: half-open overlap semantics).
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const loop = clockSnap.loop;
    const set = loop
      ? canonicalsInRange(table, loop.startMs, loop.endMs)
      : new Set<string>();
    if (!sameSet(set, loopCanonicalsRef.current)) {
      loopCanonicalsRef.current = set;
      applyLoopDom(set);
    }
    // #335: tableGen forces a recompute after every table rebuild — a
    // tempo edit can leave the ms range identical while the covered
    // canonicals changed.
  }, [clockSnap.loop, applyLoopDom, tableGen]);

  /* --------------------------- selection -------------------------------- */

  const reportInspector = useCallback(() => {
    const docs = docsRef.current;
    const sel = selectionRef.current;
    if (!docs) return;
  if (!sel) {
      // #270: the score summary labels the view the user is looking
      // at — written key signatures in the Horn in F presentation.
      onInspectorChange(buildScoreInspector(scoreDoc.meta, pendingCount, copy, pitch));
     return;
   }
    const canonical = sel.canonicalId;
    const concertFrags = canonical
      ? (docs.concertByCanonical.get(canonical) ?? [])
      : [
          docs.concertByExport.get(sel.exportId) ??
            docs.hornByExport.get(sel.exportId) ??
            docs.bFlatByExport.get(sel.exportId),
        ].filter((n): n is ParsedNote => n != null);
    // #156: the written column follows the CURRENT written view - the
    // inspector's 記譜音 row always names what the user is looking at;
    // concert view keeps the F-horn written pitch as the secondary.
    const writtenByCanonical =
      pitch === "bFlat" ? docs.bFlatByCanonical : docs.hornByCanonical;
    const writtenFrags = canonical
      ? (writtenByCanonical.get(canonical) ?? [])
      : concertFrags;
    const onsetMs = canonical
      ? (tableRef.current?.onsetMsByCanonical.get(canonical) ?? null)
      : null;
    onInspectorChange(
      buildNoteInspector({
        canonicalId: canonical,
        concert: concertFrags,
        written: writtenFrags,
        onsetMs,
        // UI-050: all issues for the note (open AND decided) — the status
        // label column keeps resolved rows readable in the inspector.
        issues: canonical
          ? allIssuesForCanonical(scoreDoc.reviewIssues(), canonical)
          : [],
        copy,
      }),
    );
   // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreDoc, pendingCount, docVersion, copy, pitch, onInspectorChange]);

  /** Select by export id; canonical notes also seek the transport to the
   *  note onset (§10: 原音位置と対応). */
  const selectExportId = useCallback(
    (exportId: string, opts: { seek?: boolean; scroll?: boolean } = {}) => {
      const canonicalId = canonicalNoteIdFromMusicxml(exportId);
      const sel: Selection = { exportId, canonicalId };
      selectionRef.current = sel;
      setSelection(sel);
      const idx = indexRef.current;
      if (idx) {
        markCanonical(idx, canonicalId, SELECTED_CLASS);
        if (!canonicalId) {
          idx.byExportId.get(exportId)?.classList.add(SELECTED_CLASS);
        }
      }
      reportInspector();
      const parsed =
        (canonicalId
          ? docsRef.current?.concertByCanonical.get(canonicalId)?.[0]
          : docsRef.current?.concertByExport.get(exportId)) ??
        docsRef.current?.hornByExport.get(exportId);
      if (parsed) announce(describeNote(parsed));
      const onsetMs = canonicalId
        ? tableRef.current?.onsetMsByCanonical.get(canonicalId)
        : undefined;
      if (opts.seek !== false && onsetMs != null) {
        clockRef.current?.seek(onsetMs);
      }
      if (opts.scroll && idx) {
        idx.byCanonical.get(canonicalId ?? "")?.[0]?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
      }
    },
    [announce, reportInspector],
  );

  const clearSelection = useCallback(() => {
    selectionRef.current = null;
    setSelection(null);
    const idx = indexRef.current;
    if (idx) markCanonical(idx, null, SELECTED_CLASS);
    reportInspector();
    announce(ja.scoreView.deselected);
  }, [announce, reportInspector]);

  /* --------------------------- follow mode ------------------------------- */

  const suspendFollow = useCallback(() => {
    // Only meaningful while playback is actually following (§11); a paused
    // score can scroll freely without nagging the user.
    if (
      !followRef.current ||
      suspendedRef.current ||
      !clockRef.current?.isPlaying()
    ) {
      return;
    }
    suspendedRef.current = true;
    setFollowSuspended(true);
  }, []);

  const resumeFollow = useCallback(() => {
    suspendedRef.current = false;
    setFollowSuspended(false);
    setFollowEnabled(true);
    followRef.current = true;
    scrollCanonicalIntoView(activeRef.current);
  }, [scrollCanonicalIntoView]);

  /* ---------------------------- view switch ------------------------------ */
  /* Concert↔F管: re-render the other presentation. Canonical ids, the       */
  /* transport clock, selection, loop and zoom are all view-independent —    */
  /* marks reapply in the layout effect above; playback never pauses.        */

 useEffect(() => {
   if (!rendererRef.current || pitch === renderedPitchRef.current) return;
   renderScore(pitch, { keepScroll: true });
    // #270: the score summary's key label is view-dependent too —
    // refresh it so a concert/horn switch never leaves stale text.
    reportInspector();
  }, [pitch, renderScore, reportInspector]);

  const changeZoom = useCallback(
    (pct: number) => {
      const next = clampScoreZoom(pct);
      if (next === zoomRef.current) return;
      zoomRef.current = next;
      setZoom(next);
      writeScoreSessionView({ zoomPct: next });
      renderScore(pitchRef.current, { keepScroll: true });
    },
    [renderScore],
  );

  const zoomFit = useCallback(() => {
    const container = scrollRef.current;
    const svg = container?.querySelector(".hs-score-page > svg");
    if (!container || !svg) return;
    const width = svg.getBoundingClientRect().width;
    if (width <= 0) return;
    const target = Math.floor(
      (container.clientWidth - 32) * (zoomRef.current / width),
    );
    changeZoom(target);
  }, [changeZoom]);

  const changeViewMode = useCallback(
    (mode: ScoreViewMode) => {
      if (mode === viewModeRef.current) return;
      viewModeRef.current = mode;
      setViewMode(mode);
      writeScoreSessionView({ viewMode: mode });
      renderScore(pitchRef.current, { keepScroll: true });
    },
    [renderScore],
  );

  /* ------------------------------ review --------------------------------- */
  /* UI-050 + #361: the linear 前へ/次へ cursor walks the OPEN subset
   *  (resumed projects never re-pass resolved rows). Resolved issues
   *  stay reachable — the navigator (未解決のみ OFF) and direct
   *  gotoIssue jumps land on them; markers + pendingCount come from the
   *  still-open subset. */

  const issueAtCursor = useCallback(
    () => allIssues[reviewIndexRef.current] ?? null,
    [allIssues],
  );

  const gotoIssue = useCallback(
    (index: number) => {
      const issues = allIssues;
      if (issues.length === 0) return;
      const i = ((index % issues.length) + issues.length) % issues.length;
      reviewIndexRef.current = i;
      setReviewIndex(i);
      const issue = issues[i];
      const table = tableRef.current;
      const canonicalId = issue.canonicalNoteIds[0];
      const exportId = canonicalId
        ? table?.exportIdsByCanonical.get(canonicalId)?.[0]
        : undefined;
      if (exportId) {
        // Page mode: jump to the containing page first — the layout effect
        // re-applies the selection mark on the freshly shown page.
        if (viewModeRef.current === "page") {
          const r = rendererRef.current;
          const page = r ? r.pageWithElement(exportId) : 0;
          if (page > 0 && page !== currentPageRef.current) {
            setCurrentPage(page);
          }
        }
        selectExportId(exportId, {
          scroll: viewModeRef.current !== "page",
        });
        // Select ALL associated canonical notes visually — an issue may
        // span several (e.g. a tie chain); the first stays the canonical
        // selection for the inspector.
        const idx = indexRef.current;
        if (idx && issue.canonicalNoteIds.length > 1) {
          markCanonicalSet(
            idx,
            new Set(issue.canonicalNoteIds),
            SELECTED_CLASS,
          );
        }
      }
      // Position the source cursor at the issue's range start so
      // 元音源を再生 is immediate (acceptance: replay without extra steps).
      // Keep the review-audition loop on the issue actually selected:
      // an armed loop retargets to this issue's range (a range-less
      // issue clears it) BEFORE the seek, so a playing transport can
      // never wrap back into the previous issue's range.
      const range = issueAuditionRange(issue, table);
      reviewLoopRef.current = retargetReviewLoop(
        reviewLoopRef.current,
        reviewLoopPorts(),
        range,
      );
      if (range != null) sourceControl?.seekTo(range.start);
      announce(ja.review.position(i + 1, issues.length));
    },
    [allIssues, selectExportId, sourceControl, announce, reviewLoopPorts],
  );

  /** #361: 前へ/次へ steps between OPEN issues only — decided rows are
   *  skipped (the navigator's unfiltered list is the explicit history
   *  path). With nothing left open the cursor stays and the bar shows
   *  its all-done state. */
  const stepReviewOpen = useCallback(
    (dir: 1 | -1) => {
      const issues = session.issues();
      if (issues.length === 0) return;
      const next = nextOpenIssueIndex(issues, reviewIndexRef.current, dir);
      if (next < 0) {
        announce(ja.review.allDone);
        return;
      }
      gotoIssue(next);
    },
    [session, gotoIssue, announce],
  );

  /** #361: after a decision resolves the issue under the cursor,
   *  advance to the next still-open issue (wrapping) so accept/dismiss
   *  chains cost one key each. Nothing open → stay on the resolved row
   *  and let the bar show all-done (never auto-close the review). The
   *  pitch fix intentionally does NOT advance: Alt+↑↓ is iterative — a
   *  second press must hit the SAME issue or a two-semitone
   *  correction would silently retune the next note. */
  const advanceAfterResolve = useCallback(() => {
    const issues = session.issues();
    if (issues.length === 0) return;
    if (issues[reviewIndexRef.current]?.status === "open") return;
    const next = nextOpenIssueIndex(issues, reviewIndexRef.current, 1);
    if (next >= 0) gotoIssue(next);
  }, [session, gotoIssue]);

  /* #361: navigator popover — toggled by the 一覧 button / I command.
   *  Closing returns focus to the toggle so the keyboard review flow
   *  resumes exactly where it left off. */
  const closeNavigator = useCallback((refocus = true) => {
    navOpenRef.current = false;
    setNavOpen(false);
    if (refocus) navToggleRef.current?.focus();
  }, []);
  const toggleNavigator = useCallback(() => {
    if (navOpenRef.current) closeNavigator();
    else {
      navOpenRef.current = true;
      setNavOpen(true);
    }
  }, [closeNavigator]);

  const openReview = useCallback(() => {
    if (allIssues.length === 0) {
      announce(ja.review.feedback.noIssues);
      return;
    }
    reviewOpenRef.current = true;
    setReviewOpen(true);
    // Enter on the first still-open issue; when everything is resolved the
    // bar shows the all-done state at the top of the list.
    const firstOpen = allIssues.findIndex((i) => i.status === "open");
    gotoIssue(firstOpen >= 0 ? firstOpen : 0);
  }, [allIssues, gotoIssue, announce]);

  // #376: waveform-marker jump — open the review if needed and land
  //  the shared cursor on the clicked issue (score selection + source
  //  seek come free with gotoIssue).
  const openReviewAt = useCallback(
    (index: number) => {
      if (allIssues.length === 0) return;
      reviewOpenRef.current = true;
      setReviewOpen(true);
      gotoIssue(index);
    },
    [allIssues, gotoIssue],
  );

  const exitReview = useCallback(() => {
    reviewOpenRef.current = false;
    setReviewOpen(false);
    // #361: the navigator dies with the review (no refocus — the bar,
    //  including the toggle button, unmounts together).
    navOpenRef.current = false;
    setNavOpen(false);
    // The review-audition loop dies with the review - restore whatever
    // loop the user had before the review session armed it.
    reviewLoopRef.current = releaseReviewLoop(
      reviewLoopRef.current,
      reviewLoopPorts(),
    );
    announce(ja.review.feedback.exited);
  }, [announce, reviewLoopPorts]);

  /** Re-parse presentations + re-render after a note edit (pitch/delete):
   *  inspector labels and the playback table both derive from the XML. */
  const reloadEditedScore = useCallback(() => {
    const concert = parseScoreDoc(scoreDoc.musicXml("concert"));
    const horn = parseScoreDoc(scoreDoc.musicXml("hornF"));
    const bFlat = scoreDoc.supportsPitchView?.("bFlat")
      ? parseScoreDoc(scoreDoc.musicXml("bFlat"))
      : null;
    docsRef.current = {
      concert,
      horn,
      bFlat,
      concertByCanonical: notesByCanonical(concert),
      hornByCanonical: notesByCanonical(horn),
      bFlatByCanonical: bFlat ? notesByCanonical(bFlat) : new Map(),
      concertByExport: notesByExportId(concert),
      hornByExport: notesByExportId(horn),
      bFlatByExport: bFlat ? notesByExportId(bFlat) : new Map(),
    };
    renderScore(pitchRef.current, { keepScroll: true });
    const r = rendererRef.current;
    if (r) {
      tableRef.current = buildPlaybackTable(
        r.timemap(),
        buildSwingWarp(scoreDoc.canonicalDocument?.() ?? null) ?? undefined,
      );
      // #170: the edit changed the notated content — refresh the audition
      // note list and the score clock's total span so the heard score and
      // the transport length match the edited score (previously both kept
      // the pre-edit notes/duration).
      synthRef.current?.load(
        tableRef.current,
        notesByCanonical(concert),
        velocityByCanonicalId(scoreDoc.canonicalDocument?.() ?? null),
        bendsByCanonicalId(scoreDoc.canonicalDocument?.() ?? null),
        /* #398: the edit may have changed the part list (doc swap,
         *  re-transcribe) — re-derive rows and the routing map. */
        syncPartMix(scoreDoc.canonicalDocument?.() ?? null),
      );
      // #101: 拍子/テンポ編集はクリック列も変える — 張り直す。
      synthRef.current?.setClickTrack(
        clickTrack(scoreDoc.canonicalDocument?.() ?? null),
      );
      clockRef.current?.setDuration(tableRef.current.durationMs);
      /* #335: an armed loop marks a PASSAGE — re-map it through the
       *  rebuilt table. Tempo/swing/onset edits move note onsets, so
       *  the old ms range would silently loop a different passage (and
       *  the LOOP_CLASS marks never recomputed). Review-owned loops are
       *  left to reviewLoop's own lifecycle. */
      const clock = clockRef.current;
      const rebuilt = tableRef.current;
      if (
        clock?.loopRange() &&
        rebuilt &&
        !reviewLoopRef.current.armed
      ) {
        const remapped = remapLoopRange(rebuilt, loopAnchorRef.current);
        if (remapped.kind === "range") {
          clock.setLoop({
            startMs: remapped.startMs,
            endMs: remapped.endMs,
          });
        } else if (remapped.kind === "drop") {
          // The anchored note is gone — drop the loop rather than
          // looping a passage that no longer exists.
          clock.setLoop(null);
        }
      }
      // The marks effect derives the loop's canonicals from the table —
      // bump a generation so a rebuild with an unchanged ms range still
      // recomputes against the new onsets.
      setTableGen((g) => g + 1);
    }
  }, [scoreDoc, renderScore, syncPartMix]);

  /** Apply a session action: bump the document version so derived views
   *  (markers, inspector, counts) refresh; reload the score when the edit
   *  changed notation. Returns false on a no-op (caller announces). */
  const runReviewEdit = useCallback(
    (
      edit: ReviewEdit | null,
      feedback: string,
      opts: { reload?: boolean } = {},
    ): boolean => {
      if (!edit) return false;
      bumpDoc();
      if (
        opts.reload ??
        (edit.noteChanges.length > 0 || edit.docSwap != null)
      ) {
        reloadEditedScore();
      }
      reportInspector();
      announce(feedback);
      return true;
    },
    [bumpDoc, reloadEditedScore, reportInspector, announce],
  );

  const reviewAccept = useCallback(() => {
    const issue = issueAtCursor();
    if (!issue) return;
    if (
      !runReviewEdit(
        session.decide(issue.id, "accepted"),
        ja.review.feedback.accepted,
      )
    ) {
      announce(ja.review.feedback.already(ja.reviewStatus.accepted));
    } else {
      advanceAfterResolve();
    }
  }, [issueAtCursor, session, runReviewEdit, advanceAfterResolve, announce]);

  const reviewDismiss = useCallback(() => {
    const issue = issueAtCursor();
    if (!issue) return;
    if (
      !runReviewEdit(
        session.decide(issue.id, "dismissed"),
        ja.review.feedback.dismissed,
      )
    ) {
      announce(ja.review.feedback.already(ja.reviewStatus.dismissed));
    } else {
      advanceAfterResolve();
    }
  }, [issueAtCursor, session, runReviewEdit, advanceAfterResolve, announce]);

  /** #167: batch-accept every open issue sharing the cursor issue's
   *  reason — the repetitive "問題なし x N" flow collapses into one
   *  click, and one undo (the decideMany group) restores them all. */
  const reviewAcceptSameReason = useCallback(() => {
    const issue = issueAtCursor();
    if (!issue || issue.status !== "open") return;
    const ids = session
      .openIssues()
      .filter((i) => i.reason === issue.reason)
      .map((i) => i.id);
    if (ids.length < 2) {
      // The button only shows for 2+, but stay honest if reached
      //  programmatically — a lone member is the ordinary accept.
      reviewAccept();
      return;
    }
    const applied = session.decideMany(ids, "accepted");
    if (applied.length === 0) return;
    bumpDoc();
    reportInspector();
    announce(ja.review.feedback.acceptedMany(applied.length));
    advanceAfterResolve();
  }, [
    issueAtCursor,
    session,
    bumpDoc,
    reportInspector,
    announce,
    reviewAccept,
    advanceAfterResolve,
  ]);

  const reviewPitch = useCallback(
    (delta: number) => {
      const issue = issueAtCursor();
      if (!issue) return;
      if (
        !runReviewEdit(
          session.adjustPitch(issue.id, delta),
          ja.review.feedback.pitchFixed,
          { reload: true },
        )
      ) {
        announce(ja.review.feedback.noIssues);
      }
    },
    [issueAtCursor, session, runReviewEdit, announce],
  );

  const reviewDeleteOrRestore = useCallback(() => {
    const issue = issueAtCursor();
    if (!issue || issue.canonicalNoteIds.length === 0) return;
    const deleted = session.isDeleted(issue.canonicalNoteIds[0]);
    const applied = runReviewEdit(
      session.setNoteDeleted(issue.id, !deleted),
      deleted
        ? ja.review.feedback.noteRestored
        : ja.review.feedback.noteDeleted,
      { reload: true },
    );
    // #361: deleting resolves the issue (fixed) — auto-advance;
    //  restoring reopens it — the helper sees it still open and stays.
    if (applied) advanceAfterResolve();
  }, [issueAtCursor, session, runReviewEdit, advanceAfterResolve]);

  /* #114 (spec 10/13): score-workspace note navigation + direct edits.
   *  Arrow keys walk canonical notes in document order; Alt+arrows /
   *  Delete / E edit the selection through the shared undo stack. */
  const selectAdjacentNote = useCallback(
    (direction: 1 | -1) => {
      const docs = docsRef.current;
      if (!docs) return;
      // #368: canonical order, not fragment order — a tied note split
      // across a barline emits several MusicXML notes under one
      // canonicalId; walking raw fragments traps ←/→ on the first.
      const canonicals = canonicalNoteOrder(docs.concert);
      if (canonicals.length === 0) return;
      const cur = selectionRef.current?.canonicalId ?? null;
      let next: string;
      if (cur == null) {
        next =
          direction === 1 ? canonicals[0] : canonicals[canonicals.length - 1];
      } else {
        const i = canonicals.indexOf(cur);
        const j =
          i < 0 ? (direction === 1 ? 0 : canonicals.length - 1) : i + direction;
        if (j < 0 || j >= canonicals.length) return; // stay at the edges
        next = canonicals[j];
      }
      const exportId = docs.concertByCanonical.get(next)?.[0]?.exportId;
      if (exportId) selectExportId(exportId, { scroll: true });
    },
    [selectExportId],
  );

  const editSelectedPitch = useCallback(
    (delta: number) => {
      const canonicalId = selectionRef.current?.canonicalId;
      if (!canonicalId) return;
      if (
        !runReviewEdit(
          session.editNote(canonicalId, {
            pitchDelta: session.noteEditOf(canonicalId).pitchDelta + delta,
          }),
          ja.review.feedback.pitchFixed,
          { reload: true },
        )
      ) {
        announce(ja.review.feedback.noIssues);
      }
    },
    [session, runReviewEdit, announce],
  );

  const toggleSelectedDeleted = useCallback(() => {
    const canonicalId = selectionRef.current?.canonicalId;
    if (!canonicalId) return;
    const deleted = session.isDeleted(canonicalId);
    runReviewEdit(
      session.editNote(canonicalId, { deleted: !deleted }),
      deleted
        ? ja.review.feedback.noteRestored
        : ja.review.feedback.noteDeleted,
      { reload: true },
    );
  }, [session, runReviewEdit]);

  const toggleSelectedEnharmonic = useCallback(() => {
    const canonicalId = selectionRef.current?.canonicalId;
    if (!canonicalId) return false;
    const cur = session.noteEditOf(canonicalId).enharmonic ?? false;
    const ok = runReviewEdit(
      session.editNote(canonicalId, { enharmonic: !cur }),
      ja.review.feedback.respelled,
      { reload: true },
    );
    if (!ok) {
      announce(ja.review.feedback.noIssues);
    }
    return ok;
  }, [session, runReviewEdit, announce]);

  /* #204: a review action that corrected the score should mark its
   *  issue fixed — the same resolution the pitch/delete buttons get.
   *  decide() pushes its own undo entry, so undoing first reopens the
   *  issue and the next undo reverts the score edit itself. */
  const markIssueFixed = useCallback(
    (issueId: string) => {
      if (session.decide(issueId, "fixed")) {
        bumpDoc();
        reportInspector();
        // #361: a resolved cursor issue hands the review to the next
        //  open one (remedy buttons land here via applyRhythmEdit's
        //  async success path — advance only when reviewing).
        if (reviewOpenRef.current) advanceAfterResolve();
      }
    },
    [session, bumpDoc, reportInspector, advanceAfterResolve],
  );

  // #360: issues beyond the engine cap ride the result as deferred
  // extras — expanding appends them to the live review list so they
  // get markers, decisions, and navigation like any other issue.
  const expandOmitted = useCallback(() => {
    const n = scoreDoc.expandOmittedIssues?.() ?? 0;
    if (n <= 0) return;
    bumpDoc();
    reportInspector();
    announce(ja.review.feedback.expandedOmitted(n));
  }, [scoreDoc, bumpDoc, reportInspector, announce]);

  /* #115 (spec 13): engine rhythm edits — duration ladder, onset grid
   *  shift, tie toggle. The engine re-realizes the affected measures
   *  and returns fresh MusicXML + a new revision; the document swaps
   *  its content in place so selection and this undo stack survive
   *  (a remount would lose both). Undo restores the previous snapshot
   *  through the shared ReviewSession stack. */
  const applyRhythmEdit = useCallback(
    (
      buildOp: (canonical: unknown) => RhythmEditOp | null,
      feedback: string | ((result: ScoreEditResult) => string),
      after?: () => void,
    ) => {
      if (!onRhythmEdit || !scoreDoc.replaceContent) {
        announce(ja.commandFeedback.rhythmEditUnavailable);
        return;
      }
      // Serialize engine edits: each call must see the newest content.
      // #399: the edit is pending work from THIS point — guards and
      // Ctrl+S see it before the engine answers.
      setPendingEdits((n) => n + 1);
      rhythmQueueRef.current = rhythmQueueRef.current.then(async () => {
        try {
          const canonical = scoreDoc.canonicalDocument?.();
          const prev = scoreDoc.contentSnapshot?.();
          if (canonical == null || !prev) {
            announce(ja.commandFeedback.rhythmEditUnavailable);
            return;
          }
          const op = buildOp(canonical);
          if (!op) {
            announce(ja.commandFeedback.rhythmEditFailed);
            return;
          }
          // #392: snapshot what the engine consumes — the overlay and
          // the undo depth. Edits the user makes while the RPC is in
          // flight are the delta that must rebase onto the response,
          // and the doc-swap commits under them so undo order matches
          // the user's own action order.
          const overlayAtRequest = prev.noteEdits;
          const depthAtRequest = session.undoDepth;
          const result = await onRhythmEdit(canonical, op);
          // #399: the app may have swapped this document out while
          // the engine worked — a late response must not write into
          // a detached document (the mounted workspace owns the new
          // one).
          if (!mountedRef.current) return;
          // #392: rebase post-request overlay edits onto the engine
          // result; edits whose target the engine merged away count
          // as conflicts and surface honestly instead of vanishing.
          const rebased = scoreDoc.rebasedNoteEdits?.(
            result.scoreDocument,
            overlayAtRequest,
          );
          const next = {
            concertXml: result.musicXmlConcert,
            hornXml: result.musicXmlHornF,
            bFlatXml: result.musicXmlBFlat,
            revisionId: result.scoreRevision,
            canonicalDocument: result.scoreDocument,
            // #224: the canonical the engine just consumed already
            // carries the pending edits — only notation-only facets
            // (enharmonic) stay overlaid.
            // #392: request overlay + in-flight delta -> rebased set.
            noteEdits: rebased?.edits,
          };
          scoreDoc.replaceContent?.(next);
          session.commitDocSwap(
            prev,
            next,
            session.undoDepth - depthAtRequest,
          );
          bumpDoc();
          reloadEditedScore();
          reportInspector();
          announce(
            typeof feedback === "function" ? feedback(result) : feedback,
          );
          if (rebased && rebased.conflicts > 0) {
            // The success announce above lands first; this one stays
            // last so the status bar keeps the conflict visible.
            announce(ja.commandFeedback.editConflict);
          }
          after?.();
        } catch {
          announce(ja.commandFeedback.rhythmEditFailed);
        } finally {
          // #399: every exit path (success, failure, bail-out,
          // unmount) releases the pending count — a stuck >0 would
          // pin the app's unsaved guards forever.
          setPendingEdits((n) => Math.max(0, n - 1));
        }
      });
    },
    [
      scoreDoc,
      onRhythmEdit,
      session,
      bumpDoc,
      reloadEditedScore,
      reportInspector,
      announce,
    ],
  );

  /** 音価を2倍/半分 — the duration ladder walks ×2/÷2 on the canonical
   *  note's written length (a quarter → half → whole ...). */
  const noteDurationScale = useCallback(
    (power: number) => {
      const canonicalId = selectionRef.current?.canonicalId;
      if (!canonicalId) return;
      applyRhythmEdit((canonical) => {
        const note = findCanonicalNote(canonical, canonicalId);
        if (!note) return null;
        const next = scaleFraction(note.durationBeats, power);
        if (!next) return null;
        return {
          kind: "setDuration",
          noteId: canonicalId,
          durationBeats: formatFraction(next),
        };
      }, ja.commandFeedback.rhythmEdited);
    },
    [applyRhythmEdit],
  );

  /** 発音位置を左/右へ — shift the onset by whole minimum-grid steps. */
  const shiftSelectedOnset = useCallback(
    (steps: number) => {
      const canonicalId = selectionRef.current?.canonicalId;
      if (!canonicalId) return;
      applyRhythmEdit(
        () => ({ kind: "shiftOnset", noteId: canonicalId, steps }),
        ja.commandFeedback.rhythmEdited,
      );
    },
    [applyRhythmEdit],
  );

  /** 次の音符とタイで結ぶ/解く — the engine validates the contiguous
   *  same-pitch partner and reports a rejection honestly. */
  const toggleSelectedTie = useCallback(() => {
    const canonicalId = selectionRef.current?.canonicalId;
    if (!canonicalId) return;
    applyRhythmEdit(
      () => ({ kind: "toggleTie", noteId: canonicalId }),
      ja.commandFeedback.tieToggled,
    );
  }, [applyRhythmEdit]);

  /* spec 14 BPM edit - the properties panel's tempo field commits here.
   * setTempo is note-independent (it rewrites the tempo map's head
   * segment), so the op carries no noteId; the engine still returns a
   * fresh revision + rebuilt XML, which keeps undo on the same stack. */
  const setTempo = useCallback(
    (bpm: number) => {
      applyRhythmEdit(
        () => ({ kind: "setTempo", noteId: "", bpm }),
        ja.commandFeedback.tempoChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #198: the tempo-octave fix — scales the tempo map AND every note
   * value by the same factor, so playback seconds stay put while the
   * written rhythm corrects itself. setTempo alone would relabel BPM
   * and leave the (wrong) note values standing. */
  const scaleTempo = useCallback(
    (factor: number) => {
      applyRhythmEdit(
        () => ({ kind: "scaleTempo", noteId: "", factor }),
        ja.commandFeedback.tempoChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #129 (spec 14): meter edit — the engine re-tiles every part under
   * the new signature (positions rescale when the beat unit changes);
   * same serialized queue + undo stack as the other rhythm edits. */
  const setMeter = useCallback(
    (beatsPerMeasure: number, beatUnit: number) => {
      applyRhythmEdit(
        () => ({
          kind: "setMeter",
          noteId: "",
          beatsPerMeasure,
          beatUnit,
        }),
        ja.commandFeedback.meterChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #358 (spec 14): anacrusis edit — the engine rebuilds the barline
   * grid under the new pickup while note values stay put (unlike
   * setMeter, nothing rescales); the properties pickup field and
   * the review bar's suggestion both land here. */
  const setPickup = useCallback(
    (pickupBeats: string) => {
      applyRhythmEdit(
        () => ({ kind: "setPickup", noteId: "", pickupBeats }),
        ja.commandFeedback.pickupChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #145 (spec 14): key edit — replaces the head signature and
   * collapses detected key changes to the new single key; same
   * serialized queue + undo stack as the other rhythm edits. */
const setKey = useCallback(
    (fifths: number, mode?: "major" | "minor" | null) => {
      applyRhythmEdit(
        () => ({ kind: "setKey", noteId: "", fifths, mode: mode ?? undefined }),
        ja.commandFeedback.keyChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #145 (spec 14): local key-map edits — insert/update a boundary
   *  (startBeat "0/1" rewrites the head key without collapsing the
   *  map) or drop a detected modulation. Same serialized queue +
   *  undo stack as setKey. */
  const keyChangeAt = useCallback(
    (args: {
      fifths: number;
      mode?: "major" | "minor" | null;
      startBeat?: string;
      startMeasure?: number;
    }) => {
      applyRhythmEdit(
        () => ({
          kind: "keyChangeAt",
          noteId: "",
          fifths: args.fifths,
          mode: args.mode ?? undefined,
          startBeat: args.startBeat,
          startMeasure: args.startMeasure,
        }),
        ja.commandFeedback.keyChanged,
      );
    },
    [applyRhythmEdit],
  );

  const removeKeyChange = useCallback(
    (startMeasure: number) => {
      applyRhythmEdit(
        () => ({
          kind: "removeKeyChange",
          noteId: "",
          startMeasure,
        }),
        ja.commandFeedback.keyChangeRemoved,
      );
    },
    [applyRhythmEdit],
  );

  /* #249 (spec 14): tempo-map edits — insert/update a segment
   *  (exact startBeat for tracked marks, startMeasure for a new
   *  barline mark) or drop one. Same serialized queue + undo stack
   *  as setTempo. */
  const tempoChangeAt = useCallback(
    (args: { bpm: number; startBeat?: string; startMeasure?: number }) => {
      applyRhythmEdit(
        () => ({
          kind: "tempoChangeAt",
          noteId: "",
          bpm: args.bpm,
          startBeat: args.startBeat,
          startMeasure: args.startMeasure,
        }),
        ja.commandFeedback.tempoChanged,
      );
    },
    [applyRhythmEdit],
  );

  const removeTempoChange = useCallback(
    (args: { startBeat?: string; startMeasure?: number }) => {
      applyRhythmEdit(
        () => ({
          kind: "removeTempoChange",
          noteId: "",
          startBeat: args.startBeat,
          startMeasure: args.startMeasure,
        }),
        ja.commandFeedback.tempoChangeRemoved,
      );
    },
    [applyRhythmEdit],
  );

  /* #271: notation metadata — title/composer/arranger rewrite the
   *  MusicXML headers (and therefore the PDF export) without
   *  touching the content-derived revision. */
  const setMetadata = useCallback(
    (metadata: { title?: string; composer?: string; arranger?: string }) => {
      applyRhythmEdit(
        () => ({ kind: "setMetadata", noteId: "", metadata }),
        ja.commandFeedback.metadataChanged,
      );
    },
    [applyRhythmEdit],
  );

  /* #267: octave arrange — one canonical transposeRange over the
   *  whole score (real sounding pitch, not the F管 projection).
   *  The engine rejects moves that would leave MIDI 0-127; undo is
   *  a single doc-swap entry. */
  const transposeScore = useCallback(
    (semitones: number) => {
      applyRhythmEdit(
        () => ({ kind: "transposeRange", noteId: "", semitones }),
        ja.commandFeedback.octaveShifted,
      );
    },
    [applyRhythmEdit],
  );

  /* #123: fold voices/chords into the single playable melody — the
   *  engine keeps the top voice per simultaneity and drops extra
   *  parts; undo restores the pre-collapse document in one entry. */
  const collapseToMelody = useCallback(() => {
    applyRhythmEdit(
      () => ({ kind: "collapseToMelody", noteId: "" }),
      ja.commandFeedback.collapsedToMelody,
    );
  }, [applyRhythmEdit]);

  /* #130 (spec 14): re-quantize the whole score under changed
   * quantization settings — the engine replays the canonical notes
   * through the DP with the merged profile. */
  const requantize = useCallback(
    (settings: Record<string, unknown>) => {
      applyRhythmEdit(
        () => ({ kind: "requantize", noteId: "", settings }),
        // #226: raw evidence present → true replay of the performance;
        // absent → the honest degraded label (re-rounding notation).
        (result) =>
          result.requantizeMode === "synthetic"
            ? ja.commandFeedback.requantizedSynthetic
            : ja.commandFeedback.requantized,
      );
    },
    [applyRhythmEdit],
  );

  /* #131 (spec 13 post-MVP): split at the grid-snapped midpoint; merge
   * with the contiguous next same-pitch note — the engine validates
   * both (too short to split, different pitch, non-contiguous) and
   * reports a rejection honestly. */
  const splitSelectedNote = useCallback(() => {
    const canonicalId = selectionRef.current?.canonicalId;
    if (!canonicalId) return;
    applyRhythmEdit(
      () => ({ kind: "splitNote", noteId: canonicalId }),
      ja.commandFeedback.noteSplit,
    );
  }, [applyRhythmEdit]);

  const mergeSelectedNotes = useCallback(() => {
    const canonicalId = selectionRef.current?.canonicalId;
    if (!canonicalId) return;
    applyRhythmEdit(
      () => ({ kind: "mergeNotes", noteId: canonicalId }),
      ja.commandFeedback.notesMerged,
    );
  }, [applyRhythmEdit]);

  /* #163: the selected rest becomes a note at its own atom position —
   * default pitch = the nearest preceding note's, default duration =
   * the rest atom's span (the engine re-tiles leftovers as rests).
   * Afterwards the fresh note is selected so pitch/duration edits are
   * one keystroke away. */
  const convertSelectedRest = useCallback(() => {
    const sel = selectionRef.current;
    const ordinal = sel ? restOrdinalOf(sel.exportId) : null;
    if (sel == null || ordinal == null) return;
    // The engine assigns the next free sn-* id — capture it from the
    // PRE-edit canonical inside buildOp (after the swap the counter
    // has already moved past the new note).
    let newNoteExportId: string | null = null;
    applyRhythmEdit(
      (canonical) => {
        const target = restAtomAtOrdinal(canonical, ordinal);
        if (!target) return null;
        newNoteExportId = nextScoreNoteId(canonical).replace(/^sn-/, "hs-sn-");
        return {
          kind: "restToNote",
          noteId: "",
          partId: target.partId,
          startBeat: formatFraction(target.startBeat),
          durationBeats: formatFraction(target.durationBeats),
          pitchMidi: pitchBefore(canonical, target.partId, target.startBeat),
        };
      },
      ja.commandFeedback.restConverted,
      () => {
        if (newNoteExportId) selectExportId(newNoteExportId, { scroll: true });
      },
    );
  }, [applyRhythmEdit, selectExportId]);

  const reviewUndo = useCallback(() => {
    const edit = session.undo();
    if (!edit) {
      announce(ja.review.feedback.nothingToUndo);
      return;
    }
    bumpDoc();
    if (edit.noteChanges.length > 0 || edit.docSwap != null)
      reloadEditedScore();
    reportInspector();
    // #361: undo reopens the issue — bring the cursor back to it so
    //  the reopened row is what the user is looking at (auto-advance
    //  had moved the cursor forward past it).
    if (reviewOpenRef.current && edit.issueId != null) {
      const idx = session.issues().findIndex((i) => i.id === edit.issueId);
      if (idx >= 0) gotoIssue(idx);
    }
    announce(ja.review.feedback.undone);
  }, [
    session,
    bumpDoc,
    reloadEditedScore,
    reportInspector,
    announce,
    gotoIssue,
  ]);

  const reviewRedo = useCallback(() => {
    const edit = session.redo();
    if (!edit) {
      announce(ja.review.feedback.nothingToRedo);
      return;
    }
    bumpDoc();
    if (edit.noteChanges.length > 0 || edit.docSwap != null)
      reloadEditedScore();
    reportInspector();
    announce(ja.review.feedback.redone);
  }, [session, bumpDoc, reloadEditedScore, reportInspector, announce]);

  /** 元音源を再生 — loop the issue's source range. The media transport is
   *  driven when a source is loaded (sourceControl); the score clock loop
   *  arms either way so the passage indication (LOOP_CLASS) shows which
   *  notes the audio range covers. */
  const playSource = useCallback(() => {
    const issue = issueAtCursor();
    if (!issue) return;
    const range = issueAuditionRange(issue, tableRef.current);
    if (range == null) return;
    // Arm the review-owned loop on every loop-capable clock (score clock
    // + media transport). The user's previous loop is saved inside the
    // review-loop state and restored by exitReview.
    reviewLoopRef.current = armReviewLoop(
      reviewLoopRef.current,
      reviewLoopPorts(),
      range,
    );
    const clock = clockRef.current;
    if (sourceControl) {
      sourceControl.seekTo(range.start);
      sourceControl.play();
    } else {
      clock?.seek(range.start * 1000);
      clock?.play();
    }
    announce(ja.review.feedback.playingSource);
  }, [issueAtCursor, sourceControl, announce, reviewLoopPorts]);

  /* --------------------------- controller -------------------------------- */

  useEffect(() => {
    if (!controllerRef) return;
    const controller: ScoreWorkspaceController = {
      zoomIn: () => changeZoom(zoomRef.current + SCORE_ZOOM_STEP_PCT),
      zoomOut: () => changeZoom(zoomRef.current - SCORE_ZOOM_STEP_PCT),
      zoomFit: () => zoomFit(),
      clearSelection: () => {
        if (reviewOpenRef.current) exitReview();
        else clearSelection();
      },
      togglePlayPause: () => {
        const c = clockRef.current;
        if (!c) return;
        if (c.isPlaying()) {
          c.pause();
          return;
        }
        // #101: カウントイン — メトロノームか audition が鳴る時だけ
        // 1小節分のクリックを武装して保留付きで再生する(無音のまま
        // 待たせても意味がないので両方オフなら即時開始)。
        const doc = scoreDoc.canonicalDocument?.() ?? null;
        // 末尾での play はクロック側で pos=0 に巻き戻る — カウントインの
        // 拍子は実際に鳴り始める小節から取る(変拍子でずれないため)。
        const pos =
          c.positionMs() >= c.durationMs() ? 0 : c.positionMs();
        const countIn =
          countInRef.current && (auditionRef.current || metronomeRef.current)
            ? countInMs(doc, pos)
            : 0;
        const synth = synthRef.current;
        if (synth) {
          synth.armCountIn(countIn > 0 ? countInPattern(doc, pos) : null);
        }
        c.play(countIn);
      },
      stop: () => clockRef.current?.stop(),
      seekToStart: () => clockRef.current?.seek(0),
      seekToEnd: () => {
        const c = clockRef.current;
        if (c) c.seek(c.durationMs());
      },
      jumpBy: (deltaMs) => clockRef.current?.jumpBy(deltaMs),
      toggleLoop: () => {
        const c = clockRef.current;
        if (!c) return;
        if (c.loopRange()) {
          c.setLoop(null);
          loopAnchorRef.current = null;
        } else {
          // No waveform range selection yet (UI-020) — arm the loop over
          // the selected note's span when possible so Ctrl+L is honest.
          const sel = selectionRef.current;
          const table = tableRef.current;
          if (sel?.canonicalId && table) {
            const onset = table.onsetMsByCanonical.get(sel.canonicalId);
            if (onset != null) {
              const next = nearestOffset(table, onset);
              c.setLoop({ startMs: onset, endMs: next });
              loopAnchorRef.current = sel.canonicalId;
            }
          } else {
            c.setLoop({ startMs: 0, endMs: c.durationMs() });
            loopAnchorRef.current = "full";
          }
        }
      },
      // #113: expose the armed loop so the app can mirror it onto the
      // media transport (audio loops together with the score marks).
      loopRange: () => clockRef.current?.loopRange() ?? null,
      resumeFollow: () => resumeFollow(),
      setFollowEnabled: (on) => {
        if (on) resumeFollow();
        else {
          setFollowEnabled(false);
          followRef.current = false;
          suspendedRef.current = false;
          setFollowSuspended(false);
        }
      },
      // FEAT-001: audition toggle — driven from the transport bar.
      toggleAudition: () => {
        const synth = synthRef.current;
        if (!synth) return;
        const next = !auditionRef.current;
        auditionRef.current = next;
        setAuditionEnabled(next);
        synth.setEnabled(next);
        announce(
          next
            ? ja.transport.auditionOnAnnounce
            : ja.transport.auditionOffAnnounce,
        );
      },
      // #101: メトロノーム — クリックレイヤは audition と独立。
      toggleMetronome: () => {
        const synth = synthRef.current;
        if (!synth) return;
        const next = !metronomeRef.current;
        metronomeRef.current = next;
        setMetronomeEnabled(next);
        synth.setMetronome(next);
        announce(
          next
            ? ja.transport.metronomeOnAnnounce
            : ja.transport.metronomeOffAnnounce,
        );
      },
      // #101: カウントイン — 次の再生から効く設定トグル(即時の音は出ない)。
      toggleCountIn: () => {
        const next = !countInRef.current;
        countInRef.current = next;
        setCountInEnabled(next);
        announce(
          next
            ? ja.transport.countInOnAnnounce
            : ja.transport.countInOffAnnounce,
        );
      },
      // #101: クリック音量 fader — synth の click 層のゲインを更新する
      // (スケジュール済みの鳴りは変えない; ミキサーの行は state 経由)。
      updateClickVolume: (volume) => {
        const v = Math.min(1, Math.max(0, volume));
        setClickVolume(v);
        synthRef.current?.setClickVolume(v);
      },
      /* #398: mixer row edit — applies live to ringing + future voices
       *  (gain nodes, no reschedule), mirrors into onStateChange so the
       *  transport popover reflects it. */
      updatePartMix: (index, patch) => {
        const prev = partMixRef.current;
        if (index < 0 || index >= prev.length) return;
        const next = prev.map((m, i) =>
          i === index
            ? {
                name: m.name,
                volume:
                  patch.volume !== undefined
                    ? Math.min(1, Math.max(0, patch.volume))
                    : m.volume,
                muted: patch.muted ?? m.muted,
                solo: patch.solo ?? m.solo,
              }
            : m,
        );
        partMixRef.current = next;
        setPartMix(next);
        pushPartGains(synthRef.current, next);
      },
      openReview: () => openReview(),
      openReviewAt: (i) => openReviewAt(i),
      reviewNext: () => stepReviewOpen(1),
      reviewPrevious: () => stepReviewOpen(-1),
      reviewToggleNavigator: () => toggleNavigator(),
      reviewAccept: () => reviewAccept(),
      reviewDismiss: () => reviewDismiss(),
      reviewAcceptSameReason: () => reviewAcceptSameReason(),
      reviewPlaySource: () => playSource(),
      reviewPitch: (delta) => reviewPitch(delta),
      reviewDeleteOrRestore: () => reviewDeleteOrRestore(),
      exitReview: () => exitReview(),
      undo: () => reviewUndo(),
      redo: () => reviewRedo(),
      // #399: callers that snapshot the document (Ctrl+S) wait out
      // the serialized engine queue so their write lands after the
      // user's last edit, not before it.
      waitForPendingEdits: () => rhythmQueueRef.current,
      // #114: score-workspace navigation + direct note edits (spec 10/13).
      selectAdjacentNote: (direction) => selectAdjacentNote(direction),
      editSelectedPitch: (delta) => editSelectedPitch(delta),
      toggleSelectedDeleted: () => toggleSelectedDeleted(),
      toggleSelectedEnharmonic: () => toggleSelectedEnharmonic(),
      // #115: engine rhythm edits (spec 13) — duration ladder, onset
      // grid shift, tie toggle. Async internally; feedback announces.
      noteDurationScale: (power) => noteDurationScale(power),
      shiftSelectedOnset: (steps) => shiftSelectedOnset(steps),
      toggleSelectedTie: () => toggleSelectedTie(),
      setTempo: (bpm) => setTempo(bpm),
      scaleTempo: (factor) => scaleTempo(factor),
      setMeter: (bpm_, bu) => setMeter(bpm_, bu),
      setPickup: (p) => setPickup(p),
      setKey: (fifths, mode) => setKey(fifths, mode),
      keyChangeAt: (args) => keyChangeAt(args),
      removeKeyChange: (m) => removeKeyChange(m),
      tempoChangeAt: (args) => tempoChangeAt(args),
      removeTempoChange: (args) => removeTempoChange(args),
      setMetadata: (md) => setMetadata(md),
      transposeScore: (s) => transposeScore(s),
      collapseToMelody: () => collapseToMelody(),
      requantize: (settings) => requantize(settings),
      splitSelectedNote: () => splitSelectedNote(),
      mergeSelectedNotes: () => mergeSelectedNotes(),
      convertSelectedRest: () => convertSelectedRest(),
    };
    controllerRef(controller);
    return () => controllerRef(null);
  }, [
    controllerRef,
    changeZoom,
    zoomFit,
    clearSelection,
    exitReview,
    resumeFollow,
    openReview,
    openReviewAt,
    gotoIssue,
    stepReviewOpen,
    toggleNavigator,
    reviewAccept,
    reviewDismiss,
    reviewAcceptSameReason,
    playSource,
    reviewPitch,
    reviewDeleteOrRestore,
    reviewUndo,
    reviewRedo,
    selectAdjacentNote,
    editSelectedPitch,
    toggleSelectedDeleted,
    toggleSelectedEnharmonic,
    noteDurationScale,
    shiftSelectedOnset,
    toggleSelectedTie,
    setTempo,
    scaleTempo,
    setMeter,
    setPickup,
    setKey,
    keyChangeAt,
    removeKeyChange,
    tempoChangeAt,
    removeTempoChange,
    setMetadata,
    transposeScore,
    collapseToMelody,
    requantize,
    splitSelectedNote,
    mergeSelectedNotes,
    convertSelectedRest,
    announce,
    scoreDoc,
  ]);

  /* --------------------------- state mirror ------------------------------ */

  useEffect(() => {
    onStateChangeRef.current?.({
      hasSelection: selection !== null,
      // #163: a rest glyph is selected (canonicalId null + hs-rest id) —
      // gates the score.restToNote command.
      hasRestSelection:
        selection !== null &&
        selection.canonicalId === null &&
        restOrdinalOf(selection.exportId) !== null,
      isPlaying: clockSnap.isPlaying,
      loopEnabled: clockSnap.loop !== null,
      positionMs: clockSnap.positionMs,
      durationMs: clockSnap.durationMs,
      followEnabled,
      followSuspended,
      reviewOpen,
      reviewIssueEditable: issueHasNoteTargets(
        allIssues[reviewIndex] ?? null,
      ),
      zoomPct: zoom,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      openIssueCount: pendingCount,
      // #361: decided rows included — review.open stays reachable as
      //  the history entry point once pending hits 0.
      totalIssueCount: allIssues.length,
      auditionEnabled,
      metronomeEnabled,
      countInEnabled,
      clickVolume,
      partMix,
      // #399: queued engine edits — unsaved work from the app's
      // perspective even before editVersion moves.
      pendingEdits,
    });
  }, [
    selection,
    clockSnap,
    followEnabled,
    followSuspended,
    reviewOpen,
    allIssues,
    reviewIndex,
    zoom,
    session,
    pendingCount,
    docVersion,
    auditionEnabled,
    metronomeEnabled,
    countInEnabled,
    clickVolume,
    partMix,
    pendingEdits,
  ]);

  // Initial inspector = score summary (§22 "Nothing selected").
  useEffect(() => {
    if (!loading) reportInspector();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // #247: page navigation lazily renders the target page (cache hit
  // for prefetched neighbours, one renderToSVG otherwise), then
  // queues the next pair of neighbours for idle prefetch.
  useEffect(() => {
    if (viewMode !== "page" || loading) return;
    ensurePage(currentPage);
    schedulePagePrefetch(currentPage);
  }, [viewMode, currentPage, loading, ensurePage, schedulePagePrefetch]);

  /* #401: init-failure recovery — 再試行 re-runs the init effect
   * (the verovio singleton self-heals on rejection, so this is a
   * fresh attempt); 診断情報 copies the kept diagnostics text. */
  const retryInit = useCallback(() => {
    setInitError(null);
    setInitDiagOpen(false);
    setInitDiagCopied(false);
    setInitAttempt((n) => n + 1);
  }, []);
  const copyInitDiagnostics = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(initError ?? "");
      setInitDiagCopied(true);
    } catch {
      setInitDiagCopied(false);
    }
  }, [initError]);

  /* ------------------------------- render -------------------------------- */

  const visiblePages =
    viewMode === "page" ? pages.filter((p) => p.page === currentPage) : pages;
  const s = ja.scoreView;

  if (initError) {
    // #401: same contract as the render-failure surface — fixed
    // Japanese title/body + recovery actions; the raw exception stays
    // behind 診断情報 (GUI_UX_SPEC §20, JAPANESE_UI_COPY §7).
    return (
      <>
        <div className="hs-score-error" role="alert">
          <h2>{s.initErrorTitle}</h2>
          <p>{s.initErrorBody}</p>
          <HsButton variant="primary" onClick={retryInit}>
            {ja.common.retry}
          </HsButton>
          <HsButton variant="secondary" onClick={() => setInitDiagOpen(true)}>
            {ja.common.diagnostics}
          </HsButton>
        </div>
        <HsDialog
          open={initDiagOpen}
          onOpenChange={(open) => {
            setInitDiagOpen(open);
            if (!open) setInitDiagCopied(false);
          }}
          title={ja.diagnostics.title}
          actions={
            <>
              <HsButton
                variant="secondary"
                onClick={() => void copyInitDiagnostics()}
              >
                {initDiagCopied ? ja.diagnostics.copied : ja.diagnostics.copy}
              </HsButton>
              <HsButton
                variant="primary"
                onClick={() => setInitDiagOpen(false)}
              >
                {ja.diagnostics.close}
              </HsButton>
            </>
          }
        >
          <pre className="hs-diagnostics">{initError}</pre>
        </HsDialog>
      </>
    );
  }

  return (
    <div className="hs-score-workspace">
      <div
        className="hs-score-toolbar"
        role="toolbar"
        aria-label={s.regionLabel}
      >
        <SegmentedControl
          options={[
            { value: "continuous", label: s.continuous },
            { value: "page", label: s.page },
          ]}
          value={viewMode}
          onChange={(v) => changeViewMode(v)}
          ariaLabel={s.viewModeLabel}
        />
        {viewMode === "page" && pageCount > 1 && (
          <span className="hs-score-toolbar__pages">
            <HsButton
              size="small"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
            >
              {s.prevPage}
            </HsButton>
            <span aria-live="polite">
              {s.pagePosition(currentPage, pageCount)}
            </span>
            <HsButton
              size="small"
              onClick={() =>
                setCurrentPage((p) => Math.min(pageCount, p + 1))
              }
              disabled={currentPage >= pageCount}
            >
              {s.nextPage}
            </HsButton>
          </span>
        )}
        {pitch !== "concert" && (
          <span className="hs-score-toolbar__caption">
            {pitch === "hornF" ? ja.pitch.hornF : ja.pitch.bFlat}（
            {ja.pitch.writtenNote}）
          </span>
        )}
        <span className="hs-score-toolbar__spacer" />
        <HsButton
          size="small"
          onClick={() => changeZoom(zoom - SCORE_ZOOM_STEP_PCT)}
        >
          {s.zoomOut}
        </HsButton>
        <span
          className="hs-score-toolbar__zoom"
          aria-live="polite"
          aria-label={s.zoomLabel}
        >
          {zoom}%
        </span>
        <HsButton
          size="small"
          onClick={() => changeZoom(zoom + SCORE_ZOOM_STEP_PCT)}
        >
          {s.zoomIn}
        </HsButton>
        <HsButton size="small" onClick={zoomFit}>
          {s.zoomFit}
        </HsButton>
      </div>

      {reviewOpen && (
        <>
          <ReviewBar
          index={Math.min(reviewIndex, Math.max(0, allIssues.length - 1))}
          total={allIssues.length}
          pending={pendingCount}
          omitted={scoreDoc.meta.omittedIssueCount}
          issue={allIssues[reviewIndex] ?? null}
          copy={
            allIssues[reviewIndex]
              ? {
                  reasonTitle: copy.review.reasonTitle(
                    allIssues[reviewIndex].reason,
                  ),
                  reasonDetail: copy.review.reasonDetail(
                    allIssues[reviewIndex],
                  ),
                  severityLabel: copy.review.severityLabel(
                    allIssues[reviewIndex].severity,
                  ),
                  statusLabel: copy.review.statusLabel(
                    allIssues[reviewIndex].status,
                  ),
                }
              : null
          }
          noteDeleted={
            allIssues[reviewIndex]?.canonicalNoteIds[0] != null &&
            session.isDeleted(allIssues[reviewIndex].canonicalNoteIds[0])
          }
          canUndo={session.canUndo}
          canRedo={session.canRedo}
          canEditNotes={issueHasNoteTargets(
            allIssues[reviewIndex] ?? null,
          )}
          canPlaySource={
            issueAuditionRange(
              allIssues[reviewIndex] ?? null,
              tableRef.current,
            ) != null
          }
          action={buildReviewAction(allIssues[reviewIndex] ?? null, {
            retranscribeVoices: onRetranscribeVoices,
            retranscribeVocalIsolation: onRetranscribeVocalIsolation,
            retranscribeBasicPitch: onRetranscribeBasicPitch,
            openProperties: onOpenProperties,
            toggleEnharmonic: toggleSelectedEnharmonic,
            // Engine-backed remedies need the edit channel - without it
            // (fixture/dev documents) the action hides rather than
            // announcing "unavailable" after the click.
            applyEdit:
              onRhythmEdit && scoreDoc.replaceContent
                ? (op, feedback, onApplied) =>
                    applyRhythmEdit(op, feedback, onApplied)
                : undefined,
            markFixed: markIssueFixed,
          })}
          onPrev={() => stepReviewOpen(-1)}
          onNext={() => stepReviewOpen(1)}
          navigatorOpen={navOpen}
          onToggleNavigator={toggleNavigator}
          navigatorButtonRef={navToggleRef}
          onExpandOmitted={
            scoreDoc.expandOmittedIssues ? expandOmitted : undefined
          }
          onPlaySource={playSource}
          onAccept={reviewAccept}
          onDismiss={reviewDismiss}
          sameReasonPending={
            allIssues.filter(
              (i) =>
                i.status === "open" &&
                i.reason === allIssues[reviewIndex]?.reason,
            ).length
          }
          onAcceptSameReason={reviewAcceptSameReason}
          onPitch={reviewPitch}
          onDeleteOrRestore={reviewDeleteOrRestore}
          onUndo={reviewUndo}
          onRedo={reviewRedo}
          onExit={exitReview}
          />
          {navOpen && (
            <ReviewNavigator
              issues={allIssues}
              activeIndex={Math.min(
                reviewIndex,
                Math.max(0, allIssues.length - 1),
              )}
              omitted={scoreDoc.meta.omittedIssueCount}
              copy={copy.review}
              onExpandOmitted={
                scoreDoc.expandOmittedIssues ? expandOmitted : undefined
              }
              onJump={(i) => {
                gotoIssue(i);
                closeNavigator();
              }}
              onClose={() => closeNavigator()}
            />
          )}
        </>
      )}

      {loading && <div className="hs-score-loading">{s.loading}</div>}
      {renderError && (
        <div className="hs-score-error" role="alert">
          <h2>{s.renderErrorTitle}</h2>
          <p>{s.renderErrorBody}</p>
          <HsButton onClick={() => renderScore(pitchRef.current)}>
            {ja.common.retry}
          </HsButton>
        </div>
      )}
      {!renderError && (
        <ScoreView
          ref={scrollRef}
          pages={visiblePages}
          onElementClick={(id) => selectExportId(id)}
          onBackgroundClick={clearSelection}
          onUserNavigate={suspendFollow}
          ariaLabel={s.regionLabel}
        />
      )}

      {followSuspended && (
        <div className="hs-score-follownote" role="status">
          <span>{s.followPaused}</span>
          <HsButton size="small" variant="primary" onClick={resumeFollow}>
            {s.resumeFollow}
          </HsButton>
        </div>
      )}
    </div>
  );
}

/** Offset ms for a canonical id — the next distinct onset after its own,
 *  or the document end. Used to arm a note-span loop. */
const nearestOffset = nextOnsetOrEnd;

/** The source range an issue auditions over: its explicit timeRange, or
 *  the first canonical note's notated span (onset -> next onset) when the
 *  issue carries no range. null when neither is derivable (whole-piece
 *  issues on a source-less fixture). */
function issueAuditionRange(
  issue: ScoreReviewIssue | null,
  table: PlaybackTable | null,
): LoopRangeSec | null {
  if (!issue) return null;
  const t = issue.timeRange;
  if (t != null && t.endSec > t.startSec) {
    return { start: t.startSec, end: t.endSec };
  }
  const first = issue.canonicalNoteIds[0];
  const onset = first ? table?.onsetMsByCanonical.get(first) : undefined;
  if (!table || onset == null) return null;
  return {
    start: onset / 1000,
    end: nearestOffset(table, onset) / 1000,
  };
}
