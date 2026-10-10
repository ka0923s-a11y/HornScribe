## 背景
#100 (PR #102) で `.hornscribe.json` への保存を実装した際、楽譜復元に必要な extras (`scoreDocument`, `musicXmlConcert`, `musicXmlHornF`, `reviewIssues`, `meta`) を「将来の project-open 復元用」として同梱した。しかし `ImportController.openProject` は audio の検証と復元のみを行い、extras を一切読まない。

## 不整合
保存したプロジェクトを開くと AUDIO_READY で止まり、保存済みの楽譜は捨てられる。ユーザーは同じ音源を再度採譜し直す必要があり、保存の意味が半減する。`project.ts` のコメント自体が "the data a future project-open restore needs" と意図を明示している。

## やりたいこと
- `parseProjectFile` が extras (musicXmlConcert/musicXmlHornF/score.revision/reviewIssues) を取り出す
- 音源検証成功時にスコアを復元し SCORE_READY へ直接遷移 (engineDocumentFromResult と同じ extras 形状なので既存アダプタを再利用可能)
- SOURCE_MISSING でもスコアは復元 (音源は後でリリンク可能)
- extras のないプロジェクト (外部作成等) は従来どおり AUDIO_READY で止まる
