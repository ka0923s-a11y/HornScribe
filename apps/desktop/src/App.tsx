import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FluentProvider } from "@fluentui/react-components";
import { ja } from "./strings/ja";
import { hsLightTheme, hsDarkTheme } from "./theme/fluentTheme";
import { useThemeMode } from "./theme/useThemeMode";
import { AppShell } from "./components/AppShell";
import { TitleBar } from "./components/TitleBar";
import { CommandBar } from "./components/CommandBar";
import { WaveformView } from "./components/WaveformView";
import { ScoreWorkspace } from "./components/ScoreWorkspace";
import { PropertiesPanel } from "./components/PropertiesPanel";
import {
  RequantizeDialog,
  requantizeSeed,
} from "./components/RequantizeDialog";
import { TransportBar } from "./components/TransportBar";
import { StatusBar } from "./components/StatusBar";
import { SettingsView } from "./components/SettingsView";
import { TranscriptionView } from "./components/TranscriptionView";
import { TranscriptionErrorView } from "./components/TranscriptionErrorView";
import { ExportDialog } from "./export/ExportDialog";
import { DiagnosticsSheet } from "./diagnostics/DiagnosticsSheet";
import { createDefaultExportPort } from "./export/port";
import type { ExportSource } from "./export/tauriPort";
import { exportErrorCode } from "./export/types";
import { createDefaultDiagnosticsPort } from "./diagnostics/port";
import { useAppSettings, type SettingsCategory } from "./settings/store";
import type { PitchView } from "./components/PitchSegmented";
import { createFixtureScoreDocument } from "./score/fixtureDocument";
import { scoreHandoffFromResult } from "./score/jobResult";
import {
  createEngineScoreDocument,
  engineDocumentFromResult,
} from "./score/xmlDocument";
import type { ScoreDocumentPort } from "./score/document";
import type { InspectorModel } from "./score/inspector";
import type { RhythmEditInvoker } from "./score/rhythmEdits";
import type {
  ScoreWorkspaceController,
  ScoreWorkspaceState,
} from "./score/controller";
import { openIssues } from "./score/review";
import { formatTimecode as formatScoreTimecode } from "./score/timecode";
import {
  createCommandRegistry,
  createCommandSurface,
  type CommandContext,
  type CommandSnapshot,
} from "./commands/registry";
import { KeyboardDispatcher } from "./keyboard/dispatcher";
import { useCommandKeyboard } from "./keyboard/useCommandKeyboard";
import { cycleFocusZone, focusZone } from "./focus/zones";
import { getShellInfo, isTauriRuntime } from "./tauri/bridge";
import {
  ImportController,
  parseProjectFile,
  type ImportState,
} from "./import/controller";
import { INITIAL_IMPORT_STATE } from "./import/controller";
import {
  loadRecentProjects,
  recordRecentProject,
} from "./import/recentProjects";
import { createImportPorts } from "./import/runtimePorts";
import { issueCopy, type ImportView } from "./import/ImportStates";
import { listenNativeDrop } from "./import/nativeDrop";
import { invoke } from "@tauri-apps/api/core";
import { buildProjectDocument } from "./import/project";
import { baseName } from "./import/formats";
import { CaptureController, type CaptureState } from "./capture/controller";
import {
  collectReferencedRecordingNames,
  copyRecordingToManaged,
  getRecordingsInfo,
  getSourceRefIndex,
  pruneRecordings,
  recordingNameUnder,
  sourceRefCountUnder,
  updateSourceRef,
} from "./capture/recordings";
import { createCapturePort } from "./capture/runtimePorts";
import type { CaptureDeviceList, CaptureSource } from "./capture/types";
import {
  MediaElementTransport,
  SUPPORTED_RATES,
  type TransportSnapshot,
} from "./import/mediaTransport";
import {
  DEFAULT_TRANSCRIPTION_OPTIONS,
  type AudioFileRef,
  type TranscriptionOptions,
  type LoadedAudio,
} from "./import/types";
import {
  buildTranscriptionParams,
  transcriptionOptionsFromSettings,
} from "./import/transcriptionParams";
import { stageAudioForEngine } from "./import/staging";
import { formatTimecode } from "./import/format";
import { HsButton } from "./components/primitives/Button";
import { HsDialog } from "./components/primitives/Dialog";
import {
  regionVisibility,
  commandStateFor,
  SCREEN_STATES,
  type ScreenState,
} from "./workspace/screen";
import {
  TranscriptionSession,
  createDefaultSidecarPort,
  type EngineStatus,
} from "./sidecar";
import {
  inspectorHasContent,
  NO_SELECTION,
  type InspectorContent,
} from "./workspace/inspector";
import { useWorkspaceLayout } from "./workspace/layout";
import { initWindowGeometryPersistence } from "./workspace/windowGeometry";

type View = "workspace" | "settings";

/** "#/dev/gallery" — dev-only internal component gallery (UI-010). */
const GALLERY_HASH = "#/dev/gallery";
/** "#/dev/state/<screen>" — dev-only screen-state override so the
 *  responsive layout can be verified in every machine state (§27) before
 *  the real audio/score features land. No-op in packaged builds. */
const STATE_HASH_PREFIX = "#/dev/state/";
/**
 * "#/dev/transcribing" — dev-only entry that starts the shell in
 * AUDIO_READY and auto-invokes `score.transcribe` once mounted, so the
 * real UI-040 job flow (mock engine) runs end to end before UI-020's
 * file-open wiring lands. Unlike "#/dev/state/transcribing" (a static
 * layout preview) this runs an actual job.
 */
const DEV_TRANSCRIBING_HASH = "#/dev/transcribing";
// Lazy so the gallery (and its Fluent imports) stay out of the prod bundle.
const DevGallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery"))
  : null;

function screenFromHash(hash: string): ScreenState | null {
  if (!import.meta.env.DEV || !hash.startsWith(STATE_HASH_PREFIX)) return null;
  const name = hash.slice(STATE_HASH_PREFIX.length);
  return (SCREEN_STATES as readonly string[]).includes(name)
    ? (name as ScreenState)
    : null;
}

/** #234: content-derived audio identity for score ownership — the
 *  import-time SHA-256 when known, else the durable path, else a
 *  name+size fallback for browser-dev File refs. A score only ever
 *  belongs to the source identity that produced it. */
function audioIdentityOf(audio: LoadedAudio | null): string | null {
  if (!audio) return null;
  const ref = audio.ref;
  const hash = "contentHash" in ref && ref.contentHash ? ref.contentHash : null;
  if (hash) return `hash:${hash}`;
  if (ref.kind === "path") return `path:${ref.path}`;
  if (ref.kind === "recording" && ref.path) return `path:${ref.path}`;
  return `mem:${audio.fileName}:${audio.sizeBytes}`;
}

/** Japanese display name for a focus zone (for status announcements). */
function zoneName(id: string): string {
  const names: Record<string, string> = ja.commandFeedback.zoneNames;
  return names[id] ?? id;
}

/** Engine connection line for the status bar (解析エンジン: …). */
function engineStatusText(engine: EngineStatus): string {
  switch (engine) {
    case "ready":
      return ja.status.engineReady;
    case "starting":
      return ja.status.engineStarting;
    case "crashed":
      return ja.status.engineCrashed;
    case "unresponsive":
      return ja.status.engineUnresponsive;
    default:
      return ja.status.engineNotConnected;
  }
}

/**
 * HornScribe workspace shell (UI-011) driven by the UI-012 command
 * architecture (GUI_UX_SPEC §2/§21/§22/§23/§27). Information architecture:
 * single workspace, score is primary, properties collapse before the score
 * narrows, command overflow instead of horizontal scrolling, layout state
 * restored across restarts.
 *
 * The screen-state machine (§27) feeds the CommandSnapshot, so every
 * surface — command bar, transport, keyboard — agrees on enablement:
 * EMPTY mounts only 開く-level shell actions; 採譜 needs audio and is
 * disabled while transcribing; 要確認/書き出し need a score.
 */
export default function App() {
  const { mode, resolved, select } = useThemeMode();
  const [view, setView] = useState<View>("workspace");
  const [pitch, setPitch] = useState<PitchView>("concert");
  // UI-060: persisted settings (localStorage) + the two secondary surfaces
  // (書き出し dialog / 診断情報 sheet) that live outside the workspace.
  const { settings, update: updateSettings } = useAppSettings();
  const [exportOpen, setExportOpen] = useState(false);
  const [requantizeOpen, setRequantizeOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<
    SettingsCategory | undefined
  >(undefined);
  // Ports are runtime-gated (mock in a browser, explicit-failure in the
  // Tauri shell until the engine spawn bridge lands — see export/port.ts).
  // #99: the Tauri port reads the live score document + audio name at
  // export time through this ref (state lives below; the port is
  // created once, so a ref keeps the getter fresh).
  const exportSourceRef = useRef<ExportSource | null>(null);
  // The session is created once per App mount; the default port is the
  // mock outside Tauri and the gated port inside (src/sidecar/README.md).
  const session = useMemo(
    () => new TranscriptionSession({ portFactory: createDefaultSidecarPort }),
    [],
  );
  const exportPort = useMemo(
    // #256: playback MIDI goes through the engine's canonical exporter
    // (velocity / bends / swing / tempo map); the port falls back to
    // the client-side build when the document has no canonical payload.
    () =>
      createDefaultExportPort(
        () => exportSourceRef.current,
        (doc) => session.exportMidi(doc).then((r) => r.midiBase64),
      ),
    [session],
  );
  const diagnosticsPort = useMemo(() => createDefaultDiagnosticsPort(), []);
  // User-specified tool paths (設定 → ツール) flow into every probe.
  const toolOverrides = useMemo(
    () => ({
      museScorePath: settings.museScorePath || undefined,
      ffmpegPath: settings.ffmpegPath || undefined,
    }),
    [settings.museScorePath, settings.ffmpegPath],
  );
  const [statusMessage, setStatusMessage] = useState<string>(ja.status.ready);
  const [shellDetail, setShellDetail] = useState<string | undefined>(
    ja.status.shellInfoLoading,
  );
  const [hash, setHash] = useState(() => window.location.hash);
  // Screen state machine (§27). The import flow (UI-020) drives
  // empty/openingAudio/audioReady/audioError/sourceMissing; the sidecar
  // session (UI-040) drives transcribing/transcriptionError/scoreReady.
  // Dev builds can override via "#/dev/state/<name>" or auto-start a real
  // job via "#/dev/transcribing".
  const [screen, setScreen] = useState<ScreenState>(() =>
    import.meta.env.DEV && window.location.hash === DEV_TRANSCRIBING_HASH
      ? "audioReady"
      : "empty",
  );
  // Event handlers outside React render (native drop listener) read
  // the screen through a ref — the listener is subscribed once.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  // A canonical score exists — survives failed/cancelled retranscription
  // (issue rule: partial failure never destroys valid state).
  const [hasScore, setHasScore] = useState(false);
  const [engineRestarting, setEngineRestarting] = useState(false);
  const layout = useWorkspaceLayout();

  const [sessionSnap, setSessionSnap] = useState(() => session.getSnapshot());

  useEffect(() => {
    const unsub = session.subscribe(setSessionSnap);
    return () => {
      unsub();
      // App shutdown → graceful engine.shutdown (bounded, never throws).
      void session.dispose();
    };
  }, [session]);

  const job = sessionSnap.job;
  const jobPhase = job?.phase;

  // [UI-030] the document behind SCORE_READY+: built once a transcription
  // completes — identity + review issues come from the job result
  // (score/jobResult.ts); the notation body stays on the committed fixture
  // until the engine ships MusicXML through the same port.
  const [scoreDocument, setScoreDocument] = useState<ScoreDocumentPort | null>(
    null,
  );
  // #234/#240: the score belongs to a specific source identity and a
  // specific successful result — tracked separately from both the
  // in-flight job and the audio slot so a source switch or a failed
  // re-transcription can never mix score A with audio B.
  const scoreAudioIdentityRef = useRef<string | null>(null);
  const jobAudioIdentityRef = useRef<string | null>(null);
  const audioIdentityRef = useRef<string | null>(null);
  const [scoreProvenance, setScoreProvenance] = useState<unknown | null>(null);
  const projectIdRef = useRef<string | null>(null);
  /** #265: the opened project's recorded source ref — kept separately
   *  from importState.audio so a SOURCE_MISSING save preserves the
   *  originalPath/contentHash a later relink verifies against. */
  const projectSourceRef = useRef<{
    originalPath: string;
    contentHash: string;
  } | null>(null);
  const [inspectorModel, setInspectorModel] = useState<InspectorModel>({
    kind: "empty",
  });
  const [scoreState, setScoreState] = useState<ScoreWorkspaceState | null>(
    null,
  );
  const scoreCtlRef = useRef<ScoreWorkspaceController | null>(null);

  // §27 transitions driven by the job lifecycle. Terminal phases are
  // consumed once (session.clearJob) — retry is never silent.
  useEffect(() => {
    if (!jobPhase) return;
    if (jobPhase === "completed") {
      setHasScore(true);
      // ENG-002: a real engine result carries MusicXML — build the
      // document from it. The mock/dev result carries none, so the
      // deterministic fixture stays the honest fallback there.
      const engineInput = engineDocumentFromResult(sessionSnap.lastResult);
      const handoff = scoreHandoffFromResult(sessionSnap.lastResult);
      const engineDoc =
        engineInput !== null
          ? createEngineScoreDocument({
              ...engineInput,
              issues: handoff?.issues ?? [],
            })
          : null;
      // #234: a stale job result (its source was replaced while it
      // ran) must not land — the score belongs to the audio that
      // started the job, not whatever is loaded now.
      if (
        jobAudioIdentityRef.current != null &&
        jobAudioIdentityRef.current !== audioIdentityRef.current
      ) {
        session.clearJob();
        return;
      }
      const doc = engineDoc ?? createFixtureScoreDocument(handoff);
      setScoreDocument(doc);
      // #240: the completed result is this score's provenance —
      // kept across later job starts so a failed/cancelled
      // re-transcription never loses the transcription record.
      setScoreProvenance(sessionSnap.lastResult);
      scoreAudioIdentityRef.current =
        jobAudioIdentityRef.current ?? audioIdentityRef.current;
      setScreen("scoreReady");
      setStatusMessage(ja.transcription.completed);
      session.clearJob();
    } else if (jobPhase === "cancelled") {
      setScreen(hasScore ? "scoreReady" : "audioReady");
      setStatusMessage(ja.transcription.cancelled);
      session.clearJob();
    }
    // `failed` also sets snap.failure — the screen mapping lives on the
    // failure flag below so crash/unresponsive land identically.
  }, [jobPhase, hasScore, session, sessionSnap.lastResult]);

  // §27: fail → TRANSCRIPTION_ERROR. Set by a terminal `failed` event
  // (job error) or by crash/unresponsive supervision while a job ran.
  useEffect(() => {
    if (sessionSnap.failure) setScreen("transcriptionError");
  }, [sessionSnap.failure]);

  /* ---- UI-020 import flow ---- */
  // The transport adapter (UI-004 contract) is created once per app; the
  // import controller feeds it decoded media sources on AUDIO_READY.
  const transport = useMemo(() => new MediaElementTransport(), []);
  const [transportSnap, setTransportSnap] = useState<TransportSnapshot | null>(
    null,
  );
  const [importState, setImportState] =
    useState<ImportState>(INITIAL_IMPORT_STATE);
  const [recentProjects, setRecentProjects] = useState(() =>
    loadRecentProjects(),
  );
  const [nativeDrag, setNativeDrag] = useState(false);
  const [transcriptionOptions, setTranscriptionOptions] =
    useState<TranscriptionOptions>(DEFAULT_TRANSCRIPTION_OPTIONS);
  // #264: a project open carries its saved transcription.settings —
  // the audio-slot reset below must prefer them over global defaults
  // so 採譜し直す reproduces the project's own conditions. Keyed by
  // the audio identity so a stale project can't leak into a new file.
  const projectOptionsRef = useRef<{
    identity: string | null;
    options: TranscriptionOptions;
  } | null>(null);
  // 設定→採譜は採譜オプションの既定値: 新しい音源を開くたびに
  // 設定値でリセットする(表示だけの死んだ設定にしない)。
  // #227: settings 全体は ref で読む — 依存に入れるとテーマや
  // 再生速度の変更でも採譜オプションが初期化されてしまう。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!importState.audio) return;
    const s = settingsRef.current;
    // #264: opening a project restores its saved transcription
    // settings (provenance) instead of the global defaults — the
    // identity key keeps a stale entry from leaking into a new file.
    const projectEntry = projectOptionsRef.current;
    if (
      projectEntry &&
      projectEntry.identity === audioIdentityOf(importState.audio)
    ) {
      setTranscriptionOptions(projectEntry.options);
      projectOptionsRef.current = null;
      return;
    }
    setTranscriptionOptions({
      ...DEFAULT_TRANSCRIPTION_OPTIONS,
      tempo: s.tempoMode,
      tempoBpm: s.tempoMode === "manual" ? s.bpm : null,
      meter: s.meter,
      minDuration: { eighth: "8", sixteenth: "16", thirtySecond: "32" }[
        s.minDuration
      ],
      // 「三連符を使う」off は候補を生成しない none。on は既定の
      // region-gated 自動判定(auto)に任せる — always だと全拍に
      // 三連符候補が乗り既定挙動が変わるため。
      triplets: s.triplets ? "auto" : "none",
      // #189: the per-job engine pin defaults to the global selector.
      backend: s.backend,
    });
  }, [importState.audio]);

  // #219: when the audio slot empties (SOURCE_MISSING, dismissed
  // error) the transport must release the previous source — a
  // restored score must not keep playing the old file's bytes.
  useEffect(() => {
    if (importState.audio == null) transport.unload();
  }, [importState.audio, transport]);

  // #99: keep the export port's source getter current — the doc plus a
  // basename derived from the loaded audio's file name (extension
  // stripped), matching the ENG-001 `<basename>_<artifact>` policy.
  useEffect(() => {
    const fileName = importState.audio?.fileName ?? "";
    const stem = fileName.replace(/\.[^.]*$/, "");
    // #87: path-backed refs can be bundled into the export; in-browser
    // bytes (kind:"file" drops, pathless recordings) cannot be copied.
    const ref = importState.audio?.ref;
    const audioPath =
      ref?.kind === "path"
        ? ref.path
        : ref?.kind === "recording"
          ? (ref.path ?? null)
          : null;
    exportSourceRef.current = scoreDocument
      ? {
          doc: scoreDocument,
          basename: stem || scoreDocument.meta.title,
          audioPath,
          audioName: audioPath ? fileName || null : null,
        }
      : null;
  }, [scoreDocument, importState.audio]);

  // FEAT-001 (#60): capture session state (loopback / microphone).
  const [captureState, setCaptureState] = useState<CaptureState | null>(null);
  // #76: 録音開始前の「現在の音源を置き換える」確認ダイアログ。
  const [pendingCapture, setPendingCapture] = useState<CaptureSource | null>(
    null,
  );
  // #73: 取り込みデバイス選択(capture_devices の結果)。
  const [captureDevices, setCaptureDevices] =
    useState<CaptureDeviceList | null>(null);

  const importer = useMemo(
    () =>
      new ImportController(
        createImportPorts(),
        {
          onScreenChange: (s) => setScreen(s),
          onState: (s) => setImportState(s),
          onRecentChange: (entries) => setRecentProjects([...entries]),
          announce: setStatusMessage,
          onAudioReady: (audio) => {
            // Fire-and-forget: a media failure flips the transport
            // snapshot to "error" — the status line already carries
            // the outcome.
            void transport.load(audio.mediaSource).catch(() => undefined);
            // #234: the audio slot changed owners — a score that
            // belongs to a different source identity is no longer
            // current (a verified relink keeps the same hash and
            // survives; a genuinely different file invalidates).
            const identity = audioIdentityOf(audio);
            audioIdentityRef.current = identity;
            if (
              scoreAudioIdentityRef.current != null &&
              (scoreAudioIdentityRef.current === "?" ||
                identity !== scoreAudioIdentityRef.current)
            ) {
              setHasScore(false);
              setScoreDocument(null);
              setScoreProvenance(null);
              projectIdRef.current = null;
              projectSourceRef.current = null;
              scoreAudioIdentityRef.current = null;
            }
          },
          onProjectScoreReady: (result, project) => {
            // #106: the saved extras mirror the completed-job result —
            // rebuild the document and land on SCORE_READY without
            // re-transcribing. Malformed extras fall back to the
            // fixture document only in dev; with a real result null
            // means no usable MusicXML, so keep the audio-only state.
            const input = engineDocumentFromResult(result);
            if (!input) return;
            const handoff = scoreHandoffFromResult(result);
            const doc = createEngineScoreDocument({
              ...input,
              issues: handoff?.issues ?? [],
            });
            if (!doc) return;
            setHasScore(true);
            setScoreDocument(doc);
            // #219: land on the score even when the source is
            // missing — the SOURCE_MISSING banner below carries the
            // relink action while score-only operations stay usable.
            // #240/#222: the saved result is this score's provenance
            // and the project's identity — both ride along so a
            // re-save keeps the transcription record and prj- id.
            setScoreProvenance(result);
            projectIdRef.current = project.projectId;
            projectSourceRef.current =
              project.sourcePath && project.sourceHash
                ? {
                    originalPath: project.sourcePath,
                    contentHash: project.sourceHash,
                  }
                : null;
            scoreAudioIdentityRef.current = project.sourceHash
              ? `hash:${project.sourceHash}`
              : (audioIdentityRef.current ?? "?");
            setScreen("scoreReady");
          },
          onProjectOpened: (project) => {
            // #264: the saved transcription.settings are this
            // project's provenance — stage them so the audio-slot
            // reset picks them up (fires before onAudioReady).
            projectOptionsRef.current =
              project.transcriptionSettings != null
                ? {
                    identity: project.sourceHash
                      ? `hash:${project.sourceHash}`
                      : null,
                    options: transcriptionOptionsFromSettings(
                      project.transcriptionSettings,
                    ),
                  }
                : null;
          },
        },
        // Recent-project MRU persists in localStorage (web + webview).
        typeof window !== "undefined" ? window.localStorage : null,
      ),
    [transport],
  );

  // #128 (§26 last project): on launch, reopen the project at the top
  // of the MRU — the same entry the 最近のプロジェクト list shows
  // first. Runs once on the initial empty screen; browser dev has no
  // durable project paths so it skips quietly there.
  const restoredProjectRef = useRef(false);
  useEffect(() => {
    if (restoredProjectRef.current) return;
    restoredProjectRef.current = true;
    if (!isTauriRuntime()) return;
    if (screen !== "empty") return;
    const last = recentProjects[0];
    if (!last?.path) return;
    void importer.openProject(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launch-only restore
  }, []);

  // FEAT-001: the capture controller pushes recorded audio straight into
  // the import flow — a finished take lands as AUDIO_READY exactly like a
  // picked file (single-document app: the new source replaces the old).
  const capture = useMemo(
    () =>
      new CaptureController(createCapturePort(), {
        onState: (s) => setCaptureState(s),
        announce: setStatusMessage,
        onCaptureComplete: ({ path, bytes, fileName, source, mimeType }) => {
          // Tauri: 録音は appDataDir/recordings/ に保存済み(#70)なので
          // path を渡し、import 側で読み直す。ブラウザ dev 等で path が
          // 無い場合は bytes → Blob を渡す。
          const blob = bytes
            ? new Blob(
                [
                  new Uint8Array(
                    new Uint8Array(
                      bytes.buffer,
                      bytes.byteOffset,
                      bytes.byteLength,
                    ),
                  ),
                ],
                { type: mimeType ?? "audio/wav" },
              )
            : undefined;
          void importer.importRecording({
            kind: "recording",
            name: fileName,
            source,
            path,
            blob,
          });
        },
      }),
    [importer],
  );
  useEffect(() => () => capture.dispose(), [capture]);

  // 設定→再生: 標準再生速度はライブ設定なので即時反映する
  // (transport.setRate は [0.25,4] にクランプ済み)。
  useEffect(() => {
    transport.setRate(settings.playbackRate);
  }, [transport, settings.playbackRate]);

  // #87: 保持日数ポリシー — 起動時に一度だけ古い録音を削除する。
  // settings.recordingsRetentionDays は起動時の値で確定(途中変更は
  // 次回起動から有効)。削除件数はステータスバーで知らせる。
  useEffect(() => {
    const days = settings.recordingsRetentionDays;
    if (days <= 0) return;
    /* #132: recordings a saved project still references are excluded
     * from the retention sweep — deleting them would leave the project
     * openable but source-less. Only the recordings dir is protected;
     * unreadable projects fail open (their refs stay unknown). */
    void (async () => {
      const ports = createImportPorts();
      const info = await getRecordingsInfo();
      const keep = await collectReferencedRecordingNames({
        readProjectBytes: ports.readProjectBytes,
        entries: loadRecentProjects(),
        dir: info?.dir ?? null,
        sourcePathOf: async (blob) =>
          parseProjectFile(await blob.arrayBuffer(), "").sourcePath,
      });
      // #147: the persistent source-ref index also protects recordings —
      // a project pushed out of the 8-entry MRU still keeps its source.
      for (const name of sourceRefCountUnder(
        await getSourceRefIndex(),
        info?.dir ?? null,
      ).keys()) {
        keep.add(name);
      }
      const n = await pruneRecordings(days, keep);
      if (n > 0) setStatusMessage(ja.settings.recordingsPruned(n));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once
  }, []);

  // #81: 録音中にアプリを閉じると録音は失われる。WebView2/Tauri でも
  // beforeunload の preventDefault は閉じる確認として扱われるため、
  // 録音中だけガードを掛ける(録音していない時の常駐確認はしない)。
  const recordingActive = captureState?.phase === "recording";
  useEffect(() => {
    if (!recordingActive) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [recordingActive]);

  // #73: デバイス一覧はメニューを開く度に取り直す(抜き差しに追従)。
  const refreshCaptureDevices = useCallback(() => {
    void capture
      .listDevices()
      .then(setCaptureDevices)
      .catch(() => setCaptureDevices(null));
  }, [capture]);

  // #76: 録音は現在の音源(と楽譜)を置き換える単一ドキュメントのため、
  // 既に音源がある時は開始前に確認する。録音中に演奏が鳴っていると
  // ループバック/マイクに混入するので、開始時に audition は切る。
  const requestCapture = useCallback(
    (source: CaptureSource) => {
      if (importState.audio || scoreDocument) {
        setPendingCapture(source);
        return;
      }
      if (scoreState?.auditionEnabled) scoreCtlRef.current?.toggleAudition();
      void capture.start(source);
    },
    [capture, importState.audio, scoreDocument, scoreState?.auditionEnabled],
  );
  const confirmCapture = useCallback(() => {
    const source = pendingCapture;
    setPendingCapture(null);
    if (!source) return;
    if (scoreState?.auditionEnabled) scoreCtlRef.current?.toggleAudition();
    void capture.start(source);
  }, [capture, pendingCapture, scoreState?.auditionEnabled]);

  const regions = regionVisibility(screen);

  // [UI-030] Feature inspector model → the shell's selection contract: the
  // panel auto-opens on real selections and stays closed otherwise (§6).
  const inspector: InspectorContent = useMemo(
    () =>
      inspectorModel.kind === "note"
        ? { kind: "note", noteId: inspectorModel.canonicalId ?? "" }
        : NO_SELECTION,
    [inspectorModel],
  );
  const propertiesVisible = regions.properties && layout.propertiesOpen;
  // Open-issue count prefers the live workspace mirror (UI-050: it tracks
  // decisions as they resolve); then the document's static list; then the
  // job result count for the window before the document mounts; the
  // dev-state REVIEWING placeholder stays so its surfaces can be reviewed.
  const reviewCount =
    scoreState?.openIssueCount ??
    (scoreDocument
      ? openIssues(scoreDocument.reviewIssues()).length
      : sessionSnap.reviewIssueCount > 0
        ? sessionSnap.reviewIssueCount
        : screen === "reviewing"
          ? 12
          : 0);

  // The registry is static: predicates read the snapshot, not React state.
  const registry = useMemo(() => createCommandRegistry(), []);

  // Screen machine → command snapshot (§23). Playback fields mirror the
  // transport adapter (UI-020) or, when no media source is loaded, the
  // score clock (UI-030 dev/fixture playback); isTranscribing keeps
  // score-writing commands disabled while a transcription runs (§5).
  const snapshot = useMemo<CommandSnapshot>(
    () => ({
      ...commandStateFor(screen),
      hasScore: commandStateFor(screen).hasScore && scoreDocument !== null,
      // #219: a source-missing score is viewable/editable but has no
      // audio — audio-gated commands (採譜, source playback) stay
      // off until the relink lands.
      hasAudio: commandStateFor(screen).hasAudio && importState.audio != null,
      isPlaying:
        transportSnap?.status === "playing" || (scoreState?.isPlaying ?? false),
      loopEnabled:
        transportSnap?.loop != null || (scoreState?.loopEnabled ?? false),
      pitch,
      // UI-050: undo/redo reach the score workspace's review/edit history.
      canUndo: scoreState?.canUndo ?? false,
      canRedo: scoreState?.canRedo ?? false,
      hasSelection: scoreState?.hasSelection ?? false,
      hasRestSelection: scoreState?.hasRestSelection ?? false,
      // #113: the waveform range selection (AUDIO_READY) is Esc-clearable
      // like a score selection (spec 8).
      hasWaveformSelection:
        screen === "audioReady" && transcriptionOptions.range === "selection",
      reviewOpen: scoreState?.reviewOpen ?? screen === "reviewing",
      reviewIssueEditable: scoreState?.reviewIssueEditable ?? false,
      reviewCount,
      view,
      // FEAT-001: recording + audition gates for the command registry.
      isRecording: captureState?.phase === "recording",
      isRecordingPaused:
        captureState?.phase === "recording" && captureState.paused,
      auditionEnabled: scoreState?.auditionEnabled ?? false,
    }),
    [
      screen,
      scoreDocument,
      transportSnap,
      scoreState,
      pitch,
      reviewCount,
      view,
      captureState,
      transcriptionOptions,
      importState.audio,
    ],
  );

  // Whether the media transport carries a loaded source — then it is the
  // authoritative clock and the score follows via the transport prop
  // (UI-005 one-clock contract). Otherwise transport commands fall back to
  // the score clock (dev/fixture playback with no audio loaded).
  const mediaLive = transportSnap != null && transportSnap.status !== "empty";

  // §8 §-seek transport step (GUI_UX_SPEC §9: ←/→ 5 seconds).
  const seekBy = useCallback(
    (delta: number) => {
      void transport
        .seek(transport.getCurrentTime() + delta)
        .catch(() => undefined);
      setStatusMessage(
        ja.import.feedback.position(formatTimecode(transport.getCurrentTime())),
      );
    },
    [transport],
  );

  // #100: プロジェクトを保存 — pick a path, build the schema-v1
  // document, and let the engine validate + atomically write it. The
  // flow is async behind a fire-and-forget command entry.
  const saveProjectFlow = useCallback(async () => {
    const doc = scoreDocument;
    if (!doc) {
      setStatusMessage(ja.notifications.projectSaveFailed);
      return;
    }
    if (!isTauriRuntime()) {
      // Browser dev has no save picker — the honest limitation, not a
      // silent no-op (same posture as the other Tauri-only commands).
      setStatusMessage(ja.notifications.projectSaveUnsupported);
      return;
    }
    try {
      /* #132: a recording-backed source gets copied into the managed
       * sources/ area before the project is written — the saved
       * originalPath then points outside the retention sweep, so
       * keeping the project never depends on keepNames luck. Non-
       * recording sources and copy failures keep the original path. */
      let audioForProject = importState.audio;
      const ref = audioForProject?.ref;
      if (ref?.kind === "recording" && ref.path) {
        const info = await getRecordingsInfo();
        const name = info ? recordingNameUnder(ref.path, info.dir) : null;
        if (name) {
          const managed = await copyRecordingToManaged(name);
          if (managed) {
            audioForProject = {
              ...audioForProject!,
              ref: { ...ref, path: managed },
            };
          }
        }
      }
      const project = await buildProjectDocument({
        audio: audioForProject,
        doc,
        // #240: the score's own provenance — survives a cancelled/
        // failed re-transcription that cleared session.lastResult.
        result: scoreProvenance,
        projectId: projectIdRef.current,
        // #265: SOURCE_MISSING save — keep the recorded source ref
        // instead of writing sourceAudio:null over the relink target.
        priorSourceAudio: projectSourceRef.current,
      });
      if (!project) {
        setStatusMessage(ja.notifications.projectSaveUnsupported);
        return;
      }
      const fileName = importState.audio?.fileName ?? "score";
      const suggested = fileName.replace(/\.[^.]*$/, "") || "score";
      const path = await invoke<string | null>("project_save_path", {
        suggestedName: `${suggested}.hornscribe.json`,
      });
      if (!path) return; // cancelled — no announcement needed
      const res = await session.saveProject(path, project);
      const name = res.path.split(/[\\/]/).pop() ?? res.path;
      setRecentProjects(recordRecentProject({ name, path: res.path }));
      // #147: persist the source ref so the Settings badge/delete
      // warning tracks this project even after it leaves the MRU.
      const savedSource = project.sourceAudio as
        | { originalPath?: string }
        | null
        | undefined;
      void updateSourceRef(res.path, savedSource?.originalPath ?? null);
      // #222: the saved id becomes this session's project identity —
      // later saves keep it instead of minting a new prj-.
      projectIdRef.current =
        typeof project.projectId === "string"
          ? project.projectId
          : projectIdRef.current;
      setStatusMessage(ja.notifications.projectSaved);
    } catch {
      setStatusMessage(ja.notifications.projectSaveFailed);
    }
  }, [scoreDocument, importState.audio, scoreProvenance, session]);

  // #115 (spec 13): engine rhythm edits — the score workspace delegates
  // to the live engine's score.edit; the same worker that produced the
  // score re-realizes the edited measures (one worker, one caller, so
  // no extra spawn cost beyond the lazy ensureEngine).
  const applyRhythmEdit = useCallback<RhythmEditInvoker>(
    (scoreDocPayload, op) => session.applyScoreEdit(scoreDocPayload, op),
    [session],
  );

  /* §27 AUDIO_READY → TRANSCRIBING. The job lifecycle effects own every
   * later transition; a failed start lands on the §20 surface.
   * #86: browser-held bytes (kind:"file" drops, pathless recordings) are
   * staged to a temp file first so the real engine gets a readable
   * audioPath; refs already on disk return null from staging and keep
   * their own path. #148: overrides pin job options (voices retry)
   * without a stale transcriptionOptions read. */
  const startTranscriptionJob = useCallback(
    (overrides?: Partial<TranscriptionOptions>) => {
      if (!importState.audio) {
        // #219: a source-missing score can be viewed but not
        // re-transcribed — the relink banner is the way back.
        setStatusMessage(ja.notifications.transcribeRequiresAudio);
        return;
      }
      // #234: pin the job to the audio identity that started it — a
      // completed event only lands when the same source is still
      // loaded.
      jobAudioIdentityRef.current = audioIdentityRef.current;
      setScreen("transcribing");
      setStatusMessage(ja.transcription.start);
      void stageAudioForEngine(importState.audio)
        .then((staged) =>
          session.startTranscription(
            buildTranscriptionParams(
              importState.audio,
              { ...transcriptionOptions, ...overrides },
              staged,
              settings.backend,
            ),
          ),
        )
        .catch(() => {
          /* failure flag drives the error surface */
        });
    },
    [importState.audio, transcriptionOptions, settings.backend, session],
  );

  const ctx = useMemo<CommandContext>(
    () => ({
      openAudio: () => {
        // #234: same gate as the import view — a running job owns
        // the audio slot.
        if (screen === "transcribing") {
          setStatusMessage(ja.notifications.importWhileTranscribing);
          return;
        }
        void importer.openViaDialog();
      },
      transcribe: (overrides) => startTranscriptionJob(overrides),
      cancelTranscription: () => {
        // Cooperative job.cancel — the terminal `cancelled` event is the
        // real transition; the button shows キャンセルしています… until then.
        session.cancelTranscription().catch(() => {
          /* JOB_NOT_FOUND races are ignored in the session; other
            failures surface through snap.failure/engine state */
        });
      },
      togglePlayPause: () => {
        if (transport.getSnapshot().status !== "empty") {
          // [UI-020] real audio clock — the score follows it through the
          // transport prop mirror (ScoreReadyWorkspace sync effect).
          if (transport.getSnapshot().status === "playing") {
            transport.pause();
            setStatusMessage(ja.import.feedback.paused);
          } else {
            void transport.play().catch(() => undefined);
            setStatusMessage(ja.import.feedback.playing);
          }
        } else {
          // No audio source loaded — the score clock is the transport
          // (fixture/dev playback, UI-030).
          const c = scoreCtlRef.current;
          if (c) c.togglePlayPause();
          else setStatusMessage(ja.score.empty);
        }
      },
      stop: () => {
        if (transport.getSnapshot().status !== "empty") {
          transport.stop();
          setStatusMessage(ja.import.feedback.stopped);
        } else {
          const c = scoreCtlRef.current;
          if (c) c.stop();
          else setStatusMessage(ja.score.empty);
        }
      },
      jumpBack: () => {
        if (transport.getSnapshot().status !== "empty")
          seekBy(-settings.skipSeconds);
        else scoreCtlRef.current?.jumpBy(-settings.skipSeconds * 1000);
      },
      jumpForward: () => {
        if (transport.getSnapshot().status !== "empty")
          seekBy(settings.skipSeconds);
        else scoreCtlRef.current?.jumpBy(settings.skipSeconds * 1000);
      },
      seekToStart: () => {
        if (transport.getSnapshot().status !== "empty") {
          void transport.seek(0).catch(() => undefined);
          setStatusMessage(ja.import.feedback.position(formatTimecode(0)));
        } else {
          scoreCtlRef.current?.seekToStart();
        }
      },
      seekToEnd: () => {
        if (transport.getSnapshot().status !== "empty") {
          void transport.seek(transport.getDuration()).catch(() => undefined);
          setStatusMessage(
            ja.import.feedback.position(
              formatTimecode(transport.getDuration()),
            ),
          );
        } else {
          scoreCtlRef.current?.seekToEnd();
        }
      },
      // Loop arming is score-side when a score exists (UI-030 owns the
      // range contract: the score clock wraps inside the range and the
      // score draws passage marks). #113: the media transport mirrors the
      // same range so the *audio* loops too - and before any score exists
      // (AUDIO_READY) the loop button arms the media A-B loop directly,
      // over the waveform selection when one is committed.
      toggleLoop: () => {
        const c = scoreCtlRef.current;
        if (c) {
          c.toggleLoop();
          const range = c.loopRange?.();
          transport.setLoop(
            range
              ? { start: range.startMs / 1000, end: range.endMs / 1000 }
              : null,
          );
          return;
        }
        if (transportSnap && transportSnap.status !== "empty") {
          if (transportSnap.loop) {
            transport.setLoop(null);
            setStatusMessage(ja.commandFeedback.loopOff);
          } else {
            const sel =
              transcriptionOptions.range === "selection" &&
              transcriptionOptions.selectionStartSec != null &&
              transcriptionOptions.selectionEndSec != null
                ? {
                    start: transcriptionOptions.selectionStartSec,
                    end: transcriptionOptions.selectionEndSec,
                  }
                : { start: 0, end: transportSnap.duration };
            transport.setLoop(sel);
            setStatusMessage(ja.commandFeedback.loopOn);
          }
        } else {
          setStatusMessage(ja.commandFeedback.disabled);
        }
      },
      // FEAT-001: capture + score audition commands.
      captureSystemAudio: () => {
        requestCapture("loopback");
      },
      captureMicrophone: () => {
        requestCapture("microphone");
      },
      stopCapture: () => {
        void capture.stop();
      },
      cancelCapture: () => {
        void capture.cancel();
      },
      pauseCapture: () => {
        void capture.pause();
      },
      resumeCapture: () => {
        void capture.resume();
      },
      toggleScoreAudition: () => {
        const c = scoreCtlRef.current;
        if (c) c.toggleAudition();
        else setStatusMessage(ja.commandFeedback.disabled);
      },
      toggleSourceMute: () => {
        transport.setMuted(!(transportSnap?.muted ?? false));
        setStatusMessage(
          transportSnap?.muted
            ? ja.commandFeedback.unmutedSource
            : ja.commandFeedback.mutedSource,
        );
      },
      setPitchView: (v) => {
        setPitch(v);
        setStatusMessage(
          v === "concert"
            ? ja.commandFeedback.pitchConcert
            : ja.commandFeedback.pitchHornF,
        );
      },
      openReview: () => scoreCtlRef.current?.openReview(),
      reviewNext: () => scoreCtlRef.current?.reviewNext(),
      reviewPrevious: () => scoreCtlRef.current?.reviewPrevious(),
      // UI-050 review actions — all live in the score workspace session.
      reviewAccept: () => scoreCtlRef.current?.reviewAccept(),
      reviewDismiss: () => scoreCtlRef.current?.reviewDismiss(),
      reviewPlaySource: () => scoreCtlRef.current?.reviewPlaySource(),
      reviewPitchUp: () => scoreCtlRef.current?.reviewPitch(1),
      reviewPitchDown: () => scoreCtlRef.current?.reviewPitch(-1),
      reviewDeleteOrRestore: () => scoreCtlRef.current?.reviewDeleteOrRestore(),
      exitReview: () => scoreCtlRef.current?.exitReview(),
      undo: () => {
        const c = scoreCtlRef.current;
        if (c) c.undo();
        else setStatusMessage(ja.commandFeedback.nothingToUndo);
      },
      redo: () => {
        const c = scoreCtlRef.current;
        if (c) c.redo();
        else setStatusMessage(ja.commandFeedback.nothingToRedo);
      },
      openExport: () => setExportOpen(true),
      // §13 高度編集: open the live score (current pitch view, edits
      // included) in the MuseScore GUI. The port resolves the detected/
      // user-pinned executable; missing MuseScore announces the 設定 →
      // ツール recovery path instead of a dead menu item.
      openInMuseScore: () => {
        void exportPort
          .openInMuseScore?.(pitch, toolOverrides)
          .then(() => setStatusMessage(ja.commandFeedback.museScoreOpened))
          .catch((err: unknown) =>
            setStatusMessage(
              exportErrorCode(err) === "MUSESCORE_UNAVAILABLE"
                ? ja.commandFeedback.museScoreMissing
                : ja.commandFeedback.museScoreFailed,
            ),
          );
      },
      // #100: プロジェクトを保存 — pick a path (Tauri) then hand the
      // schema-v1 document to the engine's project.save. In a plain
      // browser there is no save picker, so the command announces the
      // honest limitation instead of faking a write.
      saveProject: () => {
        void saveProjectFlow();
      },
      zoomScoreIn: () => scoreCtlRef.current?.zoomIn(),
      zoomScoreOut: () => scoreCtlRef.current?.zoomOut(),
      zoomScoreFit: () => scoreCtlRef.current?.zoomFit(),
      clearSelection: () => scoreCtlRef.current?.clearSelection(),
      // #113: Esc on a waveform selection drops the committed range and
      // returns the transcription-range option to "all" (spec 8).
      clearWaveformSelection: () => {
        if (transcriptionOptions.range === "selection") {
          setTranscriptionOptions({ ...transcriptionOptions, range: "all" });
        }
      },
      // #114: score note navigation + direct edits (spec 10/13).
      selectAdjacentNote: (direction) =>
        scoreCtlRef.current?.selectAdjacentNote?.(direction),
      editSelectedPitch: (delta) =>
        scoreCtlRef.current?.editSelectedPitch?.(delta),
      toggleSelectedDeleted: () =>
        scoreCtlRef.current?.toggleSelectedDeleted?.(),
      toggleSelectedEnharmonic: () =>
        scoreCtlRef.current?.toggleSelectedEnharmonic?.(),
      // #115: engine rhythm edits (spec 13) — duration ladder, onset
      // grid shift, tie toggle. The workspace runs them through the
      // serialized score.edit queue; these just forward.
      noteDurationScale: (power) =>
        scoreCtlRef.current?.noteDurationScale?.(power),
      shiftSelectedOnset: (steps) =>
        scoreCtlRef.current?.shiftSelectedOnset?.(steps),
      toggleSelectedTie: () => scoreCtlRef.current?.toggleSelectedTie?.(),
      // #130 (spec 14): quantization-settings dialog — app-owned
      // surface; the workspace controller applies the requantize edit.
      openRequantizeDialog: () => setRequantizeOpen(true),
      // #131 (spec 13 post-MVP): split/merge via the workspace.
      splitSelectedNote: () => scoreCtlRef.current?.splitSelectedNote?.(),
      mergeSelectedNotes: () => scoreCtlRef.current?.mergeSelectedNotes?.(),
      // #163: rest→note conversion via the workspace (was unwired).
      convertSelectedRest: () =>
        scoreCtlRef.current?.convertSelectedRest?.(),
      // #267: octave arrange — canonical transposeRange on the whole
      // score through the workspace's serialized edit queue.
      transposeScore: (semitones) =>
        scoreCtlRef.current?.transposeScore?.(semitones),
      openSettings: () => {
        setSettingsFocus(undefined);
        setView("settings");
      },
      openDiagnostics: () => setDiagnosticsOpen(true),
      // F6 / Shift+F6 region cycling (§22) — owned by focus/zones.ts; these
      // are the only fully-working transport-independent commands so far.
      focusNextRegion: () => {
        const zone = cycleFocusZone(1);
        if (zone) {
          setStatusMessage(ja.commandFeedback.focusMoved(zoneName(zone)));
        }
      },
      focusPreviousRegion: () => {
        const zone = cycleFocusZone(-1);
        if (zone) {
          setStatusMessage(ja.commandFeedback.focusMoved(zoneName(zone)));
        }
      },
      announce: setStatusMessage,
    }),
    [
      importer,
      transport,
      seekBy,
      session,
      capture,
      requestCapture,
      transportSnap,
      transcriptionOptions,
      settings.skipSeconds,
      saveProjectFlow,
      pitch,
      toolOverrides,
      exportPort,
      startTranscriptionJob,
      screen,
    ],
  );

  // The dispatcher reads the snapshot lazily per key event, so it must see
  // the latest render's value even though the listener is stable.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const dispatcher = useMemo(
    () =>
      new KeyboardDispatcher({
        registry,
        getSnapshot: () => snapshotRef.current,
        context: ctx,
      }),
    [registry, ctx],
  );
  useCommandKeyboard(dispatcher);

  // One render-scoped invocation surface shared by command bar, transport
  // and any other component — buttons never call services directly.
  const commands = useMemo(
    () => createCommandSurface(registry, ctx, snapshot),
    [registry, ctx, snapshot],
  );

  // Closing the panel returns focus to the score region when the focus was
  // inside the panel (§22 focus discipline); if it was closed from the
  // overflow menu, focus stays where it is.
  const closeProperties = useCallback(() => {
    const focusInside =
      document
        .querySelector(".hs-properties")
        ?.contains(document.activeElement) ?? false;
    layout.setPropertiesOpen(false);
    if (focusInside) {
      requestAnimationFrame(() => focusZone("score"));
    }
  }, [layout]);

  // §6: the panel opens itself when a real selection exists; with nothing
  // selected it stays closed until the user reopens it manually.
  useEffect(() => {
    if (
      inspectorHasContent(inspector) &&
      regions.properties &&
      !layout.propertiesOpen
    ) {
      layout.setPropertiesOpen(true);
    }
  }, [inspector, regions.properties, layout]);

  // 採譜 start routes through the command surface — the registry decides
  // (disabled → honest announcement, never a silent no-op). Cancellation
  // is owned by TranscriptionView via score.cancelTranscription (§5).
  const transcribeClicked = useCallback(() => {
    if (!commands.invoke("score.transcribe")) {
      setStatusMessage(ja.commandFeedback.disabled);
    }
  }, [commands]);

  // Hash routing: internal dev gallery + dev screen-state override. The
  // product shell is a single workspace (§2), not a page router.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash;
      setHash(h);
      const forced = screenFromHash(h);
      if (forced) {
        // Score states need a document — the deterministic fixture adapter
        // supplies one until engine output flows through the job result.
        if (commandStateFor(forced).hasScore) {
          setHasScore(true);
          setScoreDocument((doc) => doc ?? createFixtureScoreDocument());
        }
        setScreen(forced);
        setView("workspace");
      }
    };
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Dev-only entry: "#/dev/transcribing" auto-starts a real job once the
  // shell is up so the whole TRANSCRIBING flow can be reviewed directly.
  const devAutoStarted = useRef(false);
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      hash === DEV_TRANSCRIBING_HASH &&
      !devAutoStarted.current
    ) {
      devAutoStarted.current = true;
      commands.invoke("score.transcribe");
    }
  }, [hash, commands]);

  // §26 session restore: window geometry (size/position) persists across
  // restarts; panel sizes/visibility persist via useWorkspaceLayout.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void initWindowGeometryPersistence().then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // §27 SCORE_READY ⇄ REVIEWING (UI-050): the review bar lives inside the
  // score workspace, so the screen machine mirrors its open flag — region
  // chrome, command predicates (reviewOpen) and the dev-state surface all
  // read the same truth. Transitions are deliberately limited to the
  // scoreReady/reviewing pair so EXPORTING is never hijacked.
  const scoreReviewOpen = scoreState?.reviewOpen;
  useEffect(() => {
    if (screen === "scoreReady" && scoreReviewOpen === true) {
      setScreen("reviewing");
    } else if (screen === "reviewing" && scoreReviewOpen === false) {
      setScreen("scoreReady");
    }
  }, [screen, scoreReviewOpen]);

  // Prove the JS↔Rust IPC channel early; populates the status area.
  useEffect(() => {
    let alive = true;
    getShellInfo().then((info) => {
      if (!alive) return;
      setShellDetail(
        info ? `v${info.version}` : undefined, // browser dev: no shell info
      );
      setStatusMessage(ja.status.ready);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Transport adapter → low-frequency snapshot for playhead + transport
  // bar (media timeupdate cadence, no rAF — see mediaTransport.ts header).
  useEffect(() => {
    const unsubscribe = transport.subscribe(setTransportSnap);
    setTransportSnap(transport.getSnapshot());
    return () => {
      unsubscribe();
      transport.dispose();
    };
  }, [transport]);

  // Native file drop (Tauri `dragDropEnabled`): enter/over light the drop
  // affordance on the score region, drop imports the first supported path.
  // Outside the webview this resolves to a no-op (HTML5 drop covers dev).
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenNativeDrop((payload) => {
      if (payload.type === "enter" || payload.type === "over") {
        setNativeDrag(true);
      } else if (payload.type === "leave") {
        setNativeDrag(false);
      } else {
        setNativeDrag(false);
        // 録音中のドロップは onDropFiles と同じゲート — 取り込み済みの
        // 録音を黙って上書きしない。
        if (captureState?.phase === "recording") return;
        // #234: a running job owns the audio slot — a native drop
        // during transcription is refused like the open commands.
        if (screenRef.current === "transcribing") {
          setStatusMessage(ja.notifications.importWhileTranscribing);
          return;
        }
        const refs: AudioFileRef[] = payload.paths.map((path) => ({
          kind: "path",
          path,
          name: baseName(path),
        }));
        void importer.importRefs(refs);
      }
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [importer, captureState?.phase]);

  // Assembled once per render for the import-owned score bodies
  // (ImportStates.tsx) — keeps ScoreWorkspace's prop surface small.
  const importView = useMemo<ImportView>(
    () => ({
      audio: importState.audio,
      openingLabel: importState.openingLabel,
      openingKind: importState.openingKind,
      issue: importState.issue,
      sourceMissing: importState.sourceMissing,
      recentProjects,
      options: transcriptionOptions,
      // #234: while a job runs the audio slot is owned by that job —
      // opening a different source mid-transcription would orphan
      // the running job's result, so imports are refused with a
      // status line instead of silently swapping.
      onOpenAudio: () => {
        if (screen === "transcribing") {
          setStatusMessage(ja.notifications.importWhileTranscribing);
          return;
        }
        void importer.openViaDialog();
      },
      onOpenProject: (entry) => {
        if (screen === "transcribing") {
          setStatusMessage(ja.notifications.importWhileTranscribing);
          return;
        }
        void importer.openProject(entry);
      },
      onPickRelink: () => void importer.pickRelinkSource(),
      onDismissError: () => importer.dismiss(),
      onOptionsChange: setTranscriptionOptions,
      // FEAT-001: EMPTY state capture entry points.
      captureState,
      onStartCapture: (source) => {
        requestCapture(source);
      },
    }),
    [
      importState,
      recentProjects,
      transcriptionOptions,
      importer,
      captureState,
      requestCapture,
      screen,
    ],
  );

  const theme = resolved === "dark" ? hsDarkTheme : hsLightTheme;
  // Dev-only route: the gallery renders in place of the shell and never
  // appears in product navigation.
  const showGallery = DevGallery != null && hash === GALLERY_HASH;

  return (
    // .hs-provider fixes the UI-009 latent bug: the FluentProvider wrapper
    // div had no definite height, so `height:100%` on .hs-shell collapsed
    // to content height. The provider now owns the full viewport.
    <FluentProvider theme={theme} className="hs-provider">
      {showGallery ? (
        <Suspense fallback={null}>
          <DevGallery themeMode={mode} onThemeMode={select} />
        </Suspense>
      ) : (
        <AppShell>
          {/* Document identity follows the loaded source audio (§2). */}
          <TitleBar documentTitle={importState.audio?.fileName} />
          {view === "settings" ? (
            <div className="hs-settings-wrap">
              <SettingsView
                themeMode={mode}
                onThemeMode={select}
                onBack={() => setView("workspace")}
                settings={settings}
                onSettingsChange={updateSettings}
                diagnosticsPort={diagnosticsPort}
                exportPort={exportPort}
                onOpenDiagnostics={() => setDiagnosticsOpen(true)}
                onAnnounce={setStatusMessage}
                focusCategory={settingsFocus}
                recentProjects={recentProjects}
              />
            </div>
          ) : (
            <>
              <CommandBar
                commands={commands}
                pitch={pitch}
                screen={screen}
                reviewCount={reviewCount}
                compact={layout.breakpoint === "compact"}
                propertiesOpen={layout.propertiesOpen}
                onToggleProperties={() =>
                  layout.setPropertiesOpen(!layout.propertiesOpen)
                }
                captureState={captureState}
                captureDevices={captureDevices}
                captureSelectedDevice={(source) =>
                  capture.selectedDeviceId(source)
                }
                onSelectCaptureDevice={(source, id) => {
                  capture.selectDevice(source, id);
                  // 選択は localStorage 側に持つので React state は
                  // 変わらない — ✓ を即座に反映するため再描画を起こす。
                  setCaptureDevices((d) => (d ? { ...d } : d));
                }}
                onCaptureMenuOpen={refreshCaptureDevices}
              />
              {regions.waveform ? (
                <WaveformView
                  height={layout.waveformHeight}
                  min={layout.waveformMin}
                  max={layout.waveformMax}
                  onResize={layout.requestWaveformHeight}
                  onReset={layout.resetWaveformHeight}
                  audio={importState.audio}
                  loading={screen === "openingAudio"}
                  positionSec={transportSnap?.time}
                  onSeek={(s) => {
                    void transport.seek(s).catch(() => undefined);
                  }}
                  captureState={captureState}
                  selection={
                    screen === "audioReady" &&
                    transcriptionOptions.range === "selection"
                      ? {
                          startSec: transcriptionOptions.selectionStartSec ?? 0,
                          endSec:
                            transcriptionOptions.selectionEndSec ??
                            importState.audio?.durationSeconds ??
                            0,
                        }
                      : null
                  }
                  onSelect={
                    screen === "audioReady"
                      ? (range) =>
                          setTranscriptionOptions({
                            ...transcriptionOptions,
                            range: "selection",
                            selectionStartSec: range.startSec,
                            selectionEndSec: range.endSec,
                          })
                      : undefined
                  }
                  // #113: armed media loop band + selection context
                  // actions (spec 8: ループ/再生/ズーム/解除).
                  loop={
                    transportSnap?.loop
                      ? {
                          startSec: transportSnap.loop.start,
                          endSec: transportSnap.loop.end,
                        }
                      : null
                  }
                  onLoopSelection={(range) => {
                    if (transportSnap?.loop) transport.setLoop(null);
                    else {
                      transport.setLoop({
                        start: range.startSec,
                        end: range.endSec,
                      });
                      setStatusMessage(ja.commandFeedback.loopOn);
                    }
                  }}
                  onPlaySelection={(range) => {
                    void transport
                      .playRange(range.startSec, range.endSec)
                      .catch(() => undefined);
                  }}
                  onClearSelection={() => {
                    if (transcriptionOptions.range === "selection") {
                      setTranscriptionOptions({
                        ...transcriptionOptions,
                        range: "all",
                      });
                    }
                  }}
                />
              ) : null}
              <div className="hs-main">
                <ScoreWorkspace
                  screen={screen}
                  importView={importView}
                  externalDragActive={nativeDrag}
                  onDropFiles={(files) =>
                    // 録音中のドロップは取り込み済み録音を黙って上書きする
                    // ので受け付けない(file.openAudio と同じゲート)。
                    captureState?.phase === "recording"
                      ? undefined
                      : screen === "transcribing"
                        ? setStatusMessage(
                            ja.notifications.importWhileTranscribing,
                          )
                        : void importer.importRefs(
                            files.map<AudioFileRef>((file) => ({
                              kind: "file",
                              file,
                              name: file.name,
                            })),
                          )
                  }
                  onTranscribe={transcribeClicked}
                  transcribingBody={
                    <TranscriptionView job={job} commands={commands} />
                  }
                  transcriptionErrorBody={
                    <TranscriptionErrorView
                      kind={sessionSnap.failure?.kind ?? "transcriptionFailed"}
                      errorCode={sessionSnap.failure?.errorCode}
                      errorPackage={sessionSnap.failure?.errorPackage}
                      restarting={engineRestarting}
                      diagnostics={() => session.buildDiagnostics()}
                      onPrimary={() => {
                        const failure = sessionSnap.failure;
                        if (
                          !failure ||
                          failure.kind === "transcriptionFailed"
                        ) {
                          // 再試行 is explicit — never a silent resubmit.
                          session.clearFailure();
                          startTranscriptionJob();
                        } else {
                          // エンジンを再起動 — the §20 crash recovery action.
                          setEngineRestarting(true);
                          session
                            .restartEngine()
                            .then(() => {
                              session.clearFailure();
                              setScreen(hasScore ? "scoreReady" : "audioReady");
                              setStatusMessage(ja.status.engineRestarted);
                            })
                            .catch(() => {
                              /* failure stays set — surface remains */
                            })
                            .finally(() => setEngineRestarting(false));
                        }
                      }}
                      onClose={() => {
                        session.clearFailure();
                        session.clearJob();
                        setScreen(hasScore ? "scoreReady" : "audioReady");
                      }}
                    />
                  }
                  scoreDocument={scoreDocument}
                  pitch={pitch}
                  initialViewMode={settings.scoreInitialView}
                  followPlayback={settings.followPlayback}
                  onInspectorChange={setInspectorModel}
                  onScoreStateChange={setScoreState}
                  scoreControllerRef={(c) => {
                    scoreCtlRef.current = c;
                  }}
                  announce={setStatusMessage}
                  transport={
                    mediaLive && transportSnap
                      ? {
                          isPlaying: transportSnap.status === "playing",
                          positionSec: transportSnap.time,
                          rate: transportSnap.rate,
                        }
                      : null
                  }
                  sourceControl={
                    // UI-050 元音源を再生 — real audio clock when a source is
                    // loaded; the score clock covers fixture/dev playback.
                    mediaLive
                      ? {
                          seekTo: (s: number) =>
                            void transport.seek(s).catch(() => undefined),
                          play: () =>
                            void transport.play().catch(() => undefined),
                          setLoop: (r) => transport.setLoop(r),
                          loopRange: () => transport.getSnapshot().loop,
                        }
                      : null
                  }
                  onRhythmEdit={applyRhythmEdit}
                  onRetranscribeVoices={
                    // #219: no source, no re-transcription — the prop
                    // disappears so the review action hides.
                    importState.audio
                      ? () => {
                          /* #148: pin the job to voices AND mirror the choice
                           * into the stored options so the import screen's
                           * texture select reflects what actually ran. */
                          setTranscriptionOptions((o) => ({
                            ...o,
                            texture: "voices",
                          }));
                          startTranscriptionJob({ texture: "voices" });
                        }
                      : undefined
                  }
                  onRetranscribeBasicPitch={
                    importState.audio
                      ? () => {
                          /* #181: mirror the backend switch into settings so
                           * the 詳細設定 selector reflects what ran, and pin
                           * the job itself so a stale settings read cannot
                           * sneak pYIN back in. */
                          updateSettings({ backend: "basicPitch" });
                          /* #189: a per-job pyin pin would outrank the
                           * backend arg, so pin the job options too. */
                          setTranscriptionOptions((o) => ({
                            ...o,
                            backend: "basicPitch",
                          }));
                          startTranscriptionJob({ backend: "basicPitch" });
                        }
                      : undefined
                  }
                  onOpenProperties={() => layout.setPropertiesOpen(true)}
                  banner={
                    importState.sourceMissing ? (
                      <div className="hs-source-missing-banner" role="alert">
                        <span>
                          {importState.sourceMissing.mismatch
                            ? ja.import.errors.hashMismatchBody
                            : ja.import.errors.sourceMissingBody}
                        </span>
                        <HsButton
                          variant="secondary"
                          size="small"
                          onClick={() => void importer.pickRelinkSource()}
                        >
                          {importState.sourceMissing.mismatch
                            ? ja.import.errors.specifyAnother
                            : ja.import.errors.specifySource}
                        </HsButton>
                      </div>
                    ) : null
                  }
                />
                {propertiesVisible ? (
                  <PropertiesPanel
                    content={inspector}
                    model={inspectorModel}
                    pitch={pitch}
                    width={layout.propertiesWidth}
                    min={layout.propertiesMin}
                    max={layout.propertiesMax}
                    overlay={layout.breakpoint === "compact"}
                    onResize={layout.requestPropertiesWidth}
                    onReset={layout.resetPropertiesWidth}
                    onClose={closeProperties}
                    onTempoChange={(bpm) =>
                      scoreCtlRef.current?.setTempo?.(bpm)
                    }
                    onTempoScale={(factor) =>
                      scoreCtlRef.current?.scaleTempo?.(factor)
                    }
                    onMeterChange={(b, u) =>
                      scoreCtlRef.current?.setMeter?.(b, u)
                    }
                    onKeyChange={(f, mode) => scoreCtlRef.current?.setKey?.(f, mode)}
                    onKeyChangeAt={(args) =>
                      scoreCtlRef.current?.keyChangeAt?.(args)
                    }
                    onRemoveKeyChange={(m) =>
                      scoreCtlRef.current?.removeKeyChange?.(m)
                    }
                    onTempoChangeAt={(args) =>
                      scoreCtlRef.current?.tempoChangeAt?.(args)
                    }
                    onRemoveTempoChange={(args) =>
                      scoreCtlRef.current?.removeTempoChange?.(args)
                    }
                    onMetadataChange={(md) =>
                      scoreCtlRef.current?.setMetadata?.(md)
                    }
                  />
                ) : null}
              </div>
              {regions.transport ? (
                <TransportBar
                  commands={commands}
                  live={
                    transportSnap && transportSnap.status !== "empty"
                      ? {
                          isPlaying: transportSnap.status === "playing",
                          positionSec: transportSnap.time,
                          durationSec: transportSnap.duration,
                          rate: transportSnap.rate,
                          muted: transportSnap.muted,
                        }
                      : undefined
                  }
                  onCycleRate={() => {
                    const idx = SUPPORTED_RATES.findIndex(
                      (r) => r === transportSnap?.rate,
                    );
                    const next =
                      SUPPORTED_RATES[(idx + 1) % SUPPORTED_RATES.length] ?? 1;
                    transport.setRate(next);
                  }}
                  timeLabel={
                    !mediaLive && scoreState
                      ? `${formatScoreTimecode(scoreState.positionMs)} / ${formatScoreTimecode(scoreState.durationMs)}`
                      : undefined
                  }
                  followEnabled={scoreState?.followEnabled}
                  followSuspended={scoreState?.followSuspended}
                  onToggleFollow={() => {
                    const c = scoreCtlRef.current;
                    if (!c) return;
                    if (scoreState?.followSuspended) c.resumeFollow();
                    else
                      c.setFollowEnabled(!(scoreState?.followEnabled ?? true));
                  }}
                  auditionEnabled={scoreState?.auditionEnabled}
                  loopArmed={
                    transportSnap?.loop != null ||
                    (scoreState?.loopEnabled ?? false)
                  }
                />
              ) : null}
            </>
          )}
          <StatusBar
            message={statusMessage}
            detail={shellDetail}
            engineStatus={engineStatusText(sessionSnap.engine)}
          />
          {/* Re-import failure over a live workspace (§20): the audio session
              is kept, the failure surfaces as a dialog — never a dead end. */}
          {/* #76: 録音は現在の音源(と楽譜)を置き換えるため、開始前に確認。
              alert 型 = 破壊的操作の確認(JAPANESE_UI_COPY §8)。 */}
          <HsDialog
            open={pendingCapture !== null}
            modalType="alert"
            title={ja.capture.replaceTitle}
            onOpenChange={(open) => {
              if (!open) setPendingCapture(null);
            }}
            actions={
              <>
                <HsButton variant="danger" onClick={confirmCapture}>
                  {ja.capture.replaceConfirm}
                </HsButton>
                <HsButton
                  variant="secondary"
                  onClick={() => setPendingCapture(null)}
                >
                  {ja.capture.replaceCancel}
                </HsButton>
              </>
            }
          >
            <p style={{ margin: 0 }}>
              {scoreDocument
                ? ja.capture.replaceBodyWithScore
                : ja.capture.replaceBody}
            </p>
          </HsDialog>
          {importState.audio && importState.issue
            ? (() => {
                const copy = issueCopy(importState.issue);
                return (
                  <HsDialog
                    open
                    title={copy.title}
                    onOpenChange={(open) => {
                      if (!open) importer.dismiss();
                    }}
                    actions={
                      <>
                        <HsButton
                          variant="primary"
                          onClick={() => {
                            importer.dismiss();
                            void importer.openViaDialog();
                          }}
                        >
                          {ja.import.errors.chooseAnother}
                        </HsButton>
                        <HsButton
                          variant="secondary"
                          onClick={() => importer.dismiss()}
                        >
                          {ja.import.errors.close}
                        </HsButton>
                      </>
                    }
                  >
                    <p style={{ margin: 0 }}>
                      {copy.fileName ? `${copy.fileName} — ` : ""}
                      {copy.body}
                    </p>
                  </HsDialog>
                );
              })()
            : null}
          {/* UI-060 secondary surfaces — modals over the shell, never a
              workspace mode. Recovery paths deep-link into 設定/診断情報. */}
          <ExportDialog
            open={exportOpen}
            onOpenChange={setExportOpen}
            port={exportPort}
            defaultDestination={settings.defaultExportDir}
            toolOverrides={toolOverrides}
            onOpenSettings={(category) => {
              setSettingsFocus(category);
              setView("settings");
            }}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            onAnnounce={setStatusMessage}
          />
          <DiagnosticsSheet
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            port={diagnosticsPort}
            toolOverrides={toolOverrides}
            onAnnounce={setStatusMessage}
          />
          {/* #130 (spec 14): quantization settings on the finished
              score — seeded from the canonical payload's stored
              quantizationSettings; apply goes through the undoable
              score.edit path on the workspace controller. */}
          <RequantizeDialog
            open={requantizeOpen}
            seed={
              requantizeOpen
                ? requantizeSeed(scoreDocument?.canonicalDocument?.())
                : null
            }
            onOpenChange={setRequantizeOpen}
            onApply={(overrides) =>
              scoreCtlRef.current?.requantize?.(overrides)
            }
          />
        </AppShell>
      )}
    </FluentProvider>
  );
}
