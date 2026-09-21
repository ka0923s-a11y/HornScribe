import { useEffect, useMemo, useState } from "react";
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
  createCommands,
  dispatchCommand,
  type CommandContext,
} from "./commands/registry";
import { getShellInfo } from "./tauri/bridge";

type View = "workspace" | "settings";

/**
 * UI-001 spike shell. Screen state is fixed to EMPTY (GUI_UX_SPEC §27):
 * no audio, no score, no engine. The shell proves layout, theming,
 * Japanese copy, keyboard focus, IPC plumbing and the CSP/capability
 * baseline before real features are wired in.
 */
export default function App() {
  const { mode, resolved, select } = useThemeMode();
  const [view, setView] = useState<View>("workspace");
  const [pitch, setPitch] = useState<PitchView>("concert");
  const [statusMessage, setStatusMessage] = useState<string>(ja.status.ready);
  const [shellDetail, setShellDetail] = useState<string | undefined>(
    ja.status.shellInfoLoading,
  );

  // EMPTY state: nothing loaded yet.
  const shellState = useMemo(
    () => ({ hasAudio: false, hasScore: false, reviewCount: 0 }),
    [],
  );
  const commands = useMemo(() => createCommands(shellState), [shellState]);

  const ctx = useMemo<CommandContext>(
    () => ({
      setPitchView: setPitch,
      openAudioRequested: () => setStatusMessage(ja.status.spikeNoFileOpen),
      openSettings: () => setView("settings"),
    }),
    [],
  );

  // Central shortcut dispatch (GUI_UX_SPEC §23).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (dispatchCommand(e, commands, ctx)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commands, ctx]);

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

  return (
    <FluentProvider theme={theme}>
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
              ctx={ctx}
              pitch={pitch}
              onPitch={setPitch}
            />
            <WaveformView />
            <div className="hs-main">
              <ScoreWorkspace onOpenAudio={ctx.openAudioRequested} />
              <PropertiesPanel />
            </div>
            <TransportBar enabled={shellState.hasAudio} />
          </>
        )}
        <StatusBar message={statusMessage} detail={shellDetail} />
      </AppShell>
    </FluentProvider>
  );
}
