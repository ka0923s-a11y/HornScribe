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
    openLabel: "開く",
    openTooltip: "音声ファイルを開く（Ctrl+O）",
    transcribeTooltip: "採譜を開始する",
    retranscribeTooltip: "現在の設定でもう一度採譜する",
    exportTooltip: "MusicXML・PDF・MIDIを書き出し",
    reviewWithCount: "要確認（{count}）",
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
  },

  status: {
    regionLabel: "状態表示",
    ready: "準備完了",
    shellInfoLoading: "シェル情報を取得しています…",
    spikeNoFileOpen: "このスパイク版ではファイルを開く機能は未実装です",
    engineNotConnected: "解析エンジン: 未接続",
    spikeNoTranscribe: "このスパイク版では採譜エンジンは未接続です",
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
    recordingsUnavailable:
      "録音の管理はデスクトップアプリで利用できます。",
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
    stopCapture: "録音を終了して取り込む",
    cancelCapture: "録音をやめる",
    /* #80: 録音の一時停止/再開 */
    pauseCapture: "録音を一時停止",
    resumeCapture: "録音を再開",
    toggleAudition: "楽譜を演奏",
    toggleSourceMute: "元音源のミュート",
    /* #100: project save */
    saveProject: "プロジェクトを保存",
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
      secondsUnit: "秒",
      texture: "音源の種類",
      textureAuto: "自動",
      textureMono: "単旋律（楽器・歌声のみ）",
      textureMelody: "メロディ優先（ミックス音源）",
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
      projectOpened: (name: string) => `${name} を開きました`,
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
    renderErrorTitle: "楽譜を表示できません",
    renderErrorBody:
      "楽譜データの読み込みに失敗しました。プロジェクトと採譜結果は失われていません。",
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
    reviewPosition: (index: number, total: number) => `要確認 ${index} / ${total}`,
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
    fields: {
      pitch: "音高",
      concertPitch: "コンサートピッチ",
      writtenPitch: "記譜音（F管）",
      onset: "開始位置",
      duration: "音の長さ",
      tie: "タイ",
      canonicalId: "正準ID",
      confidence: "モデル確信度",
    },
    summaryFields: {
      title: "タイトル",
      tempo: "テンポ",
      meter: "拍子",
      key: "調",
      measures: "小節数",
      notes: "音符数",
      openIssues: "要確認",
    },
    scoreSeconds: (sec: number) => `スコア ${sec.toFixed(1)} 秒`,
    tieFragments: (count: number) => `タイで分割（${count}分割）`,
    tempoLabel: (bpm: number) => `${bpm} BPM`,
    measureCountLabel: (n: number) => `${n} 小節`,
    noteCountLabel: (n: number) => `${n} 音`,
    openIssuesLabel: (n: number) => `${n} 件`,
    keyLabel: (fifthsLabel: string) => fifthsLabel,
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
    actionsLabel: "要確認の操作",
    playSource: "元音源を再生",
    markOk: "問題なし",
    dismiss: "対応不要にする",
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
    hint: "← → で移動、R で元音源を再生、O で問題なし、Alt+↑↓ で音高修正、Delete で削除、Ctrl+Z で元に戻す、Esc で終了",
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
      sourceAudio: "元の音声ファイル",
    },
    destination: "保存先",
    chooseDestination: "保存先を選ぶ",
    submit: "書き出す",
    running: "書き出しています",
    loading: "書き出しの準備をしています",
    museScoreMissingNote:
      "PDFを書き出すにはMuseScoreが必要です。MusicXMLとMIDIはそのまま書き出せます。",
    pdfDisabledTooltip: "MuseScoreが見つからないためPDFを書き出せません",
    audioDisabledTooltip:
      "元の音声がディスク上にないため同梱できません",
    specifyMuseScore: "MuseScoreの場所を指定",
    completeTitle: "書き出しが完了しました",
    completeCount: "{count}件のファイルを書き出しました",
    revealInExplorer: "エクスプローラーで表示",
    revealFailed: "エクスプローラーで表示できませんでした",
    destinationPickFailed: "保存先を選択できませんでした",
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
    projectSaveUnsupported: "この楽譜はプロジェクトとして保存できません（採譜結果のみ保存できます）",
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
    replaceBody:
      "新しく取り込むと、現在の音源は置き換えられます。続けますか?",
    replaceConfirm: "取り込む",
    replaceCancel: "キャンセル",
    /** #80: 一時停止中の表示/アナウンス。 */
    pausedLabel: "一時停止中",
    pausedAnnounce: "録音を一時停止しました。再開するまで音は記録されません。",
    resumedAnnounce: "録音を再開しました",
    /** #79: 録音中にデバイスが切断・拒否された時の説明。 */
    interruptedAnnounce: "録音デバイスとの接続が切れました。録音をやり直してください。",
  },
} as const;

export type JaStrings = typeof ja;
