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
  segmentAt,
  type PlaybackTable,
} from "./playbackTable";
import {
  ScoreCursorClock,
  type ClockSnapshot,
  type TransportClock,
} from "./clock";
import { ScorePlaybackSynth, velocityByCanonicalId } from "./playbackSynth";
import { bendsByCanonicalId } from "./playbackSynth";
import { buildSwingWarp } from "./swingWarp";
import {
  allIssuesForCanonical,
  markedCanonicalIds,
  numEvidence,
  type ScoreReviewIssue,
} from "./review";
import { ReviewSession, type ReviewEdit } from "./reviewSession";
import { ReviewBar } from "./ReviewBar";
import {
  findCanonicalNote,
  formatFraction,
  scaleFraction,
  type RhythmEditInvoker,
  type RhythmEditOp,
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
  /** #181: re-run the job with the Basic Pitch backend — offered on
   *  the monophonic-backend review issue. */
  onRetranscribeBasicPitch?(): void;
  /** #209: open the properties panel — offered on the meter-conflict
   *  issue so the user finds the meter select without hunting. */
  onOpenProperties?(): void;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

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
  onRetranscribeBasicPitch,
  onOpenProperties,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ScoreRenderer | null>(null);
  const indexRef = useRef<ElementIndex | null>(null);
  const clockRef = useRef<TransportClock | null>(null);
  const tableRef = useRef<PlaybackTable | null>(null);

  const [pages, setPages] = useState<RenderedPage[]>([]);
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
  const [initError, setInitError] = useState<string | null>(null);
  const [followEnabled, setFollowEnabled] = useState(followPlayback);
  const [followSuspended, setFollowSuspended] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [clockSnap, setClockSnap] = useState<ClockSnapshot>({
    positionMs: 0,
    durationMs: 0,
    isPlaying: false,
    rate: 1,
    loop: null,
  });
  // FEAT-001: score audition engine. Lazily created when the user turns
  // the audition toggle on; synced with the score clock below.
  const synthRef = useRef<ScorePlaybackSynth | null>(null);
  const [auditionEnabled, setAuditionEnabled] = useState(false);
  const auditionRef = useRef(false);

  // Parsed presentations — identical canonical ids, different spelling.
  const docsRef = useRef<{
    concert: ScoreDoc;
    horn: ScoreDoc;
    concertByCanonical: Map<string, ParsedNote[]>;
    hornByCanonical: Map<string, ParsedNote[]>;
    concertByExport: Map<string, ParsedNote>;
    hornByExport: Map<string, ParsedNote>;
  } | null>(null);

  // Refs mirrored so the rAF pump / layout effect always see fresh values.
  const selectionRef = useRef<Selection | null>(null);
  const activeRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  const loopCanonicalsRef = useRef<ReadonlySet<string>>(EMPTY_SET);
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
  const reviewIndexRef = useRef(0);
  const reviewOpenRef = useRef(false);
  const pendingScrollRef = useRef<{ ratio: number } | null>(null);

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
  pitchRef.current = pitch;
  reviewIndexRef.current = reviewIndex;
  reviewOpenRef.current = reviewOpen;

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
        setPages(r.renderAllPages());
        setRenderError(false);
        setLoading(false);
      } catch {
        setPages([]);
        setRenderError(true);
        setLoading(false);
      }
    },
    [scoreDoc],
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
      currentPageRef.current > pages.length
    ) {
      setCurrentPage(pages.length);
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
  }, [pages, scoreDoc, viewMode, currentPage, docVersion]);

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
        // Parse both presentations once — inspector reads both regardless of
        // the current view (written/concert rows, §22).
        const concert = parseScoreDoc(scoreDoc.musicXml("concert"));
        const horn = parseScoreDoc(scoreDoc.musicXml("hornF"));
        docsRef.current = {
          concert,
          horn,
          concertByCanonical: notesByCanonical(concert),
          hornByCanonical: notesByCanonical(horn),
          concertByExport: notesByExportId(concert),
          hornByExport: notesByExportId(horn),
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
        );
        clock.subscribe((s) => {
          synth.setLoop(
            s.loop ? { startMs: s.loop.startMs, endMs: s.loop.endMs } : null,
          );
          synth.sync(s.positionMs, s.isPlaying, s.rate);
        });
      })
      .catch((e: unknown) =>
        setInitError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
      clockRef.current?.dispose();
      clockRef.current = null;
      synthRef.current?.dispose();
      synthRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [clockSnap.loop, applyLoopDom]);

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
            docs.hornByExport.get(sel.exportId),
        ].filter((n): n is ParsedNote => n != null);
    const hornFrags = canonical
      ? (docs.hornByCanonical.get(canonical) ?? [])
      : concertFrags;
    const onsetMs = canonical
      ? (tableRef.current?.onsetMsByCanonical.get(canonical) ?? null)
      : null;
    onInspectorChange(
      buildNoteInspector({
        canonicalId: canonical,
        concert: concertFrags,
        written: hornFrags,
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
  /* UI-050: the cursor walks the FULL issue list (resolved issues stay
   *  reachable so their status/decision can be revisited and undone);
   *  markers + pendingCount come from the still-open subset. */

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
      const startSec = issue.timeRange?.startSec;
      if (startSec != null) sourceControl?.seekTo(startSec);
      announce(ja.review.position(i + 1, issues.length));
    },
    [allIssues, selectExportId, sourceControl, announce],
  );

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

  const exitReview = useCallback(() => {
    reviewOpenRef.current = false;
    setReviewOpen(false);
    announce(ja.review.feedback.exited);
  }, [announce]);

  /** Re-parse presentations + re-render after a note edit (pitch/delete):
   *  inspector labels and the playback table both derive from the XML. */
  const reloadEditedScore = useCallback(() => {
    const concert = parseScoreDoc(scoreDoc.musicXml("concert"));
    const horn = parseScoreDoc(scoreDoc.musicXml("hornF"));
    docsRef.current = {
      concert,
      horn,
      concertByCanonical: notesByCanonical(concert),
      hornByCanonical: notesByCanonical(horn),
      concertByExport: notesByExportId(concert),
      hornByExport: notesByExportId(horn),
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
      );
      clockRef.current?.setDuration(tableRef.current.durationMs);
    }
  }, [scoreDoc, renderScore]);

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
    }
  }, [issueAtCursor, session, runReviewEdit, announce]);

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
    }
  }, [issueAtCursor, session, runReviewEdit, announce]);

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
    runReviewEdit(
      session.setNoteDeleted(issue.id, !deleted),
      deleted
        ? ja.review.feedback.noteRestored
        : ja.review.feedback.noteDeleted,
      { reload: true },
    );
  }, [issueAtCursor, session, runReviewEdit]);

  /* #114 (spec 10/13): score-workspace note navigation + direct edits.
   *  Arrow keys walk canonical notes in document order; Alt+arrows /
   *  Delete / E edit the selection through the shared undo stack. */
  const selectAdjacentNote = useCallback(
    (direction: 1 | -1) => {
      const docs = docsRef.current;
      if (!docs) return;
      const canonicals = docs.concert.notes
        .map((n) => n.canonicalId)
        .filter((id): id is string => id != null);
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
      }
    },
    [session, bumpDoc, reportInspector],
  );

  /* #115 (spec 13): engine rhythm edits — duration ladder, onset grid
   *  shift, tie toggle. The engine re-realizes the affected measures
   *  and returns fresh MusicXML + a new revision; the document swaps
   *  its content in place so selection and this undo stack survive
   *  (a remount would lose both). Undo restores the previous snapshot
   *  through the shared ReviewSession stack. */
  const applyRhythmEdit = useCallback(
    (
      buildOp: (canonical: unknown) => RhythmEditOp | null,
      feedback: string,
      after?: () => void,
    ) => {
      if (!onRhythmEdit || !scoreDoc.replaceContent) {
        announce(ja.commandFeedback.rhythmEditUnavailable);
        return;
      }
      // Serialize engine edits: each call must see the newest content.
      rhythmQueueRef.current = rhythmQueueRef.current.then(async () => {
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
        try {
          const result = await onRhythmEdit(canonical, op);
          const next = {
            concertXml: result.musicXmlConcert,
            hornXml: result.musicXmlHornF,
            revisionId: result.scoreRevision,
            canonicalDocument: result.scoreDocument,
          };
          scoreDoc.replaceContent?.(next);
          session.commitDocSwap(prev, next);
          bumpDoc();
          reloadEditedScore();
          reportInspector();
          announce(feedback);
          after?.();
        } catch {
          announce(ja.commandFeedback.rhythmEditFailed);
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

  /* #130 (spec 14): re-quantize the whole score under changed
   * quantization settings — the engine replays the canonical notes
   * through the DP with the merged profile. */
  const requantize = useCallback(
    (settings: Record<string, unknown>) => {
      applyRhythmEdit(
        () => ({ kind: "requantize", noteId: "", settings }),
        ja.commandFeedback.requantized,
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
    announce(ja.review.feedback.undone);
  }, [session, bumpDoc, reloadEditedScore, reportInspector, announce]);

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
    let startSec = issue.timeRange?.startSec;
    let endSec = issue.timeRange?.endSec;
    if (startSec == null || endSec == null) {
      // No explicit range: loop the canonical note's notated span.
      const table = tableRef.current;
      const first = issue.canonicalNoteIds[0];
      const onset = first ? table?.onsetMsByCanonical.get(first) : undefined;
      if (!table || onset == null) return;
      startSec = onset / 1000;
      endSec = nearestOffset(table, onset) / 1000;
    }
    const clock = clockRef.current;
    clock?.setLoop({ startMs: startSec * 1000, endMs: endSec * 1000 });
    if (sourceControl) {
      sourceControl.setLoop({ start: startSec, end: endSec });
      sourceControl.seekTo(startSec);
      sourceControl.play();
    } else {
      clock?.seek(startSec * 1000);
      clock?.play();
    }
    announce(ja.review.feedback.playingSource);
  }, [issueAtCursor, sourceControl, announce]);

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
      togglePlayPause: () => clockRef.current?.togglePlayPause(),
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
        if (c.loopRange()) c.setLoop(null);
        else {
          // No waveform range selection yet (UI-020) — arm the loop over
          // the selected note's span when possible so Ctrl+L is honest.
          const sel = selectionRef.current;
          const table = tableRef.current;
          if (sel?.canonicalId && table) {
            const onset = table.onsetMsByCanonical.get(sel.canonicalId);
            if (onset != null) {
              const next = nearestOffset(table, onset);
              c.setLoop({ startMs: onset, endMs: next });
            }
          } else {
            c.setLoop({ startMs: 0, endMs: c.durationMs() });
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
            ? "楽譜の自動演奏をオンにしました"
            : "楽譜の自動演奏をオフにしました",
        );
      },
      openReview: () => openReview(),
      reviewNext: () => gotoIssue(reviewIndexRef.current + 1),
      reviewPrevious: () => gotoIssue(reviewIndexRef.current - 1),
      reviewAccept: () => reviewAccept(),
      reviewDismiss: () => reviewDismiss(),
      reviewPlaySource: () => playSource(),
      reviewPitch: (delta) => reviewPitch(delta),
      reviewDeleteOrRestore: () => reviewDeleteOrRestore(),
      exitReview: () => exitReview(),
      undo: () => reviewUndo(),
      redo: () => reviewRedo(),
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
      setKey: (fifths, mode) => setKey(fifths, mode),
      keyChangeAt: (args) => keyChangeAt(args),
      removeKeyChange: (m) => removeKeyChange(m),
      setMetadata: (md) => setMetadata(md),
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
    gotoIssue,
    reviewAccept,
    reviewDismiss,
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
    setKey,
    keyChangeAt,
    removeKeyChange,
    setMetadata,
    requantize,
    splitSelectedNote,
    mergeSelectedNotes,
    convertSelectedRest,
    announce,
  ]);

  /* --------------------------- state mirror ------------------------------ */

  useEffect(() => {
    onStateChange?.({
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
      zoomPct: zoom,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      openIssueCount: pendingCount,
      auditionEnabled,
    });
  }, [
    selection,
    clockSnap,
    followEnabled,
    followSuspended,
    reviewOpen,
    zoom,
    onStateChange,
    session,
    pendingCount,
    docVersion,
    auditionEnabled,
  ]);

  // Initial inspector = score summary (§22 "Nothing selected").
  useEffect(() => {
    if (!loading) reportInspector();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  /* ------------------------------- render -------------------------------- */

  const visiblePages =
    viewMode === "page" ? pages.filter((p) => p.page === currentPage) : pages;
  const s = ja.scoreView;

  if (initError) {
    return (
      <div className="hs-score-error" role="alert">
        <h2>{s.renderErrorTitle}</h2>
        <p>{initError}</p>
      </div>
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
        {viewMode === "page" && pages.length > 1 && (
          <span className="hs-score-toolbar__pages">
            <HsButton
              size="small"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
            >
              {s.prevPage}
            </HsButton>
            <span aria-live="polite">
              {s.pagePosition(currentPage, pages.length)}
            </span>
            <HsButton
              size="small"
              onClick={() =>
                setCurrentPage((p) => Math.min(pages.length, p + 1))
              }
              disabled={currentPage >= pages.length}
            >
              {s.nextPage}
            </HsButton>
          </span>
        )}
        {pitch === "hornF" && (
          <span className="hs-score-toolbar__caption">
            {ja.pitch.hornF}（{ja.pitch.writtenNote}）
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
          actionLabel={(() => {
            const issue = allIssues[reviewIndex];
            if (!issue) return null;
            if (
              issue.evidence["suggestVoicesTexture"] === true &&
              onRetranscribeVoices
            ) {
              return ja.review.retranscribeVoices;
            }
            // #176: spelling issues resolve with the enharmonic toggle,
            // not the pitch +/- buttons (those change sounding pitch).
            if (issue.reason === "pitch_spelling_ambiguous") {
              return ja.commands.noteEnharmonic;
            }
            // #181: the monophonic-backend issue resolves by
            // re-running with the polyphonic-capable backend.
            if (
              issue.reason === "monophonic_backend" &&
              issue.evidence["suggestBasicPitch"] === true &&
              onRetranscribeBasicPitch
            ) {
              return ja.review.retranscribeBasicPitch;
            }
            // #188: the tempo-uncertain issue resolves by applying
            // the suggested correction as a scaleTempo edit — the
            // note values must rescale with the BPM (#198).
            if (
              issue.reason === "tempo_uncertain" &&
              typeof issue.evidence["suggestedBpm"] === "number"
            ) {
              return ja.review.applyTempoSuggestion(
                issue.evidence["suggestedBpm"] as number,
              );
            }
            // #209: the meter-conflict issue cannot auto-resolve —
            // the remedy is the meter select in the properties
            // panel, so the action opens it.
            if (issue.reason === "meter_conflict" && onOpenProperties) {
              return ja.review.openMeterEditor;
            }
            // #208: the ambiguous-quantization issue carries the
            // runner-up spans — the action swaps them in.
            if (
              issue.reason === "quantization_ambiguous" &&
              Array.isArray(issue.evidence["alternativeNotes"])
            ) {
              return ja.review.applyAlternative;
            }
            // #212: the possible-triplet issue carries the region
            // start — the action rewrites that beat as triplets.
            if (
              issue.reason === "possible_triplet" &&
              typeof issue.evidence["beatStartBeats"] === "string"
            ) {
              return ja.review.applyTriplet;
            }
            return null;
          })()}
          onAction={(() => {
            const issue = allIssues[reviewIndex];
            if (!issue) return undefined;
            if (issue.evidence["suggestVoicesTexture"] === true) {
              return onRetranscribeVoices ?? undefined;
            }
            if (issue.reason === "pitch_spelling_ambiguous") {
              // #204: resolving the spelling marks the issue fixed —
              // the toggle alone left it open and confusing.
              return () => {
                if (toggleSelectedEnharmonic()) {
                  markIssueFixed(issue.id);
                }
              };
            }
            if (
              issue.reason === "monophonic_backend" &&
              issue.evidence["suggestBasicPitch"] === true
            ) {
              return onRetranscribeBasicPitch ?? undefined;
            }
            if (
              issue.reason === "tempo_uncertain" &&
              typeof issue.evidence["suggestedBpm"] === "number"
            ) {
              // #198: scaleTempo, not setTempo — the engine doubles/
              // halves note values with the tempo so playback seconds
              // stay invariant. Direction evidence says which way.
              const factor = issue.evidence["direction"] === "halve" ? 0.5 : 2;
              // #204: applyRhythmEdit's after-hook marks the issue
              // fixed only when the engine edit actually landed.
              return () => {
                applyRhythmEdit(
                  () => ({ kind: "scaleTempo", noteId: "", factor }),
                  ja.commandFeedback.tempoChanged,
                  () => markIssueFixed(issue.id),
                );
              };
            }
            if (issue.reason === "meter_conflict") {
              return onOpenProperties ?? undefined;
            }
            if (
              issue.reason === "quantization_ambiguous" &&
              Array.isArray(issue.evidence["alternativeNotes"])
            ) {
              // #208: swap in the runner-up spans the engine embedded
              // in the issue evidence; marks fixed on success.
              const alt = issue.evidence["alternativeNotes"] as {
                id: string;
                startBeat: string;
                durationBeats: string;
              }[];
              return () => {
                applyRhythmEdit(
                  () => ({ kind: "applyAlternative", noteId: "", notes: alt }),
                  ja.commandFeedback.rhythmEdited,
                  () => markIssueFixed(issue.id),
                );
              };
            }
            if (
              issue.reason === "possible_triplet" &&
              typeof issue.evidence["beatStartBeats"] === "string"
            ) {
              const startBeat = issue.evidence["beatStartBeats"] as string;
              return () => {
                applyRhythmEdit(
                  () => ({ kind: "applyTriplet", noteId: "", startBeat }),
                  ja.commandFeedback.rhythmEdited,
                  () => markIssueFixed(issue.id),
                );
              };
            }
            return undefined;
          })()}
          onPrev={() => gotoIssue(reviewIndexRef.current - 1)}
          onNext={() => gotoIssue(reviewIndexRef.current + 1)}
          onPlaySource={playSource}
          onAccept={reviewAccept}
          onDismiss={reviewDismiss}
          onPitch={reviewPitch}
          onDeleteOrRestore={reviewDeleteOrRestore}
          onUndo={reviewUndo}
          onRedo={reviewRedo}
          onExit={exitReview}
        />
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
function nearestOffset(table: PlaybackTable, onsetMs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const t of table.onsetMsByCanonical.values()) {
    if (t > onsetMs && t < best) best = t;
  }
  return Number.isFinite(best) ? best : table.durationMs;
}
