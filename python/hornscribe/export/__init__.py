"""Deterministic export artifacts (ENG-001; master plan §4.3/§11).

Canonical export set (cache artifacts use bare names; user-facing exports
use a ``<basename>_`` prefix)::

    concert.musicxml      / <basename>_concert.musicxml
    horn_in_f.musicxml    / <basename>_horn_in_f.musicxml
    b_flat.musicxml       / <basename>_b_flat.musicxml
    playback.mid          / <basename>_playback.mid

``horn_in_f.mid`` is intentionally absent: Standard MIDI files carry no
transposing-instrument semantics, so the MVP default MIDI is sounding
pitch only (``playback.mid``).
"""

from __future__ import annotations

from pathlib import Path

from hornscribe.domain.score import ScoreDocument
from hornscribe.export.midi import playback_midi_bytes
from hornscribe.export.musicxml import (
    export_b_flat_musicxml,
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)


def export_filename(kind: str, basename: str | None = None) -> str:
    """Filename policy for export artifacts (dev plan Phase 5).

    ``kind`` is one of ``"concert"``, ``"horn_in_f"``, ``"b_flat"``,
    ``"playback"``.
    With ``basename`` the user-facing ``<basename>_<artifact>`` form is
    used; without it the canonical cache-artifact name is returned.
    """
    names = {
        "concert": "concert.musicxml",
        "horn_in_f": "horn_in_f.musicxml",
        "b_flat": "b_flat.musicxml",
        "playback": "playback.mid",
    }
    if kind not in names:
        raise ValueError(f"unknown export kind: {kind!r}")
    if basename:
        stem, _, ext = names[kind].rpartition(".")
        return f"{basename}_{stem}.{ext}"
    return names[kind]


def export_score_bundle(
    score: ScoreDocument,
    directory: Path,
    basename: str | None = None,
) -> dict[str, Path]:
    """Write the canonical export set (concert/horn/Bb MusicXML + playback.mid).

    Returns a mapping of artifact kind -> written path.
    """
    directory.mkdir(parents=True, exist_ok=True)
    paths = {
        "concert": directory / export_filename("concert", basename),
        "horn_in_f": directory / export_filename("horn_in_f", basename),
        "b_flat": directory / export_filename("b_flat", basename),
        "playback": directory / export_filename("playback", basename),
    }
    paths["concert"].write_text(
        export_concert_musicxml(score), encoding="utf-8", newline="\n"
    )
    paths["horn_in_f"].write_text(
        export_horn_in_f_musicxml(score), encoding="utf-8", newline="\n"
    )
    paths["b_flat"].write_text(
        export_b_flat_musicxml(score), encoding="utf-8", newline="\n"
    )
    paths["playback"].write_bytes(playback_midi_bytes(score))
    return paths
