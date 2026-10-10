## 段階2 実装メモ (2026-09-29 調査)

capture.rs は `windows` crate 直叩きの WASAPI COM 実装(`enum_devices`/`eRender` で render エンドポイント列挙済み)。プロセス単位キャプチャはこの延長でいける:

- **活性化**: `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 2004+)。`AUDIOCLIENT_ACTIVATION_PARAMS` に対象 PID を渡す。従来の `IMMDevice::Activate` 経路と分岐する形で `CaptureSource::ProcessLoopback { pid }` を追加
- **列挙**: `IAudioSessionManager2::GetSessionEnumerator` でオーディオセッション保持プロセスを列挙 → PID→プロセス名/表示名マッピング(`QueryFullProcessImageName`)。ブラウザはタブ別にセッションが割れるのでセッション単位で列挙・選択させる
- **IPC/UI**: `media.listAudioSessions`(仮) でセッション一覧 → 取り込みメニューの「PCの音」を2段化(全体ミックス / 対象アプリ選択)。対象終了時の挙動(セッション消滅)は `AUDCLNT_E_*` エラーを既存の capture issue パイプラインに流す
- **フォールバック**: OS が 2004 未満 or 活性化失敗時は全体ミックスに戻す + 注意コピー維持

**ブロッカー**: このワークスペースの Rust toolchain には MSVC linker (link.exe) が無く `cargo check`/`cargo build` が不可(VS Build Tools 未インストール)。COM 非同期活性化は実機検証必須の領域なので、ビルド検証できる環境(リリースホスト or VS Build Tools 導入後)での着手が安全。段階1の注意喚起は #111 で済。
