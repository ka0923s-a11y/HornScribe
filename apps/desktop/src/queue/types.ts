/**
 * #18: 採譜キュー — 複数ジョブの逐次実行。
 *
 * 単一ドキュメントアプリのまま「連続で回したい」を成立させる設計:
 * - 1エントリ = 1採譜ジョブ(音源 ref + params スナップショット + ラベル)。
 * - 実行は既存 TranscriptionSession を逐次ドライブ(ワーカーは従来通り
 *   maxConcurrentJobs: 1 — キューは上流で直列化するだけ)。
 * - completed 結果はエントリに保持し「開く」で現在ドキュメントとして
 *   取り込む。「どの音源に対する結果か」はエントリの label/ref が担う。
 */
import type { TranscriptionJobParams } from "../import/transcriptionParams";
import type { AudioFileRef, RecordedAudioRef } from "../import/types";

export type QueueEntryStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface QueueEntry {
  readonly id: string;
  /** 一覧表示名 — 音源ファイル名(+ 範囲指定時は秒数)。 */
  readonly label: string;
  /** 結果を開く時に音源を再ロードするための参照。 */
  readonly ref: AudioFileRef | RecordedAudioRef | null;
  /** enqueue 時に確定させた job.start params。 */
  readonly params: TranscriptionJobParams;
  /** enqueue 時点で分かっている音源 identity(あれば)。 */
  readonly identity: string | null;
  readonly status: QueueEntryStatus;
  /** running 中だけ session job.progress をミラーする。 */
  readonly progress: number | null;
  readonly error: string | null;
  /** completed ジョブの result payload — ドキュメント再構築に使う。 */
  readonly result: unknown;
  readonly reviewIssueCount: number;
}

export interface QueueSnapshot {
  readonly entries: readonly QueueEntry[];
  /** run loop がエントリを逐次ドライブ中。 */
  readonly running: boolean;
  /** 現在 in-flight のエントリ id(無ければ null)。 */
  readonly activeId: string | null;
}

export const INITIAL_QUEUE_SNAPSHOT: QueueSnapshot = {
  entries: [],
  running: false,
  activeId: null,
};
