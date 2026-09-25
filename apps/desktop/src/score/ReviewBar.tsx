/**
 * 要確認 review header (UI-050, GUI_UX_SPEC §12).
 *
 * Spec header: 「要確認 n / total」＋ [前へ] [元音源を再生] [問題なし]
 * [次へ]. The P4 prototype's validated flow is productionized here: every
 * action is a real button (Tab/Enter reachable) AND a registry-bound
 * shortcut shown in the tooltip — 20+ items are processable without ever
 * opening a menu.
 *
 * Visual rule (issue body + §12/§15): the review state is expressed by a
 * text badge (要確認 + severity label), the reason's Japanese title/detail
 * and the position counter — never by color alone and never by a raw
 * confidence number (モデル確信度 is shown only as labelled evidence).
 */
import { ja } from "../strings/ja";
import type { RefObject } from "react";
import { HsButton } from "../components/primitives/Button";
import { HsTooltip } from "../components/primitives/Tooltip";
import { issueConfidence, type ScoreReviewIssue } from "./review";
import { List24Regular } from "@fluentui/react-icons";

export interface ReviewBarCopy {
  reasonTitle: string;
  reasonDetail: string;
  severityLabel: string;
  statusLabel: string;
}

export interface ReviewBarProps {
  /** Current cursor (0-based) into the full issue list. */
  readonly index: number;
  /** Total issues in this revision's list. */
  readonly total: number;
  /** Issues still open. */
  readonly pending: number;
  /** #272: issues the engine detected but the surfacing cap omitted —
   *  shown so a truncated list is never silent (0 = hide). */
  readonly omitted?: number;
  // #360: expanding the omitted tail — when the document can supply
  //  the deferred issues, the count turns into a one-click 展開.
  onExpandOmitted?(): void;
  readonly issue: ScoreReviewIssue | null;
  readonly copy: ReviewBarCopy | null;
  /** True when the focused issue's primary note is currently deleted. */
  readonly noteDeleted: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Note-edit capability: false on whole-piece issues (meter_conflict,
   *  monophonic_backend, ...) where pitch +/- and delete would be silent
   *  no-ops. Buttons stay visible but disabled with an explanation. */
  readonly canEditNotes: boolean;
  /** False when the issue has no audible range to loop. */
  readonly canPlaySource: boolean;
  /** Optional one-click remedy for issues that carry a direct fix
   *  (built by buildReviewAction - label, tooltip and handler always
   *  come from the same decision). */
  readonly action?: {
    readonly label: string;
    readonly tooltip: string;
    run(): void;
  } | null;
onPrev(): void;
onNext(): void;
  /** #361: the ReviewNavigator popover — 一覧 opens/closes it; the
   *  button stays a toggle (aria-pressed mirrors the open state). */
  readonly navigatorOpen: boolean;
  onToggleNavigator(): void;
  /** Focus lands back here when the navigator closes (Esc / jump). */
  readonly navigatorButtonRef?: RefObject<HTMLButtonElement>;
onPlaySource(): void;
  onAccept(): void;
  onDismiss(): void;
  onPitch(delta: number): void;
  onDeleteOrRestore(): void;
  onUndo(): void;
  onRedo(): void;
  onExit(): void;
}

function withKey(label: string, key: string): string {
  return `${label}（${key}）`;
}

export function ReviewBar({
  index,
  total,
  pending,
  omitted = 0,
  onExpandOmitted,
  issue,
  copy,
  noteDeleted,
  canUndo,
  canRedo,
  canEditNotes,
  canPlaySource,
  action = null,
  onPrev,
  onNext,
  navigatorOpen,
  onToggleNavigator,
  navigatorButtonRef,
  onPlaySource,
  onAccept,
  onDismiss,
  onPitch,
  onDeleteOrRestore,
  onUndo,
  onRedo,
  onExit,
}: ReviewBarProps) {
  const r = ja.review;
  const allDone = pending === 0;
  const confidence = issue ? issueConfidence(issue) : null;
  // Note-edit buttons on a whole-piece issue get the reason tooltip so
  // the disabled state explains itself (shortcut key suffix omitted -
  // the shortcut is inert too).
  const noteEditTip = (label: string, key: string) =>
    canEditNotes ? withKey(label, key) : r.noteTargetRequired;
  return (
    <div
      className="hs-score-reviewbar"
      role="region"
      aria-label={r.regionLabel}
    >
      <div className="hs-score-reviewbar__row hs-score-reviewbar__row--status">
        <strong className="hs-score-reviewbar__position" aria-live="polite">
          {allDone ? r.allDone : r.position(index + 1, total)}
        </strong>
        {!allDone && (
          <span className="hs-score-reviewbar__remaining">
            {r.remaining(pending)}
          </span>
        )}
        {omitted > 0 && (
          onExpandOmitted ? (
            <button
              type="button"
              className="hs-score-reviewbar__omitted hs-score-reviewbar__omitted--action"
              onClick={onExpandOmitted}
            >
              {r.expandOmitted(omitted)}
            </button>
          ) : (
            <span className="hs-score-reviewbar__omitted">
              {r.omitted(omitted)}
            </span>
          )
        )}
        {issue && copy && (
          <>
            <span className="hs-score-reviewbar__badge">
              {ja.reviewBadge.needsReview}
            </span>
            <span className="hs-score-reviewbar__reason">
              {copy.reasonTitle}
            </span>
            <span className="hs-score-reviewbar__detail">
              {copy.reasonDetail}
            </span>
            <span className="hs-score-reviewbar__meta">
              {copy.severityLabel}・{copy.statusLabel}
              {confidence != null &&
                `・${r.confidence(Math.round(confidence * 100))}`}
            </span>
          </>
        )}
      </div>
      <div
        className="hs-score-reviewbar__row"
        role="toolbar"
        aria-label={r.actionsLabel}
      >
        <HsTooltip content={withKey(ja.common.prev, "←")}>
          <HsButton size="small" disabled={total === 0} onClick={onPrev}>
            {ja.common.prev}
          </HsButton>
        </HsTooltip>
        <HsTooltip
          content={
            canPlaySource ? withKey(r.playSource, "R") : r.noAudibleRange
          }
        >
          <HsButton
            size="small"
            disabled={issue == null || !canPlaySource}
            onClick={onPlaySource}
          >
            {r.playSource}
          </HsButton>
        </HsTooltip>
        {action ? (
          <HsTooltip content={action.tooltip}>
            <HsButton size="small" onClick={() => action.run()}>
              {action.label}
            </HsButton>
          </HsTooltip>
        ) : null}
        <HsTooltip content={withKey(r.markOk, "O")}>
          <HsButton
            size="small"
            variant="primary"
            disabled={issue == null}
            onClick={onAccept}
          >
            {r.markOk}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={withKey(r.dismiss, "Shift+O")}>
          <HsButton size="small" disabled={issue == null} onClick={onDismiss}>
            {r.dismiss}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={noteEditTip(r.pitchUp, "Alt+↑")}>
          <HsButton
            size="small"
            disabled={issue == null || !canEditNotes}
            onClick={() => onPitch(1)}
          >
            {r.pitchUp}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={noteEditTip(r.pitchDown, "Alt+↓")}>
          <HsButton
            size="small"
            disabled={issue == null || !canEditNotes}
            onClick={() => onPitch(-1)}
          >
            {r.pitchDown}
          </HsButton>
        </HsTooltip>
        <HsTooltip
          content={noteEditTip(
            noteDeleted ? r.restoreNote : r.deleteNote,
            "Delete",
          )}
        >
          <HsButton
            size="small"
            disabled={issue == null || !canEditNotes}
            onClick={onDeleteOrRestore}
          >
            {noteDeleted ? r.restoreNote : r.deleteNote}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={withKey(r.undo, "Ctrl+Z")}>
          <HsButton size="small" disabled={!canUndo} onClick={onUndo}>
            {r.undo}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={withKey(r.redo, "Ctrl+Shift+Z")}>
          <HsButton size="small" disabled={!canRedo} onClick={onRedo}>
            {r.redo}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={withKey(ja.common.next, "→")}>
          <HsButton size="small" disabled={total === 0} onClick={onNext}>
            {ja.common.next}
          </HsButton>
        </HsTooltip>
        <HsTooltip content={withKey(r.nav.toggle, "I")}>
          <HsButton
            ref={navigatorButtonRef}
            size="small"
            icon={<List24Regular />}
            disabled={total === 0}
            onClick={onToggleNavigator}
            aria-pressed={navigatorOpen}
          >
            {r.nav.toggle}
          </HsButton>
        </HsTooltip>
        <span className="hs-score-reviewbar__spacer" />
        <HsTooltip content={withKey(r.exit, "Esc")}>
          <HsButton size="small" onClick={onExit}>
            {r.exit}
          </HsButton>
        </HsTooltip>
      </div>
      {!allDone && (
        <div className="hs-score-reviewbar__row hs-score-reviewbar__row--hint">
          <span className="hs-score-reviewbar__hint">{r.hint}</span>
        </div>
      )}
    </div>
  );
}
