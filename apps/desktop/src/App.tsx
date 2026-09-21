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
import { TransportBar } from "./components/TransportBar";
import { StatusBar } from "./components/StatusBar";
import { SettingsView } from "./components/SettingsView";
import type { PitchView } from "./components/PitchSegmented";
import {
  createCommandRegistry,
  createCommandSurface,
  type CommandContext,
  type CommandSnapshot,
} from "./commands/registry";
import { KeyboardDispatcher } from "./keyboard/dispatcher";
import { useCommandKeyboard } from "./keyboard/useCommandKeyboard";
import { cycleFocusZone, focusZone } from "./focus/zones";
import { getShellInfo } from "./tauri/bridge";
import {
  regionVisibility,
  commandStateFor,
  SCREEN_STATES,
  type ScreenState,
} from "./workspace/screen";
import { NO_SELECTION } from "./workspace/inspector";
import { useWorkspaceLayout } from "./workspace/layout";
import { initWindowGeometryPersistence } from "./workspace/windowGeometry";

type View = "workspace" | "settings";

/** "#/dev/gallery" — dev-only internal component gallery (UI-010). */
const GALLERY_HASH = "#/dev/gallery";
/** "#/dev/state/<screen>" — dev-only screen-state override so the
 *  responsive layout can be verified in every machine state (§27) before
 *  the real audio/score features land. No-op in packaged builds. */
const STATE_HASH_PREFIX = "#/dev/state/";
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

/** Japanese display name for a focus zone (for status announcements). */
function zoneName(id: string): string {
  const names: Record<string, string> = ja.commandFeedback.zoneNames;
  return names[id] ?? id;
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
  const [statusMessage, setStatusMessage] = useState<string>(ja.status.ready);
  const [shellDetail, setShellDetail] = useState<string | undefined>(
    ja.status.shellInfoLoading,
  );
  const [hash, setHash] = useState(() => window.location.hash);
  // Screen state machine (§27). The live app is EMPTY until file/engine
  // plumbing lands; dev builds can override via "#/dev/state/<name>".
  const [screen, setScreen] = useState<ScreenState>("empty");
  const layout = useWorkspaceLayout();

  const regions = regionVisibility(screen);
  // Inspector contract: no selection model exists yet (UI-003+); the panel
  // renders the "none" body when opened manually.
  const inspector = NO_SELECTION;
  const propertiesVisible = regions.properties && layout.propertiesOpen;
  // Dev-state placeholder: REVIEWING pretends a score with open issues so
  // the 要確認 surfaces exercise their populated rendering.
  const reviewCount = screen === "reviewing" ? 12 : 0;

  // The registry is static: predicates read the snapshot, not React state.
  const registry = useMemo(() => createCommandRegistry(), []);

  // Screen machine → command snapshot (§23). Playback/undo/selection stay
  // false until their feature issues land; isTranscribing is the field that
  // keeps score-writing commands disabled while a transcription runs (§5).
  const snapshot = useMemo<CommandSnapshot>(
    () => ({
      ...commandStateFor(screen),
      isPlaying: false,
      loopEnabled: false,
      pitch,
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      reviewCount,
      view,
    }),
    [screen, pitch, reviewCount, view],
  );

  const ctx = useMemo<CommandContext>(
    () => ({
      openAudio: () => setStatusMessage(ja.status.spikeNoFileOpen),
      transcribe: () => setStatusMessage(ja.commandFeedback.notImplemented),
      togglePlayPause: () =>
        setStatusMessage(ja.commandFeedback.notImplemented),
      stop: () => setStatusMessage(ja.commandFeedback.notImplemented),
      jumpBack: () => setStatusMessage(ja.commandFeedback.notImplemented),
      jumpForward: () => setStatusMessage(ja.commandFeedback.notImplemented),
      seekToStart: () => setStatusMessage(ja.commandFeedback.notImplemented),
      seekToEnd: () => setStatusMessage(ja.commandFeedback.notImplemented),
      toggleLoop: () => setStatusMessage(ja.commandFeedback.notImplemented),
      setPitchView: (v) => {
        setPitch(v);
        setStatusMessage(
          v === "concert"
            ? ja.commandFeedback.pitchConcert
            : ja.commandFeedback.pitchHornF,
        );
      },
      openReview: () => setStatusMessage(ja.commandFeedback.notImplemented),
      reviewNext: () => setStatusMessage(ja.commandFeedback.notImplemented),
      reviewPrevious: () =>
        setStatusMessage(ja.commandFeedback.notImplemented),
      undo: () => setStatusMessage(ja.commandFeedback.notImplemented),
      redo: () => setStatusMessage(ja.commandFeedback.notImplemented),
      openExport: () => setStatusMessage(ja.commandFeedback.notImplemented),
      zoomScoreIn: () => setStatusMessage(ja.commandFeedback.notImplemented),
      zoomScoreOut: () => setStatusMessage(ja.commandFeedback.notImplemented),
      zoomScoreFit: () => setStatusMessage(ja.commandFeedback.notImplemented),
      clearSelection: () =>
        setStatusMessage(ja.commandFeedback.notImplemented),
      openSettings: () => setView("settings"),
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
    [],
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
        .querySelector('.hs-properties')
        ?.contains(document.activeElement) ?? false;
    layout.setPropertiesOpen(false);
    if (focusInside) {
      requestAnimationFrame(() => focusZone("score"));
    }
  }, [layout]);

  // 採譜 / キャンセル share one callback: the command is disabled while a
  // transcription runs (§5), so the cancel affordance falls through to an
  // honest "not implemented yet" announcement instead of silently no-oping.
  const transcribeClicked = useCallback(() => {
    if (!commands.invoke("score.transcribe")) {
      setStatusMessage(ja.commandFeedback.notImplemented);
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
        setScreen(forced);
        setView("workspace");
      }
    };
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
          <TitleBar />
          {view === "settings" ? (
            <div className="hs-settings-wrap">
              <SettingsView
                themeMode={mode}
                onThemeMode={select}
                onBack={() => setView("workspace")}
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
              />
              {regions.waveform ? (
                <WaveformView
                  height={layout.waveformHeight}
                  min={layout.waveformMin}
                  max={layout.waveformMax}
                  onResize={layout.requestWaveformHeight}
                  onReset={layout.resetWaveformHeight}
                />
              ) : null}
              <div className="hs-main">
                <ScoreWorkspace
                  screen={screen}
                  onOpenAudio={() => commands.invoke("file.openAudio")}
                  onTranscribe={transcribeClicked}
                />
                {propertiesVisible ? (
                  <PropertiesPanel
                    content={inspector}
                    width={layout.propertiesWidth}
                    min={layout.propertiesMin}
                    max={layout.propertiesMax}
                    overlay={layout.breakpoint === "compact"}
                    onResize={layout.requestPropertiesWidth}
                    onReset={layout.resetPropertiesWidth}
                    onClose={closeProperties}
                  />
                ) : null}
              </div>
              {regions.transport ? <TransportBar commands={commands} /> : null}
            </>
          )}
          <StatusBar message={statusMessage} detail={shellDetail} />
        </AppShell>
      )}
    </FluentProvider>
  );
}
