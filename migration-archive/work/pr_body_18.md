## 概要

#18 — 採譜キュー(複数ジョブの逐次実行)を追加する。

これまで採譜ジョブは1つずつ手動実行のみで、複数ファイルや複数区間を連続で回すには終了を待って手で再実行する必要があった。キューにエントリを積み、ワーカーが順次消化し、結果をエントリごとに取り込めるようにする。

## 仕様

- **エントリ = 1採譜ジョブ**。音源 ref・job params(enqueue 時点のオプションで確定)・ラベルを持ち、「どの音源の結果か」が常に明確。
- **追加経路は2つ**: 取り込みメニュー「キューに音源を追加…」(複数選択ピッカー、pickAudioMulti 新設)と、audioReady 画面の「キューに追加」(現在の音源+現在のオプション。選択範囲込みなので範囲を変えて連打すれば複数区間の逐次採譜になる)。
- **逐次実行**: 既存 TranscriptionSession をそのままドライブ(ワーカーは従来通り maxConcurrentJobs: 1 — キューは上流で直列化するだけ)。完了したら session.clearJob して次へ。
- **結果はエントリに保持**。完了行の「開く」で現在ドキュメントとして取り込む(別の音源が載っている場合は先にエントリの音源を載せ替えて identity を整合 — #234 契約)。録音由来の ref は永続パスを path ref に読み替えて再取り込みする。
- **失敗は行に記録して続行**(ジョブ単位の失敗は consume 後に session.clearFailure)。エンジン死亡(crash/unresponsive)は残り全部を止め、failure を残してラン終了後に §20 エラー画面へ繋ぐ。
- **UI**: 「採譜キュー…」ダイアログ(取り込みメニュー/コマンドから)。行ごとに ↑↓ 並び替え・キャンセル・削除(pending)、実行中はキャンセル+進捗バー、完了は開く、フッターに追加/開始・停止/終了分クリア。実行中に閉じてもランは継続(transcribing 画面が進捗を表示)。
- **App 側の協調**: キュー実行中(queueSnap.running)は App の job ライフサイクル・failure→error画面 effect をゲートし、終端相はキューが消費する。ゲートは React state なので runner 側フラグとの競合が起きない。

## 変更

- `src/queue/`: TranscriptionQueue コントローラ(ランループ・progress ミラー・終端捕捉・clearFailure 処理)と types。
- `src/components/QueuePanel.tsx`: キュー管理ダイアログ。
- `src/import/ports.ts` + `runtimePorts.ts`: `pickAudioMulti` 追加(Tauri multiple:true / ブラウザ input.multiple)。
- `src/commands/`: `media.openQueue` / `media.enqueueAudio` コマンド。
- `src/App.tsx`: キューインスタンス・両 effect のゲート・完了結果適用を applyCompletedResult に抽出してキュー 開く と共用・エントリ追加/結果オープン導線。importPorts を useMemo でホイストしてキューと共有。
- `src/components/CommandBar.tsx` / `ImportStates.tsx` / `ja.ts` / `styles.css`: メニュー項目・audioReady ボタン・文言・スタイル。

## テスト

- `queue/controller.test.ts` 新規10件(逐次実行と結果捕捉・progress ミラー・失敗記録と続行・engine-dead 停止・個別/全体キャンセル・並び替え・clearFinished・外部ジョブ中の拒否)。
- vitest 全797件・tsc・eslint クリーン。

Closes #18
