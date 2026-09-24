import { useState, type ReactNode } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import {
  ImportScreenBody,
  type ImportView,
} from "../import/ImportStates";
import type { ScreenState } from "../workspace/screen";
import { ScoreReadyWorkspace } from "../score/ScoreReadyWorkspace";
import type { ScoreDocumentPort } from "../score/document";
import type { InspectorModel } from "../score/inspector";
import type {
  ScoreWorkspaceController,
  ScoreWorkspaceState,
} from "../score/controller";
import type { RhythmEditInvoker } from "../score/rhythmEdits";
import type { ScoreViewMode } from "../score/verovio";
import type { PitchView } from "./PitchSegmented";

/* #115: engine rhythm edits swap a document's content in place — its
 * revisionId changes without the workspace needing a remount (a remount
 * would drop the selection + the shared undo stack). React still needs
 * a string key, so each document instance gets a stable id from a
 * WeakMap: same object → same key across content swaps, a genuinely new
 * document (new transcription, project load) → a new key → remount. */
const documentKeys = new WeakMap<ScoreDocumentPort, number>();
let nextDocumentKey = 0;
function keyForDocument(doc: ScoreDocumentPort): string {
  let id = documentKeys.get(doc);
  if (id === undefined) {
    id = nextDocumentKey;
    nextDocumentKey += 1;
    documentKeys.set(doc, id);
  }
  return `doc-${id}`;
}

/**
 * Score workspace (GUI_UX_SPEC §3/§4/§5/§6, §27 screen state machine).
 * The score is always the primary surface — properties collapse before it
 * narrows (§21). Content is state-driven:
 *   empty / openingAudio / audioReady / audioError / sourceMissing
 *              → import-owned bodies (src/import/ImportStates.tsx, UI-020)
 *   transcribing → the job-driven body injected via `transcribingBody`
 *                  (UI-040 renders the real stage/progress/cancel view)
 *   transcriptionError → §20 surface injected via `transcriptionErrorBody`
 *   scoreReady+  → the production score workspace (UI-030, src/score/)
 *                  once a `ScoreDocumentPort` exists; paper placeholder
 *                  otherwise.
 *
 * The region is the §3 drop target: HTML5 drops hand `File` objects to
 * `onDropFiles` (browser dev), while the Tauri window emits native
 * drag-drop path events (see import/nativeDrop.ts) which App routes into
 * the same import flow — `externalDragActive` keeps the affordance lit for
 * both paths.
 *
 * The UI-030 props are additive: while no `ScoreDocumentPort` is wired the
 * shell states keep working untouched; once the document exists the real
 * score takes over the region.
 */
export function ScoreWorkspace({
  screen,
  importView,
  externalDragActive = false,
  onDropFiles,
  onTranscribe,
  transcribingBody,
  transcriptionErrorBody,
  scoreDocument = null,
  pitch = "concert",
  initialViewMode = "continuous",
  followPlayback = true,
  onInspectorChange,
  onScoreStateChange,
  scoreControllerRef,
  announce,
  transport = null,
  sourceControl = null,
  onRhythmEdit,
  onRetranscribeVoices,
  onRetranscribeBasicPitch,
  onOpenProperties,
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
  /** [UI-030] present when the screen machine says a score exists; the
   *  port abstracts fixture vs engine data. */
  scoreDocument?: ScoreDocumentPort | null;
  pitch?: PitchView;
  /** 設定→楽譜 初期表示 (continuous/page) — seeds the view mode. */
  initialViewMode?: ScoreViewMode;
  /** 設定→再生 再生位置を追従 — seeds the follow toggle. */
  followPlayback?: boolean;
  onInspectorChange?(model: InspectorModel): void;
  onScoreStateChange?(state: ScoreWorkspaceState): void;
  scoreControllerRef?(controller: ScoreWorkspaceController | null): void;
  announce?(message: string): void;
  /** [UI-020→UI-030] live media-transport mirror — when set, the score
   *  clock follows the real audio clock (UI-005 one-clock contract). */
  transport?: {
    readonly isPlaying: boolean;
    readonly positionSec: number;
    readonly rate?: number;
  } | null;
  /** [UI-050] drive the media transport for 元音源を再生 / jump-to-issue
   *  (seek + A-B loop on the issue's source range); null when no source
   *  is loaded — the score clock covers that case. */
  sourceControl?: {
    seekTo(sec: number): void;
    play(): void;
    setLoop(range: { start: number; end: number } | null): void;
  } | null;
  /** #115: engine score.edit invoker for rhythm edits — absent for
   *  fixture/dev documents (the commands announce unavailable). */
  onRhythmEdit?: RhythmEditInvoker;
  /** #148: review-bar action — re-run the job with the voices texture
   *  when auto detected a mix. Absent for fixture/dev documents. */
  onRetranscribeVoices?(): void;
  /** #181: review-bar action — re-run the job with the Basic Pitch
   *  backend when pYIN produced a monophonic result. */
  onRetranscribeBasicPitch?(): void;
  /** #209: review-bar action — open the properties panel so the
   *  meter-conflict issue can reach the meter select. */
  onOpenProperties?(): void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const dragActive = dragOver || externalDragActive;
  const scoreState =
    screen === "scoreReady" ||
    screen === "reviewing" ||
    screen === "exporting";
  const showScore = scoreState && scoreDocument !== null;
  return (
    <main
      className={mergeClasses(
        "hs-score",
        dragActive && "hs-score--dragover",
        showScore && "hs-score--ready",
      )}
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
      ) : scoreState ? (
        showScore && scoreDocument ? (
          <ScoreReadyWorkspace
            key={keyForDocument(scoreDocument)}
            document={scoreDocument}
            pitch={pitch}
            initialViewMode={initialViewMode}
            followPlayback={followPlayback}
            onInspectorChange={(m) => onInspectorChange?.(m)}
            onStateChange={(s) => onScoreStateChange?.(s)}
            controllerRef={(c) => scoreControllerRef?.(c)}
            announce={(m) => announce?.(m)}
            transport={transport}
            sourceControl={sourceControl}
            onRhythmEdit={onRhythmEdit}
            onRetranscribeVoices={onRetranscribeVoices}
            onRetranscribeBasicPitch={onRetranscribeBasicPitch}
            onOpenProperties={onOpenProperties}
          />
        ) : (
          <div className="hs-score-paper" aria-hidden="true">
            <span className="hs-score-paper__placeholder">
              {ja.score.placeholder}
            </span>
          </div>
        )
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
