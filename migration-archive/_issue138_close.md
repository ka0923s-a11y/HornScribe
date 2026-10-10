PR #139 で修正・マージ済み。

実機検証(検証ハーネス = 本番コード同一の WASAPI 呼出し):

- セッション列挙: 3件(修正前0件 — S_FALSE を除外扱いしていたのを
  S_OK 明示比較に修正)
- 有効化: ActivateCompleted → IAudioClient 取得成功、0xC0000374 解消
  (blob ペイロードを CoTaskMem 化 + async op を完了まで生存)
- キャプチャ: 1秒で47,520非無音フレーム @48kHz を取得
- GetMixFormat E_NOTIMPL は Initialize フォーマット交渉で回避
- cargo check / tsc / eslint / vitest 890 全緑
