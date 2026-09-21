import { useState, type ReactNode } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import {
  ImportScreenBody,
  type ImportView,
} from "../import/ImportStates";
import type { ScreenState } from "../workspace/screen";

/**
 * Score workspace (GUI_UX_SPEC §3/§4/§5/§6, §27 screen state machine).
 * The score is always the primary surface — properties collapse before it
 * narrows (§21). Content is state-driven:
 *   empty / openingAudio / audioReady / audioError / sourceMissing
 *              → import-owned bodies (src/import/ImportStates.tsx, UI-020)
 *   transcribing → the job-driven body injected via `transcribingBody`
 *                  (UI-040 renders the real stage/progress/cancel view)
 *   transcriptionError → §20 surface injected via `transcriptionErrorBody`
 *   scoreReady+  → score paper placeholder (real rendering is UI-003)
 *
 * The region is the §3 drop target: HTML5 drops hand `File` objects to
 * `onDropFiles` (browser dev), while the Tauri window emits native
 * drag-drop path events (see import/nativeDrop.ts) which App routes into
 * the same import flow — `externalDragActive` keeps the affordance lit for
 * both paths.
 */
export function ScoreWorkspace({
  screen,
  importView,
  externalDragActive = false,
  onDropFiles,
  onTranscribe,
  transcribingBody,
  transcriptionErrorBody,
}: {
  screen: ScreenState;
  importView: ImportView;
  /** Native (Tauri) drag-over state — merged with the HTML5 one. */
  externalDragActive?: boolean;
  /** HTML5 file drop (browser dev); Tauri drops arrive as paths via App. */
  onDropFiles(files: readonly File[]): void;
  onTranscribe(): void;
  /** [UI-040] live transcription job view — provided by the shell while a
   *  job runs; when absent a minimal honest placeholder renders. */
  transcribingBody?: ReactNode;
  /** [UI-040] §20 failure/recovery surface for TRANSCRIPTION_ERROR. */
  transcriptionErrorBody?: ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);
  const dragActive = dragOver || externalDragActive;
  return (
    <main
      className={mergeClasses("hs-score", dragActive && "hs-score--dragover")}
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
        // Browser-dev path: DataTransfer carries File objects. Inside the
        // Tauri webview this event does not fire (dragDropEnabled routes
        // drops through onDragDropEvent — see import/nativeDrop.ts).
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length > 0) onDropFiles(files);
      }}
    >
      {screen === "transcribing" ? (
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
      ) : screen === "scoreReady" ||
        screen === "reviewing" ||
        screen === "exporting" ? (
        <div className="hs-score-paper" aria-hidden="true">
          <span className="hs-score-paper__placeholder">
            {ja.score.placeholder}
          </span>
        </div>
      ) : (
        <ImportScreenBody
          screen={screen}
          view={importView}
          onTranscribe={onTranscribe}
        />
      )}
    </main>
  );
}
