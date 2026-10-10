## 概要

ボーカル分離（vocalIsolation）で使う demucs のモデルを選択可能にし、既定の `htdemucs` に加えて fine-tune 版 `htdemucs_ft` + shift 平均を「高精度」ティアとして提供する。#165 の結論（残り誤差は分離品質依存）への直接的な精度レバー。完全無料の範囲内（demucs 同梱モデルのみ・追加コストなし）。

## 背景

現行 `isolate_demucs_vocals` は `<demucs> --two-stems=vocals` をモデル未指定で実行するため常に既定モデル(`htdemucs`)が使われる。demucs は `htdemucs_ft`（fine-tuned、ボーカル SDR がさらに良い・約4倍の計算時間）と `--shifts`（シフト平均による精度向上、線形コスト）を提供する。実ボーカル素材（一般 JPOP）では分離品質が採譜精度の支配因子と確立済み。

## 実装

- エンジン: `vocalIsolationQuality: "standard" | "precision"` ジョブパラメータを追加（options.py ホワイトリスト）
- `standard` → `-n htdemucs`（現行と同等・既定値ピン留め）、`precision` → `-n htdemucs_ft --shifts 2`
- 分離キャッシュキーと method_version/provenance にバリアントを含める（別モデルの stem を混同しない・tr-* 同一性が実際の前処理を反映する）
- フロント: 採譜オプションに「分離品質」選択を追加（ボーカル分離 ON 時のみ有効）。標準=速い / 高精度=低速だがボーカル分離が上質

## 注意

- パッケージ版は demucs 非同梱のため、効果は engine-vocal extra / tools/demucs / PATH 経由の環境に限る（将来の同梱にも効く設計）
- shifts=2 は分離時間を約2倍にする。precision は意図的なオプトイン
