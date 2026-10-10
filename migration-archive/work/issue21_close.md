録音まわりの未消化件を棚卸しした結果、列挙された項目はすべて出荷済みでした。該当実装:

| 項目 | 状態 | 実装箇所 |
| --- | --- | --- |
| 録音の一時停止/再開 | 済(#80) | `CaptureController.pause/resume` + CommandBar の Pause/Play ボタン + `ja.capture.pausedLabel/pausedAnnounce/resumedAnnounce` |
| 録音中クローズガード | 済(#301/#450) | `workspace/closeGuard.ts` + App.tsx の閉じる要求確認ダイアログ(録音中のみガード) |
| マイク権限拒否の専用誘導 | 済(#79) | `CaptureIssue.permissionDenied` → `issueText` で「Windowsの設定 → プライバシーとセキュリティ → マイク」まで明示 |
| 録音中ライブレベル表示 | 済(#71) | `CaptureStatus.level` → `hs-waveform__level-fill`(WaveformView) |
| デバイス選択+永続化 | 済(#73) | ループバック/マイク別のデバイスメニュー + `DEVICE_PREF_KEY` 保存 |
| 録音中デバイス切断 | 済(#79) | `CaptureIssue.interrupted` + 専用アナウンス |
| 録音の保持/管理 | 済(#70/#87) | recordings フォルダ管理・保持日数ポリシー・一括削除 |

棚卸しで見つかった残件は個別issueへ切り出しました:

- #42: 録音開始前の入力モニター(マイクレベルの事前確認)

本issueは棚卸し完了としてクローズします。

