# HornScribe UI Copy Contract (UI-006)

> Status: Authoritative conventions for user-facing UI copy
> Copy deck: [`protocol/copy/ja-JP.json`](../protocol/copy/ja-JP.json)
> Copy standard (tone, terminology, patterns): [JAPANESE_UI_COPY.md](JAPANESE_UI_COPY.md)
> Related: [MASTER_PLAN.md](MASTER_PLAN.md) §8, [GUI_UX_SPEC.md](GUI_UX_SPEC.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)

---

# 1. Purpose and rule

HornScribe's user-facing UI is **Japanese only**. This document defines how the
canonical copy deck is keyed and consumed so that the desktop app (UI-001 spike
onward) never grows ad-hoc or English placeholder copy.

Hard rules:

- **No language switcher.** There is no `language`/`locale` setting, no en-US
  deck, no runtime locale negotiation. `meta.locale` in the deck is a fixed
  declaration (`"ja-JP"`), not an option.
- **No English fallback copy.** Every user-visible string resolves from
  `protocol/copy/ja-JP.json`. A missing key is a bug; the UI must fail visibly
  in development (e.g. render `!!key.path!!` in dev builds, never silently emit
  English).
- **No translation framework required.** A flat lookup (`key → string`) plus
  `{placeholder}` interpolation is sufficient. Do not add i18n libraries to
  satisfy this contract.
- **JAPANESE_UI_COPY.md wins.** Terminology, style, error-message structure,
  and progress-stage wording follow that document. The deck implements it; it
  does not replace it.

---

# 2. Deck location and format

Canonical file: `protocol/copy/ja-JP.json` (UTF-8, no BOM, 2-space indent).

Top-level groups are UI surfaces:

| Group | Covers |
|---|---|
| `meta` | Deck version, declared locale, governing documents (not user-visible) |
| `app`, `common` | App name, shared buttons (キャンセル, 再試行, 閉じる…) |
| `menus`, `commandBar` | Menu labels/items, persistent commands |
| `segments` | コンサートピッチ / F管ホルン segmented control |
| `tooltips` | Mandatory tooltips for icon-only controls |
| `transport`, `waveform`, `score` | Playback bar, waveform, score workspace |
| `transcription` | 採譜中 progress, stage labels, options popover |
| `review` | 要確認 banner, actions, and per-reason strings |
| `properties` | プロパティ panel fields and note actions |
| `exportSheet` | 書き出し options, destination, MuseScore states |
| `settings`, `diagnostics` | 設定 categories/fields, 診断情報 |
| `dialogs` | Confirmation dialogs (dangerous operations only) |
| `errors` | Error surfaces (title / body / actions) |
| `emptyStates`, `loading` | Empty and loading states |
| `firstRun`, `dependencies` | First-run guidance, dependency-missing guidance |
| `notifications` | Toasts and transient status messages |
| `a11y` | Accessible names/descriptions for component primitives |

## 2.1 Key naming

- Structural keys use **camelCase** (`emptyStates.launch.headline`), matching
  the camelCase convention of `protocol/schema/project-v1.schema.json`.
- **Domain enum keys keep their internal snake_case form** so IPC payloads map
  directly onto the deck:
  - `transcription.stages.<stage>` keys are engine stage IDs
    (`preparing_audio`, `transcribing`, `cleaning`, `analyzing_rhythm`,
    `quantizing`, `building_score`, `rendering`).
  - `review.reasons.<reason>` keys are ReviewIssue `reason` values
    (`low_model_confidence`, `quantization_ambiguous`, …; see MASTER_PLAN §10
    and JAPANESE_UI_COPY §14).
- Lookup paths are dot-separated: `review.reasons.quantization_ambiguous.title`.

## 2.2 Value shapes

- **Plain string** for labels, tooltips, single-line copy.
- **Object** when a surface needs coordinated parts:
  - `{"title", "body", "actions": {...}}` — errors and dialogs
  - `{"title", "detail"}` — review reasons
  - `{"pending", "active", "done"}` — progress stages
  - `{"label", "tooltip", "aria"}` — commands/controls
- **Placeholders** use `{snake_case}` and are filled at render time
  (e.g. `"{count}か所を確認すると、より確かな楽譜になります"`). Rendering
  substitutes parameters first, then displays — never show a raw `{name}`.
- Punctuation follows the copy standard: no 。on short labels/buttons;
  full sentences in body/description text end with 。

---

# 3. Allowed non-Japanese tokens

Proper nouns, standards, file formats, key names, and machine identifiers stay
in standard notation. The test suite enforces this whitelist; anything else
ASCII-alphabetic inside a copy string fails CI.

- Product/tools: `HornScribe`, `FFmpeg`, `MuseScore`, `Basic Pitch`,
  `Verovio`, `wavesurfer`, `Python`
- Standards/formats: `MusicXML`, `MIDI`, `PDF`, `WAV`, `MP3`, `FLAC`, `M4A`,
  `OGG`, `BPM`
- Key names: `Ctrl`, `Shift`, `Alt`, `Space`, `Esc`, `Home`, `End`, `Tab`,
  `Enter`, `Backspace`, `Delete`, and single letter keys (`J`, `K`, `L`, `F`…)
- `PC` (as in 「このPC上で」), file names, paths, version numbers
- `{placeholder}` names are substituted before display and are exempt

Rule: a proper noun may appear only **wrapped in Japanese explanatory copy**
(e.g. 「PDFを書き出すにはMuseScoreが必要です。」), never as a bare English label
or sentence. Internal jargon (`raw`, `cleaned`, `backend`, `worker`, `HSQ`,
`candidate lattice`, …) is banned from normal UI; it may appear only inside
診断情報. The test also rejects the banned variants エクスポート /
トランスクリプション / レビュー / セッティング / 譜面 and the label `OK`.

---

# 4. Consuming the deck (future app)

- Load `ja-JP.json` once at startup; resolve `group.path.leaf` lookups.
- Command registry (`GUI_UX_SPEC` §23) sets `labelJa` from the deck — commands
  never carry hard-coded strings.
- Icon-only buttons must take both `aria` (from `a11y.*`) and `tooltip` (from
  `tooltips.*` or the control's own `tooltip` field).
- Progress: use `transcription.stages.<id>.{pending,active,done}`. When real
  progress is unknown, show the stage label indeterminate — **never fabricate
  percentages** (copy standard §5).
- Errors: render `errors.<id>` as title → body → actions, in that order
  (copy standard §7). Raw tracebacks and exception text never reach the UI.
- Review: map `ReviewIssue.reason` to `review.reasons.<reason>.title` /
  `.detail`. Unknown future reasons fall back to `review.reasons.other`.
- Adding or renaming keys: update the deck, this contract if the shape
  changes, and `tests/python/test_copy_deck.py` if groups change. Deck edits
  are copy changes — review them against JAPANESE_UI_COPY.md.

---

# 5. Fixtures for the component gallery

`fixtures/ui/*.json` are renderable sample states for the future dev-preview /
component gallery (UI-010) and golden screenshots. Format per file:

```json
{
  "id": "score_ready.with_review",
  "screenState": "SCORE_READY",
  "scenario": "採譜完了直後。要確認が12件。",
  "elements": [
    {
      "id": "reviewBanner",
      "component": "ReviewBanner",
      "copyKey": "review.banner",
      "params": {"count": 12},
      "text": "12か所を確認すると、より確かな楽譜になります"
    }
  ],
  "sampleData": {"projectTitle": "サンプル曲"}
}
```

- `screenState` — one of the spec §27 states (`EMPTY`, `AUDIO_READY`,
  `TRANSCRIBING`, `SCORE_READY`, `REVIEWING`, `EXPORTING`) plus `ERROR`,
  `LOADING`, `FIRST_RUN`, `SETTINGS` for surfaces outside the happy-path
  machine.
- `elements[].copyKey` — dot path into the deck. **Every copy string in a
  fixture resolves through `copyKey`; ad-hoc copy in fixtures is a bug.** The
  test suite re-renders `copyKey` + `params` and asserts it equals `text`.
- `sampleData` — non-copy content (file names, times, counts) a gallery needs
  to render the state. Exempt from the proper-noun language check, but keep it
  realistic for Japanese layout testing (include long file names etc.).

Current fixtures cover: empty launch, audio ready, transcribing (mid-stage),
score ready with review banner, reviewing, export with MuseScore missing,
errors (FFmpeg / MuseScore / worker crash / engine unresponsive / source moved
/ audio open failure / export permission), loading, first run, and tool
statuses in settings. Extend alongside new surfaces; visual-regression
variants (dark/light, DPI) are rendering concerns, not new copy fixtures.

---

# 6. Verification notes (deferred to the app)

These acceptance items require the real desktop shell and are **documented
here as gates**, not verifiable from the copy deck alone. Track them on the
UI-001+ milestones:

- **Scaling**: render long strings (「コンサートピッチ」「エクスプローラーで表示」,
  long error bodies) at Windows 100% / 150% / 200% — no clipping, no
  fixed-width ellipsis on important actions (DESIGN_SYSTEM §23).
- **Fonts**: verify `Yu Gothic UI` primary and `Meiryo` fallback render; the
  family stack in DESIGN_SYSTEM §5 already orders them.
- **IME**: editable fields (project name, tempo/BPM overrides, MuseScore path)
  must accept Japanese IME composition without breaking focus or committed
  text. J/K/L shortcuts stay disabled during composition and text input.
- **Golden screenshots**: canonical UI language is Japanese; fixtures above
  are the states to capture.
- **Copy QA per UI PR** (UX_VALIDATION §12): no English placeholder, glossary
  conformance, Japanese accessible names and tooltips, no text clipping.

The automated check for everything that can be checked without the app is
`tests/python/test_copy_deck.py` (`pytest tests/python -q`).
