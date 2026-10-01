import { useState } from "react";
import { ja } from "../strings/ja";
import { HsButton } from "./primitives/Button";
import { HsDialog } from "./primitives/Dialog";
import type { FailureKind } from "../sidecar/session";

/**
 * Transcription failure surface (GUI_UX_SPEC §20, §27 TRANSCRIPTION_ERROR).
 *
 * Copy follows the error contract strictly — title (what failed) → body
 * (what is preserved) → actions (recovery). Engine error codes/messages
 * never appear here (JAPANESE_UI_COPY §7); they live in the diagnostics
 * dialog behind the 診断情報 action.
 *
 * The surface lives inside ScoreWorkspace's score region — not a blocking
 * modal — and closing it returns to the last valid screen (a prior score
 * is never destroyed by a failed retranscription).
 */
export function TranscriptionErrorView({
  kind,
  errorCode,
  errorPackage,
  restarting,
  diagnostics,
  onPrimary,
  onClose,
}: {
  /** Which §20 copy block to render. */
  kind: FailureKind;
  /** Engine error code — used only to pick the dependency-missing
   *  copy; the code itself never renders (JAPANESE_UI_COPY §7). */
  errorCode?: string;
  /** ENGINE_DEPENDENCY_MISSING: the missing package name (#195). */
  errorPackage?: string;
  /** エンジンを再起動 in flight — honest pending state on the button. */
  restarting: boolean;
  /** Diagnostics text for the 診断情報 dialog. */
  diagnostics(): string;
  /** Primary recovery action: 再試行 (job failed) or エンジンを再起動
   *  (crash / unresponsive). */
  onPrimary(): void;
  /** Dismiss → back to the last valid workspace state. */
  onClose(): void;
}) {
  const [diagOpen, setDiagOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // #195: a missing engine package can never succeed on retry — the
  // surface names the package and makes diagnostics the lead action.
  const dependencyMissing = errorCode === "ENGINE_DEPENDENCY_MISSING";
  // #153: NO_PITCHED_CONTENT is a content outcome — the audio is fine,
  // it just has no pitched notes. Retry on the same audio fails
  // deterministically, so the lead action becomes "pick another
  // source" (dismiss → back to import/record) and retry drops to the
  // subtle slot.
  const noPitchedContent =
    !dependencyMissing && errorCode === "NO_PITCHED_CONTENT";
  const copy = dependencyMissing
    ? {
        title: ja.errors.dependencyMissing.title,
        body: ja.errors.dependencyMissing.body(
          errorPackage ?? ja.errors.dependencyMissing.unknownPackage,
        ),
      }
    : noPitchedContent
      ? ja.errors.noPitchedContent
      : kind === "transcriptionFailed"
        ? ja.errors.transcriptionFailed
        : kind === "workerCrashed"
          ? ja.errors.workerCrashed
          : ja.errors.workerNotResponding;
  const primaryLabel = dependencyMissing
    ? ja.errors.dependencyMissing.diagnostics
    : noPitchedContent
      ? ja.errors.noPitchedContent.chooseAnother
      : kind === "transcriptionFailed"
        ? ja.errors.transcriptionFailed.retry
        : ja.errors.workerCrashed.restartEngine;

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      {/* role=alert: the failure itself is the announcement — actions stay
          in normal focus order. */}
      <div className="hs-error-surface" role="alert">
        <h2 className="hs-error-surface__title">{copy.title}</h2>
        <p className="hs-error-surface__body">{copy.body}</p>
        <div className="hs-error-surface__actions">
          <HsButton
            variant="primary"
            loading={restarting}
            onClick={
              dependencyMissing
                ? () => setDiagOpen(true)
                : noPitchedContent
                  ? onClose
                  : onPrimary
            }
          >
            {primaryLabel}
          </HsButton>
          <HsButton variant="secondary" onClick={() => setDiagOpen(true)}>
            {ja.common.diagnostics}
          </HsButton>
          <HsButton
            variant="subtle"
            onClick={noPitchedContent ? onPrimary : onClose}
          >
            {noPitchedContent
              ? ja.errors.noPitchedContent.retry
              : ja.errors.close}
          </HsButton>
        </div>
      </div>

      <HsDialog
        open={diagOpen}
        onOpenChange={(open) => {
          setDiagOpen(open);
          if (!open) setCopied(false);
        }}
        title={ja.diagnostics.title}
        actions={
          <>
            <HsButton variant="secondary" onClick={() => void copyDiagnostics()}>
              {copied ? ja.diagnostics.copied : ja.diagnostics.copy}
            </HsButton>
            <HsButton variant="primary" onClick={() => setDiagOpen(false)}>
              {ja.diagnostics.close}
            </HsButton>
          </>
        }
      >
        <pre className="hs-diagnostics">{diagnostics()}</pre>
      </HsDialog>
    </>
  );
}
