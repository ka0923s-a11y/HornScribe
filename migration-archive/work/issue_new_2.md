## 背景
#221/#81 の終了ガードは `beforeunload` の preventDefault に依存しているが、Tauri 2 ではウィンドウの閉じるボタンで `beforeunload` が発火しないケースがある。確実なのは `getCurrentWindow().onCloseRequested` + `preventDefault()` で、HsDialog による3択（保存して閉じる/保存せず閉じる/キャンセル）も実現できる。

## 提案
- Tauri 環境では `onCloseRequested` で dirty/録音中を検査し、未保存なら閉じるを止めて確認ダイアログを出す
- `beforeunload` はブラウザ dev のフォールバックとして残す

## 受け入れ条件
- パッケージ版で未保存のまま閉じようとすると確認が出る
- 「保存して閉じる」は保存成功時のみ終了する
