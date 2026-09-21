import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@fluentui/react-components";
import { Play24Regular } from "@fluentui/react-icons";
import { ja } from "../../strings/ja";
import {
  NOTES,
  buildIssues,
  type MockNote,
  type PitchView,
} from "../mockData";
import { useMockPlayer } from "../useMockPlayer";
import { useProtoKeys } from "../useProtoKeys";
import { ProtoScore } from "../ProtoScore";
import {
  ProtoProperties,
  ProtoShell,
  ReviewBanner,
  type ProtoCommand,
  type ProtoShellState,
} from "../ProtoChrome";

type ShellScreen = "empty" | "audioReady" | "transcribing" | "scoreReady";

const STAGES = [
  "preparingAudio",
  "transcribing",
  "cleaning",
  "analyzingRhythm",
  "quantizing",
  "buildingScore",
  "rendering",
] as const;

/**
 * P1 — app shell state. Walks the §27 screen machine with mock data:
 * EMPTY → AUDIO_READY → TRANSCRIBING → SCORE_READY. Validates that the
 * five shell regions (command bar / waveform / score / properties /
 * transport) hold up in every state.
 */
const PARAM_TO_SCREEN: Record<string, ShellScreen> = {
  empty: "empty",
  audio: "audioReady",
  transcribing: "transcribing",
  score: "scoreReady",
};

const SCREEN_TO_PARAM: Record<ShellScreen, string> = {
  empty: "empty",
  audioReady: "audio",
  transcribing: "transcribing",
  scoreReady: "score",
};

export function ShellPage({ initial }: { initial?: string }) {
  const [screen, setScreen] = useState<ShellScreen>(
    () => PARAM_TO_SCREEN[initial ?? ""] ?? "empty",
  );
  const [pitch, setPitch] = useState<PitchView>("concert");
  const [stage, setStage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(ja.status.ready);
  const [propsOpen, setPropsOpen] = useState(false);
  const player = useMockPlayer();

  const issues = useMemo(() => buildIssues(), []);
  const notes = useMemo<MockNote[]>(() => NOTES.map((n) => ({ ...n })), []);

  // Deterministic stage progression while TRANSCRIBING (mock timer).
  useEffect(() => {
    if (screen !== "transcribing") return;
    if (stage >= STAGES.length) {
      setScreen("scoreReady");
      setStatus(ja.prototype.transcribing.completed);
      return;
    }
    const id = window.setTimeout(() => setStage((s) => s + 1), 1100);
    return () => window.clearTimeout(id);
  }, [screen, stage]);

  const onCommand = useCallback((id: ProtoCommand) => {
    switch (id) {
      case "open":
        window.location.hash = "#/prototype/shell/audio";
        break;
      case "transcribe":
        window.location.hash = "#/prototype/shell/transcribing";
        break;
      case "review":
        window.location.hash = "#/prototype/review";
        break;
      case "export":
        window.location.hash = "#/prototype/export";
        break;
      case "settings":
        setStatus("設定画面はこのプロトタイプでは省略しています");
        break;
    }
  }, []);

  useProtoKeys(
    useMemo(
      () => [
        { combo: "Ctrl+o", run: () => onCommand("open") },
        { combo: "Ctrl+1", run: () => setPitch("concert") },
        { combo: "Ctrl+2", run: () => setPitch("hornF") },
        { combo: "Space", run: player.togglePlay, enabled: () => screen !== "empty" },
        { combo: "Escape", run: () => setSelectedId(null) },
      ],
      [onCommand, player.togglePlay, screen],
    ),
  );

  const state: ProtoShellState = {
    hasAudio: screen !== "empty",
    hasScore: screen === "scoreReady",
    reviewCount: screen === "scoreReady" ? issues.length : 0,
    transcribing: screen === "transcribing",
  };

  const selected = notes.find((n) => n.id === selectedId) ?? null;

  const devBar = (
    <div className="hs-proto-dev" role="group" aria-label={ja.prototype.dev.controlsLabel}>
      <span className="hs-proto-dev__label">{ja.prototype.dev.controlsLabel}</span>
      <span>{ja.prototype.dev.stateLabel}:</span>
      {(
        [
          ["empty", ja.prototype.shell.stateEmpty],
          ["audioReady", ja.prototype.shell.stateAudioReady],
          ["transcribing", ja.prototype.shell.stateTranscribing],
          ["scoreReady", ja.prototype.shell.stateScoreReady],
        ] as const
      ).map(([key, label]) => (
        <Button
          key={key}
          size="small"
          appearance={screen === key ? "primary" : "secondary"}
          onClick={() => {
            // hash change remounts the page → deterministic state
            window.location.hash = `#/prototype/shell/${SCREEN_TO_PARAM[key]}`;
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  );

  return (
    <>
      {devBar}
      <ProtoShell
        documentTitle={screen === "empty" ? undefined : ja.prototype.shell.docTitle}
        state={state}
        pitch={pitch}
        onPitch={setPitch}
        onCommand={onCommand}
        player={player}
        transportEnabled={screen !== "empty"}
        status={status}
        properties={
          screen === "scoreReady" ? (
            <ProtoProperties
              note={selected}
              pitch={pitch}
              open={propsOpen}
              onClose={() => setPropsOpen(false)}
              onReopen={() => setPropsOpen(true)}
            />
          ) : undefined
        }
        banner={
          screen === "scoreReady" ? (
            <ReviewBanner count={issues.length} onOpen={() => onCommand("review")} />
          ) : undefined
        }
      >
        {screen === "empty" && (
          <main className="hs-score" role="region" aria-label={ja.score.regionLabel} tabIndex={0}>
            <div className="hs-empty">
              <p className="hs-empty__title">{ja.emptyState.title}</p>
              <p className="hs-empty__or">{ja.emptyState.or}</p>
              <Button
                appearance="primary"
                size="large"
                icon={<Play24Regular />}
                onClick={() => onCommand("open")}
              >
                {ja.emptyState.open}
              </Button>
              <p className="hs-empty__formats">{ja.emptyState.formats}</p>
              <p className="hs-empty__privacy">{ja.emptyState.privacy}</p>
            </div>
          </main>
        )}

        {screen === "audioReady" && (
          <main className="hs-score" role="region" aria-label={ja.score.regionLabel} tabIndex={0}>
            <div className="hs-empty">
              <p className="hs-empty__title">{ja.prototype.scoreEmpty.body}</p>
              <Button
                appearance="primary"
                size="large"
                icon={<Play24Regular />}
                onClick={() => onCommand("transcribe")}
              >
                {ja.prototype.scoreEmpty.cta}
              </Button>
            </div>
          </main>
        )}

        {screen === "transcribing" && (
          <main className="hs-score" role="region" aria-label={ja.score.regionLabel}>
            <div className="hs-proto-stages" aria-live="polite">
              <h2 className="hs-proto-stages__title">
                {ja.prototype.transcribing.running}
              </h2>
              <ul className="hs-proto-stages__list">
                {STAGES.map((key, i) => {
                  const label = ja.prototype.transcribing.stages[key];
                  const st = i < stage ? "done" : i === stage ? "active" : "pending";
                  return (
                    <li key={key} className="hs-proto-stages__item" data-state={st}>
                      <span className="hs-proto-stages__icon" aria-hidden="true">
                        {st === "done" ? "✓" : st === "active" ? "●" : "○"}
                      </span>
                      <span>{st === "done" ? label.done : st === "active" ? label.active : label.pending}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="hs-proto-stages__note">{ja.prototype.shell.transcribeNote}</p>
              <Button onClick={() => setScreen("audioReady")}>
                {ja.prototype.transcribing.cancel}
              </Button>
            </div>
          </main>
        )}

        {screen === "scoreReady" && (
          <ProtoScore
            notes={notes}
            pitch={pitch}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setPropsOpen(true);
            }}
            positionSec={player.playing ? player.positionSec : null}
            issues={issues}
            onBackgroundClick={() => setSelectedId(null)}
          />
        )}
      </ProtoShell>
    </>
  );
}
