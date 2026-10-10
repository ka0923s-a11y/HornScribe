## 概要

export backendには `ExportRequest.basename` + `sanitizeBasename()` があり任意basenameを受け取れる設計でしたが、
`ExportDialog` にファイル名入力がなく、Appが作る `ExportSource.basename` は元音源stem固定でした。
曲名を編集しても `track01_horn_in_f.pdf` のような機械的名前のまま出力されていました。

## 変更点

- `ExportDialog` に「ファイル名」Inputを追加（`<basename>_<artifact>` の基準）。
- `suggestedBasename` prop：score `meta.title` が編集済み（stemと異なる）なら曲名、それ以外はstemをseed。
- openごとにreseed（曲名編集が反映される）。`basename.trim() || undefined` を `port.export` へ渡し、
  空ならport側の既存fallback（source.basename → meta.title）へ。
- `ja.exportSheet.fileName` / `fileNameHint` + `.hs-export__basename*` スタイル。

## 検証

- `tsc` / `eslint` / `vitest`（export関連）：クリーン。

Closes #362
