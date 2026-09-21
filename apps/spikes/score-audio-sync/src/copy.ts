/**
 * Copy resolution for the UI-005 spike.
 *
 * All strings that exist in the canonical deck are resolved from
 * protocol/copy/ja-JP.json (docs/UI_COPY_CONTRACT.md). Spike-only surfaces
 * (fixture picker, sync readouts, measurement panel) live in `spikeCopy` —
 * still Japanese-only, visibly marked, intended to be upstreamed if the
 * spike graduates.
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

/** Resolve a canonical deck key. Missing keys render loudly — `!!key!!`. */
export function t(path: string, vars?: Record<string, string | number>): string {
  const raw = get(deck as Deck, path)
  if (raw === undefined) return `!!${path}!!`
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  )
}

export const copy = {
  appName: deck.app.name,
  seg: deck.segments.scoreView,
  score: deck.score,
  a11y: deck.a11y,
  common: deck.common,
  renderFailed: deck.errors.scoreRenderFailed,
  fields: deck.properties.fields,
}

/** Spike-only labels (ja). Proper nouns/identifiers stay Latin per §41. */
export const spikeCopy = {
  title: 'UI-005: 楽譜⇔音声 同期スパイク',
  subtitle: '1つの再生クロックで波形・正準ID・描画済み楽譜を同期する検証',
  fixtureLabel: '検証データ',
  loadingAudio: '音声を生成しています',
  loadingScore: '楽譜を表示しています',
  positionQl: '楽譜位置',
  currentMeasure: '現在小節',
  activeNotes: '発音中の音符',
  noActiveNotes: '（発音中の音符はありません）',
  selectionHeading: '選択中の音符',
  selectionEmpty: '楽譜または波形をクリックすると、ここに表示されます。',
  selectionRest: '休符（正準IDはありません）',
  canonicalId: '正準ID',
  exportId: 'MusicXML ID',
  onsetQl: '開始位置（ql）',
  onsetSec: '開始時刻（秒）',
  measureField: '小節',
  pitchField: '音高',
  loopPassage: 'ループ範囲の楽譜',
  noLoop: 'ループは設定されていません',
  scoreZoom: '楽譜の表示倍率',
  zoomIn: '拡大',
  zoomOut: '縮小',
  waveformClickHint: '波形クリック → 最も近い音符を選択・シーク',
  clearRegion: '範囲を解除',
  scoreClickHint: '音符クリック → その音の開始位置へシーク',
  measureTitle: '同期計測',
  measureRun: '計測を実行',
  measureRunning: '計測中…',
  measureHint:
    'シーク遅延・ハイライト応答・同期誤差・ループ・表示切替を自動計測します（約60秒）。',
  measureCopyJson: 'JSONをコピー',
  measureCopied: 'コピーしました',
  measureNeedReady: '楽譜と音声の読み込みが完了してから実行してください',
  colMetric: '指標',
  colValue: '値',
  colDetail: '詳細',
  metricScoreSeek: '楽譜クリック→シーク（中央値 / p95）',
  metricWaveSelect: '波形クリック→ハイライト（中央値 / p95）',
  metricSyncError: '再生中の同期誤差（平均 / 最大）',
  metricHighlightCost: 'ハイライトDOM更新（平均 / 最大）',
  metricFollowCost: '追従スクロール（平均 / 最大）',
  metricLoop: 'ループ巻き戻し誤差（平均 / 最大）',
  metricLoopScore: 'ループ範囲の楽譜表示',
  metricViewSwitch: 'コンサート⇔F管切替',
  metricReact: '再生中のReact更新',
  metricVerovioCalls: '再生中のVerovio呼出',
  correct: '正常',
  incorrect: '不一致',
  followSuspendHint: '楽譜を手動でスクロールすると追従を一時停止します',
} as const

export { deck }
