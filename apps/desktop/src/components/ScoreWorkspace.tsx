import { useState } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { FolderOpen24Regular, Play24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsButton } from "./primitives/Button";
import { HsProgress } from "./primitives/Progress";
import type { ScreenState } from "../workspace/screen";

/**
 * Score workspace (GUI_UX_SPEC §3/§4/§5/§6, §27 screen state machine).
 * The score is always the primary surface — properties collapse before it
 * narrows (§21). Content is state-driven:
 *   empty        → drop target + single open CTA, nothing else (§3)
 *   audioReady   → "まだ楽譜はありません" + 採譜を開始 (§4)
 *   transcribing → stage list + honest indeterminate progress (§5)
 *   scoreReady+  → score paper placeholder (real rendering is UI-003)
 */
export function ScoreWorkspace({
  screen,
  onOpenAudio,
  onTranscribe,
}: {
  screen: ScreenState;
  onOpenAudio(): void;
  onTranscribe(): void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <main
      className={mergeClasses("hs-score", dragOver && "hs-score--dragover")}
      role="region"
      aria-label={ja.score.regionLabel}
      data-hs-focus-zone="score"
      tabIndex={0}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        // Browser-dev affordance: Tauri delivers file drops natively; in a
        // plain webview this still routes to the open command path.
        e.preventDefault();
        setDragOver(false);
        onOpenAudio();
      }}
    >
      {screen === "empty" ? (
        <div className="hs-empty">
          <p className="hs-empty__title">{ja.emptyState.title}</p>
          <p className="hs-empty__or">{ja.emptyState.or}</p>
          <HsButton
            variant="primary"
            size="large"
            icon={<FolderOpen24Regular />}
            onClick={onOpenAudio}
          >
            {ja.emptyState.open}
          </HsButton>
          <p className="hs-empty__formats">{ja.emptyState.formats}</p>
          <p className="hs-empty__privacy">{ja.emptyState.privacy}</p>
        </div>
      ) : screen === "audioReady" ? (
        <div className="hs-empty">
          <p className="hs-score__empty-title">{ja.score.empty}</p>
          <HsButton
            variant="primary"
            size="large"
            icon={<Play24Regular />}
            onClick={onTranscribe}
          >
            {ja.score.transcribeStart}
          </HsButton>
        </div>
      ) : screen === "transcribing" ? (
        <div className="hs-transcribing" role="status">
          <p className="hs-transcribing__title">{ja.transcription.title}</p>
          <ul className="hs-stage-list">
            <li className="hs-stage hs-stage--done">
              <span className="hs-stage__icon" aria-hidden="true">
                ✓
              </span>
              {ja.transcription.stageDone}
            </li>
            <li className="hs-stage hs-stage--active">
              <span className="hs-stage__icon" aria-hidden="true">
                ●
              </span>
              {ja.transcription.stageActive}
            </li>
            <li className="hs-stage">
              <span className="hs-stage__icon" aria-hidden="true">
                ○
              </span>
              {ja.transcription.stageRhythm}
            </li>
            <li className="hs-stage">
              <span className="hs-stage__icon" aria-hidden="true">
                ○
              </span>
              {ja.transcription.stageScore}
            </li>
            <li className="hs-stage">
              <span className="hs-stage__icon" aria-hidden="true">
                ○
              </span>
              {ja.transcription.stagePrepare}
            </li>
          </ul>
          {/* §5: indeterminate while no honest percentage exists. */}
          <HsProgress label={ja.transcription.title} />
          <HsButton variant="secondary" onClick={onTranscribe}>
            {ja.transcription.cancel}
          </HsButton>
        </div>
      ) : (
        <div className="hs-score-paper" aria-hidden="true">
          <span className="hs-score-paper__placeholder">
            {ja.score.placeholder}
          </span>
        </div>
      )}
    </main>
  );
}
