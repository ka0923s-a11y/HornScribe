## 背景

#100(PR #135)で対象アプリ単位のループバック録音を実装したが、実機検証
(本番コードをそのまま移した WASAPI 検証ハーネスで実セッションに対して実行)
で4つの実働不具合を確認した。いずれも PR 時点では未検出で、出荷状態では
「対象アプリを選ぶと壊れる」。

## 問題(実機で再現確認済み)

1. **アプリ一覧が常に空** — IAudioSessionControl2::IsSystemSoundsSession の
   戻りを .is_ok() で判定していたため S_FALSE(通常セッション)も真扱いになり、
   全セッションが除外されて対象アプリメニューが空のまま。
2. **プロセスループバック有効化でヒープ破壊(0xC0000374)** —
   ActivateAudioInterfaceAsync に渡す VT_BLOB の pBlobData がスタック上の
   params を指しており、有効化の teardown が blob の中身を解放しに来て
   プロセスごと落ちる(完了ハンドラ成功→teardown で死亡)。また返された
   async op がペンディング中に drop される生存期間の問題もある。
3. **GetMixFormat が E_NOTIMPL(0x80004001)** — プロセスループバックの
   仮想デバイスでは GetMixFormat が未実装。クライアントがフォーマットを
   指定して Initialize する必要がある(実機で HRESULT 確認)。
4. **モニター中に対象アプリを変えても古いストリームを聴き続ける** —
   レベルモニターが対象変更を拾わない。

## 修正方針

- IsSystemSoundsSession は S_OK(HRESULT==0) と明示比較
- blob ペイロードを CoTaskMemAlloc に配置(infra の解放が合法になる)、
  async op は完了コールバックまで生存
- プロセスループバックは GetMixFormat を呼ばず、48kHz float32 stereo →
  16bit PCM の候補で Initialize を試してフォーマットを自分で決める
- selectTargetApp で loopback モニター中なら張り直す

## 検証

同一コードの検証ハーネスで実機確認: セッション列挙3件・有効化・
完了・1秒キャプチャで47,520非無音フレーム取得、クラッシュ解消。
