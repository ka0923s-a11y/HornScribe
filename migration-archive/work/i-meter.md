GUI_UX_SPEC §14 の undo 対象リストに「拍子」があるが未実装。

現状: score.edit は setDuration / shiftOnset / toggleTie / setTempo（#124/#126 で実装済み）。拍子は採譜時の推定値（または設定の固定値）がそのまま使われ、採譜後に変更する手段がない。

## 実装メモ

- 拍子変更は全小節の再タイル（re-tile）が必要 — SpanRealizer の meter_map を差し替えて全パートを再実現する。setDuration 系の部分再実現とは規模が違うので、専用の edit kind（例: setMeter { beatsPerMeasure, beatUnit }）として実装するのが素直
- 弱起（pickup_beats）との整合: 拍子を変えると弱起の長さの意味も変わる。弱起を拍単位で保持するか、小節単位で保持するか決めが必要
- UI 案: プロパティパネルのスコアサマリ「拍子」行をテンポ同様に編集可能にする（プリセット選択 + 稀な拍子は自由入力）
- meter_conflict のレビューイシューから「この拍子に修正」アクションへ繋げると親切

