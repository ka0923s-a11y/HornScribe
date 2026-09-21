# HornScribe Design System

> Status: Authoritative visual/component specification  
> UI language: 日本語のみ  
> Foundation: Fluent UI React v9 + HornScribe semantic tokens

---

# 1. Visual direction

目標:

> 静か、精密、高密度、長時間使える。

避ける:

- glassmorphism乱用
- ネオン
- 大きなgradient
- 過剰なshadow
- cardだらけのdashboard
- 角丸だらけ
- mobile app風
- AI sparkle表現

---

# 2. Token layers

~~~text
primitive
→ semantic
→ component
~~~

Componentはprimitive colorを直接参照しない。

---

# 3. Color semantics

Fluent themeを基礎にし、HornScribe独自semantic tokenを定義する。

必須:

~~~text
--hs-surface-app
--hs-surface-score
--hs-surface-panel
--hs-surface-elevated

--hs-text-primary
--hs-text-secondary
--hs-text-muted
--hs-text-disabled

--hs-border-subtle
--hs-border-strong

--hs-accent
--hs-accent-hover
--hs-accent-pressed

--hs-focus

--hs-status-info
--hs-status-warning
--hs-status-error
--hs-status-success

--hs-waveform
--hs-waveform-played
--hs-waveform-selection
--hs-playhead

--hs-score-selection
--hs-score-active-note
--hs-score-current-measure
--hs-review-marker
~~~

AccentはWindows/Fluentとの整合性を優先し、固定brand colorへ過度に依存しない。

---

# 4. Contrast

最低:

- standard text 4.5:1
- large text 3:1
- non-text interactive boundary 3:1

HornScribe独自方針:

standard textは可能なら5:1以上。

Review状態は色だけに依存しない。

---

# 5. Typography

Primary:

~~~css
font-family:
  "Segoe UI Variable",
  "Segoe UI",
  "Yu Gothic UI",
  "Meiryo",
  sans-serif;
~~~

| Token | px | 用途 |
|---|---:|---|
| caption | 12 | metadata |
| compact | 13 | toolbar dense labels |
| body | 14 | default |
| body-emphasis | 14 | strong |
| subtitle | 16 | section |
| title | 20 | dialog/page title |
| display | 24 | empty-state only |

時間/BPMはtabular numerals。

---

# 6. Spacing

4px grid。

~~~text
2   micro
4   xs
8   sm
12  ms
16  md
20  ml
24  lg
32  xl
48  2xl
~~~

workspace padding:

12–16px。

---

# 7. Geometry

Radius:

- input/button 6px
- popover/panel 8px
- modal 10–12px
- score paper 2–4px

角丸を装飾目的で使わない。

---

# 8. Elevation

Persistent workspaceはほぼflat。

Shadow:

- menu
- popover
- floating sheet
- drag preview

Panel separationはborder / surface contrastを優先。

---

# 9. Controls

Button variants:

- primary
- secondary
- subtle
- danger

Primary buttonは1surfaceあたり原則1つ。

IconButton:

- tooltip必須
- accessible name必須
- selected stateがある場合は明示

---

# 10. Command bar

高さ40–44px程度をprototype。

左:

project actions

中央:

コンサートピッチ/F管ホルン selector

右:

要確認 / 書き出し / overflow

scrollさせない。

狭い時はsecondary commandをoverflow。

---

# 11. Segmented control

Concert/F管は文字表示。

アイコンのみ禁止。

~~~text
[ コンサートピッチ | F管ホルン ]
~~~

selected stateは:

- fill
- text weight
- border

の複数cue。

---

# 12. Transport

再生を最も視認性高くする。

アイコン:

- primary transport 20px
- secondary 16–18px

timecodeはtabular。

---

# 13. Score surface

Dark themeで2案prototype。

A:

dark chrome + light score paper

B:

dark chrome + dark score

default第一候補:

A。

理由:

通常の楽譜可読性を維持しやすい。

---

# 14. Waveform

波形は装飾ではない。

表示優先:

- current position
- selected region
- loop
- markers

不要:

- colorful gradient
- decorative frequency color

Spectrogramはadvanced/review only。

---

# 15. Review marker

低確信 = 赤、は禁止。

推奨:

- dotted underline
- review glyph
- subtle warning tint

error redはシステムerrorに予約。

---

# 16. Focus

Focus ring:

- 2px相当以上
- adjacent backgroundとの差3:1目標
- shadowのみで表現しない
- dark/light/high contrastで検証

custom note selectionとkeyboard focusは区別。

---

# 17. Disabled

opacityだけに頼らない。

- color change
- cursor
- accessible disabled state

理由が有用な場合はtooltip。

例:

~~~text
MuseScoreが見つからないためPDFを書き出せません
~~~

---

# 18. Motion

Tokens:

~~~text
motion-fast      100ms
motion-normal    180ms
motion-panel     220ms
motion-dialog    240ms
~~~

Reduced motion:

- panel instant/near-instant
- crossfade削減
- unnecessary spatial travelを削減

---

# 19. Empty states

巨大illustrationを置かない。

icon/small visual + clear CTA。

文字量4–5行以内。

---

# 20. Error surfaces

Error icon + title + body + recovery action。

stack trace不可。

Danger buttonは破壊操作のみ。

---

# 21. Component inventory

## Foundation

- AppShell
- TitleBar
- CommandBar
- StatusBar

## Transport

- TransportBar
- TimeDisplay
- RateControl
- LoopToggle
- FollowToggle

## Audio

- WaveformView
- TimeSelection
- TimelineRuler
- Minimap

## Score

- ScoreViewport
- ScoreToolbar
- ScoreSelection
- PlaybackCursor
- ViewSelector

## Review

- ReviewBar
- ReviewMarker
- ReviewReason
- ReviewNavigator

## Inspector

- PropertiesPanel
- PropertyRow
- NoteProperties
- RangeProperties

## Jobs

- JobProgress
- StageList
- CancelAction

## Export

- ExportSheet
- ExportFormatRow
- DependencyWarning

## Settings

- SettingsPage
- SettingsSection
- ToolStatus

---

# 22. Component state matrix

全interactive componentで定義:

- default
- hover
- pressed
- focused
- selected
- disabled
- loading
- error

Visual regression対象。

---

# 23. Japanese layout

日本語UIを基準寸法にする。

禁止:

- 英語短文基準の固定width
- ellipsisで重要actionを隠す
- tooltipだけで本来必要なlabelを補う

「コンサートピッチ」「エクスプローラーで表示」等を実寸検証。

---

# 24. Iconography

Fluent System Iconsを第一候補。

- filled/regularを無秩序に混在させない
- semantic meaningを固定
- remove/delete/errorを混同しない

icon-only:

tooltip + accessible name。

---

# 25. Design token governance

PR rule:

- raw hex禁止（documented exception除く）
- arbitrary spacing禁止
- component local tokenを増やしすぎない
- semantic token変更はvisual regression必須

---

# 26. Prototype acceptance

Design systemを完成と呼ぶ前に、

- empty
- loaded
- processing
- score
- review
- export
- settings
- error

をlight/darkでrenderする。

1366x768と150% scalingを最低確認。
