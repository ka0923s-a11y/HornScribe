## 概要

`.hs-empty__title` で修正したのと同じ問題が、`--hs-font-size-title`(20px)を使う他の見出しにも残っている。body 継承の line-height は `--hs-line-height-body`(20px)のため、20pxフォントに20px行ボックス=比率1.0となり、日本語グリフ(濁点・送り仮名の下端)が上下に削れうる。

デザイントークン定義上、title の対になる行高は `--hs-line-height-title`(28px)。

## 該当箇所 (font-size: title かつ line-height 未指定)

| セレクタ | 場面 |
|---|---|
| `.hs-score__empty-title` (L862) | スコア画面の空状態 |
| `.hs-settings__title` (L2147) | 設定画面タイトル |
| `.hs-transcribing__title` (L2189) | 採譜中画面の見出し |
| `.hs-error-surface__title` (L2274) | エラー画面タイトル |

subtitle(16px)の箇所は body 継承 20px で比率1.25となるため対象外。`.hs-error__title` は compact フォールバック込みで問題なし。

## 対応

各セレクタに `line-height: var(--hs-line-height-title);` を付ける(既存の `.hs-empty__title` 修正と同じパターン)。必要なら将来の回帰防止として「font-size トークンと line-height トークンはペアで指定する」旨を `docs/DESIGN_SYSTEM.md` に一行追記する。
