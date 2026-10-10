## 概要
Issue #384 — Rust 側から返る多様な失敗を `EXPORT_FAILED` へ潰し、原因と無関係な「保存先を選び直す」を常時表示していた問題を修正。

## 変更内容

### Rust (export.rs) — stable `CODE:` プレフィックス
- 新ヘルパー `io_export_error()` が io エラーを `PERMISSION_DENIED` / `EXPORT_DISK_FULL` / 指定 fallback へ分類（raw_os_error: ENOSPC 28, HANDLE_DISK_FULL 39, DISK_FULL 112, EDQUOT 122 / EPERM 1, EACCES 13, ACCESS_DENIED 5, WRITE_PROTECT 19, EROFS 30）
- `invalid export name` → `EXPORT_NAME_INVALID`、`source audio not found` → `EXPORT_SOURCE_MISSING`、destination 作成失敗 → `EXPORT_DESTINATION_INVALID`、staging write/copy → `EXPORT_WRITE_FAILED`、base64 → `EXPORT_INTERNAL`
- MuseScore spawn/wait/exit-status 失敗 → `EXPORT_MUSESCORE_RENDER_FAILED`（missing とは区別）
- commit ループ内の失敗 → `EXPORT_COMMIT_FAILED`（部分書き出しの可能性を正直に伝えるため専用コード）
- 音源が検証後に消失した場合も NotFound → `EXPORT_SOURCE_MISSING`
- `reveal_in_explorer` の not-a-directory → `EXPORT_DESTINATION_INVALID`

### TS (types/tauriPort)
- `ExportErrorCode` に 9 コード追加（DISK_FULL, SOURCE_MISSING, MUSESCORE_RENDER_FAILED, DESTINATION_INVALID, WRITE_FAILED, COMMIT_FAILED, NAME_INVALID, NAME_EXHAUSTED, INTERNAL）
- `mapInvokeError` を includes → `CODE:` プレフィックス厳密一致へ（パス中の誤検出を防止）
- TS 側の `no free export name` → `EXPORT_NAME_EXHAUSTED`、no document → `EXPORT_INTERNAL`

### Dialog (ExportDialog.tsx)
- `ErrorKind` を 4 → 12 へ拡大、`KIND_BY_CODE` でコード→surface を統一マッピング
- `ERROR_ACTIONS` で種別ごとの復旧アクションを定義: permission/destination→保存先変更、disk full→保存先+再試行、renderFailed→再試行+診断、sourceMissing/nameExhausted→設定に戻る、internal/failed→再試行+診断 — generic 失敗に無関係なアクションを出さない
- §20「何が保持されているか」: `ERROR_KEPT` で staging 保証（既存ファイルは変更なし）または commit 部分書き出し警告を明示

### その他
- mockPort dev-flag に全コード追加（browser dev で各 surface を再現可能）
- ja.errors に 8 エントリ + exportShared（kept/keptPartial/backToForm）

## テスト
- `tauriPort.test.ts`: 12 パターンのコード接頭辞マッピング（it.each）
- `ExportDialog.test.tsx`（新規）: コード別に title/表示アクション/非表示アクション/kept 文言/本文に raw detail を出さないことを検証（13 ケース）
- `export.test.ts`: mock failure ループを全コードへ拡張
- `npx tsc --noEmit` ✅ `npx eslint` ✅ `vitest run src/export` 54 件 ✅

Closes #384
