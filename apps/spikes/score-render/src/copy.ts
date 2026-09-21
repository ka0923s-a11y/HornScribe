/**
 * Japanese-only UI copy (GUI_UX_PLAN §41 — no language switcher, no English
 * fallback). Canonical groups are reused straight from the committed deck
 * `protocol/copy/ja-JP.json`; `spikeCopy` holds spike-only labels that will be
 * upstreamed to the deck if the spike graduates.
 */
import deck from '../../../../protocol/copy/ja-JP.json';

export const copy = {
  appName: deck.app.name,
  seg: deck.segments.scoreView,
  score: deck.score,
  a11y: deck.a11y,
  common: deck.common,
  renderFailed: deck.errors.scoreRenderFailed,
  fields: deck.properties.fields,
};

/** Spike-only labels (ja). Proper nouns/identifiers stay in Latin script per
 *  §41 exceptions (Verovio, MusicXML, WASM, DPI, ms, file names, ids). */
export const spikeCopy = {
  title: 'UI-003: Verovio 楽譜描画スパイク',
  subtitle: 'MusicXML → SVG 描画・正準ID対応・時間対応の検証',
  fixtureLabel: '検証データ',
  fixtures: {
    golden: 'ゴールデン（タイ・臨時記号・調号）',
    minimal: '最小構成（1小節）',
    multisystem: '複数段・複数ページ（24小節）',
  },
  zoom: '表示倍率',
  zoomIn: '拡大',
  zoomOut: '縮小',
  zoomPresets: '倍率プリセット',
  timeLabel: '再生位置',
  activeAtTime: 'この時刻の音符',
  noActiveNotes: '（この時刻に発音中の音符はありません）',
  noteListHeading: '音符一覧（SVGに依存しない並行表現）',
  selectionHeading: '選択中の音符',
  selectionEmpty: '楽譜上の音符を選択すると、ここに表示されます。',
  selectionRest: '休符（正準IDはありません）',
  metricsHeading: '計測結果（このセッション）',
  metricInit: 'WASM初期化',
  metricLoad: 'loadData',
  metricRender: 'SVG描画（全ページ）',
  metricHighlight: 'ハイライト更新（DOMクラス切替・再描画なし）',
  metricTimeQuery: '時刻→要素（getElementsAtTime）',
  metricElementTime: '要素→時刻（getTimeForElement）',
  metricSwitch: '表示切替（loadData＋全ページ描画）',
  metricZoom: '倍率変更の再描画',
  pagesLabel: 'ページ数',
  notesLabel: '描画された音符',
  canonicalId: '正準ID',
  exportId: 'MusicXML ID',
  onsetMs: '開始時刻',
  measureField: '小節',
  pitchField: '音高',
  dprLabel: 'デバイスピクセル比',
  injectError: 'エラー注入テスト',
  injectErrorTooltip: '不正なMusicXMLを読み込んで描画失敗からの回復を確認します',
  loading: '読み込んでいます',
  versionLabel: 'Verovioバージョン',
  viewSwitchAria: deck.a11y.viewSwitcher,
} as const;
