/**
 * Copy resolution for the spike.
 *
 * All strings that exist in the canonical deck are resolved from
 * protocol/copy/ja-JP.json (per docs/UI_COPY_CONTRACT.md). Spike-only
 * surfaces (fixture picker, measurement panel) have no deck keys yet, so
 * they live in `spikeCopy` below — still Japanese-only, visibly marked, and
 * intended to be folded back into the deck if the product keeps them.
 */
import deck from '../../../../protocol/copy/ja-JP.json'

type Deck = typeof deck

function get(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

/**
 * Resolve a canonical deck key (dot path). Missing keys render loudly —
 * `!!key.path!!` — per the copy contract (never silently emit English).
 */
export function t(path: string, vars?: Record<string, string | number>): string {
  const raw = get(deck as Deck, path)
  if (raw === undefined) return `!!${path}!!`
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  )
}

/** Spike-local copy (not yet in the canonical deck). Japanese only. */
export const spikeCopy = {
  title: 'UI-004 波形・再生スパイク',
  fixtureLabel: 'フィクスチャ',
  fixture30s: '30秒（同梱WAV）',
  fixture3min: '3分（ローカル生成WAV）',
  fixture10min: '10分（ローカル生成WAV）',
  fixture3minGen: '3分（ブラウザ内生成）',
  fixture10minGen: '10分（ブラウザ内生成）',
  generating: '音声を生成しています',
  loadFixture: '読み込み',
  clearRegion: '範囲を解除',
  preservePitch: 'ピッチを保持',
  minimap: 'ミニマップ',
  zoomAria: '波形のズーム（px/秒）',
  measureTitle: '計測',
  measureRun: '計測を実行',
  measureRunning: '計測中…',
  measureHint: 'シーク・ジッタ・ループ・ズーム・レートを自動計測します（約40秒）。',
  measureCopyJson: 'JSONをコピー',
  measureCopied: 'コピーしました',
  measureNeedFixture: '先にフィクスチャを読み込んでください',
  colMetric: '指標',
  colValue: '値',
  colDetail: '詳細',
  metricLoadDecode: '読み込み〜デコード',
  metricLoadReady: '読み込み〜描画完了',
  metricSeek: 'シーク遅延（中央値 / p95）',
  metricJitter: '再生ヘッドのジッタ（σ / 最大）',
  metricLoopDrift: 'ループ巻き戻し誤差（平均 / 最大）',
  metricMemory: 'ヒープ使用量（読み込み後 / 再生中）',
  metricZoom: 'ズーム応答（平均 / 最大）',
  metricPan: 'パン（スクロール）応答（平均 / 最大）',
  metricRate: '実測レート誤差',
  metricPeaks: 'ピークキャッシュサイズ',
  selectionLabel: '選択範囲',
  noFixtureLoaded: 'フィクスチャを読み込んでください',
  playSelectionHint: '選択範囲を再生',
  regionHandles: 'ドラッグで範囲選択・端をドラッグで調整・ダブルクリックで解除',
} as const

export { deck }
