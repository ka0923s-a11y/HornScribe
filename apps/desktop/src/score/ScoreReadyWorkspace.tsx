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
  buildPlaybackTable,
  canonicalsInRange,
  segmentAt,
  type PlaybackTable,
} from "./playbackTable";
import { ScoreCursorClock, type ClockSnapshot, type TransportClock } from "./clock";
import {
  issuesForCanonical,
  markedCanonicalIds,
  openIssues,
} from "./review";
import {
  buildNoteInspector,
  buildScoreInspector,
  keyLabelJa,
  type InspectorCopy,
  type InspectorModel,
} from "./inspector";
import type { ScoreWorkspaceController, ScoreWorkspaceState } from "./controller";
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
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Inspector copy — bound to ja.ts so Japanese text stays in one place. */
function inspectorCopy(): InspectorCopy {
  const j = ja.inspector;
  return {
    review: {
      // `?? other`: engine reason codes may be newer than this UI's copy
      // deck — the issue stays visible with generic copy (sidecar/review.ts
      // uses the same fallback policy).
      reasonTitle: (r) =>
        (ja.reviewReasons[r] ?? ja.reviewReasons.other).title,
      reasonDetail: (r) =>
        (ja.reviewReasons[r] ?? ja.reviewReasons.other).detail,
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
    key: (fifths) => j.keyLabel(keyLabelJa(fifths)),
  };
}

export function ScoreReadyWorkspace({
  document: scoreDoc,
  pitch,
  onInspectorChange,
  onStateChange,
  controllerRef,
  announce,
  transport,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ScoreRenderer | null>(null);
  const indexRef = useRef<ElementIndex | null>(null);
  const clockRef = useRef<TransportClock | null>(null);
  const tableRef = useRef<PlaybackTable | null>(null);

  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [viewMode, setViewMode] = useState<ScoreViewMode>("continuous");
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [renderError, setRenderError] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [followEnabled, setFollowEnabled] = useState(true);
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
  const zoomRef = useRef(100);
  const viewModeRef = useRef<ScoreViewMode>("continuous");
  const currentPageRef = useRef(1);
  const pitchRef = useRef(pitch);
  /** The presentation actually loaded into Verovio — compared against the
   *  `pitch` prop to detect a real view switch (the prop ref alone is
   *  updated every render and would mask the change). */
  const renderedPitchRef = useRef<PitchViewSetting | null>(null);
  const reviewIndexRef = useRef(0);
  const reviewOpenRef = useRef(false);
  const pendingScrollRef = useRef<{ ratio: number } | null>(null);
  const openReviewIssues = useMemo(
    () => openIssues(scoreDoc.reviewIssues()),
    [scoreDoc],
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

  const scrollCanonicalIntoView = useCallback((canonicals: ReadonlySet<string>) => {
    const idx = indexRef.current;
    if (!idx || canonicals.size === 0) return;
    const table = tableRef.current;
    let target: Element | null = null;
    if (table) {
      // Earliest onset leads the scroll target.
      let best = Number.POSITIVE_INFINITY;
      for (const id of canonicals) {
        const onset = table.onsetMsByCanonical.get(id) ?? Number.POSITIVE_INFINITY;
        if (onset < best) {
          best = onset;
          target = idx.byCanonical.get(id)?.[0] ?? null;
        }
      }
    }
    target ??= idx.byCanonical.get([...canonicals][0])?.[0] ?? null;
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  /* ------------------------------ rendering ------------------------------ */

  /** (Re)load + re-render the current presentation. Preserves the viewport
   *  ratio so the Concert↔F管 switch keeps an equivalent scroll position. */
  const renderScore = useCallback(
    (view: PitchViewSetting, opts: { keepScroll?: boolean } = {}) => {
      const r = rendererRef.current;
      const container = scrollRef.current;
      if (!r) return;
      if (opts.keepScroll && container) {
        const denom = Math.max(1, container.scrollHeight - container.clientHeight);
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
      indexRef.current.byExportId.get(sel.exportId)?.classList.add(SELECTED_CLASS);
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
    if (viewModeRef.current === "page" && currentPageRef.current > pages.length) {
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
      const denom = Math.max(1, container.scrollHeight - container.clientHeight);
      container.scrollTop = pending.ratio * denom;
    }
    // viewMode/currentPage swap the rendered DOM in page mode — the element
    // index must be rebuilt or marks would land on detached nodes.
  }, [pages, scoreDoc, viewMode, currentPage]);

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
        tableRef.current = buildPlaybackTable(r.timemap());
        const clock = new ScoreCursorClock(tableRef.current.durationMs);
        clockRef.current = clock;
        clock.subscribe(setClockSnap);
      })
      .catch((e: unknown) =>
        setInitError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
      clockRef.current?.dispose();
      clockRef.current = null;
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
    const set = loop ? canonicalsInRange(table, loop.startMs, loop.endMs) : new Set<string>();
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
      onInspectorChange(
        buildScoreInspector(scoreDoc.meta, openReviewIssues.length, copy),
      );
      return;
    }
    const canonical = sel.canonicalId;
    const concertFrags = canonical
      ? (docs.concertByCanonical.get(canonical) ?? [])
      : [docs.concertByExport.get(sel.exportId) ?? docs.hornByExport.get(sel.exportId)]
          .filter((n): n is ParsedNote => n != null);
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
        issues: canonical ? issuesForCanonical(scoreDoc.reviewIssues(), canonical) : [],
        copy,
      }),
    );
  }, [scoreDoc, openReviewIssues.length, copy, onInspectorChange]);

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
    if (!followRef.current || suspendedRef.current || !clockRef.current?.isPlaying()) {
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
  }, [pitch, renderScore]);

  const changeZoom = useCallback(
    (pct: number) => {
      const next = clampScoreZoom(pct);
      if (next === zoomRef.current) return;
      zoomRef.current = next;
      setZoom(next);
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
    const target = Math.floor((container.clientWidth - 32) * (zoomRef.current / width));
    changeZoom(target);
  }, [changeZoom]);

  const changeViewMode = useCallback(
    (mode: ScoreViewMode) => {
      if (mode === viewModeRef.current) return;
      viewModeRef.current = mode;
      setViewMode(mode);
      renderScore(pitchRef.current, { keepScroll: true });
    },
    [renderScore],
  );

  /* ------------------------------ review --------------------------------- */

  const gotoIssue = useCallback(
    (index: number) => {
      const issues = openReviewIssues;
      if (issues.length === 0) return;
      const i = ((index % issues.length) + issues.length) % issues.length;
      reviewIndexRef.current = i;
      setReviewIndex(i);
      const canonicalId = issues[i].canonicalNoteIds[0];
      const table = tableRef.current;
      const exportId = table?.exportIdsByCanonical.get(canonicalId)?.[0];
      if (exportId) selectExportId(exportId, { scroll: true });
      announce(ja.scoreView.reviewPosition(i + 1, issues.length));
    },
    [openReviewIssues, selectExportId, announce],
  );

  const openReview = useCallback(() => {
    if (openReviewIssues.length === 0) return;
    setReviewOpen(true);
    gotoIssue(0);
  }, [openReviewIssues.length, gotoIssue]);

  const exitReview = useCallback(() => {
    setReviewOpen(false);
  }, []);

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
      openReview: () => openReview(),
      reviewNext: () => gotoIssue(reviewIndexRef.current + 1),
      reviewPrevious: () => gotoIssue(reviewIndexRef.current - 1),
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
  ]);



  /* --------------------------- state mirror ------------------------------ */

  useEffect(() => {
    onStateChange?.({
      hasSelection: selection !== null,
      isPlaying: clockSnap.isPlaying,
      loopEnabled: clockSnap.loop !== null,
      positionMs: clockSnap.positionMs,
      durationMs: clockSnap.durationMs,
      followEnabled,
      followSuspended,
      reviewOpen,
      zoomPct: zoom,
    });
  }, [
    selection,
    clockSnap,
    followEnabled,
    followSuspended,
    reviewOpen,
    zoom,
    onStateChange,
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
      <div className="hs-score-toolbar" role="toolbar" aria-label={s.regionLabel}>
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
            <span aria-live="polite">{s.pagePosition(currentPage, pages.length)}</span>
            <HsButton
              size="small"
              onClick={() => setCurrentPage((p) => Math.min(pages.length, p + 1))}
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
        <HsButton size="small" onClick={() => changeZoom(zoom - SCORE_ZOOM_STEP_PCT)}>
          {s.zoomOut}
        </HsButton>
        <span className="hs-score-toolbar__zoom" aria-live="polite" aria-label={s.zoomLabel}>
          {zoom}%
        </span>
        <HsButton size="small" onClick={() => changeZoom(zoom + SCORE_ZOOM_STEP_PCT)}>
          {s.zoomIn}
        </HsButton>
        <HsButton size="small" onClick={zoomFit}>
          {s.zoomFit}
        </HsButton>
      </div>

      {reviewOpen && (
        <div className="hs-score-reviewbar" role="group" aria-label={ja.commandBar.review}>
          <strong aria-live="polite">
            {s.reviewPosition(reviewIndex + 1, openReviewIssues.length)}
          </strong>
          <HsButton size="small" onClick={() => gotoIssue(reviewIndexRef.current - 1)}>
            {ja.common.prev}
          </HsButton>
          <HsButton size="small" onClick={() => gotoIssue(reviewIndexRef.current + 1)}>
            {ja.common.next}
          </HsButton>
          <HsButton size="small" onClick={exitReview}>
            {s.reviewExit}
          </HsButton>
        </div>
      )}

      {loading && <div className="hs-score-loading">{s.loading}</div>}
      {renderError && (
        <div className="hs-score-error" role="alert">
          <h2>{s.renderErrorTitle}</h2>
          <p>{s.renderErrorBody}</p>
          <HsButton onClick={() => renderScore(pitchRef.current)}>{ja.common.retry}</HsButton>
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
