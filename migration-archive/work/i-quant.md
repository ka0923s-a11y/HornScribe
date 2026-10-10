GUI_UX_SPEC §14 の undo 対象リストに「quantization settings」があるが未実装。

現状: 採譜オプション（最小音符・三連符・拍子・テンポモード）はインポート時にのみ指定でき、採譜済みスコアに対して「最小音符を16分→8分に変えて再クオンタイズ」するような操作は存在しない。

## 実装メモ

- エンジン側は量子化設定が payload.quantization_settings に残っているので、「設定差分 + 再量子化」は quantize_events の再実行で実現できる見込み（raw events が scoreDocument に含まれるか要確認 — 含まれないなら canonical notes からの再量子化になる）
- 再量子化は全ノートを書き換える大規模編集なので、undo は docSwap（スナップショット退避）で十分。rhythmQueue の直列化に乗せられる
- UI 案: プロパティパネル or コマンドバー溢れメニューに「採譜設定を変えて再適用」ダイアログ

