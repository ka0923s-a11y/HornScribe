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
score.json, concert.musicxml, horn_in_f.musicxml
```

## 4. Persistence rules

- **Atomic writes**: serialize → fsync tmp file → `os.replace` (same volume).
- **One recovery snapshot**: previous good file kept as `*.recovery`; a
  corrupt main file falls back to it on load.
- **Source audio is referenced, never modified.** Relink resolves by
  *content hash*, not path; mismatched candidates are rejected.
- **Cache is never authoritative** — deleting `cache/` must lose nothing
  that cannot be recomputed.

## 5. What this does NOT cover (yet)

- Undo/redo stack semantics (M6)
- Portable project bundles with embedded audio
- Review issue *generation* (see master plan §10 for the ReviewIssue shape;
  `reviewDecisions` here persist the user's answers)
