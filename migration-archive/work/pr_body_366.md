## 概要

Appのtransport実装は「media transportに音源が無ければscore clockを使う」fallbackを持っていますが、
command registryの再生系enable条件が全て `hasAudio` で、SOURCE_MISSING/project score-only状態では
fallbackコードが存在するのに Play/Stop/Seek/Loop がdisabledで到達不能でした。

## 変更点

- `canPlay = hasAudio || hasScore` を追加し、playPause/stop/jumpBack/jumpForward/seekStart/seekEnd/toggleLoop
  の `isEnabled` を `hasAudio` → `canPlay` へ（score clock fallbackが存在する7コマンド）。
- `toggleSourceMute` は `hasAudio` のまま（元音源なしでは意味を持たない）。
- `TransportBar`：rate/followボタンはaudio-onlyのままにするため、
  `playPause`ではなく `toggleSourceMute` のenabledを参照するよう変更（score-onlyで誤有効化しない）。

## 検証

- `registry.test.ts`：score-only snapshotで7コマンドがenabled、toggleSourceMuteはdisabled。
- `tsc` / `eslint` / `vitest`：クリーン。

Closes #366
