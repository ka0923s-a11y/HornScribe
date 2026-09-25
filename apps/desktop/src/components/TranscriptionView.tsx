import { useEffect, useRef, useState } from "react";
import { ja } from "../strings/ja";
import { HsButton } from "./primitives/Button";
import { HsProgress } from "./primitives/Progress";
import type { CommandSurface } from "../commands/registry";
import {
  initialStages,
  type JobView,
  type StageStatus,
  type TranscriptionStageId,
} from "../sidecar/jobView";

/**
 * Transcribing screen body (GUI_UX_SPEC §5, issue UI-040).
 *
 * - Not a modal: rendered inside ScoreWorkspace's score region while the
 *   rest of the shell (transport, waveform, non-score commands) stays
 *   usable.
 * - Stage list is driven ONLY by engine-reported `stage` fields — a job
 *   that reports none (spike demoLongTask) shows every stage pending
 *   rather than a guessed position.
 * - The progress bar is determinate only on real measured work — a
 *   whole-job `progress` fraction for job kinds that compute one, or
 *   the counted units (`step`/`totalSteps`) of the active stage.
 *   #385: stage boundaries carry no fabricated percentage, so a
 *   blocking inference stays honestly indeterminate.
 * - キャンセル sends cooperative `job.cancel`; the button then shows the
 *   honest pending state until the terminal `cancelled` event arrives.
 * - `job` is null while the engine is still spawning/handshaking — the
 *   view renders the same shell indeterminate, with cancel disabled.
 *
 * Screen-reader semantics: the region is labelled, the progress bar is a
 * real `progressbar` (Fluent), the active stage line is `aria-live`, and
 * each stage item exposes `aria-current="step"` while active.
 */

/** mm:ss elapsed readout — tabular-nums friendly, no unstable ETA. */
export function formatElapsedMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stageLabel(id: TranscriptionStageId, status: StageStatus): string {
  const copy = ja.transcription.stages[id];
  return status === "done"
    ? copy.done
    : status === "active"
      ? copy.active
      : copy.pending;
}

export function TranscriptionView({
  job,
  commands,
}: {
  /** Live tracked job view from the transcription session — null while
   *  the engine is still starting (spawn + handshake). */
  job: JobView | null;
  /** Command surface — キャンセル routes through `score.cancelTranscription`
   *  so the button and any future menu item stay the same command. */
  commands: CommandSurface;
}) {
  const cancelling = job?.phase === "cancelling";
  const [now, setNow] = useState(() => Date.now());
  // Before job.start resolves there is no startedAt — the wait is part of
  // the job from the user's point of view, so count from mount.
  const mountedAt = useRef(Date.now());

  // Elapsed readout — 500 ms tick, well under the §28 update budget.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = formatElapsedMs(now - (job?.startedAt ?? mountedAt.current));

  const stages = job?.stages ?? initialStages();
  const activeIndex = job?.activeStageIndex ?? -1;
  const progress = job?.progress ?? null;
  const activeStage = activeIndex >= 0 ? stages[activeIndex] : null;
  const activeStageText = activeStage
    ? stageLabel(activeStage.id, "active")
    : ja.transcription.running;
  const stepCount = job?.stepCount ?? null;
  // #385: the bar is determinate only on real fractions — a whole-job
  // `progress` (job kinds that measure one) or the counted units of
  // the active stage; otherwise it stays honestly indeterminate.
  const barValue =
    progress ??
    (stepCount !== null ? stepCount.step / stepCount.total : undefined);
  const percent = progress !== null ? Math.round(progress * 100) : null;
  const stepText =
    stepCount !== null ? `${stepCount.step}/${stepCount.total}` : null;

  return (
      // No role=status here: the container holds a ticking elapsed readout,
      // and a live region on it would announce every 500ms tick. Only the
      // dedicated stage line below is aria-live.
      <div className="hs-transcribing">
        <h2 className="hs-transcribing__title">{ja.transcription.running}</h2>

        {/* Screen-reader progress: only the changing line is live, not the
            whole list — stage transitions announce once, politely. */}
        <span className="hs-visually-hidden" aria-live="polite">
          {activeStageText}
        </span>

        <HsProgress
          label={ja.transcription.progressAria}
          value={barValue}
          description={activeStageText}
        />
        <div className="hs-transcribing__meta">
          {percent !== null ? (
            <span className="hs-transcribing__percent">{percent}%</span>
          ) : null}
          {stepText !== null ? (
            <span className="hs-transcribing__steps">{stepText}</span>
          ) : null}
          <span className="hs-transcribing__elapsed">
            {ja.transcription.elapsedLabel} {elapsed}
          </span>
        </div>

        <ul className="hs-stage-list" aria-label={ja.transcription.progressAria}>
          {stages.map((stage, i) => (
            <li
              key={stage.id}
              className="hs-stage-list__item"
              data-state={stage.status}
              aria-current={i === activeIndex ? "step" : undefined}
            >
              <span className="hs-stage-list__icon" aria-hidden="true">
                {stage.status === "done"
                  ? "✓"
                  : stage.status === "active"
                    ? "●"
                    : "○"}
              </span>
              <span>{stageLabel(stage.id, stage.status)}</span>
            </li>
          ))}
        </ul>

        <p className="hs-transcribing__note">{ja.transcription.note}</p>

        <HsButton
          variant="secondary"
          loading={cancelling}
          disabled={
            job == null || !commands.isEnabled("score.cancelTranscription")
          }
          onClick={() => commands.invoke("score.cancelTranscription")}
        >
          {cancelling ? ja.transcription.cancelling : ja.transcription.cancel}
        </HsButton>
      </div>
  );
}
