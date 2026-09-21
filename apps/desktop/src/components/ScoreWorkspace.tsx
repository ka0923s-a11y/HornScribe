import { useState, type ReactNode } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { FolderOpen24Regular, Play24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsButton } from "./primitives/Button";
import type { ScreenState } from "../workspace/screen";

/**
 * Score workspace (GUI_UX_SPEC §3/§4/§5/§6, §27 screen state machine).
 * The score is always the primary surface — properties collapse before it
 * narrows (§21). Content is state-driven:
 *   empty        → drop target + single open CTA, nothing else (§3)
 *   audioReady   → "まだ楽譜はありません" + 採譜を開始 (§4)
 *   transcribing → the job-driven body injected via `transcribingBody`
 *                  (UI-040 renders the real stage/progress/cancel view)
 *   transcriptionError → §20 surface injected via `transcriptionErrorBody`
 *   scoreReady+  → score paper placeholder (real rendering is UI-003)
 */
export function ScoreWorkspace({
  screen,
  onOpenAudio,
  onTranscribe,
  transcribingBody,
  transcriptionErrorBody,
}: {
  screen: ScreenState;
  onOpenAudio(): void;
  onTranscribe(): void;
  /** [UI-040] live transcription job view — provided by the shell while a
   *  job runs; when absent a minimal honest placeholder renders. */
  transcribingBody?: ReactNode;
  /** [UI-040] §20 failure/recovery surface for TRANSCRIPTION_ERROR. */
  transcriptionErrorBody?: ReactNode;
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
        // UI-040 owns this body (real job-driven stage/progress/cancel).
        // The fallback is honest too: no stages claimed, indeterminate bar.
        (transcribingBody ?? (
          <div className="hs-transcribing" role="status">
            <p className="hs-transcribing__title">{ja.transcription.running}</p>
          </div>
        ))
      ) : screen === "transcriptionError" ? (
        transcriptionErrorBody ?? (
          <div className="hs-error-surface" role="alert">
            <h2 className="hs-error-surface__title">
              {ja.errors.transcriptionFailed.title}
            </h2>
            <p className="hs-error-surface__body">
              {ja.errors.transcriptionFailed.body}
            </p>
          </div>
        )
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
