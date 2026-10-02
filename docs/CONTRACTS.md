# HornScribe data contracts (FND-001)

> Status: Authoritative for identity, provenance, revision, and project
> persistence semantics. Code: `python/hornscribe/domain/`,
> `python/hornscribe/project/`. JSON Schema: `protocol/schema/`.

## 1. Identity model

| Concept                  | ID format            | Scope / derivation                          |
|--------------------------|----------------------|---------------------------------------------|
| RawNoteEvent             | `rne-<6 digits>`     | sequential within a transcription revision  |
| Canonical score note     | `sn-<6 digits>`      | sequential within a score revision          |
| Score revision           | `rev-<sha256[:16]>`  | content hash of the canonical payload       |
| Transcription revision   | `tr-<sha256[:16]>`   | hash of backend + version + settings + audio hash |
| Project                  | `prj-<sha256[:16]>`  | derived once at project creation            |
| MusicXML `note/@id`      | `hs-sn-<6 digits>`   | pure function of the canonical note ID      |
| MusicXML tied fragment   | `hs-sn-<6 digits>-<k>` | fragment k>1 of one canonical note split by engraving (barline/complex duration) |
| MusicXML rest `note/@id` | `hs-rest-<6 digits>` | presentation-only, no canonical identity    |

Rules:

- **Concert and Horn in F are the same canonical notes.** Both presentations
  reference the same `sn-*` IDs. Horn is a projection, never a second note set.
- **Presentation IDs are not domain IDs.** Verovio element IDs, SVG node IDs,
  and UI selection state are derived and rebuildable.
- **Re-quantization creates a new score revision.** `rev-*` is a hash of the
  canonical payload (tempo map, meter, key, pickup, parts, quantization
  settings), so identical content always reproduces the identical revision ID
  and any change produces a new one.
- **Provenance is preserved.** `QuantizedNote.source_event_ids` links each
  canonical note back to the `rne-*` raw events that produced it.
- `musicxml_note_id()` / `canonical_note_id_from_musicxml()` are exact
  inverses: rendered MusicXML hit-testing always recovers domain identity.
  A canonical note split into tied `<note>` fragments during engraving
  emits `hs-sn-XXXXXX` then `hs-sn-XXXXXX-2`, `-3`, … — document-unique
  `xs:ID` values that all resolve to the same `sn-XXXXXX`.

## 2. Project file (schemaVersion 1)

Authoritative state lives in `<name>.hornscribe.json`:

```text
schemaVersion          required int, currently 1
projectId              prj-*
sourceAudio            originalPath + contentHash (sha256 of file bytes)
transcription          backend, backendVersion, settings, revision, rawResultRef
score                  revision, scoreRef, quantizationSettings
userEdits[]            id, scoreRevision, kind, targetNoteIds[], payload
reviewDecisions[]      issueId, scoreRevision, status(accepted|dismissed|fixed), note
uiSession              optional, NON-authoritative
```

- `schemaVersion` is required; missing/non-integer/unsupported versions fail
  closed with `SchemaVersionError` — never silently parsed.
- Migration entry point: `hornscribe.project.migrate.migrate_project_dict`.
  v1→v1 is the identity migration; the registry grows as versions do.
- JSON Schema for external tooling: `protocol/schema/project-v1.schema.json`.
- Python is the reference implementation: `hornscribe.project.model`.

## 3. Authoritative vs derived

| Authoritative (project file + referenced raw JSON) | Derived / rebuildable (cache)            |
|----------------------------------------------------|------------------------------------------|
| source audio reference + content hash              | normalized WAV                            |
| transcription record (backend/settings/revision)   | raw transcription JSON (`rawResultRef`)   |
| canonical score revision + quantization settings   | rendered MusicXML/MIDI/PDF, Verovio SVG   |
| user edits, review decisions                       | search indexes, thumbnails, UI session    |

Cache layout (rebuildable, gitignored):

```text
cache/<audio-hash>/source.json, normalized.wav, transcription.json,
score.json, concert.musicxml, horn_in_f.musicxml, b_flat.musicxml
```

## 4. Persistence rules

- **Atomic writes**: serialize → fsync tmp file → `os.replace` (same volume).
- **One recovery snapshot**: previous good file kept as `*.recovery`; a
  corrupt main file falls back to it on load.
- **Source audio is referenced, never modified.** Relink resolves by
  *content hash*, not path; mismatched candidates are rejected.
- **Cache is never authoritative** — deleting `cache/` must lose nothing
  that cannot be recomputed.

### Autosave / crash recovery (#221, #337, #408)

- **When**: while the score has unsaved changes, a 3 s-debounced write
  persists a snapshot; one write in flight, edits that arrive mid-write
  are picked up by the next tick. Tauri runtime only.
- **What**: the full schema-v1 project document — same validator as a
  manual save, so a malformed snapshot can never reach disk. The
  save-target path travels inside the document as `autosaveProjectPath`
  (a validator-ignored extra key), so content and provenance cannot
  diverge; a present-but-null value means "never saved". Legacy autosaves
  keep the path in `autosave.hornscribe.meta.json`, which `status` only
  consults when the embedded key is absent.
- **Where**: `appDataDir/autosave.hornscribe.json`, written tmp+rename —
  one slot for the whole app (single-document UI: the latest dirty
  session owns it).
- **Restore**: only through the launch prompt — presence of the slot
  arms the 復元 dialog, never a silent load. A restore opens the
  snapshot as an unsaved copy and re-points saves at
  `autosaveProjectPath`. Clean transitions (manual save, undo-to-
  baseline, decline, successful open) clear the slot.
- **Recording-only sessions need no autosave**: a finished take is
  already a persisted WAV under `recordings/`; an in-progress take is
  guarded by the 録音中 close confirmation instead.

## 5. What this does NOT cover (yet)

- Undo/redo stack semantics (M6)
- Portable project bundles with embedded audio
- Review issue *generation* (see master plan §10 for the ReviewIssue shape;
  `reviewDecisions` here persist the user's answers)
