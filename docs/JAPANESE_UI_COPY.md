# HornScribe 日本語UIコピーガイド

> Status: Active product copy standard  
> Scope: ユーザー向けUI文言  
> Language: 日本語のみ

---

# 1. 基本方針

HornScribeのユーザー向けUIは完全日本語とする。

英語UI、英語ロケール、言語切替は実装しない。

対象:

- ボタン
- メニュー
- ツールバー
- タブ/セグメント
- プロパティ
- 設定
- 空状態
- 採譜進捗
- 要確認理由
- エラー
- 警告
- 通知
- ツールチップ
- 確認ダイアログ
- アクセシビリティ名
- 依存ツール不足時の説明

## 許容する英語/英字

固有名詞・規格名・技術名は原表記を維持してよい。

例:

- HornScribe
- MusicXML
- MIDI
- FFmpeg
- MuseScore
- Basic Pitch
- Verovio
- WAV / MP3 / FLAC / M4A / OGG
- Ctrl / Shift / Alt / Space
- ファイル名
- パス
- バージョン番号

ただし、その周辺説明は日本語にする。

---

# 2. 文体

UI文は簡潔で、断定的かつ具体的にする。

推奨:

- 「音声ファイルを開く」
- 「採譜を開始」
- 「再生位置を追従」
- 「MusicXMLを書き出す」
- 「MuseScoreが見つかりません」

避ける:

- 「〜していただけます」
- 「〜することが可能です」
- 「エラーが発生しました」だけで終わる
- 不要な敬語
- 技術者向け内部用語を通常画面へ出す
- AIを擬人化する表現

ボタンは原則として動作を示す。

```text
○ 音声ファイルを開く
○ 採譜を開始
○ 書き出す
○ 再試行
○ キャンセル

× OK
× 実行
× 処理
```

文末の句点は、短いラベルやボタンでは付けない。
説明文・エラー本文では付ける。

---

# 3. 標準用語

| 内部/英語概念 | UI表記 |
|---|---|
| Concert Pitch | コンサートピッチ |
| Horn in F | F管ホルン |
| Horn in B♭ | B♭管ホルン |
| Score | 楽譜 |
| Transcribe | 採譜 |
| Transcription | 採譜 |
| Review | 要確認 |
| Needs Review | 要確認 |
| Export | 書き出し |
| Settings | 設定 |
| Inspector / Properties | プロパティ |
| Playback | 再生 |
| Play | 再生 |
| Pause | 一時停止 |
| Stop | 停止 |
| Follow Playback | 再生位置を追従 |
| Resume Follow | 追従を再開 |
| Loop | ループ |
| Playback Rate | 再生速度 |
| Quantization | 量子化 |
| Time Signature | 拍子 |
| Key Signature | 調号 |
| Pickup Measure | 弱起（アウフタクト） |
| Tempo | テンポ |
| BPM | BPM |
| Confidence | モデル確信度 |
| Diagnostics | 診断情報 |
| Retry | 再試行 |
| Cancel | キャンセル |
| Undo | 元に戻す |
| Redo | やり直す |
| Reset | リセット |
| Restore | 元に戻す / 復元（文脈で使い分け） |
| Open in MuseScore | MuseScoreで開く |
| Reveal in Explorer | エクスプローラーで表示 |
| Advanced | 詳細設定 |
| Raw events | 検出結果 |
| Cleaned events | 整理後の検出結果 |
| Source audio | 元音源 |

「raw」「cleaned」「backend」「worker」などの内部語は通常UIでは使わない。

---

# 4. メイン画面

推奨主要ラベル:

```text
音声ファイルを開く
採譜
コンサートピッチ
F管ホルン
B♭管ホルン
要確認
書き出し
設定
プロパティ
再生位置を追従
```

空状態:

```text
ここに音声ファイルをドロップ

または

[ 音声ファイルを開く ]

WAV・MP3・FLAC・M4A・OGG

すべての解析はこのPC上で実行されます。
```

---

# 5. 採譜進捗

内部stage名をそのまま表示せず、ユーザーが理解できる文言へ変換する。

| 内部stage | UI表記 |
|---|---|
| preparing_audio | 音声を準備しています |
| transcribing | 音を解析しています |
| cleaning | 検出結果を整理しています |
| analyzing_rhythm | リズムを解析しています |
| quantizing | 音符の長さと位置を整えています |
| building_score | 楽譜を作成しています |
| rendering | 楽譜を表示しています |

進捗率を正確に算出できない処理では、偽の%を表示しない。

---

# 6. 要確認UI

「confidenceが低い」だけをユーザー向け理由にしない。

推奨理由:

```text
音高を確認してください
音の開始位置を確認してください
音の長さを確認してください
複数の候補があります
リズムの解釈を確認してください
臨時記号の表記を確認してください
ホルンの音域を確認してください
小節内の音価を確認してください
```

Inspectorで必要な場合:

```text
モデル確信度: 72%
```

と表示できるが、

```text
正しい確率: 72%
```

とは表示しない。

---

# 7. エラー文

エラーは3点を順に示す。

1. 何ができなかったか
2. 何が保持されているか / 影響範囲
3. 次にできること

例:

```text
PDFを書き出せません

MuseScoreが見つかりません。
採譜結果とMusicXMLは失われていません。

[ MuseScoreの場所を指定 ] [ MusicXMLを書き出す ]
```

例:

```text
音声ファイルを開けません

このファイル形式を読み込めないか、ファイルが破損している可能性があります。

[ 別のファイルを選ぶ ] [ 診断情報 ]
```

避ける:

```text
Error
Something went wrong
Exception: ...
```

raw tracebackは通常UIへ出さない。

---

# 8. 確認ダイアログ

危険な操作でのみ確認する。

例:

```text
採譜結果を作り直しますか？

現在の手動修正に影響する可能性があります。

[ キャンセル ] [ 採譜し直す ]
```

「本当によろしいですか？」だけの抽象的確認は避ける。

---

# 9. ツールチップ

アイコンだけで意味が分からない操作には日本語ツールチップを必須とする。

例:

```text
再生 / 一時停止（Space）
5秒戻る（←）
ループを切り替える（Ctrl+L）
楽譜を画面幅に合わせる（Ctrl+0）
```

ツールチップも英語fallbackを残さない。

---

# 10. アクセシビリティ

aria-label / accessible nameも日本語にする。

例:

```text
再生
一時停止
音量
現在位置
再生速度
楽譜の表示倍率
プロパティを閉じる
前の要確認箇所
次の要確認箇所
```

SVGアイコン名や内部component名をそのまま読み上げさせない。

---

# 11. 日本語レイアウト

確認条件:

- Yu Gothic UI / Meiryo fallback
- 125% / 150% / 200% Windows scaling
- 日本語IME
- 長いエラー文
- ボタン内の全角文字
- 数値と単位の混在
- MusicXML等の半角英字との混植

英語UIより日本語の方が短くなるとは限らないため、固定幅で設計しない。

---

# 12. 表記ルール

- 「F管ホルン」を標準表記とする
- 「B♭管ホルン」を標準表記とする（B♭ は Unicode ♭、Bb/変ロ は使わない）
- 「コンサートピッチ」を標準表記とする
- 「楽譜」と「譜面」を混在させず、UIでは原則「楽譜」
- 「書き出し」を標準とし、「エクスポート」は通常UIでは使わない
- 「採譜」を標準とし、「トランスクリプション」は使わない
- 「要確認」を標準とし、「レビュー」は通常UIでは使わない
- 「設定」を標準とし、「セッティング」は使わない
- 「詳細設定」を標準とし、「Advanced」は使わない

---

# 13. テスト

Visual regressionの正準は日本語UIのみ。

必須fixture:

- 空状態
- 音源読み込み後
- 採譜中
- 採譜完了
- 要確認
- プロパティ
- 書き出し
- 設定
- FFmpeg不足
- MuseScore不足
- worker異常
- 長いエラー文
- ダーク/ライト
- 150% DPI

各PRで確認:

- 英語の仮文言がユーザー画面に残っていない
- accessible nameが日本語
- 用語集に従っている
- 文字切れがない
- 日本語IMEを使う入力欄でcompositionが正常


---

# 14. 量子化・リズム確認用語

HSQ-v1のReviewIssueは次の日本語を標準とする。

| internal reason | UI表記 |
|---|---|
| quantization_ambiguous | リズムの解釈を確認してください |
| beat_alignment_uncertain | 拍位置を確認してください |
| beat_map_uncertain | テンポと拍位置を確認してください |
| possible_triplet | 三連符の可能性があります |
| possible_grace_note | 装飾音の可能性があります |
| offset_ambiguous | 音の長さを確認してください |
| pickup_ambiguous | 弱起を確認してください |
| meter_conflict | 拍子を確認してください |
| overlapping_candidates | 音の重なりを確認してください |

通常UIでは次の内部語を表示しない。

- HSQ
- dynamic programming
- path cost
- Huber loss
- metrical tree
- candidate lattice
- mode-switch penalty

これらは「診断情報」でのみ表示可能。
