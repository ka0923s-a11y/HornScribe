# HornScribe UX Validation Plan

> Status: Required quality-gate specification  
> Applies to all GUI milestones  
> Canonical UI language: 日本語

---

# 1. 目的

見た目の完成度と、実際の使いやすさを分けて評価する。

HornScribeでは次を計測する。

- 操作完了
- 操作時間
- 無駄なクリック
- 誤操作
- 迷い
- keyboard-only成立
- focus問題
- score/audio同期
- rendering/performance
- 日本語copy clarity

---

# 2. Core usability tasks

毎回同じfixtureで評価する。

## Task A — 音源を開いて採譜開始

Success:

説明書なしで完了。

記録:

- 完了時間
- clicks
- hesitation

## Task B — 指定時刻を3回聞く

目的:

loop UX評価。

目標:

5秒以内にloop開始できること。

## Task C — 誤音を選び元音源確認

目的:

score → source audio。

目標:

2操作程度で確認できる。

## Task D — 半音修正してUndo

目的:

direct correction + recoverability。

## Task E — コンサートピッチ → F管ホルン

Success:

- 再生位置保持
- 選択保持
- loop保持
- navigation context保持

## Task F — 要確認を処理

keyboard-onlyで:

- 次へ
- source playback
- 問題なし
- 次へ

が成立。

## Task G — F管MusicXML/PDF書き出し

## Task H — MuseScoreなしでMusicXML書き出し

PDF failureが他formatを邪魔しない。

---

# 3. Dogfooding log

個人用アプリなので、大規模user studyは必須にしない。

代わりにtaskごとに記録:

~~~text
date
commit
task
success
duration
clicks
keystrokes
hesitations
error
copy confusion
visual issue
fix candidate
~~~

同じfrictionが2回以上出たらIssue化。

---

# 4. UX metrics

主要:

- time-to-transcribe
- time-to-loop
- time-to-source-check
- review items/min
- correction actions/item
- export completion rate

補助:

- clicks/task
- keyboard commands/task
- modal count
- accidental navigation loss
- focus loss incidents

---

# 5. Performance UX

測定:

- cold shell interactive
- waveform ready
- score render
- Concert/F switch
- note selection
- seek latency
- playback highlight latency
- pan/zoom FPS
- memory

「滑らかに感じる」だけで合格にしない。

---

# 6. Accessibility gate

必須:

- all actions keyboard accessible
- visible focus
- semantic role/name/state
- color-only禁止
- standard text contrast >=4.5:1
- non-text interactive >=3:1
- contrast theme smoke
- 200% scaling
- Narrator smoke

Focus appearance:

2px perimeter相当を設計基準にする。

---

# 7. Keyboard-only scenario

Mouseなし:

~~~text
音源を開く
→ 採譜
→ 再生
→ 次の要確認
→ 元音源を再生
→ 問題なし
→ F管ホルンへ切替
→ 書き出し
~~~

が成立すること。

---

# 8. Narrator smoke

最低確認:

- app title
- command bar
- waveform region
- score region
- selected note properties
- review reason
- transport
- export options
- error action

SVG上の全音符を直接screen reader navigationさせる必要はない。

選択した音符の意味はプロパティで取得可能にする。

---

# 9. Scaling matrix

Mandatory:

- 1366x768 @100%
- 1920x1080 @100%
- 1920x1080 @150%
- 3840x2160 @150%
- 200% scaling smoke

確認:

- clipped Japanese text
- toolbar overlap
- inaccessible command
- dialog overflow
- score minimum width
- properties drawer
- waveform height

---

# 10. Visual regression

Canonical:

日本語UI。

Fixtures:

- 空状態
- 音源読込
- 採譜中
- 採譜完了
- F管表示
- 音符選択
- 要確認
- 書き出し
- MuseScore不足
- worker crash
- 設定
- dark
- light
- focus-visible

---

# 11. Interaction regression

Automate where possible:

- command enabled/disabled
- shortcut dispatch
- dialog focus restore
- Concert/F switch preserves selection
- review next/previous
- loop start/end
- follow suspend/resume
- undo/redo
- export option dependency state

---

# 12. Copy QA

UI PRごと:

- 英語仮文言なし
- 用語集準拠
- 句読点統一
- actionable error
- technical jargon漏れなし
- accessible name日本語
- tooltip日本語

---

# 13. Error-recovery QA

必須scenario:

- invalid audio
- unsupported codec
- FFmpeg missing
- Python worker crash
- transcription failure
- cancel
- MuseScore missing
- export permission denied
- source audio moved
- corrupt project
- incompatible schema
- Verovio render failure

各scenario:

- user data preserved
- recovery path visible
- no raw stack trace
- no dead-end modal

---

# 14. Long-session QA

30分以上の連続作業で確認:

- unnecessary motion fatigue
- panel clutter
- focus confusion
- accidental follow-scroll
- high brightness score paper in dark mode
- repeated review speed
- waveform visual fatigue

dark chrome + light paperが疲れる場合、score surface toneを調整。

---

# 15. Design review checklist

## Hierarchy

- primary action明確
- scoreが主役
- advanced controls隠れている

## Consistency

- spacing token
- typography token
- icon family
- Japanese terminology

## State

- loading
- disabled
- error
- empty
- selected
- focused

## Input

- mouse
- keyboard
- trackpad

## Accessibility

- focus
- name
- role
- contrast
- color independence

## Performance

- unnecessary rerenderなし
- waveform/score profiled where relevant

---

# 16. Acceptance gate by phase

## Architecture spike

- technical feasibilityのみ
- styling polish不要
- measured evidence必須

## Design foundation

- tokens
- component states
- focus strategy
- Japanese copy foundation

## Vertical slice

- primary flow complete
- Japanese copy complete
- error recovery path complete

## Review UX

- keyboard review task complete
- uncertainty understandable
- correction reversible

## Polished MVP

- all core usability tasks pass
- accessibility smoke
- visual regression
- performance budget
- error recovery
- session restore
