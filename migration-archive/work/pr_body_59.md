## 概要

採譜キューのエントリに、登録済みオプションの要約行を表示する (#59)。

## 問題

params は enqueue 時点で焼き付く設計だが、行にはファイル名と状態しか
出ず、「A曲は melody、B曲は voices」という混在ランを組んでも見分けが
つかなかった。

## 変更内容

- **`queue/paramSummary.ts`** (新規): `TranscriptionJobParams` を短い
  断片の列に分解して `・` で結合する。`buildTranscriptionParams` が
  既定値を emit しない設計を活かし、params に存在するキーだけを
  正直に列挙する — 全既定なら空文字(行は出ない)。並び順は
  範囲→テクスチャ→最大声部数→エンジン→ボーカル分離→テンポ→拍子→
  調→最小音価→三連符→簡潔さ で固定。
- **`QueuePanel.tsx`**: 行の name/status の隣に要約 span を追加。
- **`ja.queue`**: 断片用の短い語彙を追加(単旋律/メロディ優先/複数声部/
  和音、三連符あり・なし、簡潔/詳細、調 X、最大 n 声部、n BPM、
  ボーカル分離、選択範囲 s–e)。長い audioOptions ラベルは要約行では
  読みにくいので、queue 名前空間で短形を保持。
- **`styles.css`**: `.hs-queue__params` — caption サイズ・ミュート色、
  省略は ellipsis。

## 動作確認

- vitest +4: 全既定=空文字(identity キーは無視)、範囲タイムコード、
  全フィールドの安定順序、未知 enum の raw fallback を検証。
- tsc / eslint / copy テスト クリーン。

Closes #59
