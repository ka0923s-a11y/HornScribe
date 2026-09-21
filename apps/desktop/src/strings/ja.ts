/**
 * HornScribe 日本語UI文言の共通定義。
 *
 * docs/JAPANESE_UI_COPY.md と protocol/copy/ja-JP.json（UI-006 copy deck）
 * に従い、頻出用語・ステータス文を一箇所に集約して表記ゆれを防ぐ。
 * ユーザー向けUIは日本語のみ（言語切替は実装しない）。
 * 固有名詞（MusicXML, MIDI, FFmpeg, MuseScore 等）は原表記を維持する。
 */
export const ja = {
  app: {
    name: "HornScribe",
    untitled: "名称未設定",
  },

  common: {
    cancel: "キャンセル",
    close: "閉じる",
    retry: "再試行",
    back: "戻る",
    next: "次へ",
    prev: "前へ",
    delete: "削除",
    save: "保存",
    browse: "参照…",
    diagnostics: "診断情報",
    or: "または",
    loading: "読み込んでいます",
  },

  commandBar: {
    regionLabel: "コマンドバー",
    open: "音声ファイルを開く",
    transcribe: "採譜",
    retranscribe: "採譜し直す",
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
    empty: "まだ楽譜はありません",
    transcribeStart: "採譜を開始",
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
    volume: "音量",
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

  /** 要確認バッジ (GUI_UX_SPEC §12, copy deck review.status.*) */
  reviewBadge: {
    needsReview: "要確認",
    accepted: "確認済み",
    dismissed: "対応不要",
    fixed: "修正済み",
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

  /**
   * Dev gallery copy (#/dev/gallery). Not part of the product surface, but
   * kept in this file so the gallery itself exercises Japanese labels and
   * mirrors the copy deck instead of growing ad-hoc English.
   */
  gallery: {
    title: "コンポーネントギャラリー",
    devBadge: "開発用",
    note: "ホバー・押下・フォーカスの各セルは疑似状態を静的に再現したものです。実際の挙動はマウス・キーボードでも確認できます。",
    themeLight: "ライト",
    themeDark: "ダーク",
    states: {
      default: "通常",
      hover: "ホバー",
      pressed: "押下",
      focus: "フォーカス",
      selected: "選択",
      disabled: "無効",
      loading: "読み込み中",
      error: "エラー",
    },
    variants: {
      primary: "プライマリ",
      secondary: "セカンダリ",
      subtle: "サブトル",
      danger: "危険",
    },
    sections: {
      button: "ボタン",
      iconButton: "アイコンボタン",
      segmented: "セグメントコントロール",
      tooltip: "ツールチップ",
      popover: "ポップオーバー",
      menu: "メニュー",
      slider: "スライダー",
      numericField: "数値フィールド",
      select: "セレクト",
      progress: "プログレス",
      badge: "ステータス / 要確認バッジ",
      panel: "パネル",
      dialog: "ダイアログ",
      sheet: "シート",
      overlays: "オーバーレイ",
      fixtures: "画面状態フィクスチャ",
    },
    samples: {
      primaryAction: "採譜を開始",
      secondaryAction: "別のファイルを選ぶ",
      subtleAction: "詳細設定",
      dangerAction: "削除",
      save: "保存",
      volumeLabel: "音量",
      rateLabel: "再生速度",
      tempoLabel: "テンポ",
      tempoError: "30から300の範囲で入力してください",
      meterLabel: "拍子",
      meterError: "拍子を選択してください",
      meterOptions: ["4/4", "3/4", "6/8", "2/4"],
      transcribeOptions: "採譜オプション",
      menuFile: "ファイル",
      menuOpenAudio: "音声ファイルを開く",
      menuOpenProject: "プロジェクトを開く",
      menuRecent: "最近使ったプロジェクト",
      menuClose: "プロジェクトを閉じる",
      progressLabel: "採譜の進捗",
      progressStage: "音を解析しています",
      progressDone: "採譜が完了しました",
      progressError: "採譜を完了できませんでした",
      toolFound: "検出済み",
      toolChecking: "確認しています",
      toolMissing: "見つかりません",
      infoNotice: "情報",
      panelTitle: "プロパティ",
      panelBody: "選択中の音符の情報がここに表示されます。",
      floatingPanelTitle: "フローティングパネル",
      dialogTitle: "採譜結果を作り直しますか？",
      dialogBody: "現在の手動修正に影響する可能性があります。",
      dialogConfirm: "採譜し直す",
      dialogOpen: "確認ダイアログを表示",
      sheetTitle: "書き出し",
      sheetOpen: "書き出しシートを表示",
      sheetBody: "MusicXML・PDF・MIDIの書き出しオプションがここに並びます。",
      sheetSubmit: "書き出す",
      fixtureEmpty: "空状態",
      fixtureTranscribing: "採譜中",
      fixtureReview: "要確認",
      fixtureError: "エラー状態",
      fixtureExport: "書き出し",
      reviewBanner: "12か所を確認すると、より確かな楽譜になります",
      reviewCta: "要確認箇所を見る",
      reviewReason: "リズムの解釈を確認してください",
      reviewPosition: "要確認 3 / 12",
      markOk: "問題なし",
      playSource: "元音源を再生",
      errorTitle: "PDFを書き出せません",
      errorBody: "MuseScoreが見つかりません。MusicXMLとMIDIは書き出せます。",
      errorAction: "MuseScoreの場所を指定",
      stageDone: "音声を準備しました",
      stageActive: "音を解析しています",
      stagePending1: "リズムを解析",
      stagePending2: "楽譜を作成",
      stagePending3: "表示を準備",
      exportScore: "コンサートピッチ MusicXML",
      exportHorn: "F管ホルン MusicXML",
      exportPdf: "コンサートピッチ PDF",
      exportMidi: "再生用MIDI（実音）",
      destination: "保存先",
    },
  },
} as const;

export type JaStrings = typeof ja;
