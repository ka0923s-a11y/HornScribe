/**
 * HornScribe 日本語UI文言の共通定義。
 *
 * docs/JAPANESE_UI_COPY.md に従い、頻出用語・ステータス文を一箇所に集約して
 * 表記ゆれを防ぐ。ユーザー向けUIは日本語のみ（言語切替は実装しない）。
 * 固有名詞（MusicXML, MIDI, FFmpeg, MuseScore 等）は原表記を維持する。
 */
export const ja = {
  app: {
    name: "HornScribe",
    untitled: "名称未設定",
  },

  commandBar: {
    regionLabel: "コマンドバー",
    open: "音声ファイルを開く",
    transcribe: "採譜",
    review: "要確認",
    export: "書き出し",
    settings: "設定",
    overflow: "その他の操作",
  },

  pitch: {
    regionLabel: "表示音高の切り替え",
    concert: "コンサートピッチ",
    hornF: "F管ホルン",
    writtenNote: "記譜音",
  },

  waveform: {
    regionLabel: "波形",
    placeholder: "音源を読み込むと、ここに波形が表示されます",
  },

  score: {
    regionLabel: "楽譜ワークスペース",
  },

  properties: {
    regionLabel: "プロパティ",
    title: "プロパティ",
    placeholder: "音符を選択すると、ここに情報が表示されます",
    close: "プロパティを閉じる",
  },

  transport: {
    regionLabel: "トランスポート",
    skipBack: "先頭へ戻る",
    play: "再生",
    pause: "一時停止",
    playPause: "再生 / 一時停止",
    stop: "停止",
    skipForward: "末尾へ進む",
    loop: "ループを切り替える",
    follow: "再生位置を追従",
    rate: "再生速度",
    position: "現在位置",
  },

  status: {
    regionLabel: "状態表示",
    ready: "準備完了",
    shellInfoLoading: "シェル情報を取得しています…",
    spikeNoFileOpen: "このスパイク版ではファイルを開く機能は未実装です",
    engineNotConnected: "解析エンジン: 未接続",
  },

  emptyState: {
    title: "ここに音声ファイルをドロップ",
    or: "または",
    open: "音声ファイルを開く",
    formats: "WAV・MP3・FLAC・M4A・OGG",
    privacy: "すべての解析はこのPC上で実行されます。",
  },

  settings: {
    title: "設定",
    back: "戻る",
    regionLabel: "設定画面",
    appearanceSection: "外観",
    themeLabel: "テーマ",
    themeSystem: "システム",
    themeLight: "ライト",
    themeDark: "ダーク",
    playbackSection: "再生",
    transcriptionSection: "採譜",
    exportSection: "書き出し",
    toolsSection: "ツール",
    advancedSection: "詳細設定",
    placeholder: "この画面はスパイク用のプレースホルダーです。",
  },

  time: {
    zero: "00:00.0",
    zeroTotal: "00:00.0",
  },
} as const;

export type JaStrings = typeof ja;
