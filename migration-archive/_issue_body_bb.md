## 概要

現在の移調表示は コンサートピッチ / F管ホルン の2択。B♭ 管楽器（トランペット・クラリネット・テナーサックス等、written = sounding + 長二度）ユーザーのために B♭ 表記を追加する。

## スコープ（既存アーキテクチャのミラー）

- python/hornscribe/instruments/b_flat.py（新規）: concert→written +2 半音、written→sounding diatonic -1 / chromatic -2、調号 +2 fifths。horn_f.py と同型
- export: b_flat.musicxml 系エクスポート（horn_in_f.musicxml に相当）+ MusicXML transpose 要素
- score.edit の B♭ MusicXML 生成（musicXmlHornF と並列）
- フロント: PitchView に B♭ を追加、セグメントコントロール 3 択化、エクスポートダイアログ・プロジェクトモデル・strings

## 完了条件

- B♭ ビューで表示・試聴・MusicXML 書き出しが F 管と同等に動く
- 往復（round-trip）テスト: written pitch + transpose メタデータから concert を回復できる
