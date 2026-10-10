## 概要

`ExportDialog` はopenのたびに `selected` を全形式ONへ戻していたため、
「F管PDFのみ」「F管MusicXMLのみ」といった定型用途で毎回チェックをやり直していました。

## 変更点

- `AppSettings.exportFormats: Record<ExportFormatId, boolean>` を追加し、
  localStorageのsettings recordへ保存（`hornscribe.settings`）。
- `parseSettings` でper-key検証：未知idはdrop、欠損はdefault(true)へ。
- `ExportDialog`：open時の `setSelected(全ON)` リセットを削除し、
  `initialSelected` propでseed + `onSelectionChange` で変更をpersist。
- `App.tsx`：`settings.exportFormats` / `updateSettings({exportFormats})` を接続。

## 検証

- `store.test.ts`：exportFormatsのround-trip・未知id drop・非object blob → default。
- `tsc` / `eslint` / `vitest`：クリーン。

Closes #377
