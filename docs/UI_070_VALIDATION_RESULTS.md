# UI-070 品質ゲート検証結果

Issue #30 に基づく、`docs/UX_VALIDATION.md` の主観的品質目標を反復可能な
リリースゲートに変換した結果の記録。すべてのゲートはリポジトリにコミット済み
で、`apps/desktop` 配下で再実行可能。

## ゲート一覧と実行方法

| ゲート | 実行コマンド | 成果物 |
| --- | --- | --- |
| アクセシビリティ/品質テスト | `npx vitest run src/quality` | Vitest 出力 |
| ビジュアルマトリクス取得 | `npm run ui070:matrix` | `apps/desktop/measurements/ui-070/matrix/` (ignored), `docs/ui-070/*.png` + `matrix-manifest.json` |
| ビジュアル回帰チェック | `npm run ui070:matrix:check` | ゴールデンとのピクセル差分照合(canvas 比較、しきい値あり — Chromium のラスタライズは実行間でビット一致しないため) |
| ドッグフード/ユーザビリティ | `npm run ui070:dogfood` | `apps/desktop/measurements/ui-070/dogfood-*.json` |
| パフォーマンス計測 | `npm run ui070:measure` | `apps/desktop/measurements/ui-070/perf-*.json` |

ブラウザ自動化は `puppeteer-core` + ローカルの Chrome/Edge
(`scripts/ui070/lib.mjs` が `CHROME_PATH`/`EDGE_PATH` 環境変数または既知の
インストール先から実行ファイルを検出) を使用。

## 項目別ステータス

ステータス定義: `VERIFIED` = 自動ゲートが成果物付きでグリーン、
`PARTIAL` = 部分的に自動化/要手動補完、`MANUAL-ONLY` = 手順のみ。

| UX_VALIDATION 項目 | ステータス | ゲート/成果物 |
| --- | --- | --- |
| 全操作キーボードアクセス可能 | VERIFIED | `src/quality/keyboardOnly.test.tsx`(jsdom) + ドッグフード §7(実ブラウザで 0 クリック完走) |
| F6 ゾーン巡回 | VERIFIED | `keyboardOnly.test.tsx` が 6 ゾーン(commandbar/waveform/score/properties/transport/status)の存在と巡回を検証 |
| 可視フォーカス(focus-visible、約2px リング) | VERIFIED | `staticStyles.test.ts` が `:focus-visible` リング規則と outline 剥奪の有無を静的検証。`focus-visible-{light,dark}.png` ゴールデンで視覚確認 |
| 日本語のアクセシブルネーム / aria-label 完備 | VERIFIED | `a11y.test.tsx` + `a11y-core.mjs` が全インタラクティブ要素の name と日本語ラベルをスキャン(各画面状態で実行) |
| セマンティック role/name/state | VERIFIED | `a11y-core.mjs` のブラウザ注入監査 + jsdom テスト。マトリクス実行中に Chromium 上で違反 0 件 |
| 色だけに依存しない表現(色オンリー禁止) | VERIFIED | `colorIndependence.test.tsx`: レビューバッジがテキスト+アイコン/形状であること、エラー/警告が色以外の手掛かりを持つことを検証 |
| テキストコントラスト >= 4.5:1 | VERIFIED | `contrast.test.ts`/`contrast.ts` が `theme/tokens.css` のトークン組を WCAG 計算で検証。新規ゲートが実際のトークン不備を検出し修正済み(ライト警告テキスト 4.14→>=4.5 等) |
| 非テキスト(操作対象)>= 3:1 | VERIFIED | 同上。スコア選択・プレイヘッド・レビューマーカーの合成コントラストを検証し修正 |
| テーマ(ライト/ダーク)コントラストスモーク | VERIFIED | `contrast.test.ts` が両テーマのトークンペアを網羅 |
| 画面の主要状態ビジュアルマトリクス | VERIFIED | 28 ゴールデン(14 状態×2 テーマ)+ 10 viewport/DPI 設定で 100 キャプチャ。`docs/ui-070/matrix-manifest.json` に SHA-256 記録し、`--check` はピクセル差分(閾値超過ピクル数 >100 で失敗)で照合 |
| 200% スケーリング | PARTIAL | 自動: `1920x1080@200` キャプチャでレイアウト崩壊なし。手動: 下記「200% スケーリング手順」で実機確認が必要 |
| Narrator スモーク | MANUAL-ONLY | 下記「Narrator スモーク手順」。スコア SVG は `aria-hidden` で、選択音符の意味はプロパティパネル経由で読み上げ可能 |
| エラー回復(非行き止まり) | VERIFIED | `errorRecovery.test.tsx`: 音源エラー/音源移動/採譜エラー/MuseScore不足/権限エラー各画面に再試行・再リンク・設定・別選択等の回復アクションがあることを検証 |
| コピー品質(日本語統一、プレースホルダなし) | VERIFIED | `copy.test.ts` が `strings/ja.ts` と UI 文字列の英語残留・TODO/FIXME/lorem をスキャン(技術用語・ショートカット表記は許可リスト) |

### ユーザビリティ 8 タスク(ドッグフード)

`npm run ui070:dogfood` が実ブラウザ上で計測。
成功/所要時間/クリック数/キーストローク数を `dogfood-*.json` に記録。
直近の結果(全タスク success=true):

| タスク | 時間 | 操作 | 結果 |
| --- | --- | --- | --- |
| A 音源を開いて採譜 | ~3.6s | 1 click | 成功(ファイル選択レグは手動前提のため PARTIAL 扱い) |
| B ループ作成 | ~0.4s | 2 keys | 成功。目標「5 秒以内」達成 |
| C 音符の元音源確認 | ~0.6s | 2 clicks + 1 key | 成功 |
| D 音符修正 + 取り消し | ~0.8s | 1 click + 2 keys | 成功。Ctrl+Z で復元確認 |
| E Concert→F管切替 | ~0.7s | 1 click + 1 key | 成功。選択音符の canonical id が再描画後も維持 |
| F 要確認項目処理(3 件) | ~1.9s | 3 keys/件 | 成功。キーボードのみ |
| G F管 MusicXML/PDF 書き出し | ~1.5s | 1 click + 1 key | 成功 |
| H MuseScore なしで書き出し | ~1.6s | 1 click + 1 key | 成功。PDF ブロック + 設定への回復導線を確認 |
| §7 キーボードのみ主要フロー | ~6.2s | 19 keys, 0 clicks | 成功。audioReady→採譜→再生→要確認→元音源→問題なし→F管→書き出し |

人間による主観評価(迷い/コピー混乱/見た目の不満/修正候補)は
自動化不可能なため手動セッションで補完する。スクリプト出力の
`durationMs`/`keystrokes` が異常に大きい項目は迷いの代理指標として使える。

### パフォーマンス計測(直近実測)

`npm run ui070:measure` の出力(開発ビルド + Verovio WASM のため絶対値は参考値):

| 指標 | 実測 |
| --- | --- |
| コールドシェル interactive | 258 ms 壁時間(DOMContentLoaded 105 ms) |
| スコアレンダー | 壁 6966 ms / renderToSVG 2079 ms、SVG 109,395 bytes、46 要素 |
| ビュー切替 | 118 ms |
| 音符選択 | 2 ms |
| シークレイテンシ | 8 ms |
| 再生ハイライト | 16 更新、初回マーク 603 ms、再生中ヒープ 131 MB |
| 再生中の全 SVG 再描画 | `renderToSVGCallsDuringPlayback = 0`(DOM クラストグルのみ) |
| バンドル | 合計 9,075,167 bytes / gzip 2,650,153。main JS 794,380、Verovio chunk 8,197,317(gzip 2,402,114)。>500KB 警告は Verovio 由来で既知 |

## 手動手順

### Narrator スモーク

1. 本番 Tauri シェルまたは `npm run dev` でアプリを起動し、Narrator を起動
   (Win+Ctrl+Enter)。
2. F6/Tab でゾーンを巡回し、各コマンドバー・波形・スコア領域・プロパティ・
   トランスポート・ステータスで日本語名が読み上げられることを確認。
3. 音符を選択し、プロパティパネルに音名/拍/状態が読み上げ可能な形で
   表示されることを確認(スコア SVG 自体は `aria-hidden` で仕様どおり)。
4. 要確認モードに入り、バッジが「テキスト+形状」で読み上げられること、
   元音源再生/問題なしがキーボード操作可能なことを確認。
5. エラー画面(音源移動、MuseScore不足)でエラー内容と回復アクションが
   読み上げられることを確認。

### 200% スケーリング手順

1. Windows 設定 → ディスプレイ → スケールを 200% に設定(または
   DevTools の deviceScaleFactor=2)。
2. `empty` → `audio-ready` → `score-ready` → `reviewing` → 書き出し
   ダイアログ → 設定を順に表示し、以下を確認:
   - レイアウトの崩壊・横スクロール・クリップなし
   - フォーカスリングが視認できる
   - コマンドバー/パネルの主要操作が画面内に収まる
3. 自動ゲート側: `1920x1080@200` のキャプチャは
   `apps/desktop/measurements/ui-070/matrix/` に保存済み。

## 再実行時の注意

- `apps/desktop/measurements/` は gitignore 対象。ゴールデンは
  `docs/ui-070/` にコミット済み。`ui070:matrix:check` はピクセル差分で照合
  (SHA-256 はマニフェストに記録するが、実行間のコンポジタノイズを許容する
  ため差分ピクセル数で判定)。アニメーション/キャレットはキャプチャ時に
  凍結し、経過時間表示は `Date.now` を固定して決定的にしている。
- `node scripts/ui070/pngdiff.mjs <a.png> <b.png>` でゴールデン差分の
  原因箇所(差分ピクセル数とバウンディングボックス)を調査できる。
- 意図的な UI 変更時は `ui070:matrix` でゴールデンを再生成してコミットする。
- Verovio WASM によりビルド時に >500KB チャンク警告が出るが既知の仕様。
- `npx vitest run src/quality` は jsdom/Fluent 由来の
  `HTMLMediaElement.pause()` / Keyborg dispose の警告を出すが失敗ではない。
