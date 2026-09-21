import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
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
import { cycleFocusZone } from "./focus/zones";
import { getShellInfo } from "./tauri/bridge";

type View = "workspace" | "settings";

/** "#/dev/gallery" — dev-only internal component gallery (UI-010). */
const GALLERY_HASH = "#/dev/gallery";
// Lazy so the gallery (and its Fluent imports) stay out of the prod bundle.
const DevGallery = import.meta.env.DEV
  ? lazy(() => import("./dev/Gallery"))
  : null;

/** Japanese display name for a focus zone (for status announcements). */
function zoneName(id: string): string {
  const names: Record<string, string> = ja.commandFeedback.zoneNames;
  return names[id] ?? id;
}

/**
 * UI-001 spike shell driven by the UI-012 command architecture
 * (GUI_UX_SPEC §22/§23). Screen state is fixed to EMPTY (§27): no audio, no
 * score, no engine. The shell proves layout, theming, Japanese copy,
 * keyboard/focus behavior, IPC plumbing and the CSP/capability baseline
 * before real features are wired in.
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

  // The registry is static: predicates read the snapshot, not React state.
  const registry = useMemo(() => createCommandRegistry(), []);

  // EMPTY state (§27): nothing loaded yet — transport/edit/export commands
  // evaluate disabled from this snapshot on every surface at once.
  const snapshot = useMemo<CommandSnapshot>(
    () => ({
      hasAudio: false,
      hasScore: false,
      isTranscribing: false,
      isPlaying: false,
      loopEnabled: false,
      pitch,
      canUndo: false,
      canRedo: false,
      hasSelection: false,
      reviewOpen: false,
      reviewCount: 0,
      view,
    }),
    [pitch, view],
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
      // F6 / Shift+F6 region cycling (§22) — the only fully-working
      // transport-independent commands in the spike.
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

  // Hash routing is only used for the internal dev gallery; the product
  // shell is a single workspace (GUI_UX_SPEC §2), not a page router.
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
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
    <FluentProvider theme={theme}>
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
              <CommandBar commands={commands} pitch={pitch} />
              <WaveformView />
              <div className="hs-main">
                <ScoreWorkspace
                  onOpenAudio={() => commands.invoke("file.openAudio")}
                />
                <PropertiesPanel />
              </div>
              <TransportBar commands={commands} />
            </>
          )}
          <StatusBar message={statusMessage} detail={shellDetail} />
        </AppShell>
      )}
    </FluentProvider>
  );
}
