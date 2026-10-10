## 症状（実機検証で観測）
audio ドロップ後も WaveformView の view が {0,0} のまま固定され、波形・選択・ズーム・再生ヘッド・ノートオーバーレイ（#402）が一切描画されない。`data-view-end=0` のまま `data-audio-duration=5` が表示される矛盾状態。

## 原因（調査済み・修正ブランチあり）
「前回の audio」を `useRef` で追跡する render 中ガード:

```tsx
const audioRef = useRef(audio);
if (audioRef.current !== audio) {
  audioRef.current = audio;   // ← render 中の ref ミューテーション
  setView(restored ?? fullView(duration));
}
```

concurrent レンダーが中断・破棄されると、その pass で呼ばれた `setView` は破棄されるが **ref ミューテーションは巻き戻らない**。リトライされたレンダーでは `audioRef.current === audio` となりガードが二度と発火せず、view が `{0,0}` のまま張り付く。StrictMode + 実機の重いレンダー（採譜直後の大きな再描画）で顕在化した。

## 修正内容（codex/note-overlay ブランチで実装済み）
React 公式の "adjusting state during render" パターンに変更 — 前回値を `useState` で追跡:

```tsx
const [prevAudio, setPrevAudio] = useState(audio);
if (prevAudio !== audio) {
  setPrevAudio(audio);
  setView(restored ?? fullView(duration));
}
```

破棄されたレンダーでは `setPrevAudio` も巻き戻るため、リトライでガードが再発火して確実に `fullView(duration)` になる。

## 検証
- puppeteer 実機: ドロップ後 `data-view-end="5"` を確認（修正前は永久に 0）
- 既存 WaveformView テスト + renderloop 回帰テスト全緑

## 影響
波形・選択・ループ・ズーム・再生位置・#402 ノートオーバーレイの全機能が音源を読み込んでも動かない致命的UI不具合。
