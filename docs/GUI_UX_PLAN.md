# HornScribe GUI / UX Design & Implementation Plan

> Status: Proposed GUI architecture and product design specification  
> Updated: 2026-09-21  
> Product: HornScribe  
> Primary platform: Windows 11  
> Operating model: Personal use, local-first, offline-capable, zero recurring cost  
> Roadmap authority: [Master Plan](MASTER_PLAN.md)  
> Related: [Development Plan](DEVELOPMENT_PLAN.md)

---

# 0. Executive decision

HornScribe のGUIは、既存計画の「Python + PySide6 Widgetsでアプリ全体を構築する」案から見直す。

## 採用候補

**Tauri 2 + React + TypeScript + Fluent UI React v9 + Verovio WASM + wavesurfer.js**

採譜・音楽ロジックは既存のPython資産を維持し、**独立したPython worker sidecar** として実行する。

```text
┌─────────────────────────────────────────────────────┐
│ HornScribe Desktop                                  │
│                                                     │
│ Tauri 2 / Rust shell                                │
│ ┌─────────────────────────────────────────────────┐ │
│ │ React + TypeScript UI                           │ │
│ │                                                 │ │
│ │ Fluent UI    wavesurfer.js    Verovio WASM     │ │
│ │ controls      waveform          score SVG       │ │
│ └─────────────────────────────────────────────────┘ │
│                    │ IPC                            │
│                    ▼                                │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Python worker                                  │ │
│ │ Basic Pitch / music21 / quantizer / MusicXML   │ │
│ │ Horn in F / FFmpeg / MuseScore integration     │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

この構成にする理由は、HornScribe のGUI要件が一般的なフォーム中心のデスクトップアプリではなく、

- インタラクティブなSVG楽譜
- 波形タイムライン
- 再生ヘッド
- 範囲選択とループ
- 音符単位のハイライト
- AI confidence の可視化
- 複数の表示レイヤ
- Fluent 2準拠の洗練されたUI
- 滑らかなアニメーション
- 高度なキーボード操作

を必要とするためである。

**Pythonは捨てない。GUIとML/音楽処理の責務を分離する。**

---

# 1. Product UX vision

HornScribe の目標は「MuseScoreを再実装すること」ではない。

目標は、

> 音源から得た採譜結果を、ホルン奏者が短時間で確認・修正し、Concert Pitch / Horn in F の完成した譜面として書き出せること。

である。

UI品質の基準は「モダンに見えるか」だけではなく、以下で評価する。

1. **Speed** — 目的の操作までの手数が少ない
2. **Clarity** — 今何が起きているか迷わない
3. **Confidence** — AI結果の不確実な箇所が分かる
4. **Directness** — 音符や波形を直接操作できる
5. **Calmness** — 長時間利用しても視覚的に疲れない
6. **Recoverability** — いつでも戻せる、rawデータを失わない
7. **Keyboard efficiency** — マウスなしでも主要操作が完結する
8. **Accessibility** — 色、拡大率、キーボード、スクリーンリーダーに配慮する
9. **Performance** — 再生・スクロール・ズームが視覚的に途切れない
10. **Platform fit** — Windows 11上で「完成品」に見える

---

# 2. 調査した製品から採用するUXパターン

## 2.1 MuseScore Studio

参考:
- https://handbook.musescore.org/
- https://musescore.org/

採用する考え方:

- 楽譜を画面の主役にする
- Properties/Inspector は選択対象に応じて内容が変わる
- 不要なパネルは閉じられる
- Light / Dark / High Contrast
- キーボードでUI領域と楽譜を移動可能
- 再生コントロールは常にアクセス可能

HornScribeではMuseScoreのような大量の記譜ツールパレットは持たない。

---

## 2.2 Dorico

参考:
- https://www.steinberg.help/r/dorico-pro/

採用する考え方:

**モードによる progressive disclosure**。

Dorico は Setup / Write / Engrave / Play / Print のように作業文脈を分離する。

HornScribeではもっと少なくする。

```text
Score
Review
Export
```

通常作業では Score を使う。

AI結果を確認したい時だけ Review に入る。

---

## 2.3 Ableton Live

参考:
- https://www.ableton.com/en/live-manual/

採用する考え方:

- 高密度だが装飾を抑えた画面
- タイムラインのズーム/スクロールが高速
- Space で再生停止
- Follow playback
- ユーザーが手動スクロールしたらFollowを一時停止
- 選択範囲を中心にズーム
- コンテキストに応じた情報表示

HornScribeでも再生追従を強制しない。

ユーザーが楽譜や波形を手動移動した場合:

```text
Follow Playback: temporarily suspended
[Resume Follow]
```

とする。

---

## 2.4 Transcribe!

参考:
- https://www.seventhstring.com/xscribe/

採用する考え方:

- 再生位置へ素早く戻れる
- loop が第一級機能
- playback speed が常時利用可能
- 波形とマーカー
- キーボード中心の反復再生

採譜確認では「同じ1〜2秒を何度も聴く」操作が極めて重要。

HornScribeではLoopをサブ機能扱いしない。

---

## 2.5 Sonic Visualiser

参考:
- https://www.sonicvisualiser.org/

採用する考え方:

- 同じ時間軸に複数の分析layerを揃える
- waveform / spectrogram / notes の時間位置を完全に一致させる
- layerのON/OFF

ただしHornScribeでは、通常画面に全layerを同時表示しない。

---

## 2.6 Melodyne

参考:
- https://helpcenter.celemony.com/

採用する考え方:

- 音符を直接クリックして選択
- 選択位置によって操作文脈が変わる
- pitch/time/durationを直接修正
- グリッドを必要時だけ解除

HornScribeの簡易修正UIに応用する。

---

# 3. GUI framework 調査

## 3.1 PySide6 / Qt Widgets

### 長所

- Pythonとの統合が最も単純
- QtMultimediaを利用可能
- 成熟している
- Windows/macOS/Linux
- native desktop の操作モデル
- 配布例が多い

### HornScribeでの弱点

- 高度に洗練されたカスタムUIを作るほどQSS/独自描画が増える
- SVG楽譜とのDOM的interactionがWeb UIより複雑
- 波形・spectrogram・timelineの高度な描画を自作しがち
- 「機能は動くが見た目が古い」状態へ陥りやすい

### 結論

**ML/プロトタイプには優秀だが、最終GUIの第一候補にはしない。**

---

# 3.2 Qt Quick / QML

Qt Quick Scene Graph は60fps級のfluid UIを意識して設計されている。

参考:
- https://doc.qt.io/qt-6/qtquick-index.html
- https://doc.qt.io/qt-6/qtquick-performance.html

### 長所

- GPU accelerated scene graph
- animation
- responsive layout
- C++/Python backendと統合しやすい
- Qt Quick Controls
- Windows/macOS/Linux

Qt 6.8以降には FluentWinUI3 style が存在する。

参考:
- https://doc.qt.io/qt-6/qtquickcontrols-fluentwinui3.html

### 注意

FluentWinUI3 style はまだ発展中で、一部Controlsがfallbackになる。

Verovioやwavesurfer.js等のWeb資産との統合はTauri案より複雑。

### 結論

**Tauri案が成立しない場合の第一fallback。**

Qtを使うなら Qt Widgets ではなく Qt Quick/QML を優先する。

---

# 3.3 Electron

参考:
- https://www.electronjs.org/docs/latest/tutorial/process-model

### 長所

- Web UI資産がそのまま使える
- React等との統合が容易
- SVG / waveform / WebAudioと相性が良い
- 実績が非常に多い

### 弱点

- Chromium + Node runtimeを同梱
- メモリ/アプリサイズが大きくなりやすい
- HornScribeの規模にはやや過剰

### 結論

Tauriより明確な利点が必要にならない限り採用しない。

---

# 3.4 Tauri 2

参考:
- https://v2.tauri.app/
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/develop/tests/

TauriはRust shell + OS WebViewの構成。

WindowsではWebView2を利用する。

### 長所

- React/TypeScript/HTML/CSSのUI表現力
- Windows 11ではWebView2が標準的に利用可能
- Electronよりruntimeを軽量化しやすい
- sidecar binaryを公式にサポート
- Python CLI/workerをsidecarとしてbundle可能
- Rust側でfilesystem/process権限を限定できる
- SVG/DOM interactionが非常に自然
- Verovio WASMと高い親和性
- wavesurfer.jsと高い親和性

### 弱点

- Python単一言語ではなくなる
- Rust / TypeScript / Python の3レイヤ
- frontend/backend protocolを設計する必要がある
- WebView特有のtestingが必要

### 結論

**HornScribeの最終GUIに採用する。**

複数言語化のコストより、UI品質・描画・interaction・保守上の利点が大きい。

---

# 3.5 .NET / WinUI 3

参考:
- https://learn.microsoft.com/windows/apps/winui/
- https://learn.microsoft.com/windows/apps/windows-app-sdk/

Windows専用なら最もnativeな候補。

### 長所

- Microsoft推奨native Windows UI
- Fluent
- Accessibility/UI Automation
- Windows integration
- 高品質なnative controls

### 弱点

HornScribeの中心である、

- interactive MusicXML/SVG
- waveform
- spectrogram
- browser向けnotation ecosystem

との統合ではTauri/Webの方が直接的。

PythonとのIPCも必要。

### 結論

Windows専用の一般業務アプリなら有力だが、HornScribeではTauriを優先する。

---

# 3.6 Avalonia

参考:
- https://docs.avaloniaui.net/

### 長所

- .NET
- Windows/macOS/Linux
- Fluent theme
- Skia
- UI Automation
- Win32 integration

### 結論

強力なfallback。

ただしscore/waveform interactionではWeb ecosystemを利用できるTauriが有利。

---

# 3.7 Flutter

参考:
- https://docs.flutter.dev/platform-integration/windows
- https://docs.flutter.dev/ui/accessibility-and-internationalization/accessibility

### 長所

- 高品質なcustom rendering
- animation
- Windows desktop
- accessibility
- クロスプラットフォーム

### 弱点

MusicXML→SVGのinteractive DOM integrationには追加bridgeが必要。

### 結論

HornScribeの既存OSSとの組み合わせでは採用しない。

---

# 3.8 Slint / Rust native UI

参考:
- https://slint.dev/

軽量で魅力的だが、2025〜2026にdesktop機能が急速に拡張されている段階。

HornScribeの現時点では、Web/Qtほど周辺ecosystemが成熟していない。

### 結論

将来再評価。

---

# 4. UI technology decision

## Adopt

```text
Desktop shell:
Tauri 2 / Rust

Frontend:
React
TypeScript

Component foundation:
Fluent UI React v9

Styling:
HornScribe design tokens
CSS variables / Fluent tokens

Score:
Verovio WASM

Waveform:
wavesurfer.js stable 7.x initially

Backend:
Python sidecar

IPC:
newline-delimited JSON protocol over stdin/stdout
```

## Why not full PySide6

PySide6を捨てる理由ではなく、**役割を変える**。

Pythonは採譜エンジンに集中させる。

UI側がML packageと同じPython processに存在すると、

- model importで起動が重くなる
- ML crashでGUIも落ちる
- dependency conflictがUIまで巻き込む
- GUI threadをblockingしやすい
- Python version upgradeとGUI lifecycleが密結合

する。

分離することで、UIは常にresponsiveに保ちやすい。

---

# 5. Score renderer

## 5.1 Verovio — 採用

参考:
- https://www.verovio.org/
- https://book.verovio.org/toolkit-reference/toolkit-methods.html

特徴:

- MusicXML import
- SVG output
- C++ / JavaScript / WASM
- element IDs
- time ↔ element APIs
- page mapping
- CSSによるhighlight

重要API例:

```text
getElementsAtTime(ms)
getTimeForElement(xmlId)
getTimesForElement(xmlId)
getPageWithElement(xmlId)
```

これにより、

```text
playback time
→ active MusicXML element ID
→ SVG note highlight
```

と、

```text
SVG note click
→ xml ID
→ onset time
→ audio seek
```

を実装できる。

### Accessibility注意

SVGだけをscreen reader用UIとみなさない。

別途、score domain modelからaccessible treeを生成する。

---

## 5.2 OpenSheetMusicDisplay — fallback

参考:
- https://opensheetmusicdisplay.org/
- https://github.com/opensheetmusicdisplay/opensheetmusicdisplay

MusicXMLをbrowserで描画でき、

- cursor
- note coloring
- SVG
- TypeScript

を利用可能。

Verovioで必要なinteractionに問題が出た場合、PoCで比較する。

---

## 5.3 VexFlow

参考:
- https://www.vexflow.com/

低レベルnotation engine。

HornScribeは既にMusicXMLをcanonical exportとするため、直接VexFlowで譜面を組み立てる必要はない。

---

## 5.4 MuseScore

**ライブプレビューには使わない。**

用途:

- PDF
- final engraving preview
- Open in MuseScore
- interoperability test

ライブUIはVerovio、最終PDFはMuseScoreという役割分担にする。

---

# 6. Waveform

## wavesurfer.js

参考:
- https://wavesurfer.xyz/

利用するもの:

- Waveform
- Regions
- Timeline
- Hover
- optional Spectrogram
- optional Minimap

2026-09時点ではstable 7.xをまず固定し、v8 betaは本番導入しない。

## 原則

通常モード:

```text
Waveform
Score
```

Reviewモード:

```text
Waveform
+ optional spectrogram
+ optional raw note overlay
Score
```

waveform / spectrogram / piano-roll / score を常時全部表示してはいけない。

情報量を段階的に開示する。

---

# 7. Audio playback / transport

HTMLMediaElement + wavesurfer.js は **Architecture Spikeで検証する実装候補**であり、HornScribeの永続的なdomain interfaceではない。

Frontendには独立した `TransportController` を定義する。

```ts
interface TransportController {
  play(): Promise<void>
  pause(): void
  seek(seconds: number): Promise<void>
  setRate(rate: number): void
  setLoop(range: { start: number; end: number } | null): void
  getCurrentTime(): number
  subscribe(listener: (state: TransportSnapshot) => void): () => void
}
```

wavesurfer / HTMLMediaElementはadapterとして実装する。

Spikeで測定する:

- seek latency
- playback cursor jitter
- loop drift
- 3分/10分音源でのmemory
- playback-rate behavior
- `preservesPitch` behavior
- pause/resume後のtime mapping
- WebView2 codec support

`playbackRate`候補:

- 0.5x
- 0.75x
- 1.0x
- 1.25x
- 1.5x

参考:
- https://developer.mozilla.org/docs/Web/API/HTMLMediaElement/preservesPitch

高度なtime stretch品質が必要になった段階でnative DSPを評価する。

## 7.1 Local playback cache

元音源をWebViewへ無制限に公開しない。

推奨データフロー:

```text
User-selected original audio
→ Rust/Python backend only
→ normalized playback cache
→ narrowly scoped Tauri asset protocol
→ waveform / transport
```

利点:

- WebView filesystem exposureを最小化
- unsupported codec差を吸収
- waveform peak生成と同じcache identityを使える
- source audioを変更しない

再生cache formatはSpikeで、WAV等のtiming安定性とfile sizeを比較して決定する。

---

# 8. Frontend / backend boundary

## 8.1 Tauri Rust shell

責務:

- app lifecycle
- native window
- filesystem permission boundary
- file open/save dialogs
- drag/drop bridge
- Python worker launch
- Python worker termination
- Python crash detection
- sidecar version discovery
- OS integration
- deep link/file association（将来）

音楽ロジックをRustへ移植しない。

---

## 8.2 React frontend

責務:

- layout
- interaction
- transport controls
- score rendering
- waveform
- selection
- review workflow
- progress
- settings
- accessibility presentation
- keyboard shortcuts
- undo/redo command dispatch

concert→Horn移調の計算をReactで実装してはいけない。

---

## 8.3 Python worker

責務:

- audio normalization
- transcription
- cleanup
- beat / tempo
- quantization
- canonical ScoreDocument
- Horn in F transformation
- MusicXML
- MIDI
- PDF/MuseScore
- cache
- project persistence

**Canonical concert pitch は引き続きPython domain layerのsource of truth。**

---

# 8.4 Security / local-file boundary

Tauriの権限は最小化する。

必須:

- remote CDN/scriptをruntimeで読み込まない
- restrictive CSPを設定
- Verovio WASMに必要な場合だけ `wasm-unsafe-eval` を許可
- frontendへhome directory全体のfilesystem権限を与えない
- asset protocolを使う場合はapp cacheと明示的に許可したpathだけをscopeへ追加
- user-selected original audioは原則backend ownershipとし、frontendにはnormalized playback cacheを渡す
- shell command stringを組み立てず、FFmpeg/MuseScoreはargument arrayでspawn
- diagnostics/logには不要なsource pathや音源内容を複製しない

Tauriではasset protocol scopeとCSPの設定がlocal file accessのsecurity boundaryになるため、Architecture Spikeのacceptance criteriaに含める。

参考:
- https://v2.tauri.app/security/asset-protocol/
- https://v2.tauri.app/security/csp/
- https://v2.tauri.app/reference/acl/scope/

---

# 9. IPC protocol

MVPではlocal socket/gRPCを使わない。

stdin/stdout の line-delimited JSON を使う。

理由:

- port不要
- firewall不要
- lifecycleが明確
- debuggingが容易
- sidecarと1対1
- unit testしやすい

## 9.1 Handshake

UI起動時:

```json
{
  "type": "request",
  "id": "1",
  "method": "system.handshake",
  "params": {
    "protocolVersion": 1
  }
}
```

response:

```json
{
  "type": "response",
  "id": "1",
  "result": {
    "protocolVersion": 1,
    "backendVersion": "0.1.0",
    "capabilities": {
      "basicPitch": true,
      "ffmpeg": true,
      "musescore": false
    }
  }
}
```

## 9.2 Progress event

```json
{
  "type": "event",
  "event": "job.progress",
  "payload": {
    "jobId": "abc",
    "stage": "transcribing",
    "progress": 0.42,
    "cancelable": true
  }
}
```

## 9.3 Rules

- protocol messages → stdout
- log messages → stderr
- binary audioをJSONに送らない
- file path / cache IDを渡す
- protocolVersionを必須にする
- unknown fieldは原則ignore
- incompatible major versionは接続拒否
- requestには必ずid
- cancelは `jobs.cancel`
- ML libraryがstdoutへ書き込む場合はworker wrapperでstderrへ隔離する
- cancellationは「messageを受け取れる」だけで合格にしない。実際のBasic Pitch inferenceを停止できるか測定する
- blocking inferenceをpromptに止められない場合、sidecar restartまたはper-job child processをfallbackにする

worker crash時:

1. UIは落ちない
2. jobをfailed表示
3. autosaved projectは保持
4. worker restartを試行
5. diagnosticsからstderr logを見られる

---

# 10. Frontend state model

最低限、状態を次に分離する。

```text
ProjectState
TransportState
SelectionState
ScoreViewState
ReviewState
JobState
PreferencesState
```

## ProjectState

- project ID
- source audio
- dirty state
- backend version
- current ScoreDocument revision

## TransportState

- playing
- playback rate
- current time
- loop
- follow enabled
- follow suspended

**60fpsのplayhead positionをReact global storeへ毎frame書き込まない。**

audio clockをsource of truthとしてrequestAnimationFrameで描画要素へ反映し、global state updateはthrottleする。

## SelectionState

- selected score element
- selected raw note event
- selected time region

## ReviewState

- confidence threshold
- suspect IDs
- current suspect
- raw/cleaned/quantized visibility
- reviewed/dismissed state

---

# 11. Information Architecture

HornScribeはDAW型「全パネル常時表示」にはしない。

## Primary workspaces

```text
Score
Review
```

Exportは一時的なside sheet/dialogとする。

Settingsは独立dialog。

## Why

日常作業の大半は、

```text
Listen
Transcribe
Read
Export
```

であり、spectrogramやraw eventは常時必要ではない。

---

# 12. Main window — recommended layout

## 12.1 1920×1080

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ HornScribe · MySong                                      ─  □  ×            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Score  Review        ↶ ↷       [コンサートピッチ / F管ホルン]      Export          │
├──────────────────────────────────────────────────────────────────────────────┤
│ 00:42.381     ◀  ▶/Ⅱ  ▶▶       Loop     0.75×     Follow     ───●── zoom   │
├──────────────────────────────────────────────────────────────────────────────┤
│ │ waveform                         LOOP REGION                    │           │
│ │───────▂▃▅▂▁─────▃▆██▅▂──────────████████──────────────────────│           │
│ └─────────────────────────────▲ playhead─────────────────────────┘           │
├──────────────────────────────────────────────────────────┬───────────────────┤
│                                                          │ プロパティ         │
│                 SCORE                                    │                   │
│                                                          │ Selection         │
│      ♩   ♪ ♪   ♩     ♩                                   │ Pitch: G4         │
│               │ playhead                                 │ Start: 12.50      │
│                                                          │ Duration: 1/8     │
│                                                          │ Confidence: 72%   │
│                                                          │                   │
│                                                          │ [Listen Loop]     │
│                                                          │ [Restore Raw]     │
├──────────────────────────────────────────────────────────┴───────────────────┤
│ Ready · Basic Pitch · 120 BPM · 4/4                              Saved      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Heights

Approximate logical px:

- titlebar: 40
- command bar: 44
- transport: 44
- waveform: 96–120
- status: 26
- remaining area: score

Inspector:
- 300–340 logical px
- collapsible

---

## 12.2 1366×768

Rules:

- Inspector is collapsed by default
- labels on secondary toolbar buttons may become icons + tooltip
- waveform 72–88px
- score receives maximum vertical area
- Export remains visible
- never introduce horizontal application scrolling

Inspector opens as right overlay/drawer.

---

## 12.3 4K / HiDPI

Do not simply enlarge every panel.

Use logical pixels and OS DPI.

- Inspector remains ~320 logical px
- toolbar remains compact
- score gets the extra area
- page can show more systems or larger zoom according to preference
- typography follows OS scale

---

# 13. Concert / Horn interaction

ConcertとHornは別documentではない。

**同じScoreDocumentのpresentation。**

UIはtabsではなくsegmented selector:

```text
[ コンサートピッチ | F管ホルン ]
```

切替時:

- playback time stays
- selected note stays mapped
- zoom stays
- page location stays as closely as possible
- loop stays
- Review issue stays mapped

Ctrl+1:
Concert

Ctrl+2:
Horn in F

---

# 14. Score workspace

Default.

表示:

- compact waveform
- large score
- optional Inspector
- transport

非表示:

- spectrogram
- raw event piano roll
- backend debug values
- full confidence graph

目的:

**譜面を読んで演奏可能か確認する。**

---

# 15. Review workspace

AI結果の確認専用。

```text
┌─────────────────────────────────────────────────────────┐
│ Needs review  7              [All] [Unreviewed] [Done] │
├─────────────────────────────────────────────────────────┤
│ waveform + loop selection                              │
├─────────────────────────────────────────────────────────┤
│ optional spectrogram / raw note events                 │
├─────────────────────────────────────────────────────────┤
│ score                                                   │
│     note with dotted uncertainty outline                │
├─────────────────────────────────────────┬───────────────┤
│ Issue 3 of 7                            │ correction    │
│ 72% confidence · pitch conflict         │ G4 → Ab4     │
│ [Listen] [Accept] [Dismiss]             │ duration ...  │
└─────────────────────────────────────────┴───────────────┘
```

Review navigation:

```text
Previous issue
Next issue
Listen 1.5 sec
Loop
Accept
Correct
Dismiss
```

---

# 16. AI uncertainty / ReviewIssue UX

FrontendはBasic Pitch等のraw confidenceを直接product stateとして扱わない。

Python engineはbackend固有のconfidence・cleanup警告・quantization ambiguity等を、共通の `ReviewIssue` へ変換する。

例:

```text
ReviewIssue
  id
  canonicalNoteIds[]
  timeRange
  reason
  severity
  evidence
  status
```

`reason` の例:

- low_model_confidence
- very_short_detection
- overlapping_candidates
- quantization_ambiguous
- pitch_spelling_ambiguous
- outside_preferred_horn_range
- structural_measure_conflict

Raw confidenceはInspector内のevidenceとして表示してよいが、「この音が間違っている確率」と断定しない。

表示名:

- Needs review
- Review reason
- Model confidence（利用可能な場合のみ）

## Do not

- 低confidenceをすべて赤にする
- backendごとに意味の違うconfidence thresholdをUI共通ロジックとして直接比較する
- 低confidence noteを自動削除する
- confidenceを精度保証のように表示する

## Visual encoding

Review item:

- subtle tinted background
- dotted/segmented outline
- review glyph
- reason text in Inspector

**色だけに依存しない。**

### Suggested semantics

```text
Normal       no decoration
Review       dotted outline + review icon
Edited       small edit marker
Resolved     warning removed, decision retained
Dismissed    warning hidden, history retains decision
Conflict     warning icon + explanation
```

Redは処理失敗・破損等のerror専用にする。

Review decisionはscore revision / canonical note IDへ紐づけてprojectに保存する。

---

# 17. Raw / Cleaned / Quantized

通常UIには出さない。

Review mode内に:

```text
Display:
[ Score ]
[ Cleaned events ]
[ Raw events ]
```

としてlayer表示する。

目的:

- AIが本当に検出した内容
- cleanupが削った内容
- quantizerが移動した内容

を比較できること。

データはnon-destructive。

---

# 18. Audio ↔ Score synchronization

これはHornScribeの最重要UX。

## 18.1 Playback

audio timeを基準に:

```text
audio currentTime
→ score mapping
→ active note/system
→ highlight
→ optional auto scroll
```

## 18.2 Score click

```text
click note
→ select MusicXML element
→ lookup canonical note ID
→ seek audio onset
```

設定:

```text
Seek audio when selecting a score note: ON
Play short preview on double-click: OFF default
```

## 18.3 Waveform click

```text
click waveform
→ seek
→ find nearest active score note
→ update score selection
```

## 18.4 Follow Playback

ON:

score follows current playback.

ユーザーがscoreをscroll/panすると:

```text
follow = suspended
```

小さなpillを出す。

```text
[ Resume follow ]
```

F key or playback restartでresume。

強制的に現在位置へ引き戻してはいけない。

---

# 19. Loop UX

Shift + drag on waveform:

time range selection.

Selection表示:

```text
12.42s ├──────────────┤ 14.10s
```

Action:

- Loop selection
- Play selection
- Clear

handlesをドラッグして調整可能。

Keyboard:

```text
[   set loop start
]   set loop end
Ctrl+L  toggle loop
Esc     clear selection
```

必要ならユーザー設定で変更可能にする。

---

# 20. Keyboard shortcuts

テキスト入力中はglobal shortcutを抑制する。

Initial defaults:

| Action | Shortcut |
|---|---|
| Play / Pause | Space |
| Shuttle reverse | J |
| Stop / pause | K |
| Shuttle forward | L |
| Seek backward | Left |
| Seek forward | Right |
| Larger seek backward | Shift+Left |
| Larger seek forward | Shift+Right |
| Previous review item | Ctrl+Left |
| Next review item | Ctrl+Right |
| Toggle loop | Ctrl+L |
| Loop start | [ |
| Loop end | ] |
| Follow playback | F |
| Concert | Ctrl+1 |
| Horn in F | Ctrl+2 |
| Undo | Ctrl+Z |
| Redo | Ctrl+Shift+Z |
| Zoom in | + |
| Zoom out | - |
| Fit score | Ctrl+0 |
| Open audio | Ctrl+O |
| Export | Ctrl+E |
| Settings | Ctrl+, |

すべてmenuとtooltipから発見できること。

shortcut customizationはv1以降。

---

# 21. Editing boundary

HornScribe内で実装する編集は「採譜修正」に限定する。

## MVP / Polished MVP

- pitch correction
- delete false note
- restore removed note
- split note
- merge adjacent same-pitch notes
- BPM
- meter
- pickup
- key
- quantization
- loop/listen
- undo/redo

## Do not build

- advanced engraving
- beam layout editor
- slur visual positioning
- text frame system
- lyrics editor
- page layout engine
- full articulation library
- orchestral score layout

高度な編集:

```text
[Open in MuseScore]
```

へ渡す。

---

# 22. Inspector

Inspectorはselection contextによって変わる。

## Nothing selected

Project:

- BPM
- meter
- key
- quantization
- backend summary

## Note selected

- written/concert pitch
- onset
- duration
- confidence
- correction controls
- Listen
- Loop
- raw note relation

## Time range selected

- start/end
- loop
- transcribe selected region（将来）
- playback selection

Inspectorに大量のadvanced inference parameterを置かない。

---

# 23. Transcription job UX

Stages:

```text
Preparing audio
Transcribing
Cleaning detections
Analyzing rhythm
Quantizing
Building score
Rendering
```

## Determinate progress

実測可能なstageだけpercentage表示。

## Indeterminate progress

計測できない処理で偽のpercentageを生成しない。

表示:

```text
Transcribing audio…
Basic Pitch
[Cancel]
```

## ETA

初回は表示しない。

同じPCで十分な測定履歴があり、誤差範囲を推定できるようになった場合のみ将来検討。

---

# 24. Long-running jobs

採譜中でも:

- source audioを再生できる
- settings dialogを開ける
- appを移動/resizeできる

job panel:

```text
Transcribing MySong
Stage: Quantizing
██████████░░░░
[Cancel]
```

close app時にactive jobがある場合:

```text
Transcription is still running.
[Keep HornScribe open] [Cancel job and quit]
```

バックグラウンド常駐はMVPでは行わない。

---

# 25. Welcome / Empty state

```text
┌─────────────────────────────────────────────────────────┐
│ HornScribe                                              │
│                                                         │
│                Drop an audio file here                  │
│                    or                                   │
│                [ Open Audio ]                           │
│                                                         │
│ WAV · MP3 · FLAC · M4A · OGG                            │
│                                                         │
│ Analysis stays on this computer.                        │
└─────────────────────────────────────────────────────────┘
```

避ける:

- marketing hero
- 巨大なillustration
- 何枚ものonboarding cards

個人用工具として起動後すぐ作業に入れる。

Recent projectsはv1。

---

# 26. Dependency missing states

## FFmpeg missing

```text
Audio conversion is unavailable.

HornScribe could not find FFmpeg.
[Choose FFmpeg location] [Diagnostics]
```

## MuseScore missing

アプリ全体をerrorにしない。

```text
PDF export is unavailable.
MusicXML and MIDI export are still available.

[Choose MuseScore location]
```

## Transcription model unavailable

```text
Transcription model is not ready.
[Prepare model]
```

offline利用を意識し、必要ファイルと保存場所を明示する。

---

# 27. Export UX

Exportはside sheetまたはcompact dialog。

```text
Export

Score
[x] Concert
[x] Horn in F

Formats
[x] MusicXML
[x] MIDI
[x] PDF

Folder
C:\Users\...\Music\HornScribe
[Choose…]

                 [キャンセル] [書き出し]
```

MuseScoreなし:

PDF checkbox disabled + reason tooltip/text。

完了:

```text
書き出しが完了しました
[エクスプローラーで表示] [Open Horn score in MuseScore]
```

---

# 28. Settings IA

## General

- Theme
- Open last project
- Autosave
- Default export directory

## Audio

- output device（v1）
- seek amount
- default playback rate
- preserve pitch

## Transcription

Simple:

- backend
- sensitivity
- minimum note duration

Advanced collapsed:

- model-specific thresholds
- cleanup values

## Notation

- default meter
- quantization
- preferred accidental spelling
- Horn range warnings
- page/continuous view

## Tools

- FFmpeg path
- MuseScore path
- model/cache path

## Accessibility

- high contrast
- reduced motion
- UI scale override if required
- score contrast
- waveform contrast

## Diagnostics / Advanced

- backend versions
- protocol version
- paths
- log folder
- cache
- worker restart
- system information

---

# 29. Design system

HornScribeの見た目は、

**calm professional instrument**

とする。

避ける:

- 過剰なglassmorphism
- neon gradients
- 大きすぎるcorner radius
- mobileアプリ風の巨大buttons
- 不必要なshadow
- 全画面をaccent colorで染める
- animationによる演出過多

---

# 30. Typography

Windows:

```css
font-family:
  "Segoe UI Variable",
  "Segoe UI",
  "Yu Gothic UI",
  "Meiryo",
  sans-serif;
```

Timecode:

```css
font-family:
  "Cascadia Mono",
  "Consolas",
  monospace;
```

参考:
- https://learn.microsoft.com/windows/apps/design/signature-experiences/typography

Scale:

```text
11/16  metadata only
12/18  compact label
13/20  default UI body
14/20  emphasized body
16/24  panel title
20/28  major empty-state title
```

12px未満を通常controlsに使用しない。

sentence case。

---

# 31. Spacing

4px base.

```text
space-1  4
space-2  8
space-3  12
space-4  16
space-6  24
space-8  32
```

原則8px grid。

関連するcontrol間:
4–8px

section間:
16–24px

---

# 32. Geometry

参考:
- https://learn.microsoft.com/windows/apps/design/style/rounded-corner

```text
control radius      4px
panel/popover        8px
dialog               8px
score paper          2–4px
pill                 only for status/segmented cases
```

何でも16px roundedにしない。

---

# 33. Color tokens

以下は初期prototype用であり、contrast test後に確定する。

## Light

```css
--hs-bg-app:          #F3F4F6;
--hs-surface-1:       #FFFFFF;
--hs-surface-2:       #F8F9FB;
--hs-surface-3:       #EEF1F5;
--hs-border-subtle:   #DADDE3;

--hs-text-primary:    #1B1D22;
--hs-text-secondary:  #5F6672;

--hs-accent:          #3B73D9;
--hs-accent-hover:    #2F64C4;

--hs-score-paper:     #FBFAF7;
```

## Dark

```css
--hs-bg-app:          #0F1115;
--hs-surface-1:       #15181E;
--hs-surface-2:       #1B1F27;
--hs-surface-3:       #232832;
--hs-border-subtle:   #2F3540;

--hs-text-primary:    #F2F4F7;
--hs-text-secondary:  #AAB1BC;

--hs-accent:          #6EA8FE;
--hs-score-paper:     #191A1D;
```

最終的にはFluent theme tokensとsystem accentへのmappingを行う。

---

# 34. Semantic colors

```text
Error      operation failed / invalid file
Warning    recoverable technical warning
Success    completed operation
Review     uncertain transcription / human review requested
Selection  current user selection
Playback   current time/playhead
```

Confidenceはerror colorを使わない。

Brass/gold色をHornScribeのbrand accentとして少量使用可能だが、全UIを茶/金色にはしない。

---

# 35. Waveform palette

役割を分ける。

```text
unplayed waveform       neutral
played waveform         accent
selection region        accent translucent
loop boundary           high contrast
playhead                distinct from warning/error
suspect note region     patterned/tinted review color
```

dark/light両方でcontrast test。

---

# 36. Motion

参考:
- https://learn.microsoft.com/windows/apps/design/motion/

原則:

- direct
- short
- contextual
- interruptible

Initial durations:

```text
press/hover              80–120 ms
popover                  120–167 ms
panel expand/collapse    167 ms
workspace transition     200–250 ms
large entrance           avoid unless necessary
```

`prefers-reduced-motion` ではnon-essential motionを無効化。

score playback cursorはmotion preferenceに関係なく位置を示すが、不要なeasingを入れない。

---

# 37. Material

WindowsではMica/Acrylic的表現を使うとしても限定する。

- Main background: solid or subtle Mica if Tauri/native window integration is stable
- Flyout/popover: Acrylic-like surface optional
- Score paper: opaque
- Waveform: opaque
- Inspector: opaque/subtle surface

可読性をmaterialより優先する。

---

# 38. Icons

Fluent System Icons系を基準。

Rules:

- 16px / 20px
- 1 icon family
- filled/regularの使い分けを統一
- destructive actionsはiconだけにしない
- unfamiliar iconにはtooltip
- icon-only buttonはaccessible name必須

---

# 39. Accessibility

参考:
- https://fluent2.microsoft.design/accessibility
- https://learn.microsoft.com/windows/apps/design/accessibility/accessibility

## Required

- WCAG 2.1 AAを最低基準
- keyboard-only
- visible focus
- semantic control roles
- screen reader labels
- text contrast
- non-text contrast
- color-independent state indication
- reduced motion
- high contrast
- 125% / 150% scaling
- Windows Narrator test

通常テキストcontrast目標:
4.5:1以上。

Large text:
3:1以上。

---

# 40. Score accessibility

Verovio SVG自体だけにscreen reader semanticsを依存しない。

parallel accessibility representation:

```text
Score
  Measure 12
    Note G4, eighth note, beat 1
    Note A4, eighth note, beat 1 and
  Measure 13
...
```

画面上は非表示でも、semantic treeとして提供する。

keyboard score navigation:

```text
Left/Right   previous/next note
Ctrl+Left/Right previous/next measure
Enter        play selected note/region
```

Review mode shortcutと衝突するためfocus contextで意味を分ける。

---

# 41. 日本語UI — 固定要件

HornScribeのユーザー向けUIは**完全日本語**とする。

英語UI、言語切替、`en-US` locale対応は実装しない。

## 日本語化対象

- ボタン
- メニュー
- セグメント/タブ
- 設定
- プロパティ
- 空状態
- 採譜進捗
- 要確認理由
- エラー/警告
- 通知
- ツールチップ
- アクセシビリティ名
- 確認ダイアログ
- 依存ツール不足時の案内

## 例外

次は固有名詞・技術識別子として英語表記を許可する。

- MusicXML
- MIDI
- FFmpeg
- MuseScore
- Basic Pitch
- Verovio
- バージョン番号
- ファイル名/パス
- Ctrl / Shift / Alt / Space 等のキー名

ただしユーザーに説明する周辺文章は日本語にする。

例:

```text
× MuseScore not found
○ MuseScoreが見つかりません

× Export MusicXML
○ MusicXMLを書き出す
```

## 標準用語

```text
Concert Pitch        コンサートピッチ
Horn in F            F管ホルン
Transcribe           採譜
Score                楽譜
Review               要確認
Export               書き出し
Settings             設定
Properties/Inspector プロパティ
Follow Playback      再生位置を追従
Resume Follow        追従を再開
Quantization         量子化
Pickup Measure       弱起（アウフタクト）
Loop                 ループ
Playback Rate        再生速度
Needs Review         要確認
Model Confidence     モデル確信度
Diagnostics          診断情報
Retry                再試行
Cancel               キャンセル
Undo                 元に戻す
Redo                 やり直す
```

## 実装規則

- runtime language selectorを作らない
- UI文字列を英語fallback前提にしない
- 頻出文言・エラー・status・Review reasonは共通の日本語copy定義にまとめる
- 英語の仮ラベルをproduction UIへ残さない
- 日本語文字幅を基準にcomponentを設計する
- 固定widthで文字を切り捨てない
- Yu Gothic UI / Meiryo fallbackを確認する
- IME composition eventを壊さない
- Narratorのaccessible nameも日本語
- golden screenshotの正準localeは日本語のみ

---

# 42. Focus and keyboard rules

- Tab: interactive control間
- F6: major UI region間移動を検討
- Escape: popover/selectionを閉じる
- focus ringを消さない
- toolbar iconを無限Tab移動させないようroving tabindexを検討
- dialog open時focus trap
- close後はinvokerへfocus return

---

# 43. Empty / loading / error states

全コンポーネントで以下を定義する。

```text
idle
hover
focus
pressed
disabled
loading
empty
success
warning
error
```

「loading時にbuttonが消える」等のlayout shiftを避ける。

---

# 44. Autosave / recovery

manual editが始まったらproject stateをautosave。

Strategy:

- debounce ~1 sec
- temporary file write
- fsync/close
- atomic replace
- previous recovery snapshot
- startup時にunfinished session detection

derived artifacts:

- score preview
- rendered SVG

は再生成可能なのでautosaveの最重要対象ではない。

保存対象:

- source path
- project settings
- raw transcription refs
- cleanup decisions
- user corrections
- review decisions
- quantization parameters
- selected canonical score revision

---

# 45. Undo / Redo

Command modelを採用。

Undo対象:

- pitch correction
- delete/restore note
- split/merge
- BPM
- meter
- key
- quantization setting
- manual beat offset
- selected score corrections

Undo対象外:

- playback seek
- zoom
- panel open/close
- workspace change

Backendによるrecomputeはcommand revisionと結びつける。

---

# 46. Performance budget

## Application startup

Target:

```text
cold window interactive: <= 2.0 sec
```

ML worker/model initializationはstartup blockerにしない。

Python workerはlazy initialization可能とする。

---

## Interaction

```text
button feedback            < 100 ms
inspector selection        < 100 ms
workspace switch           perceived instant / < 250 ms
```

---

## Animation

playback/waveform:

```text
target 60 fps
frame budget ~16.7 ms
```

React tree全体を60Hz rerenderしてはいけない。

---

## Waveform

after peaks are ready:

```text
10-minute audio pan/zoom: target 60 fps
```

長尺音源ではprecomputed peaksを検討する。

---

## Score

Typical single-part 3–5 minute score:

```text
initial SVG render target    <= 300 ms
local rerender target        <= 150–250 ms
```

大規模scoreはpagination/virtualizationを検討。

---

## Memory

Frontend target:

```text
<= ~250 MB typical
```

ML model / Python worker memoryは別計測。

---

# 47. Design QA target resolutions

Mandatory:

- 1366×768 @100%
- 1920×1080 @100%
- 1920×1080 @125%
- 2560×1440 @125%
- 3840×2160 @150%

also:

- light
- dark
- high contrast
- ja-JPのみ

---

# 48. UI testing

## Unit

- state reducers/stores
- time mapping
- score note mapping
- keyboard shortcut resolution
- formatting
- localization

## Component

- React Testing Library
- Fluent controls
- state variants

## Accessibility

axe-core:
- https://github.com/dequelabs/axe-core

Automate:

- missing accessible name
- role problems
- contrast where detectable
- invalid ARIA

Manual:
- Narrator
- keyboard-only
- high contrast
- 150% scaling

---

## Visual regression

Create deterministic fixtures:

- empty
- project loaded
- transcription running
- score
- selected note
- review item
- export
- settings
- error
- dark mode

Screenshot compare with tolerance.

No timestamps/random IDs in golden screenshots.

---

## End-to-end

Frontend behaviorは可能な限りbrowser-level component/E2Eで高速に検証し、実Tauri E2EはWindows smoke/integrationへ絞る。

Tauriのdesktop WebDriverはWindows/Linuxで利用できるが、WindowsではEdge WebDriverとEdge/WebView環境のversion整合が必要なため、全UI回帰をこれだけに依存しない。

References:
- https://v2.tauri.app/develop/tests/
- https://v2.tauri.app/develop/tests/webdriver/

Scenarios:

```text
Open synthetic audio
→ Transcribe
→ Concert score appears
→ switch Horn
→ click score note
→ audio seeks
→ create loop
→ correct note
→ undo
→ export MusicXML
```

---

# 49. Technical spike before full implementation

GUI stackを本実装する前に、4つのPoCを作る。

## Spike A — Tauri + Python sidecar

Acceptance:

- packaged desktop window starts
- worker handshake
- request/response
- streamed progress
- cancel
- worker crash recovery
- stderr logs separated

## Spike B — Verovio

Acceptance:

- MusicXML rendered
- note click returns stable ID
- note ID → time
- playback time → highlighted note
- Concert/Horn switching keeps location

## Spike C — Waveform

Acceptance:

- 3–10 minute audio
- pan/zoom smooth
- region select
- loop handles
- currentTime synchronization
- speed change
- preserves pitch

## Spike D — Unified timeline

Acceptance:

- waveform click → score seek
- score click → waveform seek
- loop region → score highlight range
- mapping error within agreed tolerance
- playback cursor visually smooth

**4 spikesが成功してからTauriを最終固定する。**

失敗条件を事前に決める。

Tauri案を撤回する例:

- Verovio SVG interactionがWebView2で安定しない
- accessibilityを満たせない重大問題
- Python sidecar packagingが現実的に管理不能
- audio timingが必要精度を満たさない

その場合はQt Quick/QMLへfallbackする。

---

# 50. Development roadmap

## UX Phase 0 — Architecture spike

Issues:

### UI-001 Tauri application shell

Goal:
Tauri + React + TypeScriptの最小window。

Acceptance:

- Windows 11で起動
- Light/Dark
- no console errors
- packaged dev build

### UI-002 Python sidecar protocol

Acceptance:

- handshake
- timeout
- progress event
- cancellation
- worker crash handling

Depends:
UI-001

### UI-003 Verovio interaction spike

Acceptance:

- fixture MusicXML
- SVG render
- note click
- highlight by time

### UI-004 Waveform interaction spike

Acceptance:

- waveform
- seek
- loop region
- 0.5–1.5x speed

### UI-005 Score/audio synchronization spike

Acceptance:

- bidirectional seek
- playhead
- follow/suspend/resume

Depends:
UI-003, UI-004

---

## UX Phase 1 — Design foundation

### UI-010 Design tokens

Deliver:

- colors
- typography
- spacing
- radius
- elevation
- motion

Acceptance:

- light/dark
- no hard-coded component colors except documented exceptions

### UI-011 Component primitives

- Button
- IconButton
- SegmentedControl
- Toolbar
- Slider
- Numeric field
- Select
- Popover
- Tooltip
- Progress
- Status badge
- Panel
- Inspector section

Acceptance:

all interaction states defined.

### UI-012 Application shell

- titlebar
- command bar
- transport area
- content
- inspector
- status bar

Acceptance:

1366×768 without horizontal scrolling.

### UI-013 Accessibility foundation

- focus
- ARIA
- reduced motion
- high contrast strategy
- keyboard region navigation

---

## UX Phase 2 — Import / Playback

### UI-020 Welcome state

Acceptance:

- drag/drop
- Open Audio
- local-analysis trust message
- dependency errors

### UI-021 Transport

Acceptance:

- Space
- J/K/L
- seek
- rate
- timecode
- follow toggle

### UI-022 Waveform

Acceptance:

- pan
- zoom
- hover time
- selection
- loop
- playback cursor

### UI-023 Responsive behavior

Acceptance:

- target resolutions
- inspector drawer at narrow width

---

## UX Phase 3 — Score

### UI-030 Score renderer

Acceptance:

- MusicXML fixture
- paged/continuous mode decision
- zoom
- stable element mapping

### UI-031 Concert / Horn segmented selector

Acceptance:

- retains time
- retains selection
- correct visual state
- Ctrl+1 / Ctrl+2

### UI-032 Score playback highlight

Acceptance:

- currently sounding note(s) highlighted
- no heavy React rerender
- follow playback

### UI-033 Context Inspector

Acceptance:

- project context
- note context
- range context

---

## UX Phase 4 — Jobs / Transcription

### UI-040 Transcription flow

```text
Ready → Running → Score ready
```

Acceptance:

- stage
- cancel
- recoverable error
- UI never freezes

### UI-041 Job status

Acceptance:

- determinate/indeterminate distinction
- no fake ETA
- app usable while job runs

### UI-042 Partial failure state

Acceptance:

- raw result preserved
- retry available
- technical details only in diagnostics

---

## UX Phase 5 — Review

### UI-050 Review workspace

Acceptance:

- issue queue
- previous/next
- listen
- loop
- accept/dismiss

### UI-051 Confidence visual language

Acceptance:

- not color-only
- not red error semantics
- accessible legend

### UI-052 Raw/Cleaned/Score layers

Acceptance:

- toggle without changing data
- same timeline

### UI-053 Note correction

Acceptance:

- pitch
- delete/restore
- split/merge where implemented
- undo/redo

---

## UX Phase 6 — Export / Settings

### UI-060 Export

Acceptance:

- Concert/Horn
- MIDI/MusicXML/PDF
- MuseScore missing disables PDF only
- Reveal in Explorer

### UI-061 Settings

Acceptance:

- General
- Audio
- Transcription
- Notation
- Tools
- Accessibility
- Diagnostics

### UI-062 Diagnostics

Acceptance:

- versions
- worker status
- paths
- copy diagnostics
- open log folder

---

## UX Phase 7 — Polished MVP

### UI-070 Localization

- ja-JPのみ

### UI-071 Keyboard completeness

Every primary action reachable.

### UI-072 Accessibility pass

- axe
- Narrator
- high contrast
- 150% scale

### UI-073 Visual regression

target matrix.

### UI-074 Performance pass

measure:
- startup
- frame rate
- render
- memory

### UI-075 Crash recovery/autosave

---

## UX Phase 8 — v1 Windows integration

- installer
- app icon
- file association
- recent projects
- native notifications only when useful
- session restore
- jump list evaluation
- signed build if distribution ever occurs
- uninstall cleanup policy

---

# 51. Design QA checklist

PRでUIを変更する場合、最低限確認する。

## Layout

- [ ] 4/8px spacing systemから逸脱していない
- [ ] 1366×768で横scrollが出ない
- [ ] scoreがmain contentの主役
- [ ] inspectorを閉じられる
- [ ] state changeで大きなlayout shiftがない
- [ ] long Japanese labelsで崩れない

## States

- [ ] hover
- [ ] focus
- [ ] pressed
- [ ] disabled
- [ ] loading
- [ ] error
- [ ] keyboard

## Accessibility

- [ ] icon button has accessible name
- [ ] focus visible
- [ ] color is not sole encoding
- [ ] contrast AA
- [ ] reduced motion
- [ ] keyboard-only path
- [ ] Narrator sanity check for major flow

## Motion

- [ ] motion has purpose
- [ ] <=250ms for common UI transitions
- [ ] no decorative looping motion
- [ ] reduced motion respected

## Error handling

- [ ] says what failed
- [ ] says what remains available
- [ ] gives a recovery action when possible
- [ ] technical stack trace not shown to normal user

## Performance

- [ ] no backend work on UI thread
- [ ] no full React rerender at playback frame rate
- [ ] large SVG update profiled
- [ ] waveform remains smooth

## Product discipline

- [ ] not turning into a DAW
- [ ] not turning into MuseScore clone
- [ ] advanced options are progressively disclosed
- [ ] one clear primary action per surface

---

# 52. ADRs to create

Recommended Architecture Decision Records:

```text
ADR-0001 Desktop UI stack: Tauri + React
ADR-0002 Python worker process boundary
ADR-0003 IPC protocol
ADR-0004 Interactive score renderer: Verovio
ADR-0005 Waveform renderer: wavesurfer.js
ADR-0006 Fluent-based design system
ADR-0007 Playback clock as synchronization source
ADR-0008 AI confidence presentation semantics
ADR-0009 Editing boundary vs MuseScore
ADR-0010 Autosave and recovery model
```

---

# 53. Figma / Penpot / prototype workflow

UI実装前に、全画面をFigmaで精密に完成させる必要はない。

無料運用を優先するなら、

- Penpot
- Figma free tier if desired
- code-based Storybook/preview

を使える。

推奨:

## Step 1

low-fidelity wireframe:

- Welcome
- Score
- Review
- Export
- Settings

## Step 2

design token prototype.

## Step 3

code component sandbox。

**最終的なvisual truthは実アプリのcomponent implementationとする。**

音楽アプリでは実際の波形、SVG譜面、DPI、keyboard interactionを静的mockだけで検証できないため。

---

# 54. Repository impact

既存のPython中心構成は次のように変更する。

```text
HornScribe/
├─ apps/
│  └─ desktop/
│     ├─ src/                 # React/TypeScript
│     ├─ src-tauri/           # Rust/Tauri
│     └─ package.json
│
├─ python/
│  └─ hornscribe/
│     ├─ domain/
│     ├─ transcription/
│     ├─ rhythm/
│     ├─ notation/
│     ├─ instruments/
│     ├─ export/
│     ├─ project/
│     └─ worker/
│
├─ protocol/
│  ├─ schema/
│  └─ PROTOCOL.md
│
├─ tests/
│  ├─ python/
│  ├─ frontend/
│  └─ e2e/
│
├─ docs/
│  ├─ DEVELOPMENT_PLAN.md
│  ├─ GUI_UX_PLAN.md
│  └─ adr/
│
└─ fixtures/
```

まだコードがほぼ存在しない現在が、architectureを変更する最も低コストなタイミング。

---

# 55. Final product workflow

理想的な操作は以下。

```text
Launch
 ↓
Drop audio
 ↓
Play / confirm source
 ↓
Transcribe
 ↓
Score appears
 ↓
Concert / Horn in F switch instantly
 ↓
Listen while score cursor follows
 ↓
Review 5 suspicious notes
 ↓
Correct 1 note
 ↓
Export
 ↓
MusicXML / MIDI / PDF
```

ユーザーが通常触らなくてよいもの:

- model path
- backend internals
- raw note events
- MusicXML transpose metadata
- FFmpeg commands
- cache
- Python environment

それらはDiagnostics/Advancedへ隠す。

---

# 56. Success criteria

HornScribeのGUIを「完成度が高い」と判断する条件:

1. 初見でも音源を開いて採譜開始できる
2. 主要ワークフローに説明書が不要
3. 再生中の波形/譜面が滑らか
4. Scoreが常に主役
5. Concert/Hornの切替に文脈損失がない
6. AIが怪しい箇所だけ素早く確認できる
7. 同じ音を反復して聞く操作が非常に速い
8. advanced controlsが通常画面を汚さない
9. 1366×768でも成立する
10. 4K/150%でも崩れない
11. Light/Dark双方が意図的に設計されている
12. keyboard-onlyで主要操作ができる
13. 日本語UIで表記ゆれ・文字切れがない
14. workerが落ちてもproject/UIが失われない
15. 音源・採譜データを外部へ送信しない
16. GUIが採譜モデルの交換に依存しない

---

# 57. Recommended next implementation order

コードを書き始める前に、以下だけを先に検証する。

```text
1. Tauri shell
2. Python sidecar IPC
3. Verovio note interaction
4. wavesurfer loop/seek
5. score ↔ audio synchronization
6. design token prototype
```

ここが成功すれば、

```text
Welcome
→ Playback
→ Score
→ Transcription
→ Review
→ Export
```

の順に実装する。

**最初から全機能画面を作らない。**

---

# 58. Primary references

## Windows / Fluent

- Windows app design  
  https://learn.microsoft.com/windows/apps/design/
- Windows App SDK / WinUI  
  https://learn.microsoft.com/windows/apps/windows-app-sdk/
- Fluent 2  
  https://fluent2.microsoft.design/
- Fluent accessibility  
  https://fluent2.microsoft.design/accessibility
- Windows accessibility  
  https://learn.microsoft.com/windows/apps/design/accessibility/accessibility
- Windows typography  
  https://learn.microsoft.com/windows/apps/design/signature-experiences/typography
- Windows motion  
  https://learn.microsoft.com/windows/apps/design/motion/
- Rounded geometry  
  https://learn.microsoft.com/windows/apps/design/style/rounded-corner

## Desktop frameworks

- Tauri 2  
  https://v2.tauri.app/
- Tauri sidecars  
  https://v2.tauri.app/develop/sidecar/
- Tauri testing  
  https://v2.tauri.app/develop/tests/
- Qt Quick  
  https://doc.qt.io/qt-6/qtquick-index.html
- Qt Quick performance  
  https://doc.qt.io/qt-6/qtquick-performance.html
- Qt FluentWinUI3  
  https://doc.qt.io/qt-6/qtquickcontrols-fluentwinui3.html
- Electron process model  
  https://www.electronjs.org/docs/latest/tutorial/process-model
- Avalonia  
  https://docs.avaloniaui.net/
- Flutter Windows  
  https://docs.flutter.dev/platform-integration/windows
- Slint  
  https://slint.dev/

## Music UI references

- MuseScore Handbook  
  https://handbook.musescore.org/
- Dorico documentation  
  https://www.steinberg.help/r/dorico-pro/
- Ableton Live Manual  
  https://www.ableton.com/en/live-manual/
- Transcribe!  
  https://www.seventhstring.com/xscribe/
- Sonic Visualiser  
  https://www.sonicvisualiser.org/
- Melodyne Help  
  https://helpcenter.celemony.com/

## Score / waveform

- Verovio  
  https://www.verovio.org/
- Verovio Toolkit methods  
  https://book.verovio.org/toolkit-reference/toolkit-methods.html
- OpenSheetMusicDisplay  
  https://opensheetmusicdisplay.org/
- VexFlow  
  https://www.vexflow.com/
- wavesurfer.js  
  https://wavesurfer.xyz/
- HTMLMediaElement preservesPitch  
  https://developer.mozilla.org/docs/Web/API/HTMLMediaElement/preservesPitch

## Testing

- axe-core  
  https://github.com/dequelabs/axe-core

---

# 59. Decision summary

HornScribeのGUIは単なる「Pythonアプリの見た目改善」として扱わない。

採用方針は:

```text
Tauri 2
+ React / TypeScript
+ Fluent UI React
+ HornScribe design system
+ wavesurfer.js
+ Verovio WASM
+ Python worker sidecar
```

とする。

ただし、**UX Phase 0の技術spikeを通過した時点で正式固定**する。

これにより、

- Pythonの音楽/ML ecosystem
- Webの高度なinteractive visualization
- Windows 11の洗練されたデザイン
- Rust/Tauriのnative shell

を役割ごとに組み合わせる。

最終的な設計目標は、

> 「AI採譜ソフト」ではなく、音楽家が採譜結果を最短距離で信頼・確認・修正・演奏できるプロフェッショナルな楽器ツール

である。
