/**
 * #18: 採譜キューパネル — ジョブの追加・並び替え・キャンセル・結果を開く。
 * モーダルだが実行中に閉じてもランは継続する(進行は transcribing 画面で
 * 見える)。行アクションは IconButton + ステータス行テキストのみ。
 */
import {
  ArrowDown24Regular,
  ArrowUp24Regular,
  Delete24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";
import {
  HsButton,
  HsDialog,
  HsIconButton,
  HsProgress,
} from "./primitives";
import { ja } from "../strings/ja";
import type { QueueEntry, QueueSnapshot } from "../queue/types";
import { queueParamSummary } from "../queue/paramSummary";

function statusLabel(e: QueueEntry): string {
  switch (e.status) {
    case "pending":
      return ja.queue.statusPending;
    case "running":
      return ja.queue.statusRunning;
    case "done":
      return ja.queue.statusDone;
    case "failed":
      return ja.queue.statusFailed;
    case "cancelled":
      return ja.queue.statusCancelled;
  }
}

export function QueuePanel({
  open,
  onOpenChange,
  snapshot,
  onAddAudio,
  onStart,
  onStop,
  onMove,
  onRemove,
  onCancelEntry,
  onOpenResult,
  onClearFinished,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  snapshot: QueueSnapshot;
  onAddAudio(): void;
  onStart(): void;
  onStop(): void;
  onMove(id: string, delta: -1 | 1): void;
  onRemove(id: string): void;
  onCancelEntry(id: string): void;
  onOpenResult(entry: QueueEntry): void;
  onClearFinished(): void;
}) {
  const hasPending = snapshot.entries.some((e) => e.status === "pending");
  const hasFinished = snapshot.entries.some(
    (e) => e.status === "done" || e.status === "failed" || e.status === "cancelled",
  );
  return (
    <HsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={ja.queue.title}
      actions={
        <>
          <HsButton onClick={onAddAudio}>{ja.queue.addAudio}</HsButton>
          {snapshot.running ? (
            <HsButton variant="secondary" onClick={onStop}>
              {ja.queue.stop}
            </HsButton>
          ) : (
            <HsButton
              variant="primary"
              disabled={!hasPending}
              onClick={onStart}
            >
              {ja.queue.start}
            </HsButton>
          )}
          <HsButton disabled={!hasFinished} onClick={onClearFinished}>
            {ja.queue.clearFinished}
          </HsButton>
        </>
      }
    >
      {snapshot.entries.length === 0 ? (
        <p className="hs-queue__empty">{ja.queue.empty}</p>
      ) : (
        <ul className="hs-queue__list">
          {snapshot.entries.map((e) => {
            /* #59: pinned options baked at enqueue — params only
               carries non-default keys, so an empty summary means
               "all defaults" and renders nothing. */
            const paramsSummary = queueParamSummary(e.params);
            return (
            <li key={e.id} className={`hs-queue__row hs-queue__row--${e.status}`}>
              <div className="hs-queue__main">
                <span className="hs-queue__name" title={e.label}>
                  {e.label}
                </span>
                <span className="hs-queue__status">{statusLabel(e)}</span>
                {paramsSummary ? (
                  <span className="hs-queue__params">{paramsSummary}</span>
                ) : null}
                {e.status === "running" ? (
                  <span className="hs-queue__progress">
                    <HsProgress value={e.progress ?? undefined} />
                  </span>
                ) : null}
                {e.status === "failed" && e.error ? (
                  <span className="hs-queue__error">{e.error}</span>
                ) : null}
                {e.status === "done" && e.reviewIssueCount > 0 ? (
                  <span className="hs-queue__review">
                    {ja.commandBar.reviewWithCount.replace(
                      "{count}",
                      String(e.reviewIssueCount),
                    )}
                  </span>
                ) : null}
              </div>
              <div className="hs-queue__actions">
                {e.status === "pending" ? (
                  <>
                    <HsIconButton
                      label={ja.queue.moveUp}
                      icon={<ArrowUp24Regular />}
                      size="small"
                      onClick={() => onMove(e.id, -1)}
                    />
                    <HsIconButton
                      label={ja.queue.moveDown}
                      icon={<ArrowDown24Regular />}
                      size="small"
                      onClick={() => onMove(e.id, 1)}
                    />
                    <HsIconButton
                      label={ja.queue.cancelEntry}
                      icon={<Dismiss24Regular />}
                      size="small"
                      onClick={() => void onCancelEntry(e.id)}
                    />
                    <HsIconButton
                      label={ja.queue.remove}
                      icon={<Delete24Regular />}
                      size="small"
                      onClick={() => onRemove(e.id)}
                    />
                  </>
                ) : null}
                {e.status === "running" ? (
                  <HsIconButton
                    label={ja.queue.cancelEntry}
                    icon={<Dismiss24Regular />}
                    size="small"
                    onClick={() => void onCancelEntry(e.id)}
                  />
                ) : null}
                {e.status === "done" ? (
                  <HsButton size="small" onClick={() => onOpenResult(e)}>
                    {ja.queue.openResult}
                  </HsButton>
                ) : null}
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </HsDialog>
  );
}
