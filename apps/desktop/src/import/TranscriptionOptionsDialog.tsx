/**
 * #55: スコア画面の採譜オプション dialog — AUDIO_READY の popover は
 * 採譜後にはもう開けないので、調・テクスチャ等を変えて再採譜する
 * 入口が無かった。フィールド群は TranscriptionOptionsFields で
 * popover と共有し、ここは draft state と適用ボタンだけを持つ。
 *
 * 適用は呼び出し側の retranscribeWithOptions(#343 の guarded
 * transaction)へ委譲する — 未保存の確認をキャンセルしても stored
 * options は変わらない。draft は dialog を開くたびに live options で
 * シードし直す(RequantizeDialog と同じ render-time seed パターン)。
 */
import { useState } from "react";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import { HsDialog } from "../components/primitives/Dialog";
import { TranscriptionOptionsFields } from "./TranscriptionOptionsFields";
import { invalidTranscriptionOptions } from "./transcriptionParams";
import type { TranscriptionOptions } from "./types";

export function TranscriptionOptionsDialog({
  open,
  onOpenChange,
  options,
  durationSec,
  onApply,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Live transcriptionOptions — seeds the draft on every open. */
  options: TranscriptionOptions;
  /** 読み込み済み音源の長さ(秒)。範囲入力の上限と検証に使う。 */
  durationSec: number;
  /** Apply the draft — the caller pairs it with retranscribeWithOptions
   *  so the dirty-score guard still wraps the commit + job start. */
  onApply(next: TranscriptionOptions): void;
}) {
  const [draft, setDraft] = useState<TranscriptionOptions>(options);
  const [seeded, setSeeded] = useState(open);
  // Re-seed the form every time the dialog opens (options may have
  // changed via a quick-retranscribe since the last open).
  if (open && !seeded) {
    setDraft(options);
    setSeeded(true);
  } else if (!open && seeded) {
    setSeeded(false);
  }

  // #346/#61: same field-error gate as AUDIO_READY — an empty/inverted
  // 選択範囲 or a 手動 tempo with no BPM must not start a job.
  const invalid = invalidTranscriptionOptions(draft, durationSec);

  return (
    <HsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={ja.import.audioOptions.label}
      actions={
        <>
          <HsButton onClick={() => onOpenChange(false)}>
            {ja.common.cancel}
          </HsButton>
          <HsButton
            variant="primary"
            disabled={invalid}
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
          >
            {ja.transcribeOptionsDialog.apply}
          </HsButton>
        </>
      }
    >
      <TranscriptionOptionsFields
        options={draft}
        durationSec={durationSec}
        onChange={setDraft}
      />
    </HsDialog>
  );
}
