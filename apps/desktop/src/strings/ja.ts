/**
 * HornScribe 日本語UI文言の共通定義。
 *
 * docs/JAPANESE_UI_COPY.md と protocol/copy/ja-JP.json（UI-006 copy deck）
 * に従い、頻出用語・ステータス文を一箇所に集約して表記ゆれを防ぐ。
 * ユーザー向けUIは日本語のみ（言語切替は実装しない）。
 * 固有名詞（MusicXML, MIDI, FFmpeg, MuseScore 等）は原表記を維持する。
 */
/* #175/#189: shared pYIN explanation — used by the settings backend
 * selector and the import-screen per-job engine select. */
const BACKEND_HINT_PYIN =
  "pYINは歌声や単一旋律の採譜に向いています（単音専用）。";

export const ja = {
  app: {
    name: "HornScribe",
    untitled: "名称未設定",
  },

  /** #318: ショートカット一覧ヘルプ — コマンドレジストリから自動生成。 */
  shortcutsHelp: {
    title: "キーボードショートカット",
    empty: "この画面で使えるショートカットはありません",
    sections: {
      file: "ファイル",
      score: "楽譜",
      transport: "再生",
      view: "表示",
      review: "確認",
      edit: "編集",
      export: "書き出し",
      nav: "移動",
      app: "アプリ",
    },
  },
  /** #406: コマンドパレット (Ctrl+K) — レジストリ全体のクイック起動面。 */
  commandPalette: {
    title: "コマンドパレット",
    regionLabel: "コマンドパレット",
    inputLabel: "コマンドを検索",
    placeholder: "コマンドを検索…",
    listLabel: "コマンド一覧",
    empty: "一致するコマンドはありません",
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
    openLabel: "開く",
    openTooltip: "音声ファイルを開く（Ctrl+O）",
    openProjectTooltip: "プロジェクトを開く（Ctrl+Shift+O）",
    transcribeTooltip: "採譜を開始する",
    retranscribeTooltip: "現在の設定でもう一度採譜する",
    exportTooltip: "MusicXML・PDF・MIDIを書き出し",
    reviewWithCount: "要確認（{count}）",
    /* #361: open issues are 0 but a decision history exists — the
     *  review button stays visible as the re-entry point to it. */
    reviewHistory: "要確認履歴",
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
    resizeHandle: "波形の高さを変更",
    /* #113 (spec 8): 選択範囲のコンテキスト操作とズーム表示 */
    selectionActions: "選択範囲の操作",
    loopSelection: "選択範囲をループ",
    playSelection: "選択範囲を再生",
    zoomSelection: "選択範囲へズーム",
    clearSelection: "選択を解除",
    resetZoom: "全体表示に戻す",
    zoomedLabel: "ズーム中",
    /* #116 (spec 8): 長尺音源の全体図ストリップ */
    minimap: "全体図（クリック・矢印キーで移動）",
    /* #376: review-issue markers on the strip — the listbox group
     *  label, one option's name, and a dense cluster's name. */
    reviewMarkers: "要確認マーカー（←→で移動、Enterでジャンプ）",
    reviewMarker: (n: number, title: string, time: string) =>
      `第${n}件 ${title} ${time}`,
    markerCluster: (count: number, firstLabel: string) =>
      `${count}件の要確認（最初: ${firstLabel}）`,
    /* #402: canonical-note overlay — toggle button on the strip */
    noteOverlay: "音符オーバーレイの表示切替",
  },

  score: {
    regionLabel: "楽譜ワークスペース",
    empty: "まだ楽譜はありません",
    transcribeStart: "採譜を開始",
    placeholder: "採譜結果の楽譜はここに表示されます",
  },

  properties: {
    regionLabel: "プロパティ",
    title: "プロパティ",
    placeholder: "音符を選択すると、ここに情報が表示されます",
    close: "プロパティを閉じる",
    show: "プロパティを表示",
    resizeHandle: "プロパティの幅を変更",
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
    /* FEAT-001 (#60): 録音中/楽譜演奏の表示 */
    recordingLabel: "録音中",
    recordingLoopbackLabel: "取り込み中",
    auditionOn: "楽譜の演奏: オン",
    auditionOff: "楽譜の演奏: オフ",
    /* #72: 元音源(取り込んだ音声)のミュート — 楽譜の演奏だけ聴く用途。 */
    muteSource: "元音源をミュート",
    unmuteSource: "元音源のミュートを解除",
    /* #398: 音量ミキサー — パート別 fader/ソロ/ミュート + 元音源 fader。 */
    mixer: "音量ミキサー",
    mixerSource: "元音源",
    partMute: "ミュート",
    partUnmute: "ミュート解除",
    partSolo: "このパートだけ聴く",
    partUnsolo: "ソロを解除",
  },

  status: {
    regionLabel: "状態表示",
    ready: "準備完了",
    shellInfoLoading: "シェル情報を取得しています…",
    engineNotConnected: "解析エンジン: 未接続",
    engineStarting: "解析エンジン: 起動しています",
    engineReady: "解析エンジン: 接続中",
    engineCrashed: "解析エンジン: 停止しました",
    engineUnresponsive: "解析エンジン: 応答なし",
    engineRestarted: "採譜エンジンを再起動しました",
  },

  emptyState: {
    title: "ここに音声ファイルをドロップ",
    or: "または",
    open: "音声ファイルを開く",
    openProject: "プロジェクトを開く",
    formats: "WAV・MP3・FLAC・M4A・OGG",
    privacy: "すべての解析はこのPC上で実行されます。",
    /* FEAT-001 (#60): 録音による取り込み */
    captureTitle: "このPCの音を取り込む",
    captureLoopback: "PCで再生中の音を録音",
    captureMic: "マイクで録音",
    captureHint:
      "録音はこのPCの中だけで行われ、外部に送信されません。連続録音は30分までです。",
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
    recordingsSection: "録音",
    transcriptionSection: "採譜",
    exportSection: "書き出し",
    toolsSection: "ツール",
    advancedSection: "詳細設定",
    placeholder: "この画面はスパイク用のプレースホルダーです。",

    /* ---- UI-060 additions (deck: settings.*) ---- */
    scoreSection: "楽譜",
    navLabel: "設定のカテゴリ",
    defaultRate: "標準再生速度",
    skipSeconds: "戻る/進む秒数",
    secondsUnit: "秒",
    followPlayback: "再生位置を追従",
    tempo: "テンポ",
    tempoAuto: "自動",
    tempoManual: "手動",
    bpm: "BPM",
    meter: "拍子",
    minDuration: "最小音価",
    minDurationEighth: "8分音符",
    minDurationSixteenth: "16分音符",
    minDurationThirtySecond: "32分音符",
    tripletsAllow: "三連符を使う",
    initialView: "初期表示",
    viewContinuous: "連続表示",
    viewPage: "ページ表示",
    defaultFolder: "既定の保存先",
    folderPlaceholder: "未設定",
    musescorePath: "MuseScoreの場所",
    ffmpegPath: "FFmpegの場所",
    pathPlaceholder: "自動検出",
    modelInfo: "モデル情報",
    backendLabel: "採譜エンジン",
    // #175: pYIN tracks one continuous f0 line — better for a single
    // sung/played melody; Basic Pitch stays the polyphonic default.
    backendHint: BACKEND_HINT_PYIN,
    cache: "キャッシュの場所",
    logs: "ログの場所",
    openLogs: "ログフォルダを開く",
    openDiagnostics: "診断情報を開く",
    /* #78: 録音ファイル管理 */
    recordingsFolder: "録音の保存先",
    recordingsCount: (n: number) => `${n} 件の録音`,
    recordingsEmpty: "録音はありません",
    recordingsOpen: "フォルダを開く",
    recordingsClear: "すべて削除",
    recordingsClearConfirmTitle: "録音をすべて削除しますか?",
    recordingsClearConfirmBody:
      "保存先フォルダ内の録音ファイルをすべて削除します。この操作は取り消せません。",
    recordingsClearConfirm: "削除する",
    recordingsCleared: "録音を削除しました",
    recordingsDelete: "削除",
    recordingsDeleteConfirmTitle: "この録音を削除しますか?",
    recordingsDeleteConfirmBody: (name: string) =>
      `${name} を削除します。この操作は取り消せません。`,
    recordingsDeleted: "録音を削除しました",
    recordingsRetention: "古い録音の自動削除",
    recordingsRetentionNever: "削除しない",
    recordingsRetentionDays: (n: number) => `${n} 日たったら削除`,
    recordingsPruned: (n: number) => `古い録音を ${n} 件削除しました`,
    recordingsUnavailable: "録音の管理はデスクトップアプリで利用できます。",
    /* #147: managed 音源 appDataDir/sources/ — プロジェクト保存時に
     *  録音をコピーした永続領域 (#132)。保持ポリシー対象外なので
     *  容量管理はここで行う。 */
    sourcesSection: "プロジェクトの音源",
    sourcesCount: (n: number) => n + " 件の音源",
    sourcesEmpty: "保存された音源はありません",
    sourcesReferenced: "プロジェクトが参照中",
    sourcesDeleteConfirmTitle: "この音源を削除しますか?",
    sourcesDeleteConfirmBody: (name: string) =>
      name + " を削除します。この操作は取り消せません。",
    sourcesDeleteConfirmBodyReferenced: (name: string, count = 1) =>
      name +
      " は保存済みプロジェクト " +
      count +
      " 件から参照されています。削除すると、そのプロジェクトを開いたときに音源が見つかりません。この操作は取り消せません。",
    sourcesDeleted: "音源を削除しました",
  },

  time: {
    zero: "00:00.0",
    zeroTotal: "00:00.0",
  },

  /* ============================ UI-040 ============================
   * 採譜ジョブの進捗・キャンセル (issue #27, GUI_UX_SPEC §5)。
   * 正準コピーは protocol/copy/ja-JP.json の transcription.* —
   * ここでは同じ文面をミラーする（デッキ直結はアプリ配線時に
   * 一本化する TODO があるため、現行の ja.ts ミラー方針に従う）。
   */
  transcription: {
    running: "採譜中",
    start: "採譜を開始",
    cancel: "キャンセル",
    cancelling: "キャンセルしています…",
    cancelled: "採譜をキャンセルしました",
    completed: "採譜が完了しました",
    progressAria: "採譜の進捗",
    elapsedLabel: "経過時間",
    note: "採譜中も再生・一時停止・波形の移動ができます。",
    stages: {
      preparing_audio: {
        pending: "音声を準備",
        active: "音声を準備しています",
        done: "音声を準備しました",
      },
      transcribing: {
        pending: "音を解析",
        active: "音を解析しています",
        done: "音を解析しました",
      },
      cleaning: {
        pending: "検出結果を整理",
        active: "検出結果を整理しています",
        done: "検出結果を整理しました",
      },
      analyzing_rhythm: {
        pending: "リズムを解析",
        active: "リズムを解析しています",
        done: "リズムを解析しました",
      },
      quantizing: {
        pending: "音符の長さと位置を整える",
        active: "音符の長さと位置を整えています",
        done: "音符の長さと位置を整えました",
      },
      building_score: {
        pending: "楽譜を作成",
        active: "楽譜を作成しています",
        done: "楽譜を作成しました",
      },
      rendering: {
        pending: "表示を準備",
        active: "楽譜を表示しています",
        done: "表示を準備しました",
      },
    },
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
      importStates: "取り込み画面状態（UI-020）",
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
      fixtureAudioReady: "音声準備完了",
      fixtureSourceMissing: "元音源なし",
      fixtureOpening: "読み込み中",
      fixtureRecentProject: "最近のプロジェクト例",
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

  /**
   * Command registry titles (GUI_UX_SPEC §23). One canonical Japanese label
   * per command — command bar, menus, tooltips and screen readers all
   * announce the same string, so terminology never drifts.
   */
  commands: {
    openAudio: "音声ファイルを開く",
    openProject: "プロジェクトを開く",
    transcribe: "採譜",
    retranscribe: "採譜し直す",
    cancelTranscription: "採譜をキャンセル",
    playPause: "再生 / 一時停止",
    stop: "停止",
    jumpBack: "戻る",
    jumpForward: "進む",
    seekStart: "先頭へ移動",
    seekEnd: "末尾へ移動",
    toggleLoop: "ループを切り替える",
    concertPitch: "コンサートピッチ",
    hornF: "F管ホルン",
    openReview: "要確認箇所を見る",
    reviewNext: "次の要確認箇所へ",
    reviewPrevious: "前の要確認箇所へ",
    /* UI-050 要確認ワークスペース (§12) */
    reviewPlaySource: "元音源を再生",
    reviewAccept: "問題なし",
    reviewDismiss: "対応不要にする",
    reviewPitchUp: "半音上げる",
    reviewPitchDown: "半音下げる",
   reviewDeleteOrRestore: "削除 / 復元",
   reviewExit: "要確認を終了",
    /* #361: review navigator — the issue-list popover (I キー). */
    reviewNavigator: "要確認の一覧",
   undo: "元に戻す",
    redo: "やり直し",
    export: "書き出し",
    openInMuseScore: "MuseScoreで開く",
    zoomScoreIn: "楽譜を拡大",
    zoomScoreOut: "楽譜を縮小",
    zoomScoreFit: "楽譜を幅に合わせる",
    clearSelection: "選択を解除",
    nextRegion: "次の領域へ移動",
    previousRegion: "前の領域へ移動",
    settings: "設定",
    diagnostics: "診断情報",
    /* FEAT-001 (#60): capture + score audition */
   captureSystemAudio: "PCの音を取り込む",
   captureMicrophone: "マイクで録音",
    /** #18: 採譜キュー。 */
    openQueue: "採譜キュー…",
    enqueueAudio: "キューに音源を追加…",
    stopCapture: "録音を終了して取り込む",
    cancelCapture: "録音をやめる",
    /* #80: 録音の一時停止/再開 */
    pauseCapture: "録音を一時停止",
    resumeCapture: "録音を再開",
    toggleAudition: "楽譜を演奏",
    toggleSourceMute: "元音源のミュート",
    /* #100: project save */
    saveProject: "プロジェクトを保存",
    /* #221: Save As — distinct from 書き出し (export artifacts). */
    saveProjectAs: "名前を付けて保存",
    /* #114 (spec 10/13): score note navigation + edits outside review */
    selectNextNote: "次の音符へ",
    selectPreviousNote: "前の音符へ",
    notePitchUp: "半音上げる",
    notePitchDown: "半音下げる",
    noteToggleDeleted: "音符を削除 / 復元",
    noteEnharmonic: "異名同音で書き換える",
    /* #115 (spec 13): rhythm edits via the engine's score.edit */
    noteLonger: "音価を2倍にする",
    noteShorter: "音価を半分にする",
    noteShiftLeft: "発音位置を左へ移動",
    noteShiftRight: "発音位置を右へ移動",
    noteToggleTie: "次の音符とタイで結ぶ / 解く",
    requantize: "採譜設定を変えて再適用",
    noteSplit: "音符を分割",
    noteMerge: "次の音符と結合",
    restToNote: "休符を音符に変換",
    /* #267: octave arrange — REAL sounding pitch changes (not the
     *  F管 written-pitch projection), one canonical edit. */
    scoreOctaveUp: "全曲を1オクターブ上げる",
    scoreOctaveDown: "全曲を1オクターブ下げる",
    /* #318: F1 keyboard-shortcuts help (matches ja.shortcutsHelp.title). */
    help: "キーボードショートカット",
    /* #406: Ctrl+K command palette (matches ja.commandPalette.title). */
    commandPalette: "コマンドパレット",
  },

  /**
   * Command feedback announced in the status area (role="status" is
   * aria-live polite, so these lines are what screen-reader users hear
   * when a command runs or cannot run).
   */
  commandFeedback: {
    pitchConcert: "コンサートピッチに切り替えました",
    pitchHornF: "F管ホルン表示に切り替えました",
    mutedSource: "元音源をミュートしました",
    unmutedSource: "元音源のミュートを解除しました",
    // Product-safe copy — the spike-era string must never reach the
    // shipped UI (commandFeedback.* is announced in the status bar).
    notImplemented: "この操作はまだ実行できません",
    disabled: "この操作は現在実行できません",
    nothingToUndo: "元に戻す操作はありません",
    nothingToRedo: "やり直す操作はありません",
    museScoreOpened: "MuseScoreで開きました",
    museScoreMissing:
      "MuseScoreが見つかりません。設定 → ツールで場所を指定してください",
    museScoreFailed: "MuseScoreで開けませんでした",
    // #115: engine rhythm edits (score.noteLonger/Shorter/Shift*/Tie).
    rhythmEdited: "音符の長さ・位置を変更しました",
    tieToggled: "タイを切り替えました",
    rhythmEditFailed: "この編集は適用できません",
    rhythmEditUnavailable: "この楽譜ではリズム編集を利用できません",
    // #392: an in-flight rhythm edit merged/deleted a note the user
    // was editing — the interleaved fix cannot rebase, so say so
    // instead of letting it vanish quietly.
    editConflict:
      "音符の結合・削除と重なったため、一部の修正を適用できませんでした",
    tempoChanged: "テンポを変更しました",
    tempoChangeRemoved: "テンポ変化を削除しました",
    meterChanged: "拍子を変更しました",
    // #358: user-corrected anacrusis via the properties pickup field.
    pickupChanged: "弱起を変更しました",
    keyChanged: "調を変更しました",
    keyChangeRemoved: "転調を削除しました",
    metadataChanged: "譜面情報を更新しました",
    octaveShifted: "実音を1オクターブ変更しました",
    requantized: "採譜設定を適用して楽譜を更新しました",
    // #226: the document carries no raw transcription evidence (older
    // projects / imported scores) — the requantize re-rounds the
    // notation itself instead of replaying the performance, so say so.
    requantizedSynthetic:
      "採譜設定を適用して楽譜を整形しました（元の演奏データが無いため簡易モード）",
    noteSplit: "音符を分割しました",
    notesMerged: "音符を結合しました",
    restConverted: "休符を音符に変換しました",
    // #113: media A-B loop arming (transport.toggleLoop on AUDIO_READY).
    loopOn: "ループをオンにしました",
    loopOff: "ループをオフにしました",
    focusMoved: (zoneName: string) => `${zoneName}に移動しました`,
    zoneNames: {
      commandbar: "コマンドバー",
      waveform: "波形",
      score: "楽譜",
      properties: "プロパティ",
      transport: "トランスポート",
      status: "状態表示",
      settings: "設定",
    },
  },
  /* ============================ prototype ============================
   * UI-009 (issue #31): 事前検証プロトタイプ専用の文言。
   * 正準コピーは protocol/copy/ja-JP.json（UI-006）。ここでは同じ文面を
   * ミラーし、プロトタイプ固有の案内文のみ新規に定義する。
   * 本実装ではデッキから直接解決するため、重複は意図的な仮置き。
   */
  prototype: {
    nav: {
      regionLabel: "プロトタイプの状態切替",
      index: "状態一覧",
      badge: "開発用プロトタイプ",
      exit: "通常の画面へ戻る",
      themeLabel: "テーマ",
      themeSystem: "システム",
      themeLight: "ライト",
      themeDark: "ダーク",
    },
    index: {
      title: "プロトタイプ状態一覧",
      lead: "情報階層と操作モデルを本実装の前に検証するための画面集です。",
      note: "採譜エンジンや音声とは接続していません。すべて固定のモックデータで描画されます。",
      open: "この状態を開く",
    },
    pages: {
      shell: {
        title: "P1 アプリシェル",
        desc: "コマンドバー・波形・楽譜・プロパティ・トランスポートの配置。空・音源読込後・採譜中・採譜完了を遷移する。",
      },
      density: {
        title: "P2 日本語密度",
        desc: "1366×768での描画、150%スケーリング確認手順、長い日本語ラベルと長いエラー文、ライト/ダーク。",
      },
      score: {
        title: "P3 楽譜操作",
        desc: "音符選択→プロパティ、再生ハイライト、コンサートピッチ/F管ホルン切替、追従の一時停止と再開。",
      },
      review: {
        title: "P4 要確認フロー",
        desc: "5件の要確認箇所。前後移動・元音源再生・問題なし・音高修正・元に戻すをキーボードのみで完了できる。",
      },
      export: {
        title: "P5 書き出しとエラー回復",
        desc: "通常の書き出し、MuseScore未検出、保存先の権限エラー、採譜エンジン停止、元音源なし。",
      },
    },
    dev: {
      controlsLabel: "プロトタイプ制御",
      stateLabel: "状態",
      viewLabel: "表示",
      themeLabel: "テーマ",
      light: "ライト",
      dark: "ダーク",
      frameCaption: "1366×768 のウィンドウ相当",
    },
    common: {
      cancel: "キャンセル",
      close: "閉じる",
      retry: "再試行",
      next: "次へ",
      prev: "前へ",
      undo: "元に戻す",
      delete: "削除",
      diagnostics: "診断情報",
      or: "または",
    },
    shell: {
      stateEmpty: "空の状態",
      stateAudioReady: "音源読込後",
      stateTranscribing: "採譜中",
      stateScoreReady: "採譜完了",
      docTitle: "朝練ホルン独奏",
      transcribeNote: "採譜中も再生・一時停止・波形の移動ができます。",
    },
    transcribing: {
      running: "採譜中",
      cancel: "キャンセル",
      completed: "採譜が完了しました",
      stages: {
        preparingAudio: {
          pending: "音声を準備",
          active: "音声を準備しています",
          done: "音声を準備しました",
        },
        transcribing: {
          pending: "音を解析",
          active: "音を解析しています",
          done: "音を解析しました",
        },
        cleaning: {
          pending: "検出結果を整理",
          active: "検出結果を整理しています",
          done: "検出結果を整理しました",
        },
        analyzingRhythm: {
          pending: "リズムを解析",
          active: "リズムを解析しています",
          done: "リズムを解析しました",
        },
        quantizing: {
          pending: "音符の長さと位置を整える",
          active: "音符の長さと位置を整えています",
          done: "音符の長さと位置を整えました",
        },
        buildingScore: {
          pending: "楽譜を作成",
          active: "楽譜を作成しています",
          done: "楽譜を作成しました",
        },
        rendering: {
          pending: "表示を準備",
          active: "楽譜を表示しています",
          done: "表示を準備しました",
        },
      },
    },
    scoreEmpty: {
      body: "まだ楽譜はありません",
      cta: "採譜を開始",
    },
    reviewBanner: {
      text: (count: number) =>
        `${count}か所を確認すると、より確かな楽譜になります`,
      cta: "要確認箇所を見る",
    },
    density: {
      viewShell: "シェル（長いラベル）",
      viewError: "長いエラー文",
      scalingTitle: "150%スケーリング確認手順",
      scalingSteps: [
        "Windows の設定 → システム → ディスプレイ → 拡大縮小を 150% にする",
        "またはブラウザのズーム（Ctrl + +）を 150% にする",
        "1366×768 相当の枠内で、コマンドバー・トランスポート・プロパティの主要操作が切れずに表示されることを確認する",
        "ライト / ダーク両方のテーマで同じ確認を行う",
      ],
      checkTitle: "確認ポイント",
      checks: [
        "主要操作が切れていないこと",
        "コマンドバーが横スクロールしないこと",
        "長いエラー文に回復操作が付いていること",
        "楽譜が最も大きな領域であること",
      ],
    },
    scoreView: {
      hornCaption: "記譜音",
      hint: "← → で音符を移動、Esc で選択解除、Alt+↑↓ で半音、Space で再生",
      regionLabel: "楽譜",
    },
    properties: {
      title: "プロパティ",
      close: "プロパティを閉じる",
      reopen: "プロパティを開く",
      empty: "楽譜上の音符を選択すると、ここにプロパティが表示されます。",
      noteSection: "音符",
      fields: {
        pitch: "音高",
        spelling: "表記",
        onset: "開始位置",
        duration: "音の長さ",
        measure: "小節",
        confidence: "モデル確信度",
        sourcePosition: "元音源の位置",
      },
      actions: {
        pitchUp: "半音上げる",
        pitchDown: "半音下げる",
        enharmonic: "異名同音を切り替える",
        delete: "削除",
        restore: "復元",
        playSource: "元音源を再生",
      },
      deleted: "この音符は削除されています",
      writtenNoteSuffix: "記譜音",
    },
    transport: {
      regionLabel: "トランスポート",
      skipBack: "戻る",
      play: "再生",
      pause: "一時停止",
      playPause: "再生 / 一時停止",
      stop: "停止",
      skipForward: "進む",
      toStart: "先頭へ",
      loop: "ループ",
      loopToggle: "ループを切り替える",
      follow: "追従",
      followFull: "再生位置を追従",
      followPaused: "再生位置の追従を一時停止しました",
      resumeFollow: "追従を再開",
      rate: "再生速度",
      position: "現在位置と総時間",
      loopRange: "ループ範囲",
      scrollHint: "楽譜をスクロールすると追従が一時停止します",
    },
    review: {
      title: "要確認",
      exit: "要確認を終了",
      position: (current: number, total: number) =>
        `要確認 ${current} / ${total}`,
      remaining: (count: number) => `残り ${count} か所`,
      allDone: "すべての要確認箇所を確認しました",
      /* #272: issues dropped by the surfacing cap — the header shows
       * the count so the truncation is never silent. */
      omitted: (count: number) => `（他 ${count} 件を省略）`,
      playSource: "元音源を再生",
      markOk: "問題なし",
      fixPitch: "音高修正",
      deleteNote: "削除",
      undo: "元に戻す",
      confidence: (percent: number) => `モデル確信度: ${percent}%`,
      playingSource: "元音源を再生しています…",
      hint: "← → で移動、R で元音源、O で問題なし、Alt+↑↓ で音高修正、Delete で削除、Ctrl+Z で元に戻す、Esc で終了",
      status: {
        pending: "未確認",
        accepted: "確認済み",
        fixed: "修正済み",
        deleted: "削除済み",
      },
      reasons: {
        quantizationAmbiguous: {
          title: "リズムの解釈を確認してください",
          detail: "リズムの取り方が複数考えられます。",
        },
        beatAlignmentUncertain: {
          title: "拍位置を確認してください",
          detail: "音の開始位置が拍の格子からずれている可能性があります。",
        },
        possibleTriplet: {
          title: "三連符の可能性があります",
          detail: "三連符として解釈できる箇所があります。",
        },
        outsideHornRange: {
          title: "ホルンの音域を確認してください",
          detail: "一般的なホルンの音域を外れている可能性があります。",
        },
        offsetAmbiguous: {
          title: "音の長さを確認してください",
          detail: "音の終了位置が曖昧です。",
        },
      },
    },
    exportSheet: {
      title: "書き出し",
      scoreSection: "楽譜",
      pdfSection: "PDF",
      midiSection: "MIDI",
      options: {
        concertMusicxml: "コンサートピッチ MusicXML",
        hornMusicxml: "F管ホルン MusicXML",
        concertPdf: "コンサートピッチ PDF",
        hornPdf: "F管ホルン PDF",
        playbackMidi: "再生用MIDI（実音）",
      },
      destination: "保存先",
      chooseDestination: "保存先を選ぶ",
      chooseAnotherDestination: "別の保存先を選ぶ",
      submit: "書き出す",
      running: "書き出しています…",
      museScoreMissingNote:
        "PDFを書き出すにはMuseScoreが必要です。MusicXMLとMIDIはそのまま書き出せます。",
      pdfDisabledTooltip: "MuseScoreが見つからないためPDFを書き出せません",
      completeTitle: "書き出しが完了しました",
      revealInExplorer: "エクスプローラーで表示",
      sampleDestination: "C:\\Users\\player\\Documents\\HornScribe",
    },
    exportScenarios: {
      normal: "通常の書き出し",
      musescoreMissing: "MuseScore未検出",
      permissionDenied: "保存先の権限エラー",
      workerCrashed: "エンジン停止",
      sourceMoved: "元音源なし",
    },
    errors: {
      ffmpegMissing: {
        title: "音声を準備できません",
        body: "FFmpegが見つかりません。音声ファイルの変換に必要です。プロジェクトと元音源は失われていません。FFmpegをインストールするか、場所を指定してからもう一度試してください。",
        specifyFfmpeg: "FFmpegの場所を指定",
      },
      musescoreMissing: {
        title: "PDFを書き出せません",
        body: "MuseScoreが見つかりません。MusicXMLとMIDIは書き出せます。",
        specifyMusescore: "MuseScoreの場所を指定",
        exportMusicxml: "MusicXMLを書き出す",
      },
      exportPermissionDenied: {
        title: "保存先に書き込めません",
        body: "選択したフォルダへの書き込み権限がありません。プロジェクトと楽譜は失われていません。",
        chooseDestination: "別の保存先を選ぶ",
      },
      workerCrashed: {
        title: "採譜エンジンが停止しました",
        body: "現在のプロジェクトと保存済みの採譜結果は失われていません。",
        restartEngine: "エンジンを再起動",
      },
      sourceMoved: {
        title: "元音源が見つかりません",
        body: "前回の場所から音声ファイルが移動した可能性があります。採譜結果と楽譜は保持されています。",
        specifySource: "音源を指定",
      },
    },
    status: {
      selectedNone: "音符は選択されていません",
      playing: "再生中",
      paused: "一時停止中",
      stopped: "停止",
      issueResolved: "確認済みにしました",
      pitchFixed: "音高を修正しました",
      noteDeleted: "音符を削除しました",
      noteRestored: "音符を復元しました",
      undone: "元に戻しました",
      nothingToUndo: "元に戻す操作はありません",
      exportDone: "書き出しが完了しました",
      engineRestarted: "採譜エンジンを再起動しました",
      sourceSpecified: "元音源を関連付け直しました",
      simulatedSeek: "元音源の該当位置へ移動しました",
    },
  },

  /* ============================ import (UI-020) ============================
   * 取り込みフロー専用の文言。正準は protocol/copy/ja-JP.json の
   * emptyStates / loading / errors / transcription.options / notifications。
   */
  import: {
    /** OPENING_AUDIO — indeterminate loading line (loading.openingAudio /
        loading.openingProject)。 */
    opening: {
      audio: "音声ファイルを読み込んでいます",
      project: "プロジェクトを読み込んでいます",
    },
    /** ファイルダイアログのフィルタ名（OSのダイアログ内の表示）。 */
    dialog: {
      audioFilter: "音声ファイル",
      projectFilter: "HornScribeプロジェクト",
      allFiles: "すべてのファイル",
    },
    /** 最近使ったプロジェクト (emptyStates.launch.recentProjects)。 */
    recent: {
      title: "最近使ったプロジェクト",
      openAria: (name: string) => `最近のプロジェクト ${name} を開く`,
      /** #364: per-entry 履歴から削除 affordance. */
      removeTitle: "履歴から削除",
      removeAria: (name: string) => `最近のプロジェクト ${name} を履歴から削除`,
    },
    /** AUDIO_READY の採譜オプション popover (transcription.options)。 */
    audioOptions: {
      label: "採譜オプション",
      tempo: "テンポ",
      tempoAuto: "自動",
      tempoManual: "手動",
      tempoBpm: "テンポ（手動）",
      meter: "拍子",
      meterAuto: "自動",
      minDuration: "最小音価",
      minDuration8: "8分音符",
      minDuration16: "16分音符",
      minDuration32: "32分音符",
      triplets: "三連符",
      tripletsAuto: "自動",
      tripletsAllow: "許可",
      tripletsNone: "なし",
      simplicity: "楽譜の簡潔さ",
      simplicityStandard: "標準",
      simplicitySimple: "簡潔",
      simplicityDetailed: "詳細",
      range: "採譜範囲",
      rangeAll: "全体",
      rangeSelection: "選択範囲",
      rangeStart: "開始",
      rangeEnd: "終了",
      // #346: field error when the 選択範囲 pair is empty/inverted.
      rangeInvalid: "終了は開始より後の時刻を指定してください",
      secondsUnit: "秒",
      texture: "音源の種類",
      textureAuto: "自動",
      textureMono: "単旋律（楽器・歌声のみ）",
      textureMelody: "メロディ優先（ミックス音源）",
      textureVoices: "複数声部として採譜（重奏・和音を含む演奏）",
      textureChords: "和音として採譜（同リズムの重音を1パートの和音に）",
      /* #251: 出力モードの「演奏可能性」を用途ベースで説明する。
       *  ソロ（auto/mono/melody）= 1人のF管奏者がそのまま演奏できる
       *  主成果物。voices = 複数奏者向けの重奏譜。chords = 原音の
       *  重音構造を保存する分析的表現で、1人用の演奏譜ではない。 */
      textureHint: (texture: string) =>
        texture === "voices"
          ? "声部ごとにF管パートを分けます。複数の奏者向けの重奏譜です。"
          : texture === "chords"
            ? "同時に鳴る音を1パートの和音として残します。1人で演奏する譜面ではありません。"
            : "1人のF管奏者がそのまま演奏できる譜面を作ります。",
      /* #355: voice cap field shown for the voices/chords textures. */
      maxVoices: "最大声部数（2〜8）",
      /* #189: per-job engine override — "auto" inherits 設定→詳細設定. */
      backend: "採譜エンジン",
      backendAuto: "自動（設定に従う）",
      backendHint: BACKEND_HINT_PYIN,
      /* #187: opt-in vocal isolation (center extraction). */
      vocalIsolation: "ボーカル分離を使う（ミックス音源向け）",
      vocalIsolationHint:
        "中央定位のボーカルを推定してから採譜します。JPOPなど伴奏付き音源の主旋律抽出に有効ですが、完全な分離ではありません。開発環境で pip install hornscribe[engine-vocal] を入れると、より精度の高い demucs による分離に自動で切り替わります。",
      /* #322: shown in place of vocalIsolationHint when the texture
       * is voices/chords — the checkbox is disabled and this explains
       * why the two options cannot combine. */
      vocalIsolationPolyphonicHint:
        "複数声部・和音として採譜する場合、ボーカル分離は使えません（伴奏を取り除くと重なった声部も失われるため）。",
    },
    /** エラーカード (errors.* — title/body/actions の3点構成)。 */
    errors: {
      unsupportedTitle: "対応していないファイル形式です",
      unsupportedBody:
        "このファイル形式は読み込めません。対応している形式は WAV・MP3・FLAC・M4A・OGG です。元のファイルは変更されていません。",
      openFailedTitle: "音声ファイルを開けません",
      openFailedBody:
        "このファイル形式を読み込めないか、ファイルが破損している可能性があります。元のファイルは変更されていません。",
      projectOpenFailedTitle: "プロジェクトを開けません",
      projectOpenFailedBody:
        "ファイルが破損しているか、対応していない形式の可能性があります。",
      chooseAnother: "別のファイルを選ぶ",
      /** #364: drop the dead MRU entry from the projectOpenFailed card.
       *  One click removes and closes — the refreshed list shows on EMPTY. */
      removeFromRecent: "履歴から削除して閉じる",
      close: "閉じる",
      sourceMissingTitle: "元音源が見つかりません",
      sourceMissingBody:
        "前回の場所から音声ファイルが移動した可能性があります。採譜結果と楽譜は保持されています。",
      lastLocation: "前回の場所: ",
      specifySource: "音源を指定",
      specifyAnother: "別の音源を指定",
      hashMismatchTitle: "指定されたファイルは元音源と一致しません",
      hashMismatchBody:
        "内容が異なるため、このファイルは元音源として関連付けられません。別のファイルを指定してください。",
    },
    /** 波形領域 (waveform.*) — 読込中と読込済みの注記。 */
    waveform: {
      loading: "波形を読み込んでいます",
      seekAria: "波形上の再生位置",
    },
    /** 状態表示へのアナウンス (notifications / aria-live feedback)。 */
    feedback: {
      loaded: (name: string) => `${name} を読み込みました`,
      /* #348: single-document app — multi-file drops announce the
       * constraint instead of silently taking the first file. */
      multiFileNotice:
        "一度に開けるのは1ファイルだけです。先頭のファイルを開きます",
      projectOpened: (name: string) => `${name} を開きました`,
      /* #391: the main .hornscribe.json was unreadable and the open
       * came from the .recovery sibling — tell the user explicitly
       * (and that Ctrl+S repairs the main file). */
      projectRecovered: (name: string) =>
        `${name} は前回保存時のバックアップから復元しました。元のファイルは読み込めませんでした。保存し直すには Ctrl+S を押してください`,
      sourceRelinked: "元音源を関連付け直しました",
      transcribeCancelled: "採譜をキャンセルしました",
      playing: "再生中",
      paused: "一時停止中",
      stopped: "停止",
      position: (time: string) => `位置: ${time}`,
    },
  },

  /* ============================ UI-040 ============================
   * 採譜失敗・診断 (issue #27, GUI_UX_SPEC §20/§19) —
   * errors.* / diagnostics.* のミラー。
   */

  /** §20 エラー面 — 何が失敗したか / 何が保持されているか / 次にできること */
  errors: {
    transcriptionFailed: {
      title: "採譜を完了できませんでした",
      body: "元音源とプロジェクトは保持されています。",
      retry: "再試行",
      diagnostics: "診断情報",
    },
    workerCrashed: {
      title: "採譜エンジンが停止しました",
      body: "現在のプロジェクトと保存済みの採譜結果は失われていません。",
      restartEngine: "エンジンを再起動",
      diagnostics: "診断情報",
    },
    workerNotResponding: {
      title: "採譜エンジンが応答していません",
      body: "現在のプロジェクトと保存済みの採譜結果は失われていません。エンジンを再起動できます。",
      restartEngine: "エンジンを再起動",
      diagnostics: "診断情報",
    },
    /* #195: ENGINE_DEPENDENCY_MISSING — retrying can never succeed,
     * so the surface names the package and leads with diagnostics. */
    dependencyMissing: {
      title: "採譜エンジンの部品が見つかりません",
      body: (pkg: string) =>
        `必要な部品（${pkg}）がエンジン環境にありません。アプリを再インストールするか、開発環境では pip install hornscribe[engine] を実行してからもう一度お試しください。`,
      unknownPackage: "名称不明のパッケージ",
      diagnostics: "診断情報を見る",
    },
    close: "閉じる",
    /* ---- UI-060 export errors (deck: errors.*; the export dialog maps
       stable ExportError codes onto these — engine stderr/stack traces
       never reach the surface). ---- */
    musescoreMissing: {
      title: "PDFを書き出せません",
      body: "MuseScoreが見つかりません。MusicXMLとMIDIは書き出せます。",
      actions: {
        specifyMusescore: "MuseScoreの場所を指定",
        exportMusicxml: "MusicXMLを書き出す",
        close: "閉じる",
      },
    },
    engineUnavailable: {
      title: "採譜エンジンに接続できません",
      body: "書き出しと採譜にはエンジンへの接続が必要です。エンジンを再起動するか、診断情報で状態を確認してください。",
      actions: {
        diagnostics: "診断情報",
        restartEngine: "エンジンを再起動",
        close: "閉じる",
      },
    },
    exportFailed: {
      title: "書き出しを完了できませんでした",
      body: "書き出し先への保存に失敗しました。プロジェクトと楽譜は失われていません。",
      actions: {
        chooseDestination: "別の保存先を選ぶ",
        retry: "再試行",
      },
    },
    exportPermissionDenied: {
      title: "保存先に書き込めません",
      body: "選択したフォルダへの書き込み権限がありません。プロジェクトと楽譜は失われていません。",
      actions: {
        chooseDestination: "別の保存先を選ぶ",
      },
    },
    /* ---- #384: cause-specific export failures — each entry feeds
       one ErrorKind in ExportDialog so the recovery action matches
       the actual cause. exportShared.kept* states 何が保持されたか
       (§20 contract); the staging model (#258) guarantees no partial
       artifacts until the commit loop. ---- */
    exportShared: {
      backToForm: "書き出し設定に戻る",
      kept: "書き出しは完了していません。保存先の既存ファイルは変更されていません。",
      keptPartial:
        "保存の途中で失敗したため、一部のファイルが保存先に残っている可能性があります。不要であれば削除してから再度書き出してください。",
    },
    exportDiskFull: {
      title: "空き容量が不足しています",
      body: "保存先または作業用ドライブの空き容量が足りず、ファイルを書き込めませんでした。空き容量を確保するか、別の保存先を選んでください。",
      actions: {
        chooseDestination: "別の保存先を選ぶ",
        retry: "再試行",
      },
    },
    exportDestinationInvalid: {
      title: "保存先を利用できません",
      body: "選択した保存先が存在しないか、フォルダとして使用できません。別の保存先を選んでください。",
      actions: {
        chooseDestination: "別の保存先を選ぶ",
      },
    },
    exportSourceMissing: {
      title: "元の音源が見つかりません",
      body: "同梱する音源ファイルが移動または削除されています。音源の同梱をオフにして書き出すか、読み込み画面で音源を再リンクしてください。",
      actions: {
        backToForm: "書き出し設定に戻る",
      },
    },
    exportRenderFailed: {
      title: "PDFの変換に失敗しました",
      body: "MuseScoreによるPDF変換が正常に終了しませんでした。MusicXMLとMIDIには影響ありません。再試行するか、診断情報でMuseScoreの状態を確認してください。",
      actions: {
        retry: "再試行",
        diagnostics: "診断情報",
      },
    },
    exportWriteFailed: {
      title: "ファイルを書き込めませんでした",
      body: "書き出し用ファイルの作成に失敗しました。別の保存先を選ぶか、再試行してください。",
      actions: {
        retry: "再試行",
        chooseDestination: "別の保存先を選ぶ",
      },
    },
    exportCommitFailed: {
      title: "保存の途中で失敗しました",
      body: "ファイルを保存先へ移す途中でエラーが発生しました。保存先の空き容量と権限を確認して、もう一度書き出してください。",
      actions: {
        retry: "再試行",
        chooseDestination: "別の保存先を選ぶ",
      },
    },
    exportInternal: {
      title: "予期しないエラーが発生しました",
      body: "書き出し処理で予期しないエラーが発生しました。再試行しても解決しない場合は、診断情報を確認してください。",
      actions: {
        retry: "再試行",
        diagnostics: "診断情報",
      },
    },
    exportNameExhausted: {
      title: "ファイル名を決定できませんでした",
      body: "同名のファイルが多数あるため、空いている名前を付けられませんでした。書き出し名を変更するか、別の保存先を選んでください。",
      actions: {
        backToForm: "書き出し設定に戻る",
      },
    },
  },

  /** 診断情報 (GUI_UX_SPEC §19) — セッションが正直に報告できる範囲のみ。
   *  UI-060 adds the full sheet surface (fields/groups/actions). */
  diagnostics: {
    title: "診断情報",
    copy: "診断情報をコピー",
    copied: "診断情報をコピーしました",
    close: "閉じる",
    fields: {
      appVersion: "HornScribeのバージョン",
      engineVersion: "Pythonエンジンのバージョン",
      protocolVersion: "プロトコルバージョン",
      backend: "採譜エンジン",
      ffmpeg: "FFmpeg",
      musescore: "MuseScore",
      // #10: vocal-separation engine — engine-reported, not shell-probed
      demucs: "demucs（ボーカル分離）",
      verovio: "Verovio",
      wavesurfer: "wavesurfer",
      cachePath: "キャッシュの場所",
      logPath: "ログの場所",
      workerStatus: "エンジンの状態",
    },
    groups: {
      versions: "バージョン",
      tools: "ツールの状態",
      locations: "場所",
    },
    copyFailed: "診断情報をコピーできませんでした",
    openLogs: "ログフォルダを開く",
    openLogsFailed: "ログフォルダを開けませんでした",
    restartEngine: "エンジンを再起動",
    restarted: "エンジンを再起動しました",
    restartFailed: "エンジンを再起動できませんでした",
    collecting: "診断情報を集めています",
    notConnected: "未接続",
    unknown: "不明",
    workerStates: {
      running: "稼働中",
      stopped: "停止中",
      unavailable: "未接続",
    },
  },

  /* ====================== UI-030 score workspace ======================
   * 本実装の楽譜ワークスペース文言。prototype.* ではなく本番の面に使う。 */
  scoreView: {
    regionLabel: "楽譜",
    loading: "楽譜を読み込んでいます…",
    /* #399: engine editがqueueで実行中 — statusbarの小さなbusy表示。 */
    updating: "楽譜を更新しています…",
    renderErrorTitle: "楽譜を表示できません",
    renderErrorBody:
      "楽譜データの読み込みに失敗しました。プロジェクトと採譜結果は失われていません。",
    /* #401: 初期化失敗も同じerror契約 — title=何が失敗 /
       body=何が保持される / actions=再試行+診断情報。raw例外は
       診断情報ダイアログ行きで表示面へ出さない。 */
    initErrorTitle: "楽譜を表示できません",
    initErrorBody:
      "楽譜表示機能を初期化できませんでした。採譜結果とプロジェクトは失われていません。",
    viewModeLabel: "表示方法",
    continuous: "連続表示",
    page: "ページ表示",
    prevPage: "前のページ",
    nextPage: "次のページ",
    pagePosition: (page: number, total: number) => `${page} / ${total} ページ`,
    zoomLabel: "拡大率",
    zoomOut: "楽譜を縮小",
    zoomIn: "楽譜を拡大",
    zoomFit: "幅に合わせる",
    followPaused: "再生位置の追従を一時停止しました",
    resumeFollow: "追従を再開",
    follow: "再生位置を追従",
    deselected: "選択を解除しました",
    reviewPosition: (index: number, total: number) =>
      `要確認 ${index} / ${total}`,
    reviewExit: "要確認を終了",
    measureNth: (n: number) => `第${n}小節`,
    noteSelected: "音符を選択しました",
  },

  /** Properties inspector (GUI_UX_PLAN §22) — labels rendered by
   *  PropertiesPanel; values are built by score/inspector.ts. */
  inspector: {
    noteSection: "音符",
    issuesSection: "要確認",
    selectHint: "音符を選択すると、ここに情報が表示されます。",
    tempoRangeError: "テンポは 20〜400 BPM の範囲で入力してください",
    /* #188: one-tap fixes for the classic half/double tempo pick. */
    tempoHalve: "÷2",
    tempoDouble: "×2",
    fields: {
      pitch: "音高",
      concertPitch: "コンサートピッチ",
      writtenPitch: "記譜音（F管）",
      onset: "開始位置",
      duration: "音の長さ",
      tie: "タイ",
      confidence: "モデル確信度",
    },
    /* #379: the note body is an editable inspector — the compact
     *  buttons call the same score-workspace commands as the keyboard
     *  shortcuts, so mouse and keyboard stay equivalent (GUI §13). */
    edit: {
      section: "編集",
      pitchDown: "−半音",
      pitchUp: "＋半音",
      enharmonic: "異名同音",
      shorter: "短く",
      longer: "長く",
      onsetLeft: "前へ",
      onsetRight: "後へ",
      tie: "タイ",
      split: "分割",
      merge: "結合",
      deleteOrRestore: "削除 / 復元",
      restToNote: "音符に変換",
      groupOther: "操作",
      engineOnly: "採譜エンジン接続時に利用できます",
      engineOnlyHint:
        "音価・位置・タイなどの編集は採譜エンジン接続時に利用できます",
    },
    summaryFields: {
      title: "タイトル",
      composer: "作曲者",
      arranger: "編曲者",
      tempo: "テンポ",
      meter: "拍子",
      // #358: the anacrusis summary row / pickup-field label.
      pickup: "弱起",
      key: "調",
      keyMode: "長短",
      feel: "リズムの感じ",
      measures: "小節数",
      notes: "音符数",
      openIssues: "要確認",
    },
    /** #252: key-mode select labels (major/minor share the signature). */
    keyModes: {
      major: "長調",
      minor: "短調",
    },
    /** #145: key-map editor — one row per detected boundary plus an
     *  "add" row; the head row edits the piece key without collapsing
     *  the map (keyChangeAt at beat 0). */
    keyMap: {
      measure: "小節",
      head: "冒頭",
      measureAt: (n: number) => `第${n}小節`,
      keyAt: (n: number) => `第${n}小節の調`,
      modeAt: (n: number) => `第${n}小節の長短`,
      key: "調",
      mode: "長短",
      add: "転調を追加",
      remove: "この転調を削除",
      measureRequired: "追加先の小節を入力してください",
      unify: "1つの調に統一",
      unifyHint: "全ての転調を解除し、冒頭の調だけにします",
    },
    /** #249: tempo-map editor — one row per detected tempo mark plus
     *  an "add" row; the head row edits the opening tempo without
     *  dropping the tracked rit./accel. segments. */
    tempoMap: {
      measure: "小節",
      head: "冒頭",
      measureAt: (n: number) => `第${n}小節`,
      tempoAt: (n: number) => `第${n}小節のテンポ`,
      tempo: "テンポ",
      add: "テンポ変化を追加",
      remove: "このテンポ変化を削除",
      measureRequired: "追加先の小節を入力してください",
    },
    scoreSeconds: (sec: number) => `スコア ${sec.toFixed(1)} 秒`,
    tieFragments: (count: number) => `タイで分割（${count}分割）`,
    tempoLabel: (bpm: number) => `${bpm} BPM`,
    measureCountLabel: (n: number) => `${n} 小節`,
    noteCountLabel: (n: number) => `${n} 音`,
    openIssuesLabel: (n: number) => `${n} 件`,
    keyLabel: (fifthsLabel: string) => fifthsLabel,
    // #358: pickup labels — the summary row + select options. The
    // label is a formatted beat count ("1", "1/2") so fractional
    // anacruses stay readable.
    pickupNone: "弱起なし",
    pickupLabel: (beatsLabel: string) => `弱起${beatsLabel}拍`,
    /** #134: the score carries a swing marking (<sound><swing>). */
    feelSwing: "スウィング",
  },

  /** ReviewIssue.reason → Japanese copy (domain/review.py reason codes;
   *  GUI_UX_SPEC §12 理由例, JAPANESE_UI_COPY §6/§14). The deck is a
   *  superset of the current engine enum — newer codes land on `other`. */
  reviewReasons: {
    low_model_confidence: {
      title: "音高を確認してください",
      detail: "検出された音高の確信度が低めです。",
    },
    very_short_detection: {
      title: "音の長さを確認してください",
      detail: "ごく短い音として検出されました。意図した音か確認してください。",
    },
    overlapping_candidates: {
      title: "音の重なりを確認してください",
      detail: "複数の候補が重なって検出されました。",
    },
    quantization_ambiguous: {
      title: "リズムの解釈を確認してください",
      detail: "リズムの取り方が複数考えられます。",
    },
    pitch_spelling_ambiguous: {
      title: "表記を確認してください",
      detail: "異名同音の表記が複数考えられます。",
    },
    outside_preferred_horn_range: {
      title: "ホルンの音域を確認してください",
      detail: "一般的なホルンの音域を外れている可能性があります。",
    },
    structural_measure_conflict: {
      title: "拍位置を確認してください",
      detail: "小節内の拍位置が合っていない可能性があります。",
    },
    /* ---- UI-050: product-level reason keys from JAPANESE_UI_COPY §14 /
       sidecar REVIEW_REASON_COPY_KEYS ---- */
    beat_alignment_uncertain: {
      title: "拍位置を確認してください",
      detail: "音の開始位置が拍の格子からずれている可能性があります。",
    },
    beat_map_uncertain: {
      title: "テンポと拍位置を確認してください",
      detail: "テンポと拍の対応が曖昧です。",
    },
    possible_triplet: {
      title: "三連符の可能性があります",
      detail: "三連符として解釈できる箇所があります。",
    },
    possible_grace_note: {
      title: "装飾音の可能性があります",
      detail: "装飾音として解釈できる箇所があります。",
    },
    offset_ambiguous: {
      title: "音の長さを確認してください",
      detail: "音の終了位置が曖昧です。",
    },
    pickup_ambiguous: {
      title: "弱起を確認してください",
      detail: "弱起（アウフタクト）として解釈できる箇所があります。",
    },
    meter_conflict: {
      title: "拍子を確認してください",
      detail: "小節内の音価と拍子が合っていない可能性があります。",
    },
    swing_feel: {
      title: "スウィングの可能性があります",
      detail:
        "八分の裏拍が三連符の3つ目に寄っています（シャッフル系）。記譜にスウィングの指示を付けました。再生が元音源と合うか確認してください。",
    },
    // #181: pYIN is monophonic — warn when the texture asked for
    // (or allowed) polyphony so the missing voices are not silent.
    monophonic_backend: {
      title: "単音エンジンで採譜しました",
      detail:
        "pYINは単一旋律専用のエンジンです。和音や伴奏を含む音源では他の声部が結果に反映されません。多声部を採りたい場合は、設定の採譜エンジンをBasic Pitchに変更してください。",
    },
    // #188: the tracked tempo reads as a half/double pick — the
    // action applies scaleTempo so note values rescale with the BPM.
    tempo_uncertain: {
      title: "テンポを確認してください",
      detail:
        "自動推定されたテンポが、実際の半分または2倍の可能性があります。修正ボタンを押すと音符の長さも一緒に直ります（再生の速さは変わりません）。",
    },
    // #187: vocal-isolation provenance — the opt-in stage always says
    // whether the isolated estimate reached the backend.
    vocal_isolation_applied: {
      title: "ボーカル分離を使って採譜しました",
      detail:
        "中央定位のボーカル成分を推定してから採譜しています。完全な分離ではないため、伴奏の音が混ざる箇所は確認してください。",
    },
    vocal_isolation_unavailable: {
      title: "ボーカル分離は適用されませんでした",
      detail:
        "モノラル音源または読み込み失敗のため、元の音源のまま採譜しました。ステレオのミックス音源で有効です。",
    },
    // #352: the auto-estimated key could not be justified — the
    // evidence branch names the estimate and why it is unsure.
    key_uncertain: {
      title: "調を確認してください",
      detail:
        "推定された調を確定できません。プロパティの調エディタで確認・修正してください。",
    },
    // #358: the auto-estimated pickup (anacrusis) could not be
    // justified — a wrong guess ripples into every barline, so the
    // evidence branch names why it is unsure and the pickup field
    // in the properties panel is the fix.
    pickup_uncertain: {
      title: "弱起（アウフタクト）を確認してください",
      detail:
        "曲頭の弱起の推定が曖昧です。プロパティの弱起フィールドで確認・修正してください（小節線の位置が全体的に直ります）。",
    },
    // #423: a note edge the audio evidence cannot back up — the
    // suggestedKind evidence names merge (two written notes sound
    // like one), split (a held note hides a re-articulation), or
    // uncertain (a hairline edge with no attack). The action button
    // carries the merge/split fix; uncertain asks the user to listen.
    boundary_uncertain: {
      title: "音符の区切りを確認してください",
      detail:
        "音源の音量やピッチの変化から、音符の切れ目が楽譜とずれている可能性のある箇所が見つかりました。提案された修正を適用するか、そのままにするか確認してください。",
    },
    // #419: a chord segment the local estimator cannot back up -
    // the suggested chord + runner-up ride the issue as context;
    // there is no auto-fix, the map informs how the user reads
    // spelling and rhythm choices in the span.
    chord_uncertain: {
      title: "コード進行を確認してください",
      detail:
        "この区間の和音推定が曖昧です（確信度が低い、または候補が拮抗）。推定コードを証拠として表示しています。",
    },
    onset_uncertain: {
      title: "音の開始位置を確認してください",
      detail: "音の開始位置が曖昧です。",
    },
    pitch_uncertain: {
      title: "音高を確認してください",
      detail: "検出された音高が曖昧です。",
    },
    multiple_candidates: {
      title: "複数の候補があります",
      detail: "同じ箇所に複数の解釈候補があります。",
    },
    /** Engine reason codes newer than this UI version (sidecar/review.ts
     *  falls back to `other` the same way). */
    other: {
      title: "内容を確認してください",
      detail: "採譜エンジンが確認を求めています。",
    },
  },

  /** ReviewIssue.severity/status → Japanese labels (domain/review.py). */
  reviewSeverity: {
    info: "情報",
    caution: "注意",
    warning: "警告",
  },
  reviewStatus: {
    open: "未確認",
    accepted: "確認済み",
    dismissed: "対応不要",
    fixed: "修正済み",
  },

  /* #85 voices texture / overlap evidence — counts the engine put in
   * ReviewIssue.evidence, phrased for the review bar and inspector. */
  reviewEvidence: {
    secondVoice: (kept: number, dropped: number) =>
      dropped > 0
        ? "重なった音を追加の声部として " +
          kept +
          " 個残しました。声部数を超えた " +
          dropped +
          " 個は省略されました"
        : "重なった音を追加の声部として " + kept + " 個残しました",
    mergedOverlaps: (count: number) =>
      count +
      " 箇所の音の重なりを検出し、1つの旋律にまとめました（別の声部が失われた可能性があります）",
    /** #148: same warning plus the voices-retry pointer — shown when
     *  auto texture detected a real mix. */
    mergedOverlapsSuggest: (count: number) =>
      count +
      " 箇所の音の重なりを検出し、1つの旋律にまとめました。「複数声部として採譜」で重なった音を別の声部として採譜し直せます",
    swingFeel: (offbeats: number, swing: number) =>
      "裏拍の音 " +
      offbeats +
      " 個中 " +
      swing +
      " 個が三連符の3つ目の位置に寄っています",
    /** #322: vocal isolation was requested with voices/chords — the
     *  engine skipped it because stripping the accompaniment first
     *  would defeat the multi-voice texture. */
    vocalIsolationPolyphonic:
      "複数声部・和音の採譜とボーカル分離は同時に使えません。重なった音を残すため、元の音源のまま採譜しました",
    // #352: key-uncertainty evidence — names the estimate and each
    // reason it is unsure (few notes / low confidence / a close
    // runner-up / an ambiguous mid-piece span).
    keyUncertain: (p: {
      readonly details: readonly string[];
      readonly estimated: string;
      readonly confidencePct: number | null;
      readonly noteCount: number;
      readonly runnerUp: string | null;
      readonly marginPct: number | null;
      readonly uncertainMeasures: readonly number[];
    }) => {
      const clauses = [`推定は${p.estimated}です`];
      if (p.details.includes("too_few_notes")) {
        clauses.push(`材料は${p.noteCount}音のみで、調を確定できません`);
      }
      if (
        p.details.includes("low_confidence") &&
        p.confidencePct != null
      ) {
        clauses.push(`確信度が${p.confidencePct}%と低めです`);
      }
      if (
        p.details.includes("close_candidates") &&
        p.runnerUp != null &&
        p.marginPct != null
      ) {
        clauses.push(
          `次点の${p.runnerUp}との差が${p.marginPct}%しかありません`,
        );
      }
      if (p.uncertainMeasures.length > 0) {
        clauses.push(
          `第${p.uncertainMeasures.join("・")}小節まわりの調も曖昧です`,
        );
      }
      if (clauses.length === 1) {
        clauses.push("元音源と聴き比べて確認してください");
      }
      return clauses.join("。") + "。";
    },
    // #358: pickup-uncertainty evidence — names the inferred
    // anacrusis, each flag that makes it unsure (accent phase /
    // hairline onset / mid-beat onset), and the suggested fix when
    // the evidence produces one.
    pickupUncertain: (p: {
      readonly flags: readonly string[];
      readonly inferredBeats: number;
      readonly suggestedBeats: number | null;
    }) => {
      const clauses = [
        p.inferredBeats > 0
          ? "推定は弱起" + p.inferredBeats + "拍です"
          : "弱起なしと推定されました",
      ];
      if (p.flags.includes("hairline_onset")) {
        clauses.push(
          "最初の音が第1拍の直前に検出されたため、弱起ではなく検出タイミングのずれの可能性があります",
        );
      }
      if (p.flags.includes("downbeat_phase_mismatch")) {
        clauses.push(
          "各拍の強さの証拠からは、別の拍を1拍目とした方が自然です",
        );
      } else if (p.flags.includes("downbeat_phase_ambiguous")) {
        clauses.push(
          "どの拍が1拍目か、強さの証拠だけでは決めきれません",
        );
      }
      if (p.flags.includes("offbeat_onset")) {
        clauses.push(
          "最初の音が拍の途中から始まるため、弱起かシンコペーションの入りか判断できません",
        );
      }
      if (clauses.length === 1) {
        clauses.push("元音源の曲頭を聴き比べて確認してください");
      }
      return clauses.join("。") + "。";
    },
    // #423: boundary-uncertainty evidence — names the suggested
    // fix (merge the pair / split at the heard onset / listen and
    // decide) with its score so the user can judge before tapping.
    boundaryUncertain: (p: {
      readonly kind: string;
      readonly score: number | null;
    }) => {
      const scoreTxt =
        p.score != null
          ? `（確からしさ ${Math.round(p.score * 100)}%）`
          : "";
      if (p.kind === "merge") {
        return `隣り合う同じ高さの2音ですが、音源には切れ目の証拠が見つかりません${scoreTxt}。1つの音にまとめることを検討してください。`;
      }
      if (p.kind === "split") {
        return `ひとつの音の途中に、別の発音らしき立ち上がりが検出されています${scoreTxt}。その位置で分割することを検討してください。`;
      }
      return `この区切りには確かな発音の証拠が見つかりません${scoreTxt}。元音源と聴き比べて確認してください。`;
    },
    // #419: chord-uncertainty evidence - names the suggested chord,
    // the runner-up it nearly tied with, and the confidence so the
    // user can weigh the harmony context themselves.
    chordUncertain: (p: {
      readonly suggested: string | null;
      readonly runnerUp: string | null;
      readonly confidencePct: number | null;
      readonly marginPct: number | null;
    }) => {
      const clauses: string[] = [];
      if (p.suggested != null) {
        clauses.push(
          p.confidencePct != null
            ? `推定コードは${p.suggested}です（確からしさ ${p.confidencePct}%）`
            : `推定コードは${p.suggested}です`,
        );
      }
      if (p.runnerUp != null) {
        clauses.push(
          p.marginPct != null
            ? `次点の${p.runnerUp}との差が${p.marginPct}%しかありません`
            : `次点は${p.runnerUp}です`,
        );
      }
      clauses.push(
        "この区間の和音は証拠が弱いため、臨時記号やリズムの解釈を耳で確認してください",
      );
      return clauses.join("。") + "。";
    },
  },

  /* #130 (§14): re-quantize dialog — change the quantization settings
   * on the finished score and re-apply them through score.edit. */
  requantizeDialog: {
    title: "採譜設定を変えて再適用",
    body: "現在の設定を変更して、楽譜全体をもう一度量子化します。元に戻す（Ctrl+Z）で直前の状態に戻せます。",
    apply: "適用",
    cancel: "キャンセル",
    unchanged: "設定が変わっていません",
  },

  /* ============================ UI-050 ============================
   * 要確認ワークスペース (issue #28, GUI_UX_SPEC §12, JAPANESE_UI_COPY §6).
   * ヘッダー: 「要確認 n / total」＋ 前へ / 元音源を再生 / 問題なし / 次へ。
   * キーボード中心フロー — P4 プロトタイプ (src/prototype) の検証済み
   * キー割り当てをそのまま本実装へ持ち込む。
   */
  review: {
    regionLabel: "要確認ワークスペース",
    position: (index: number, total: number) => `要確認 ${index} / ${total}`,
    remaining: (count: number) => `残り ${count} か所`,
    allDone: "すべての要確認箇所を確認しました",
    /* #272: issues dropped by the surfacing cap — never silent. */
    omitted: (count: number) => `（他 ${count} 件を省略）`,
    // #360: the omitted tail is expandable into the live review list
    //  — one click joins it as ordinary open issues.
    expandOmitted: (count: number) => `残り ${count} 件を展開`,
    actionsLabel: "要確認の操作",
    playSource: "元音源を再生",
    markOk: "問題なし",
    dismiss: "対応不要にする",
    /** #148: one-click remedy on the merged-overlap issue when auto
     *  texture detected a mix — re-runs the job with 複数声部. */
    retranscribeVoices: "複数声部として採譜",
    retranscribeVoicesTip:
      "重なった音を別の声部として採譜し直します（現在の編集は破棄されます）",
    /** #181: one-click remedy on the monophonic-backend issue —
     *  re-runs the job with the polyphonic-capable Basic Pitch. */
    retranscribeBasicPitch: "Basic Pitchで採譜し直す",
    retranscribeBasicPitchTip:
      "多声部に対応したエンジンで採譜し直します（現在の編集は破棄されます）",
    /** #314: one-click remedy on the merged-overlap issue for a
     *  lead-vocal mix — re-runs with vocal isolation + melody so the
     *  accompaniment drops out and the lead line survives. */
    retranscribeVocalIsolation: "ボーカル分離で採譜し直す",
    retranscribeVocalIsolationTip:
      "ボーカルを分離して主旋律だけを採譜し直します（現在の編集は破棄されます）",
    /** #188: apply the suggested BPM on the tempo-uncertain issue. */
    applyTempoSuggestion: (bpm: number) => `♩=${Math.round(bpm)}に修正`,
    /** #209: meter_conflict cannot auto-resolve — open the meter
     *  select in the properties panel instead. */
    openMeterEditor: "プロパティで拍子を変更",
    /** #352: key_uncertain cannot auto-resolve — the key-map editor
     *  in the properties panel is the remedy. */
    openKeyEditor: "プロパティで調を変更",
    /** #358: pickup_uncertain remedies — apply the suggested
     *  anacrusis when the evidence has one, else open the pickup
     *  field in the properties panel. */
    applyPickupSuggestion: (beats: number) =>
      beats === 0 ? "弱起なしに修正" : `弱起${beats}拍に修正`,
    openPickupEditor: "プロパティで弱起を変更",
    /** #208: swap in the runner-up notation for an ambiguous run. */
    applyAlternative: "別の解釈に切り替え",
    /** #212: rewrite the flagged beat as triplets. */
    applyTriplet: "三連符に直す",
    /** #261: the range issue's octave fix — direction comes from the
     *  pitch evidence (high → down, low → up); the copy makes the
     *  real-pitch change explicit. */
    octaveDown: "1オクターブ下げる",
    octaveUp: "1オクターブ上げる",
    /** Per-remedy tooltips (ReviewBar's action button used to show the
     *  fixed retranscribe-voices copy for every remedy). */
    enharmonicTip: "同じ音高の別の音名に書き換えます",
    applyTempoSuggestionTip:
      "検出されたテンポの誤りを修正します（音符の長さも連動して調整されます）",
    openMeterEditorTip:
      "プロパティパネルを開いて拍子を選び直します",
    openKeyEditorTip:
      "プロパティパネルを開いて調を選び直します",
    applyPickupSuggestionTip:
      "推定された弱起を修正します（全ての小節線が直り、音符の長さは変わりません）",
    openPickupEditorTip:
      "プロパティパネルを開いて弱起を選び直します",
    /** #423: boundary_uncertain remedies — mergeNotes for a phantom
     *  edge, splitNote at the heard onset for a missed re-articulation. */
    mergeBoundary: "2音を1つにまとめる",
    mergeBoundaryTip:
      "音源ではひとつの音に聞こえるため、2つの音符を結合します",
    splitBoundary: "この位置で音を分ける",
    splitBoundaryTip:
      "音源から検出された発音位置で音符を2つに分割します",
    applyAlternativeTip:
      "エンジンが次点として残した音符配置に差し替えます",
    applyTripletTip:
      "この拍を三連符の書き方に修正します",
    octaveShiftTip:
      "実音の高さを1オクターブ移動してホルンの適性音域に収めます",
    /** Disabled-state explanations for whole-piece issues (buttons stay
     *  visible so the bar's layout is stable; the tooltip says why). */
    noteTargetRequired: "音符に紐づく項目でのみ使えます",
    noAudibleRange: "この項目には再生できる範囲がありません",
    pitchUp: "半音上げる",
    pitchDown: "半音下げる",
    deleteNote: "削除",
    restoreNote: "復元",
    undo: "元に戻す",
    redo: "やり直し",
    exit: "要確認を終了",
    /** モデル確信度は根拠（evidence）としてのみ表示 — 正しい確率とは
     *  書かない (JAPANESE_UI_COPY §6, acceptance criterion). */
    confidence: (percent: number) => `モデル確信度: ${percent}%`,
    hint: "← → で移動、R で元音源を再生、O で問題なし、Alt+↑↓ で音高修正、Delete で削除、I で一覧、Ctrl+Z で元に戻す、Esc で終了",
    /* #361: ReviewNavigator popover — the filterable issue list the
     *  linear cursor opens with 一覧 / I. */
    nav: {
      toggle: "一覧",
      regionLabel: "要確認の一覧",
      listLabel: "要確認箇所リスト",
      openOnly: "未解決のみ",
      severityLabel: "重要度",
      reasonLabel: "理由",
      all: "すべて",
      filteredCount: (shown: number, total: number) =>
        `${total}件中 ${shown}件を表示`,
      notes: (count: number) => `${count}音`,
      empty: "条件に合う要確認箇所はありません",
    },
    feedback: {
      accepted: "確認済みにしました",
      dismissed: "対応不要にしました",
      reopened: "未確認に戻しました",
      pitchFixed: "音高を修正しました",
      noteDeleted: "音符を削除しました",
      noteRestored: "音符を復元しました",
      // #114: direct note edits outside the review workspace (spec 13).
      respelled: "異名同音で書き換えました",
      undone: "元に戻しました",
      redone: "やり直しました",
      nothingToUndo: "元に戻す操作はありません",
      nothingToRedo: "やり直す操作はありません",
      already: (label: string) => `すでに${label}です`,
      playingSource: "元音源を再生しています",
      exited: "要確認を終了しました",
      noIssues: "要確認箇所はありません",
      // #360: cap-omitted issues expanded into the live list.
      expandedOmitted: (count: number) =>
        `${count} 件の省略箇所を展開しました`,
    },
  },

  /* ============================ UI-060 ============================
   * Product export dialog (deck: exportSheet.*) — distinct from the
   * prototype mirror above; this is the real 書き出し surface.
   */
  exportSheet: {
    title: "書き出し",
    scoreSection: "楽譜",
    pdfSection: "PDF",
    midiSection: "MIDI",
    audioSection: "音声",
    options: {
      concertMusicxml: "コンサートピッチ MusicXML",
      hornMusicxml: "F管ホルン MusicXML",
      concertPdf: "コンサートピッチ PDF",
      hornPdf: "F管ホルン PDF",
      playbackMidi: "再生用MIDI（実音）",
      // #357: framed as an extra copy, not another score format —
      // the opt-in nature is part of the label.
      sourceAudio: "参照用に元の音声もコピーする",
    },
    destination: "保存先",
    chooseDestination: "保存先を選ぶ",
    /* #362: user-editable artifact basename — the score title /
     * source stem seeds it; <basename>_<artifact> naming applies. */
    fileName: "ファイル名",
    // #443: the real artifact suffix (曲名_horn_in_f.pdf 等) trips the
    // copy-QA English-word gate — keep the example fully Japanese.
    fileNameHint: "出力ファイル名の基準（曲名などの作品名）",
    submit: "書き出す",
    running: "書き出しています",
    loading: "書き出しの準備をしています",
    museScoreMissingNote:
      "PDFを書き出すにはMuseScoreが必要です。MusicXMLとMIDIはそのまま書き出せます。",
    /* #390: エンジン不在時のMIDI品質差を事前/事後に明示 —
       silent degraded fallback禁止。 */
    midiDegradedNote:
      "エンジンに接続できないため、再生用MIDIは簡易版になります（ベロシティ・ピッチベンド・スイングは含まれません）。",
    midiDegradedDone:
      "再生用MIDIは簡易版で書き出しました（ベロシティ・ピッチベンド・スイングは含まれません）。",
    pdfDisabledTooltip: "MuseScoreが見つからないためPDFを書き出せません",
    audioDisabledTooltip: "元の音声がディスク上にないため同梱できません",
    specifyMuseScore: "MuseScoreの場所を指定",
    completeTitle: "書き出しが完了しました",
    completeCount: "{count}件のファイルを書き出しました",
    revealInExplorer: "エクスプローラーで表示",
    revealFailed: "エクスプローラーで表示できませんでした",
    destinationPickFailed: "保存先を選択できませんでした",
    /* #231: same-name artifacts exist — one prompt decides the whole
     *  set's collision policy before the transactional write. */
    collisionTitle: "同じ名前のファイルがあります",
    collisionBody:
      "保存先に同名のファイルがあります。上書きするか、別名（連番）で保存するか選んでください。",
    collisionOverwrite: "上書きする",
    collisionRename: "別名で保存",
  },

  /** External-tool status vocabulary (deck: dependencies.*). */
  dependencies: {
    statusFound: "検出済み",
    statusMissing: "見つかりません",
    statusChecking: "確認しています",
    specifyLocation: "場所を指定",
    ffmpeg: {
      name: "FFmpeg",
      purpose: "音声ファイルの変換に必要です。",
    },
    musescore: {
      name: "MuseScore",
      purpose: "PDFの書き出しに必要です。",
    },
  },

  /** Status-bar notifications (deck: notifications.*). */
  notifications: {
    exportDone: "書き出しが完了しました",
    /* #100: project save */
    projectSaved: "プロジェクトを保存しました",
    projectSaveFailed: "プロジェクトを保存できませんでした",
    // #389: the shell-side validator refused the document — the
    // file was never touched, so score + edits stay in memory.
    projectSaveInvalid:
      "プロジェクトデータが保存の条件を満たさないため、保存を中止しました（楽譜と編集内容は保持されています）",
    projectSaveUnsupported:
      "この楽譜はプロジェクトとして保存できません（採譜結果のみ保存できます）",
    /** #234: 採譜中は音源・プロジェクトの差し替えを受け付けない。 */
    importWhileTranscribing:
      "採譜の実行中です。完了またはキャンセルしてから開いてください",
    /** #364: 履歴から削除 feedback (MRU only — the file is untouched). */
    recentRemoved: "履歴から削除しました",
    /** #219: SOURCE_MISSING でも採譜は開けるが、元音源依存の操作は不可。 */
    transcribeRequiresAudio: "元音源がありません。音源を指定すると採譜できます",
  },

  /** #221: プロジェクトのライフサイクル — 未保存ガードと自動保存復元。 */
  project: {
    /** 未保存の変更を破棄する破壊的操作の確認(alert ダイアログ)。 */
    unsavedTitle: "保存していない変更があります",
    unsavedBody:
      "楽譜への変更がまだ保存されていません。このまま続けると変更は失われます。",
    unsavedSaveAndContinue: "保存して続ける",
    unsavedDiscard: "保存せずに続ける",
    unsavedCancel: "キャンセル",
    /** #301: アプリ終了時の確認 — 保存して閉じる/閉じる系の文言。 */
    unsavedSaveAndClose: "保存して閉じる",
    unsavedDiscardAndClose: "保存せずに閉じる",
    unsavedCloseBody:
      "楽譜への変更がまだ保存されていません。このまま閉じると変更は失われます。",
    closeRecordingBody:
      "録音中です。このまま閉じると録音は失われます。",
    closeRecordingTitle: "録音を止めて閉じますか?",
    closeAnyway: "閉じる",
    /* #400: 採譲中の終了確認 — dirty との複合は専用コピー。 */
    closeTranscribingTitle: "採譲を中止して終了しますか?",
    closeTranscribingBody:
      "採譲処理はまだ完了していません。終了すると採譲は中止されます。保存済みのプロジェクトと楽譜は保持されます。",
    closeTranscribingDirtyBody:
      "採譲処理はまだ完了していません。終了すると採譲は中止され、未保存の変更も失われます。保存して終了することもできます。",
    closeTranscribingAbort: "採譲を中止して終了",
    closeBack: "戻る",
    /* #301: dirty + 録音中の複合終了確認 — 両方の喪失を明示し、
       録音の扱いをユーザーが選べるようにする。録音の保存先は
       recordings フォルダの WAV(録音停止 = take 確定)で、
       楽譜はプロジェクトへ保存される。 */
    closeDirtyRecordingTitle: "未保存の楽譜と録音中のテイクがあります",
    closeDirtyRecordingBody:
      "楽譜への変更と録音中のテイクは、どちらもまだ保存されていません。録音を保存する場合はテイクを確定してから終了します。",
    closeSaveAllAndExit: "録音と楽譜を保存して終了",
    closeSaveScoreOnly: "楽譜だけ保存し、録音を破棄して終了",
    closeDiscardAll: "すべて破棄して終了",
    /** #300: ステータスバーの未保存バッジ。 */
    unsavedBadge: "未保存の変更",
    /* #408: 自動保存の安全網が切れている間の持続warning —
       バッジで存在を示し、title属性に次の行動を書く。raw例外は出さない。 */
    autosaveFailedBadge: "自動保存できません",
    autosaveFailedHint:
      "直前の自動保存に失敗しました。Ctrl+Sでプロジェクトを保存してください。",
    /** クラッシュ/強制終了で残った自動保存の復元確認。 */
    autosaveTitle: "自動保存された作業があります",
    autosaveBody: (when: string) =>
      "前回の終了時に保存されていない変更がありました（" +
      when +
      " に自動保存）。復元しますか?",
    autosaveRestore: "復元する",
    autosaveDecline: "破棄する",
    autosaveRestored: "自動保存から復元しました",
  },

  /** FEAT-001 follow-ups: 取り込みメニュー + 置き換え確認(#70-#76)。 */
  capture: {
    /** 取り込みメニューのデバイス選択セクション。 */
    loopbackDeviceLabel: "出力先(PCの音)",
    microphoneDeviceLabel: "マイク",
    defaultDevice: "既定のデバイス",
    noDevices: "利用できるデバイスがありません",
    /** #76: 録音は現在の音源を置き換えるので、既に音源/楽譜がある時は
     *  開始前に確認する(alert = 破壊的操作の確認)。 */
    replaceTitle: "現在の音源を置き換えますか?",
    replaceBodyWithScore:
      "新しく取り込むと、現在の音源と楽譜は置き換えられます。続けますか?",
    replaceBody: "新しく取り込むと、現在の音源は置き換えられます。続けますか?",
    replaceConfirm: "取り込む",
    replaceCancel: "キャンセル",
    /** #80: 一時停止中の表示/アナウンス。 */
    pausedLabel: "一時停止中",
    pausedAnnounce: "録音を一時停止しました。再開するまで音は記録されません。",
    resumedAnnounce: "録音を再開しました",
    /** #79: 録音中にデバイスが切断・拒否された時の説明。 */
    interruptedAnnounce:
      "録音デバイスとの接続が切れました。録音をやり直してください。",
   /** #42: 録音前の入力レベルモニター(取り込みメニュー内)。 */
   monitorStart: "入力レベルを確認",
   monitorLabel: "入力レベル",
   monitorAria: "入力レベルメーター",
 },
  /** #18: 採譜キュー(複数ジョブの逐次実行)。 */
  queue: {
    title: "採譜キュー",
    open: "採譜キュー…",
    addAudio: "キューに音源を追加…",
    addCurrent: "キューに追加",
    start: "開始",
    stop: "停止",
    clearFinished: "終了分をクリア",
    empty: "キューは空です",
    busy: "別の採譜が実行中です",
    close: "閉じる",
    colName: "音源",
    colStatus: "状態",
    statusPending: "待機中",
    statusRunning: "実行中",
    statusDone: "完了",
    statusFailed: "失敗",
    statusCancelled: "キャンセル済み",
    moveUp: "上へ",
    moveDown: "下へ",
    remove: "削除",
    cancelEntry: "キャンセル",
    openResult: "開く",
    entryDone: "{name} の採譜が完了しました",
    runFinished: "キューの採譜が終了しました",
   addedToQueue: "{name} をキューに追加しました",
  },
  /** #12: 区間ラベル(波形直下のチップバー)。 */
  regionLabels: {
    title: "区間ラベル",
    add: "ラベル",
    addConfirm: "追加",
    namePlaceholder: "例: サビ",
    nameAria: "ラベル名",
    needSelection: "先に波形で範囲を選んでください",
    retranscribe: "この区間を再採譜",
    remove: "ラベルを削除",
    // #51: inline edit affordances on each chip
    edit: "ラベルを編集",
    editConfirm: "変更",
    applySelection: "選択している範囲をこのラベルに適用",
  },
} as const;

export type JaStrings = typeof ja;
