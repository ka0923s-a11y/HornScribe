## 概要
#402 の波形ノートオーバーレイ実装と、実機検証で発見した3つの重大UIバグ修正をまとめたブランチ。

## 機能追加: 波形ノートオーバーレイ (#402 / closes #20)
- canonical notes を波形ピーク上にピアノロール風レーンで描画
- 拍軸 → 音響秒の変換は試聴と同じ tempo map + swing warp を経由（`swingWarp.buildBeatToMs` を公開）
- パート毎の色分け、クリックスルー（選択/シーク操作を邪魔しない）、音符アイコンのトグルで表示切替
- ズーム・パンに追従（view window と同一の座標系）

## バグ修正（実機検証で発見）
- **#22 render storm**: ExportDialog の persist effect が不安定なインラインコールバック prop を deps に持ち、update→render→update の無限ループ（起動直後から UI 全体が死ぬ）。latest-ref + 変更時のみ発火に修正し、App 側も useCallback 化。
- **#25 view stuck {0,0}**: WaveformView が「前回の audio」を useRef で追跡 → render 中の ref ミューテーションが破棄された concurrent render で毒化し、view が {0,0} に恒久的に張り付く。useState の prev-value パターンに変更。
- **#26 tooltip portal**: `.hs-provider{height:100%}` が Fluent ポータルノードにも適用され、ツールチップ表示中に全画面の透明オーバーレイがクリックを横取り。`#root > .hs-provider` にスコープ。

## 検証（実機）
- 5秒スケール WAV を実エンジンで採譜 → 8/8 ノートが波形上に描画、トグル off→on・ズーム追従を puppeteer で確認
- elementFromPoint でポータル被覆の解消を確認
- vitest 全752件パス（新規+回帰）、tsc/eslint クリーン

Closes #20, closes #22, closes #25, closes #26.
