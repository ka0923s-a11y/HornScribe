## 概要

レビューで、ユーザーに見える文言(アナウンス/ラベル)が copy deck (`strings/ja.ts`, 正準: `protocol/copy/ja-JP.json`) を通さずコード内に直書きされている箇所を検出。`docs/UI_COPY_CONTRACT.md` の「全ユーザー向け文言はデッキから解決する」規約に違反している。

さらに、デッキ側に既に存在するキー(`ja.capture.pausedAnnounce` / `resumedAnnounce` / `interruptedAnnounce`)を使わず、コントローラ側に同内容のリテラルが別途書かれており、**文言が二重管理**になっている(既に表現が微妙にずれ始めている)。

## 検出箇所

### capture (apps/desktop/src/capture/controller.ts)
- L263-266 録音開始アナウンス `PCの音を取り込んでいます` / `マイクで録音しています`
- L293 一時停止アナウンス(デッキ `pausedAnnounce` と重複)
- L318 再開アナウンス(`resumedAnnounce` と重複)
- L370 無音終了アナウンス `録音はほぼ無音でした。…`
- L375 30分上限終了アナウンス
- L411 キャンセルアナウンス `録音を取りやめました`
- L619-639 `issueText()` 全分岐(noDevice/busy/notActive/unsupported/permissionDenied/interrupted/failed)

### import (apps/desktop/src/import/controller.ts)
- L251-252, L285-286 取り込み完了アナウンス `PCの音を取り込みました(name)` / `録音を取り込みました(name)` (L806 以降は `ja.import.feedback` 準拠なので、ここだけリテラルが残っている)

### score (apps/desktop/src/score/ScoreReadyWorkspace.tsx)
- L2141-2144 自動演奏 on/off アナウンス `楽譜の自動演奏をオンにしました` / `オフにしました`

### components
- `CommandBar.tsx:404` ツールバーボタンラベル `取り込み`
- `primitives/NumericField.tsx:69-70` aria-label `{label}を増やす` / `を減らす`
- `capture/runtimePorts.ts:343` ブラウザ側デバイス名フォールバック `マイク {n}`
- `SettingsView.tsx:637` バックエンド選択肢 `pYIN（単音）`

### App.tsx
- L1598 自動保存復元時の仮プロジェクト名 `自動保存` (タイトルバーに出る)
- L1759 キュー複数追加時 `{n} 件の音源` (ステータスアナウンス)

## 付随発見
- `ScoreReadyWorkspace.tsx:1345` コメントが文字化けしている — 同PRで修正する。

## 対応方針
- 文言を `ja.ts` の既存グループ(`capture.*`, `import.feedback.*`, `transport`/`score` 系, `a11y` 系)に移す。未使用化する既存キー(pausedAnnounce/resumedAnnounce/interruptedAnnounce)は再利用する。
- `issueText` の分岐構造は維持し、戻り値をデッキ参照に差し替える。
- ファイル名テンプレート(`PCの音_*.wav`/`録音_*.wav`)はUIコピーではなくデータ名なので今回は対象外とする。
- 完了条件: 出荷コード内にユーザー向け日本語リテラルが残らないこと(`prototype/` は spike 資産のため対象外)。
