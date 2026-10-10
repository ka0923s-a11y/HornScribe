## 症状
dev で App を開いただけでコンソールが Maximum update depth exceeded で毎秒数百件溢れ、WaveformView の view state が {0,0} に張り付いて選択・ズーム・再生ヘッドが全て壊れる。

## 原因（調査済み・修正ブランチあり）
1. App.tsx が onSelectionChange をインラインクロージャで渡していたため毎レンダー新しい関数 identity
2. ExportDialog の persist 用 useEffect が deps [selected, onSelectionChange] で発火
3. updateSettings はマージで毎回新しい settings オブジェクトを返す → 再レンダー → 新しいコールバック → effect 再発火 → 無限ループ（各反復で localStorage 書き込みも連打）

## 修正内容（codex/note-overlay ブランチで実装済み）
- ExportDialog: 最新コールバックを ref 経由で呼び、effect は selected の実変更時のみ発火（マウント時の echo は seed が既に settings 値なので省略）
- App.tsx: onExportSelectionChange を useCallback 化
- 回帰テスト追加: 不安定なコールバック prop を持つ Harness が render-loop しないことを検証（ExportDialog.test.tsx）

## 再現手順（修正前）
vite dev でアプリを開き Chrome コンソールを見る。数秒で Maximum update depth exceeded が連発。

## 影響範囲
ExportDialog は open=false でも常時マウントされているため、アプリ起動直後からストームが発生し全 UI の応答性を破壊していた。
