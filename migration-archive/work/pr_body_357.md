## 概要

GUI_UX_SPEC §17 の標準書き出しは MusicXML×2 / PDF×2 / MIDI の5形式が既定ですが、
`sourceAudio`（元音源コピー）も既定ONで、数十〜数百MBのバイナリを通常の楽譜書き出しへ暗黙同梱していました。

## 変更点

- `DEFAULT_SETTINGS.exportFormats.sourceAudio` を `false` に（#377 の persist 機構に乗るため、
  初回既定のみ変更・ユーザーが一度ONにすれば以後はその選択が維持される）。
- ラベルを `元の音声ファイル` → `参照用に元の音声もコピーする` へ変更し、
  formatの一種ではなく追加オプションであることを明示。

## 検証

- `store.test.ts` / `copy.test.ts`：パス。`tsc`/`eslint`：クリーン。

Closes #357
