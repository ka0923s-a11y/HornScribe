# HornScribe GUI / UX Product Specification

> Status: Authoritative product interaction specification  
> Language: 日本語UIのみ  
> Platform: Windows 11 first  
> Related: [GUI_UX_PLAN.md](GUI_UX_PLAN.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), [UX_VALIDATION.md](UX_VALIDATION.md), [JAPANESE_UI_COPY.md](JAPANESE_UI_COPY.md)

---

# 0. この文書の役割

この文書はHornScribeの「画面と操作」の正準仕様である。

ここで決めるもの:

- 画面構造
- 情報階層
- 状態遷移
- 主操作
- キーボード操作
- 波形と楽譜の同期
- 要確認フロー
- 簡易修正
- エラー回復
- 空状態
- 進捗
- 書き出し
- 設定
- レスポンシブ動作
- ウィンドウ再起動/復元

ここで決めないもの:

- 採譜アルゴリズム内部
- Quantizer内部
- MusicXML生成アルゴリズム
- MLモデル詳細

---

# 1. UX原則

HornScribeのUIは次の優先順位で設計する。

1. **楽譜が主役**
2. **原音へすぐ戻れる**
3. **不確実な箇所だけ効率よく確認できる**
4. **コンサートピッチ / F管ホルン切替で文脈を失わない**
5. **処理中でもアプリの状態を理解できる**
6. **結果を壊さず試せる**
7. **主要操作はキーボードでも完結する**
8. **専門的だが、内部実装をユーザーへ露出しない**
9. **長時間使っても疲れにくい**
10. **日本語UIとして自然である**

---

# 2. 情報アーキテクチャ

HornScribeはページ遷移型アプリではなく、1つの作業空間を中心とする。

基本構造:

~~~text
アプリウィンドウ
├─ タイトルバー
├─ コマンドバー
├─ 波形 / 時間軸
├─ 楽譜ワークスペース
│  └─ 必要時だけプロパティ
├─ トランスポート
└─ 状態 / ジョブ表示
~~~

主要コンテキスト:

~~~text
通常
要確認
書き出し
~~~

「設定」は作業モードではなく補助画面。

---

# 3. 起動 / 空状態

中央:

~~~text
HornScribe

ここに音声ファイルをドロップ

[ 音声ファイルを開く ]

WAV・MP3・FLAC・M4A・OGG

すべての解析はこのPC上で実行されます。
~~~

履歴がある場合のみ「最近使ったプロジェクト」。

空状態では次を出さない:

- 採譜設定一覧
- backend名
- FFmpeg設定
- Quantizer詳細
- 楽譜ツール
- プロパティ

操作:

- ドロップ → 音源読込
- Ctrl+O → ファイルダイアログ
- Ctrl+Shift+O → プロジェクトファイルダイアログ
- 最近のプロジェクト → 復元

---

# 4. 音源読込後 / 採譜前

~~~text
┌──────────────────────────────────────────────────────────┐
│ HornScribe — 曲名                              ─ □ ×     │
├──────────────────────────────────────────────────────────┤
│ [開く] [採譜]     [コンサートピッチ | F管ホルン]  [⋯] │
├──────────────────────────────────────────────────────────┤
│ 波形                                                     │
│ ────────────────●─────────────────────────────────────── │
├──────────────────────────────────────────────────────────┤
│                                                          │
│              まだ楽譜はありません                        │
│                                                          │
│                 [ 採譜を開始 ]                           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ ⏮  ▶  ⏭   00:34.2 / 03:17.8   1.0×   [ループ]          │
└──────────────────────────────────────────────────────────┘
~~~

Primary action:

**採譜を開始**

Advanced optionsは採譜ボタン横のpopoverに隠す。

- テンポ: 自動 / 手動
- 拍子
- 最小音価
- 三連符
- 楽譜の簡潔さ
- 採譜範囲

---

# 5. 採譜中

全画面モーダルで覆わない。

~~~text
採譜中

✓ 音声を準備しました
● 音を解析しています
○ リズムを解析
○ 楽譜を作成
○ 表示を準備

[ キャンセル ]
~~~

原則:

- 真に割合が分かる時だけ%
- 不明なstageはindeterminate
- ETAは安定時だけ
- 偽の進捗率を出さない

採譜中も可能:

- 再生
- 一時停止
- 波形移動
- 音量

同時再採譜などcanonical scoreを書き換える操作は無効化。

---

# 6. 採譜完了 / 通常ワークスペース

優先順位:

1. 楽譜
2. 波形
3. トランスポート
4. プロパティ
5. コマンド

~~~text
┌──────────────────────────────────────────────────────────────┐
│ HornScribe — 曲名                                  ─ □ ×   │
├──────────────────────────────────────────────────────────────┤
│ [開く] [採譜し直す] [コンサートピッチ|F管ホルン] [書き出し]│
├──────────────────────────────────────────────────────────────┤
│ 波形 / ループ範囲 / 現在位置                                │
├───────────────────────────────────────────────┬──────────────┤
│                                               │              │
│                  楽 譜                        │ プロパティ   │
│                                               │              │
│     現在小節 / 再生音 / 選択音               │ 選択時のみ   │
│                                               │              │
├───────────────────────────────────────────────┴──────────────┤
│ ⏮  ▶/⏸  ⏭   01:17.3   0.75× 1.0× 1.25× [ループ] [追従]   │
└──────────────────────────────────────────────────────────────┘
~~~

何も選択していない時、プロパティは原則閉じる。

---

# 7. コンサートピッチ / F管ホルン切替

Primary command。

~~~text
[ コンサートピッチ | F管ホルン ]
~~~

仕様:

- 即時切替
- 採譜再実行なし
- 再生継続
- canonical selection維持
- 再生位置維持
- ループ維持
- zoomを可能な限り維持

F管表示には小さく:

~~~text
F管ホルン
記譜音
~~~

Shortcut:

- Ctrl+1 コンサートピッチ
- Ctrl+2 F管ホルン

toggle shortcutより明示的な2キーを優先。

---

# 8. 波形UX

基本:

- click → seek
- drag → 範囲選択
- Ctrl+wheel → zoom
- wheel / trackpad → horizontal navigation
- Esc → 選択解除

範囲選択:

- 半透明overlay
- 両端handle
- start/end tooltip

context actions:

- ループ
- 選択範囲を再生
- 選択範囲へズーム

Minimapは長尺時のみ。

波形高さ:

- 標準 96–120px
- 最小 64px
- 最大 work areaの約35%
- resize可能
- 楽譜より大きくしない

---

# 9. トランスポートUX

常時アクセス可能。

必須:

- 再生/一時停止
- 停止
- 戻る
- 進む
- 現在時刻 / 総時間
- 再生速度
- ループ
- 追従

Shortcut:

| 操作 | キー |
|---|---|
| 再生/一時停止 | Space |
| 停止 | Shift+Space |
| 戻る | J |
| 再生/一時停止 | K |
| 進む | L |
| 先頭 | Home |
| 末尾 | End |
| ループ切替 | Ctrl+L |

J/K/Lはテキスト入力中無効。

---

# 10. 楽譜UX

MVPで連続表示とページ表示を比較する。

default候補:

**連続表示**

クリック:

- 音符選択
- canonical note ID取得
- プロパティ表示
- 原音位置と対応

Esc:

- 選択解除

矢印:

- 左右: 前/次音符
- Alt+上下: 半音上下

再生ハイライト:

1. playhead/caret
2. current measure subtle wash
3. active note outline

禁止:

- 強い塗りつぶし
- 楽譜可読性を壊す高彩度
- 毎フレームSVG全再描画

---

# 11. 再生位置追従

ON:

再生位置が画面外へ出る直前に次system/pageへ移動。

OFF:

ユーザーのscroll位置維持。

手動scrollで一時停止。

~~~text
再生位置の追従を一時停止しました
[ 追従を再開 ]
~~~

非モーダル表示。

---

# 12. 要確認ワークスペース

採譜後:

~~~text
12か所を確認すると、より確かな楽譜になります

[ 要確認箇所を見る ]
~~~

強制しない。

Header:

~~~text
要確認  3 / 12

[前へ] [元音源を再生] [問題なし] [次へ]
~~~

理由例:

- 音高を確認してください
- リズムの解釈を確認してください
- 音の長さを確認してください
- 拍位置を確認してください
- 三連符の可能性があります
- 弱起を確認してください

最低限action:

- 問題なし
- 音高修正
- 削除
- 元に戻す
- 次へ

低confidenceを赤error扱いしない。

---

# 13. 簡易音符修正

HornScribe内では「採譜修正」に限定。

必須:

- 音高 ±半音
- 異名同音
- 削除/復元
- 音価変更
- onset grid位置の限定修正
- tie toggle（妥当時）

MVP後:

- split
- merge

実装しない:

- ページレイアウト
- 記譜用テキスト
- 歌詞
- 発想記号
- 大量アーティキュレーション
- arbitrary voices
- engraving control

高度編集:

[ MuseScoreで開く ]

---

# 14. Undo / Redo

全修正をcommand化。

対象:

- pitch
- delete/restore
- duration
- spelling
- BPM
- 拍子
- quantization settings
- review decision

Ctrl+Z / Ctrl+Shift+Z。

重処理はrevision境界を明示。

---

# 15. Zoom

波形と楽譜は別zoom。

時間位置は同期。

楽譜:

- Ctrl++
- Ctrl+-
- Ctrl+0 幅に合わせる

波形:

- Ctrl+wheel

---

# 16. コマンドバー

常設:

- 開く
- 採譜 / 採譜し直す
- コンサート/F管切替
- 要確認（件数がある場合）
- 書き出し
- overflow

隠す:

- backend
- FFmpeg path
- cache
- quantizer weights
- diagnostics

---

# 17. 書き出し

~~~text
書き出し

楽譜
☑ コンサートピッチ MusicXML
☑ F管ホルン MusicXML

PDF
☑ コンサートピッチ PDF
☑ F管ホルン PDF

MIDI
☑ 再生用MIDI（実音）

保存先
...

[キャンセル] [書き出す]
~~~

MuseScore未検出:

PDFのみdisabled。

~~~text
PDFを書き出すにはMuseScoreが必要です。
MusicXMLとMIDIはそのまま書き出せます。
~~~

完了:

~~~text
書き出しが完了しました

[ エクスプローラーで表示 ]
~~~

---

# 18. 設定

カテゴリ:

## 外観

- テーマ: システム / ライト / ダーク

## 再生

- 標準再生速度
- 戻る/進む秒数
- 再生位置追従

## 採譜

- backend（詳細設定）
- BPM
- 拍子
- 最小音価
- 三連符

## 楽譜

- 初期表示
- 連続/ページ

## 書き出し

- default folder
- MuseScore path

## ツール

- FFmpeg
- MuseScore
- model info

## 詳細設定

- cache
- logs
- protocol/backend diagnostics

「言語」は存在しない。

---

# 19. 診断情報

通常UIから分離。

表示:

- HornScribe version
- Python engine version
- protocol version
- transcription backend
- FFmpeg
- MuseScore
- Verovio
- wavesurfer
- cache path
- log path
- worker status

操作:

- 診断情報をコピー
- ログフォルダを開く
- エンジンを再起動

---

# 20. エラー状態

原則:

1. 何が失敗したか
2. 何が保持されているか
3. 次にできること

Worker crash:

~~~text
採譜エンジンが停止しました

現在のプロジェクトと保存済みの採譜結果は失われていません。

[ エンジンを再起動 ] [ 診断情報 ]
~~~

MuseScore missing:

~~~text
PDFを書き出せません

MuseScoreが見つかりません。
MusicXMLとMIDIは書き出せます。

[ MuseScoreの場所を指定 ] [ 閉じる ]
~~~

Source moved:

~~~text
元音源が見つかりません

前回の場所から音声ファイルが移動した可能性があります。

[ 音源を指定 ]
~~~

---

# 21. Responsive behavior

>=1600px:

- right properties 280–320px
- full command labels
- waveform standard

1200–1599px:

- properties 240–280px
- secondary labels icon化
- waveform compact

1100–1199px:

- properties overlay/drawer
- less frequent commands overflow
- score優先

<1100px:

正式サポート対象外。
minimum window sizeで止める。

---

# 22. Focus model

Tab order:

~~~text
コマンドバー
→ 波形
→ 楽譜
→ プロパティ
→ トランスポート
→ 状態領域
~~~

F6を主要領域巡回の候補とする。

Dialog close後:

open元へfocus復帰。

---

# 23. Keyboard command registry

全shortcutを一箇所で定義。

~~~ts
interface Command {
  id: string
  labelJa: string
  shortcut?: Shortcut
  isEnabled(state): boolean
  execute(ctx): void
}
~~~

Component内で独自keydownを乱立させない。

---

# 24. Accessibility

release gate:

- accessible name / role / state
- keyboard-only
- visible focus
- color-only禁止
- contrast themes
- 200% scaling
- Narrator smoke
- logical focus order

Custom score/waveformはraw SVG/canvasだけに依存しない。

選択音符情報をプロパティからscreen readerで取得可能にする。

Focus indicator:

- 2px相当以上
- 背景との差が明瞭

---

# 25. Motion

役割:

- 状態変更
- panel開閉
- focus guidance
- view transition

時間目安:

- hover/pressed 80–120ms
- panel 160–220ms
- view 180–240ms

禁止:

- decorative looping
- bouncing
- excessive spring
- AI sparkle

reduced motionを尊重。

---

# 26. Session restore

保存:

- last project
- selected view
- waveform zoom
- score zoom
- panel visibility
- window geometry

保存しない/慎重:

- temporary tooltip
- transient error
- stale selection

---

# 27. Screen state machine

~~~text
EMPTY
  ↓ open
AUDIO_READY
  ↓ transcribe
TRANSCRIBING
  ├─ cancel → AUDIO_READY
  ├─ fail → TRANSCRIPTION_ERROR
  └─ complete → SCORE_READY

SCORE_READY
  ├─ review → REVIEWING
  ├─ export → EXPORTING
  ├─ retranscribe → TRANSCRIBING
  └─ edit → SCORE_READY(dirty)

REVIEWING
  ├─ next/previous → REVIEWING
  ├─ edit → REVIEWING(dirty)
  └─ exit → SCORE_READY

EXPORTING
  ├─ complete → SCORE_READY
  └─ fail → SCORE_READY + export error
~~~

Worker crashはmain UI stateを破壊しない。

---

# 28. UI performance conditions

- UI threadでML処理しない
- 60HzでReact全体をupdateしない
- note highlightでfull SVG rerenderしない
- waveform navigation target 60fps
- selection response <100ms
- command feedback <100ms
- app shell interactive <=2s target
- 1366x768で主要操作が隠れない
- 150/200% scalingで破綻しない

---

# 29. 実装前prototype

P1 Shell:

- command bar
- waveform placeholder
- score placeholder
- properties
- transport

P2 日本語density:

- 1366x768
- 150%
- 長い日本語error
- dark/light

P3 Score:

- click note
- highlight
- properties
- Concert/F管 switch

P4 Review:

- 5 issues
- keyboard-only next/play/resolve

P5 Export:

- normal
- MuseScore missing
- permission error

---

# 30. Completion criteria

- 空状態から採譜開始まで迷わない
- 楽譜が主役
- 波形→楽譜、楽譜→波形が成立
- F管切替で文脈を失わない
- 要確認をキーボード中心で処理できる
- 日本語に表記揺れがない
- errorが回復可能
- progressが誠実
- keyboard-only主要フロー成立
- Narrator major-flow smoke pass
- 150/200% scaling成立
- long-sessionで視覚ノイズが少ない
