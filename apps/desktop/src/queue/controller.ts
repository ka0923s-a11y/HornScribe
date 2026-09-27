/**
 * #18: TranscriptionQueue — session を逐次ドライブするランループ。
 *
 * 責務:
 * - pending エントリを先頭から1つずつ TranscriptionSession に流す。
 * - 実行中は session.job の progress をエントリにミラーする。
 * - 終端イベント(completed/cancelled/failed)を捕捉し、結果をエントリ
 *   に保存してから session.clearJob() し、次のエントリへ進む。
 * - エンジン級の障害(crash/unresponsive)はラン全体を止める。
 *
 * App 側の協調点: キューが job を所有している間(isDrivingJob)は、
 * App の job ライフサイクル effect が terminal 相を消費しないこと。
 */

import { ja } from "../strings/ja";
import type { TranscriptionJobParams } from "../import/transcriptionParams";
import type { AudioFileRef, RecordedAudioRef } from "../import/types";
import type { SessionSnapshot } from "../sidecar/session";
import type { JobViewPhase } from "../sidecar/jobView";
import { extractReviewIssueCount } from "../sidecar/review";
import {
  INITIAL_QUEUE_SNAPSHOT,
  type QueueEntry,
  type QueueSnapshot,
} from "./types";

/** session のうちキューが必要とする面だけを抜き出した依存。 */
export interface QueueSession {
  getSnapshot(): SessionSnapshot;
  subscribe(cb: (snap: SessionSnapshot) => void): () => void;
  startTranscription(params: unknown): Promise<void>;
  cancelTranscription(): Promise<void>;
  clearJob(): void;
  clearFailure(): void;
}

export interface QueueEvents {
  onState(snap: QueueSnapshot): void;
  announce(message: string): void;
  /** 1件のキュージョブが実際に開始された(画面を transcribing に)。 */
  onJobStart?(entry: QueueEntry): void;
  /** ラン全体が終了(消化完了 or 停止)。画面復帰と要約アナウンス用。 */
  onRunFinished?(snap: QueueSnapshot): void;
}

const TERMINAL: ReadonlySet<JobViewPhase> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

interface TerminalOutcome {
  kind: "completed" | "cancelled" | "failed";
  result?: unknown;
  error?: string;
  engineDead?: boolean;
}

interface EnqueueInput {
  label: string;
  params: TranscriptionJobParams;
  ref?: AudioFileRef | RecordedAudioRef | null;
  identity?: string | null;
}

let nextId = 1;

export class TranscriptionQueue {
  private snapshot: QueueSnapshot = INITIAL_QUEUE_SNAPSHOT;
  private entries: QueueEntry[] = [];
  private running = false;
  private stopRequested = false;
  /** キューが現在 session.job を所有している間 true — App はこの間
   *  job の terminal 相を消費してはいけない。 */
  private driving = false;
  private pendingResolve: ((o: TerminalOutcome) => void) | null = null;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly session: QueueSession,
    private readonly events: QueueEvents,
  ) {}

  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  /** キュー所有の job が in-flight か(App のライフサイクルゲート用)。 */
  isDrivingJob(): boolean {
    return this.driving;
  }

  /* -------------------------- エントリ操作 -------------------------- */

  enqueue(input: EnqueueInput): QueueEntry {
    const entry: QueueEntry = {
      id: `q${nextId++}`,
      label: input.label,
      ref: input.ref ?? null,
      params: input.params,
      identity: input.identity ?? null,
      status: "pending",
      progress: null,
      error: null,
      result: null,
      reviewIssueCount: 0,
    };
    this.entries = [...this.entries, entry];
    this.emit();
    return entry;
  }

  /** pending エントリを取り除く。実行中/終了済みは対象外。 */
  remove(id: string): boolean {
    const e = this.entries.find((x) => x.id === id);
    if (!e || e.status !== "pending") return false;
    this.entries = this.entries.filter((x) => x.id !== id);
    this.emit();
    return true;
  }

  /** pending エントリの並び替え(±1)。 */
  move(id: string, delta: -1 | 1): boolean {
    const idx = this.entries.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const e = this.entries[idx];
    if (e.status !== "pending") return false;
    const target = idx + delta;
    if (target < 0 || target >= this.entries.length) return false;
    const next = [...this.entries];
    [next[idx], next[target]] = [next[target], next[idx]];
    this.entries = next;
    this.emit();
    return true;
  }

  /** 個別キャンセル: pending は cancelled 扱い、running は協調キャンセル。 */
  async cancel(id: string): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    if (e.status === "pending") {
      this.patch(id, { status: "cancelled" });
      return;
    }
    if (e.status === "running") {
      await this.session.cancelTranscription().catch(() => undefined);
    }
  }

  /** 終了した行(done/failed/cancelled)を一括で掃除。 */
  clearFinished(): void {
    this.entries = this.entries.filter(
      (e) => e.status === "pending" || e.status === "running",
    );
    this.emit();
  }

  /* ------------------------------ 実行 ------------------------------ */

  /** ラン開始。既に走っている/ pending が無ければ何もしない。 */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.entries.some((e) => e.status === "pending")) {
      this.events.announce(ja.queue.empty);
      return;
    }
    // 別の手動ジョブが飛んでいる間は始めない — ワーカーは1本だけ。
    const job = this.session.getSnapshot().job;
    if (job && !TERMINAL.has(job.phase)) {
      this.events.announce(ja.queue.busy);
      return;
    }
    this.running = true;
    this.stopRequested = false;
    this.emit();
    try {
      await this.runLoop();
    } finally {
      this.running = false;
      this.emit();
      this.events.onRunFinished?.(this.snapshot);
    }
  }

  /** ラン停止: 現在ジョブを協調キャンセルし、残りの pending は残す。 */
  async stop(): Promise<void> {
    this.stopRequested = true;
    const active = this.entries.find((e) => e.status === "running");
    if (active) {
      await this.session.cancelTranscription().catch(() => undefined);
    }
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.pendingResolve = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      const entry = this.entries.find((e) => e.status === "pending");
      if (!entry) break;
      this.patch(entry.id, { status: "running", progress: null });
      const current = this.find(entry.id);
      if (current) this.events.onJobStart?.(current);
      await this.runOne(entry.id);
      if (this.stopRequested) break;
    }
  }

  private async runOne(id: string): Promise<void> {
    const entry = this.find(id);
    if (!entry) return;
    this.driving = true;
    this.ensureSub();
    // 終端待ちの resolver を start 前に登録する — 極端に速い
    // モック/ローカル経路で completed が startTranscription 解決と
    // 同tickに来ても拾い損ねない。
    const outcomeP = this.awaitTerminal();
    try {
      await this.session.startTranscription(entry.params);
    } catch (e) {
      this.pendingResolve = null;
      this.patch(id, {
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      this.driving = false;
      return;
    }
    const outcome = await outcomeP;
    this.driving = false;
    this.session.clearJob();
    if (outcome.kind === "completed") {
      this.patch(id, {
        status: "done",
        progress: 1,
        result: outcome.result,
        reviewIssueCount: extractReviewIssueCount(outcome.result),
      });
      this.events.announce(
        ja.queue.entryDone.replace("{name}", this.find(id)?.label ?? ""),
      );
    } else if (outcome.kind === "cancelled") {
      this.patch(id, { status: "cancelled", progress: null });
    } else {
      this.patch(id, { status: "failed", error: outcome.error });
      if (outcome.engineDead) {
        // エンジン死亡は failure を残す — ラン終了後に §20 のエラー
        // 画面(エンジン再起動)へ繋ぐため。
      } else {
        // ジョブ単位の失敗は行に記録した時点で消費済み — 残った
        // failure がラン終了後にエラー画面へ飛ばさないよう片付ける。
        this.session.clearFailure();
      }
    }
    // エンジン死亡(crash/unresponsive)は残り全部を止める。
    if (outcome.engineDead) this.stopRequested = true;
  }

  /** job が終端相に達するまで session スナップショットを追う。 */
  private awaitTerminal(): Promise<TerminalOutcome> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /** 常設購読: progress ミラーと終端検知をここに集約する。 */
  private ensureSub(): void {
    if (this.unsub) return;
    this.unsub = this.session.subscribe((snap) => this.onSnap(snap));
  }

  private onSnap(snap: SessionSnapshot): void {
    const j = snap.job;
    if (!j) return;
    // 実行中: progress をアクティブエントリにミラーするだけ。
    if (!TERMINAL.has(j.phase)) {
      const active = this.entries.find((e) => e.status === "running");
      if (active && j.progress !== active.progress) {
        this.patch(active.id, { progress: j.progress });
      }
      return;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    if (!resolve) return; // キュー所有でない終端(手動ジョブ)は無視。
    if (j.phase === "completed") {
      resolve({ kind: "completed", result: snap.lastResult });
    } else if (j.phase === "cancelled") {
      resolve({ kind: "cancelled" });
    } else {
      const engineDead =
        snap.failure?.kind === "workerCrashed" ||
        snap.failure?.kind === "workerNotResponding";
      const detail = j.error
        ? j.error.code + ": " + j.error.message
        : "failed";
      resolve({
        kind: "failed",
        error: snap.failure?.detail ?? detail,
        engineDead,
      });
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private find(id: string): QueueEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  private patch(id: string, p: Partial<QueueEntry>): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, ...p } : e));
    this.emit();
  }

  private emit(): void {
    const active = this.entries.find((e) => e.status === "running");
    this.snapshot = {
      entries: this.entries,
      running: this.running,
      activeId: active?.id ?? null,
    };
    this.events.onState(this.snapshot);
  }
}
