"""Raw backend events -> monophonic canonical-note evidence (ENG-002).

The product contract is a single horn line (monophonic, design section
27): one sounding pitch at a time. Basic Pitch emits overlapping
polyphonic hypotheses — octave ghosts, vibrato splits, attack
duplicates — so this stage repairs them *before* quantization:

* events are sorted by onset; when a note's offset runs past the next
  onset it is clipped to that onset (the monophonic rule; the quantizer
  also reports ``overlap_clipped_count`` on what remains);
* same-pitch notes separated by a tiny gap are merged (sustained notes
  re-detected after breath/bow noise);
* an isolated note exactly an octave off *both* neighbours' pitch class
  is snapped to the neighbour octave (Basic Pitch octave flicker — the
  classic horn-line artifact; only applied when both neighbours agree
  on pitch class, so real octave leaps are untouched);
* detections shorter than ``min_event_sec`` are dropped (attack
  artifacts) — dropped count is reported in the job meta;
* ``range`` params clip the accepted window: notes overlapping the
  selection are trimmed to it, notes fully outside are dropped.

Pitch is rounded to the nearest semitone here — canonical notes are
integer MIDI (pitch spelling is a downstream concern, flagged via
``pitch_spelling_ambiguous`` review issues, not guessed silently).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from hornscribe.domain.events import RawNoteEvent

# Cleaning thresholds (seconds). Deliberately conservative: merging
# under 30 ms only stitches obvious re-detections; dropping under 40 ms
# removes attack noise the backend already let through its own 70 ms
# minimum (frame-level flicker can still produce short survivors).
MIN_EVENT_SEC = 0.04
MERGE_GAP_SEC = 0.03


@dataclass(frozen=True)
class CleanedEvents:
    events: tuple[RawNoteEvent, ...]
    dropped_too_short: int
    merged: int
    clipped_overlaps: int
    octave_corrected: int = 0

    def stats(self) -> dict[str, Any]:
        return {
            "droppedTooShort": self.dropped_too_short,
            "merged": self.merged,
            "clippedOverlaps": self.clipped_overlaps,
            "octaveCorrected": self.octave_corrected,
            "eventCount": len(self.events),
        }


def clip_to_range(
    events: tuple[RawNoteEvent, ...],
    start_sec: float | None,
    end_sec: float | None,
) -> tuple[RawNoteEvent, ...]:
    """Clip events to ``[start_sec, end_sec]`` (selection transcription).

    ``None`` bounds mean "no bound". Events fully outside are dropped;
    events straddling a bound are trimmed to it.
    """
    if start_sec is None and end_sec is None:
        return events
    lo = start_sec if start_sec is not None else float("-inf")
    hi = end_sec if end_sec is not None else float("inf")
    out: list[RawNoteEvent] = []
    for ev in events:
        onset = max(ev.onset_sec, lo)
        offset = min(ev.offset_sec, hi)
        if offset <= onset:
            continue
        out.append(
            RawNoteEvent(
                id=ev.id,
                transcription_revision=ev.transcription_revision,
                pitch_midi=ev.pitch_midi,
                onset_sec=onset,
                offset_sec=offset,
                confidence=ev.confidence,
                velocity=ev.velocity,
                source=ev.source,
            )
        )
    return tuple(out)


def clean_monophonic(
    events: tuple[RawNoteEvent, ...],
    *,
    min_event_sec: float = MIN_EVENT_SEC,
    merge_gap_sec: float = MERGE_GAP_SEC,
) -> CleanedEvents:
    """Enforce the monophonic contract on raw backend output.

    Returns cleaned events plus counters for the job meta. Event ids are
    preserved (merged notes keep the earlier event's id and union the
    source ids implicitly through ``source_event_ids`` downstream — the
    quantizer maps each surviving event to one canonical note).
    """
    ordered = sorted(events, key=lambda e: (e.onset_sec, e.offset_sec))
    kept: list[RawNoteEvent] = []
    dropped = 0
    merged = 0
    for ev in ordered:
        if ev.offset_sec - ev.onset_sec < min_event_sec:
            dropped += 1
            continue
        if kept:
            prev = kept[-1]
            same_pitch = int(round(prev.pitch_midi)) == int(round(ev.pitch_midi))
            if same_pitch and ev.onset_sec - prev.offset_sec < merge_gap_sec:
                kept[-1] = _extend(prev, ev.offset_sec, ev.confidence)
                merged += 1
                continue
        kept.append(ev)

    clipped = 0
    for i in range(len(kept) - 1):
        nxt = kept[i + 1]
        cur = kept[i]
        if cur.offset_sec > nxt.onset_sec:
            kept[i] = _replace_offset(cur, nxt.onset_sec)
            clipped += 1
    # A clip can leave a zero-length note; drop it honestly.
    final = [e for e in kept if e.offset_sec - e.onset_sec >= min_event_sec]
    dropped += len(kept) - len(final)

    # Octave-flicker repair: a note exactly +/-12 semitones off a pitch
    # class shared by BOTH neighbours is almost always the model
    # flickering octaves mid-line, not a real leap. Snap it to the
    # matching neighbour octave. Conservative on purpose — requires
    # neighbour agreement and exact octave distance.
    octave_fixed = 0
    for i in range(1, len(final) - 1):
        prev_pc = int(round(final[i - 1].pitch_midi)) % 12
        next_pc = int(round(final[i + 1].pitch_midi)) % 12
        if prev_pc != next_pc:
            continue
        pitch = int(round(final[i].pitch_midi))
        if pitch % 12 != prev_pc:
            continue
        prev_pitch = int(round(final[i - 1].pitch_midi))
        next_pitch = int(round(final[i + 1].pitch_midi))
        if abs(pitch - prev_pitch) == 12 or abs(pitch - next_pitch) == 12:
            target = prev_pitch if abs(pitch - prev_pitch) == 12 else next_pitch
            final[i] = _replace_pitch(final[i], float(target))
            octave_fixed += 1

    return CleanedEvents(
        events=tuple(final),
        dropped_too_short=dropped,
        merged=merged,
        clipped_overlaps=clipped,
        octave_corrected=octave_fixed,
    )


def _extend(ev: RawNoteEvent, offset_sec: float, confidence: float | None) -> RawNoteEvent:
    confidences = [c for c in (ev.confidence, confidence) if c is not None]
    return RawNoteEvent(
        id=ev.id,
        transcription_revision=ev.transcription_revision,
        pitch_midi=ev.pitch_midi,
        onset_sec=ev.onset_sec,
        offset_sec=max(ev.offset_sec, offset_sec),
        confidence=max(confidences) if confidences else None,
        velocity=ev.velocity,
        source=ev.source,
    )


def _replace_offset(ev: RawNoteEvent, offset_sec: float) -> RawNoteEvent:
    return RawNoteEvent(
        id=ev.id,
        transcription_revision=ev.transcription_revision,
        pitch_midi=ev.pitch_midi,
        onset_sec=ev.onset_sec,
        offset_sec=offset_sec,
        confidence=ev.confidence,
        velocity=ev.velocity,
        source=ev.source,
    )


def _replace_pitch(ev: RawNoteEvent, pitch_midi: float) -> RawNoteEvent:
    return RawNoteEvent(
        id=ev.id,
        transcription_revision=ev.transcription_revision,
        pitch_midi=pitch_midi,
        onset_sec=ev.onset_sec,
        offset_sec=ev.offset_sec,
        confidence=ev.confidence,
        velocity=ev.velocity,
        source=ev.source,
    )
