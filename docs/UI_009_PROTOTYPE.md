# UI-009 — 事前プロトタイプパック（issue #31）

> Status: 検証用プロトタイプ（本実装ではない）  
> Entry: dev route `#/prototype/*`（`main.tsx` から lazy import。通常シェルには読み込まれない）  
> Data: すべて決定的モック。音声・採譜エンジン・永続化なし。

## 起動方法

```text
cd apps/desktop
npm run dev
# ブラウザで http://localhost:1420/#/prototype
```

Tauri でも devUrl 上の同一ハッシュで開ける（WebView2 でも hash ルーティングは有効）。

## 状態一覧（すべて深リンク可）

| ハッシュ | 状態 |
|---|---|
| `#/prototype` | 状態一覧 |
| `#/prototype/shell/empty` | P1 空の状態 |
| `#/prototype/shell/audio` | P1 音源読込後 |
| `#/prototype/shell/transcribing` | P1 採譜中（ステージは自動進行→採譜完了へ） |
| `#/prototype/shell/score` | P1 採譜完了（要確認バナー付き） |
| `#/prototype/density/shell/light` `/dark` | P2 シェル 1366×768 枠・長ラベル |
| `#/prototype/density/error/light` `/dark` | P2 長いエラー文（FFmpeg不足） |
| `#/prototype/score` | P3 楽譜操作 |
| `#/prototype/review` | P4 要確認 5 件 |
| `#/prototype/export/normal` `/done` | P5 通常の書き出し／完了 |
| `#/prototype/export/musescore` | P5 MuseScore 未検出 |
| `#/prototype/export/permission/error` | P5 保存先の権限エラー |
| `#/prototype/export/worker` | P5 採譜エンジン停止 |
| `#/prototype/export/source` | P5 元音源なし |

各ページ上部の「プロトタイプ制御」破線ストリップは開発用の状態切替であり、
製品 UI ではない（スクリーンショット上の判別用）。

## キーボード（P3 / P4）

| キー | 動作 |
|---|---|
| Space / Shift+Space | 再生・一時停止 / 停止 |
| J / L | 5 秒戻る / 進む |
| Home / End | 先頭 / 末尾 |
| Ctrl+L | ループ |
| Ctrl+1 / Ctrl+2 | コンサートピッチ / F管ホルン |
| ← / → | 音符の移動（P3）、要確認の前後移動（P4） |
| Alt+↑ / Alt+↓ | 半音上下（P3・P4 共通） |
| Delete / Backspace | 削除（P4） |
| Ctrl+Z | 元に戻す |
| Esc | 選択解除（P3）、要確認を終了（P4）、ダイアログを閉じる（P5） |
| R / O | 元音源を再生 / 問題なし（P4） |

## 150% スケーリング確認手順

P2 ページにも記載：

1. Windows の設定 → システム → ディスプレイ → 拡大縮小を 150% にする
   （またはブラウザズームを 150% にする）
2. 1366×768 枠内でコマンドバー・トランスポート・プロパティの主要操作が
   切れないことを確認する
3. ライト / ダーク両方で確認する

## 検証で見つかった点（本実装への引き継ぎ）

- **FluentProvider のラッパー div が高さを持たない**ため、直下の
  `height: 100%` は内容高に潰れる。プロトタイプでは `100vh` で回避したが、
  本実装ではプロバイダ直下のレイアウトルートに明示的な高さが要る
  （現行 `App.tsx` の `.hs-shell` も同じ影響を受ける可能性がある）。
- 1366×768 でコマンドバーは `開く / 採譜し直す / 要確認（12）/ 書き出し /
  設定 / その他` まで収まる。これ以上のラベル増加は overflow 行き。
- 要確認 5 件はキーボードのみで完走できる（→・R・O・Alt+↑↓・Ctrl+Z・Esc）。
- 追従の一時停止は「追従中の自動スクロール」と「手動スクロール」の区別が
  必要。本実装では scroll イベントの発火契機をもっと厳密に分離する
  （プロトタイプでは measure 変化時のみ自動スクロールする方式で回避）。

## スクリーンショット

`docs/ui-009/*.png`（Playwright + Edge、1366×768。P2 だけ枠全体を写すため
1420×1180）。全状態を撮影済み。
