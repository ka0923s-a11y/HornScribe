"""Deterministic domain identity (FND-001).

ID rules
--------
* RawNoteEvent IDs are unique within one transcription revision:
  ``rne-<zero-padded ordinal>`` allocated in backend output order.
* Canonical score note IDs are unique within one score revision:
  ``sn-<zero-padded ordinal>`` allocated in score order.
* Score revision IDs are content-derived: ``rev-<sha256[:16]>`` over the
  canonical serialized payload, so identical content + settings always
  produces the identical revision ID.
* Concert and Horn in F presentations share the *same* canonical note ID;
  presentation IDs (e.g. Verovio element IDs) are never domain IDs.
* MusicXML ``note/@id`` values are deterministic export IDs derived from
  ``(score_revision, canonical_note_id)`` via :func:`musicxml_note_id`.
* When notation engraving splits one canonical note into several tied
  ``<note>`` fragments (barline splits, complex durations), fragment ``k > 1``
  carries the suffixed ID ``hs-sn-<6 digits>-k`` so every emitted ``note/@id``
  remains a document-unique ``xs:ID`` while still resolving to the same
  canonical note via :func:`canonical_note_id_from_musicxml`.
* MusicXML rest ``<note>`` elements carry presentation-only IDs
  ``hs-rest-<6 digits>``; they never map back to canonical notes.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import NewType

RawNoteEventId = NewType("RawNoteEventId", str)
ScoreNoteId = NewType("ScoreNoteId", str)
ScoreRevisionId = NewType("ScoreRevisionId", str)
TranscriptionRevisionId = NewType("TranscriptionRevisionId", str)
ProjectId = NewType("ProjectId", str)

_RAW_RE = re.compile(r"^rne-\d{6}$")
_SCORE_NOTE_RE = re.compile(r"^sn-\d{6}$")
_REVISION_RE = re.compile(r"^rev-[0-9a-f]{16}$")
_TRANSCRIPTION_RE = re.compile(r"^tr-[0-9a-f]{16}$")
_PROJECT_RE = re.compile(r"^prj-[0-9a-f]{16}$")
_MUSICXML_NOTE_RE = re.compile(r"^hs-sn-\d{6}(?:-\d+)?$")
_MUSICXML_REST_RE = re.compile(r"^hs-rest-\d{6}$")


def is_raw_note_event_id(value: str) -> bool:
    return bool(_RAW_RE.match(value))


def is_score_note_id(value: str) -> bool:
    return bool(_SCORE_NOTE_RE.match(value))


def is_score_revision_id(value: str) -> bool:
    return bool(_REVISION_RE.match(value))


def is_transcription_revision_id(value: str) -> bool:
    return bool(_TRANSCRIPTION_RE.match(value))


def is_project_id(value: str) -> bool:
    return bool(_PROJECT_RE.match(value))


def is_musicxml_note_id(value: str) -> bool:
    return bool(_MUSICXML_NOTE_RE.match(value))


def is_musicxml_rest_id(value: str) -> bool:
    return bool(_MUSICXML_REST_RE.match(value))


def _digest(payload: object) -> str:
    """Stable SHA-256 over a canonical JSON encoding of *payload*."""
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def derive_project_id(seed: object) -> ProjectId:
    """Derive a deterministic project ID from creation-time seed data."""
    return ProjectId(f"prj-{_digest(seed)[:16]}")


def derive_transcription_revision_id(payload: object) -> TranscriptionRevisionId:
    """Content-derived transcription revision ID (backend + settings + audio hash)."""
    return TranscriptionRevisionId(f"tr-{_digest(payload)[:16]}")


def derive_score_revision_id(payload: object) -> ScoreRevisionId:
    """Content-derived score revision ID.

    Re-quantization with different settings/content yields a new revision ID;
    identical input always yields the identical ID.
    """
    return ScoreRevisionId(f"rev-{_digest(payload)[:16]}")


def musicxml_note_id(note_id: ScoreNoteId, fragment: int = 1) -> str:
    """Deterministic MusicXML ``note/@id`` for a canonical score note.

    The mapping is a pure function of the canonical note ID so a rendered
    element can always be traced back to domain identity:
    ``hs-sn-000042`` -> ``sn-000042``.

    ``fragment`` is the 1-based ordinal of the emitted ``<note>`` element
    when engraving splits the canonical note into tied fragments (barline
    or complex-duration splits). Fragment 1 carries the canonical export
    ID ``hs-sn-<6 digits>``; fragments 2+ carry ``hs-sn-<6 digits>-<k>`` so
    every ``note/@id`` stays a document-unique ``xs:ID``.
    """
    if not is_score_note_id(note_id):
        raise ValueError(f"not a canonical score note id: {note_id!r}")
    if fragment < 1:
        raise ValueError(f"fragment must be >= 1, got {fragment}")
    if fragment == 1:
        return f"hs-{note_id}"
    return f"hs-{note_id}-{fragment}"


def canonical_note_id_from_musicxml(export_id: str) -> ScoreNoteId:
    """Inverse of :func:`musicxml_note_id`.

    Accepts both ``hs-sn-<6 digits>`` and the tied-fragment form
    ``hs-sn-<6 digits>-<k>``; a fragment ID resolves to the canonical note
    it was split from.
    """
    if not is_musicxml_note_id(export_id):
        raise ValueError(f"not a HornScribe MusicXML note id: {export_id!r}")
    match = re.match(r"^hs-(sn-\d{6})", export_id)
    assert match is not None  # guaranteed by is_musicxml_note_id
    return ScoreNoteId(match.group(1))


def musicxml_rest_id(ordinal: int) -> str:
    """Presentation-only ID for a rest ``<note>`` element.

    Rests have no canonical identity; the ID exists so every emitted
    ``<note>`` element carries a deterministic, document-unique ``xs:ID``
    (``hs-rest-<6 digits>``).
    """
    if ordinal < 1:
        raise ValueError(f"ordinal must be >= 1, got {ordinal}")
    return f"hs-rest-{ordinal:06d}"


# #241: layout-only rests (secondary-voice gap fillers, non-strict
# measure padding) live OUTSIDE the hs-rest-* ordinal namespace — the
# frontend resolves hs-rest-N to the N-th canonical rest atom, so a
# filler rest consuming an ordinal would shift every later rest.
_MUSICXML_LAYOUT_REST_RE = re.compile(r"^hs-layout-rest(?:-\d{6})?$")
MUSICXML_LAYOUT_REST_ID = "hs-layout-rest"


def is_musicxml_layout_rest_id(value: str) -> bool:
    """True for a layout-filler rest marker id (``hs-layout-rest[-N]``)."""
    return _MUSICXML_LAYOUT_REST_RE.match(value) is not None


def musicxml_layout_rest_id(ordinal: int) -> str:
    """Document-unique id for a layout-only rest ``<note>`` element."""
    if ordinal < 1:
        raise ValueError(f"ordinal must be >= 1, got {ordinal}")
    return f"hs-layout-rest-{ordinal:06d}"


class IdAllocator:
    """Allocates sequential deterministic IDs inside one revision scope."""

    def __init__(self, prefix: str) -> None:
        if prefix not in ("rne", "sn"):
            raise ValueError(f"unknown id prefix: {prefix!r}")
        self._prefix = prefix
        self._next = 1

    def allocate(self) -> str:
        value = f"{self._prefix}-{self._next:06d}"
        self._next += 1
        return value

    def allocate_raw_event_id(self) -> RawNoteEventId:
        if self._prefix != "rne":
            raise TypeError("allocator prefix is not 'rne'")
        return RawNoteEventId(self.allocate())

    def allocate_score_note_id(self) -> ScoreNoteId:
        if self._prefix != "sn":
            raise TypeError("allocator prefix is not 'sn'")
        return ScoreNoteId(self.allocate())
