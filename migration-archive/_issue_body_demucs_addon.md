## 概要

#165 の候補1「demucs 本格分離の同梱経路」: demucs+torch は ~2GB 級で既定バンドルには重すぎるが、**任意ダウンロードのアドオン zip** として GitHub Releases で配布すれば無料・オフライン・オプトインを維持できる。

## 前提（既に実装済み）

- `_demucs_cmd` の解決は PATH / `HORNSCRIBE_DEMUCS` / bundled `tools/` を既に探す → **`tools/` への配置だけで動く**（コード変更不要な経路がある）
- PyInstaller onedir 化（#186）により、同じ仕組みで `tools/demucs/` の frozen アドオンが作れる

## 提案

1. `scripts/build_demucs_addon.py`（新規）: demucs を frozen onedir 化（`demucs -n htdemucs/htdemucs_ft --two-stems=vocals` を叩ける exe）
2. リリースに `HornScribe-demucs-addon-<ver>.zip` を同梱（任意ダウンロード）
3. アプリ内導線: vocalIsolation ヒントまたは診断シートから「分離エンジンを追加」案内 → zip を `tools/` に展開する手順書
4. モデルウェイトは demucs 初回実行時の公式 DL（既存挙動）か、モデル同梱を検討

## 効果

- #165 の残誤差の支配因子である分離品質に対し、ユーザー環境で実際に効く唯一の無料レバーを提供
- 既定バンドルは軽いまま、必要な人だけが分離強化を得られる
