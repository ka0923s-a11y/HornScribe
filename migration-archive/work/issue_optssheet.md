## 背景
採譜オプション(テンポ/拍子/調/音価/texture/backend/範囲 等 11項目)は audioReady 画面のポップオーバーにしか存在しない。スコア表示後に結果を改善したいとき、変更できるのはレビューのクイック再採譜(texture・vocalIsolation・backend の3種)だけで、調・拍子・最小音価・三連符・範囲などを変えて再実行する動線がない。

## やること
- オプションフィールド群を `TranscriptionOptionsFields` として抽出し、audioReady ポップオーバーと再利用
- スコア画面から `採譜オプション…` シートを開けるようにする(コマンド `score.transcribeOptions`)
NaN

## 期待
NaN
