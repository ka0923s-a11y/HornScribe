/**
 * FEAT-001 (#60): 楽譜の自動演奏。
 *
 * `PlaybackTable`(Verovio timemap → canonical→ms)と `ParsedNote`(音高)
 * を結合し、WebAudio でスコアを発音する。`ScoreCursorClock` と同期し、
 * 追従カーソルと同じ位置で音が鳴る。
 *
 * 設計:
 * - 演奏は常に「コンサートピッチ(実音)」。hornF 表示中も実音で鳴らす
 *   (採譜の確認用途に合わせる。記譜音で鳴らすと半音ズレて混乱する)。
 * - 音色は簡易のトライアングル+サインを重ねた「ホルン風」の柔らかい音。
 *   外部音源/サウンドフォントには依存しない(offline 方針)。
 * - `ScoreCursorClock` の `subscribe` でスナップショットを受け、
 *   再生中は rAF ではなく WebAudio の oscillator を事前スケジューリング
 *   する方式で、UIスレッド負荷を抑える。
 * - ループがアームされている間はその範囲を繰り返しスケジュールする。
 * - `rate` 変更は既スケジュールを破棄して再計算する。
 */
import type { PlaybackTable } from "./playbackTable";
import type { ParsedNote } from "./scoreDoc";

/** canonical id → 音高。step/alter/octave から MIDI note を計算する。 */
const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function noteToMidi(note: ParsedNote): number | null {
  if (note.isRest || note.step === undefined || note.octave === undefined) {
    return null;
  }
  const base = STEP_TO_SEMITONE[note.step];
  if (base === undefined) return null;
  // MIDI: C4 = 60
  return base + (note.alter ?? 0) + (note.octave + 1) * 12;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** スケジュール対象の 1 音。 */
interface ScheduledNote {
  startMs: number;
  endMs: number;
  freq: number;
}

export interface ScoreSynthOptions {
  /** AudioContext は外部注入可(テスト/既存コンテキスト共有)。 */
  audioContext?: AudioContext | null;
  /** 音量 0–1。 */
  volume?: number;
}

/**
 * 楽譜の発音エンジン。`ScoreCursorClock` に追従するので、UI の再生位置
 * と同期した「楽譜が鳴る」体験を提供する。
 */
export class ScorePlaybackSynth {
  private ctx: AudioContext | null;
  private master: GainNode | null = null;
  private notes: ScheduledNote[] = [];
  private scheduledNodes: OscillatorNode[] = [];
  private loopRangeMs: { startMs: number; endMs: number } | null = null;
  private rate = 1;
  private enabled = false;
  private disposeRequested = false;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorMs = 0;
  private playing = false;
  private volume: number;
  /** ここまでの score 時間は発音済みスケジュール済み(重複防止の
   *  ウォーターマーク)。シーク/レート変更/再生開始でリセットする。 */
  private scheduledUntilMs = 0;
  /** ティック間の実経過計測用。 */
  private lastTickAt = 0;

  /** 事前スケジュールの先読み幅(ms 相当の score 時間)。 */
  private readonly LOOKAHEAD_MS = 400;
  /** スケジュールの走査間隔。 */
  private readonly TICK_MS = 80;

  constructor(opts: ScoreSynthOptions = {}) {
    this.ctx = opts.audioContext ?? null;
    this.volume = opts.volume ?? 0.5;
  }

  /**
   * 再生するノート列をロードする。
   * `table` は Verovio timemap 由来、`notesByCanonical` は concert
   * presentation の ParsedNote マップ(実音で鳴らすため horn 側は使わない)。
   */
  load(
    table: PlaybackTable,
    notesByCanonical: ReadonlyMap<string, readonly ParsedNote[]>,
  ): void {
    const notes: ScheduledNote[] = [];
    for (const seg of table.segments) {
      for (const canonicalId of seg.canonicalIds) {
        const frags = notesByCanonical.get(canonicalId);
        if (!frags) continue;
        for (const frag of frags) {
          const midi = noteToMidi(frag);
          if (midi === null) continue;
          notes.push({
            startMs: seg.startMs,
            endMs: seg.endMs,
            freq: midiToFreq(midi),
          });
          // 和音: chord メンバーは同じ onset を持つので、同じセグメントで
          // 別 ParsedNote として既に処理済み(frag 毎に 1 音追加)。
        }
      }
    }
    // onset 順 + 同時は周波数順で安定化。
    notes.sort((a, b) => a.startMs - b.startMs || a.freq - b.freq);
    this.notes = notes;
  }

  /** スコアクロックの位置(ms)を同期する。シーク/レート変更に追従。 */
  sync(positionMs: number, isPlaying: boolean, rate: number): void {
    const wasPlaying = this.playing;
    const rateChanged = rate !== this.rate;
    // シーク/ループ折り返し検出: 内部カーソルと大きくズレたら
    // スケジュール済み音声を破棄して新位置から張り直す。
    // ティックの setTimeout ドリフトが 10Hz のスナップショット同期までに
    // 250ms を超え得るので、誤検出を避けるため余裕を持たせる。
    const jumped = Math.abs(positionMs - this.cursorMs) > 400;
    this.cursorMs = positionMs;
    this.playing = isPlaying;
    this.rate = rate;
    if (isPlaying && !wasPlaying) {
      this.scheduledUntilMs = positionMs;
      // 再生開始: 現在位置から先読みスケジュールを開始。
      this.scheduleFromCursor();
    } else if (!isPlaying && wasPlaying) {
      // 一時停止: 鳴っている音を止める。
      this.stopAllVoices();
      this.stopTimer();
    } else if (isPlaying && this.enabled && (rateChanged || jumped)) {
      // レート変更やシーク: スケジュール済みの音は旧基準なので張り直す。
      this.stopAllVoices();
      this.scheduledUntilMs = positionMs;
      this.scheduleFromCursor();
    }
  }

  /** ループ範囲の同期(ScoreCursorClock の loop)。 */
  setLoop(range: { startMs: number; endMs: number } | null): void {
    this.loopRangeMs = range;
  }

  /** 演奏モードのオン/オフ。 */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.stopAllVoices();
      this.stopTimer();
    } else if (this.playing) {
      this.scheduledUntilMs = this.cursorMs;
      this.scheduleFromCursor();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  dispose(): void {
    this.disposeRequested = true;
    this.stopTimer();
    this.stopAllVoices();
    // AudioContext は外部共有の可能性があるので close はしない。
  }

  /* ------------------------------ internals ------------------------------ */

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** カーソル位置から LOOKAHEAD_MS 先までの音をスケジュールする。 */
  private scheduleFromCursor(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master || this.notes.length === 0) return;
    this.stopTimer();

    // AudioContext の currentTime を基準に、スコア時間 → 実時間に変換する。
    // scoreMs = cursorMs から、実時間 t0 = ctx.currentTime + 少しの猶予。
    const t0 = ctx.currentTime + 0.06; // 60ms の起動猶予
    const rate = this.rate;
    const windowStart = this.cursorMs;
    const windowEnd = windowStart + this.LOOKAHEAD_MS * rate;
    // ティック毎にウィンドウが重なるので、既にスケジュール済みの範囲
    // (scheduledUntilMs 以前)は二度鳴らさない。
    const scheduleFrom = Math.max(windowStart, this.scheduledUntilMs);

    for (const note of this.notes) {
      // 進行中の音(note.startMs < cursor)は既に鳴っているはずだが、
      // シーク直後の整合のため、onset がウィンドウ内にあるものだけ鳴らす。
      if (note.endMs <= windowStart) continue;
      if (note.startMs >= windowEnd) break;
      // onset が過去/スケジュール済みの音は次回 onset を待つ。
      if (note.startMs < scheduleFrom) continue;
      const startSec = t0 + (note.startMs - windowStart) / rate / 1000;
      const durSec = Math.max(0.04, (note.endMs - note.startMs) / rate / 1000);
      this.spawnVoice(note.freq, startSec, durSec);
    }
    this.scheduledUntilMs = Math.max(this.scheduledUntilMs, windowEnd);
    this.lastTickAt = performance.now();

    // ループ: 範囲の終わりに近づいたらループ先頭から再スケジュール。
    if (this.loopRangeMs) {
      const { startMs, endMs } = this.loopRangeMs;
      if (this.cursorMs >= startMs && this.cursorMs < endMs) {
        const untilLoopEnd = (endMs - this.cursorMs) / rate;
        // ループ末尾の少し前に次周の先読みを仕掛ける。
        const nextTickMs = Math.max(
          this.TICK_MS,
          Math.min(untilLoopEnd * 1000 - 150, this.TICK_MS),
        );
        this.scheduleTimer = setTimeout(() => this.onTick(), nextTickMs);
        return;
      }
    }
    this.scheduleTimer = setTimeout(() => this.onTick(), this.TICK_MS);
  }

  private onTick(): void {
    if (this.disposeRequested || !this.enabled || !this.playing) return;
    // 実経過でカーソルを進める(setTimeout は遅延するので TICK_MS 固定
    // だと徐々に遅れる)。クロック subscribe が 10Hz で補正もする。
    const now = performance.now();
    const elapsedMs = (now - this.lastTickAt) * this.rate;
    this.cursorMs += elapsedMs;
    if (this.loopRangeMs) {
      const { startMs, endMs } = this.loopRangeMs;
      if (this.cursorMs >= endMs) {
        const span = endMs - startMs;
        this.cursorMs = startMs + ((this.cursorMs - startMs) % span);
        // ループ折り返し: 先読み済み範囲を巻き戻して再スケジュール。
        this.scheduledUntilMs = this.cursorMs;
      }
    }
    this.scheduleFromCursor();
  }

  /** 1 音を鳴らす。ホルンらしい柔らかさのため三角波+正弦波の 2 音構成。 */
  private spawnVoice(freq: number, startSec: number, durSec: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const osc1 = ctx.createOscillator();
    osc1.type = "triangle";
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = freq * 0.5; // サブオクターブで厚みを出す
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.25;

    const env = ctx.createGain();
    // ADSR 風: 5ms attack, sustain, 40ms release。
    env.gain.setValueAtTime(0, startSec);
    env.gain.linearRampToValueAtTime(0.9, startSec + 0.005);
    env.gain.setValueAtTime(0.9, startSec + Math.max(0.005, durSec - 0.04));
    env.gain.linearRampToValueAtTime(0, startSec + durSec);

    osc1.connect(env);
    osc2.connect(osc2Gain);
    osc2Gain.connect(env);
    env.connect(master);

    osc1.start(startSec);
    osc2.start(startSec);
    osc1.stop(startSec + durSec + 0.02);
    osc2.stop(startSec + durSec + 0.02);
    this.scheduledNodes.push(osc1, osc2);
    // 鳴り終わったノードを配列から外す(長時間再生で無限に増えないよう)。
    const drop = () => {
      this.scheduledNodes = this.scheduledNodes.filter(
        (n) => n !== osc1 && n !== osc2,
      );
    };
    osc1.onended = drop;
  }

  private stopAllVoices(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const osc of this.scheduledNodes) {
      try {
        osc.stop(now);
      } catch {
        /* already stopped */
      }
      osc.disconnect();
    }
    this.scheduledNodes = [];
  }

  private stopTimer(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }
}
