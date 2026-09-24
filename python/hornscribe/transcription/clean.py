"""Raw backend events -> monophonic canonical-note evidence (ENG-002).

The product contract is a single horn line (monophonic, design section
27): one sounding pitch at a time. Basic Pitch emits overlapping
polyphonic hypotheses — octave ghosts, vibrato splits, attack
duplicates — so this stage repairs them *before* quantization:

* events are sorted by onset; when a note's offset runs past the next
   onset it is clipped to that onset (the monophonic rule; the quantizer
   also reports ``overlap_clipped_count`` on what remains);
* ``prefer="top"`` switches the overlap rule to melody extraction: a
  lower overlapping hypothesis is dropped outright while a higher one
  still cuts in at its own onset (melody mode for polyphonic mixes —
  JPOP vocals over accompaniment);
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
* harmonic ghosts are suppressed *before* clipping: a short,
  lower-confidence note a stable harmonic interval (octave/fifth) away
  that starts under a sustained note is almost always a Basic Pitch
  overtone artifact — clipping the sustained note to the ghost's onset
  silently deletes the tail of a real note.

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

# Harmonic-ghost suppression: a note this short starting under a
# sustained note, a stable harmonic interval away and at lower
# confidence, is an overtone artifact, not a second voice.
GHOST_MAX_SEC = 0.12
GHOST_INTERVALS = (3, 4, 7, 12, 19, 24)  # m3/M3/P5/octave/octave+P5/2oct
GHOST_MIN_LEAD_SEC = 0.02  # ghost attack must land after the real attack


@dataclass(frozen=True)
class CleanedEvents:
    events: tuple[RawNoteEvent, ...]
    dropped_too_short: int
    merged: int
    clipped_overlaps: int
    octave_corrected: int = 0
    polyphonic_overlaps: int = 0
    """Overlaps between *different* pitch classes — likely real
    polyphony (or strong octave ghosts), worth a review warning."""
    ghost_dropped: int = 0
    """Short harmonic-interval overlaps suppressed as overtone ghosts"""

    def stats(self) -> dict[str, Any]:
        return {
            "droppedTooShort": self.dropped_too_short,
            "merged": self.merged,
            "clippedOverlaps": self.clipped_overlaps,
            "octaveCorrected": self.octave_corrected,
            "polyphonicOverlaps": self.polyphonic_overlaps,
            "ghostDropped": self.ghost_dropped,
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
    prefer: str = "onset",
) -> CleanedEvents:
    """Enforce the monophonic contract on raw backend output.

    Returns cleaned events plus counters for the job meta. Event ids are
    preserved (merged notes keep the earlier event's id and union the
    source ids implicitly through ``source_event_ids`` downstream — the
    quantizer maps each surviving event to one canonical note).

    ``prefer`` picks the survivor when two pitched events overlap:
    ``"onset"`` (default) clips the earlier note at the later onset;
    ``"top"`` keeps the higher pitch instead - the melody line for
    polyphonic mixes like JPOP (a lower overlapping hypothesis is
    dropped, a higher one cuts in at its own onset).
    """
    if prefer not in ("onset", "top"):
        raise ValueError(f"prefer must be 'onset' or 'top', got {prefer!r}")
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
    polyphonic = 0
    ghosts = 0
    final_events: list[RawNoteEvent] = []
    for ev in kept:
        if final_events:
            prev = final_events[-1]
            if prev.offset_sec > ev.onset_sec:
                if _is_harmonic_ghost(prev, ev):
                    # Overtone artifact under a sustained note — drop the
                    # ghost instead of clipping the real note's tail.
                    ghosts += 1
                    continue
                if (
                    int(round(prev.pitch_midi)) % 12
                    != int(round(ev.pitch_midi)) % 12
                ):
                    polyphonic += 1
                if prefer == "top" and ev.pitch_midi < prev.pitch_midi:
                    # Melody mode: the lower overlapping hypothesis is
                    # accompaniment, not the line — drop it rather than
                    # clipping the melody's tail.
                    continue
                final_events[-1] = _replace_offset(prev, ev.onset_sec)
                clipped += 1
        final_events.append(ev)
    kept = final_events
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
        polyphonic_overlaps=polyphonic,
        ghost_dropped=ghosts,
    )


def _is_harmonic_ghost(prev: RawNoteEvent, ev: RawNoteEvent) -> bool:
    """True when *ev* is an overtone artifact riding on *prev*.

    Basic Pitch frequently emits a short, weaker note a stable harmonic
    interval (octave/fifth/third) away that starts under a sustained
    note. Under the monophonic contract clipping the sustained note at
    the ghost's onset throws away the real tail, so the ghost loses.
    Deliberately conservative: requires a short span, a later attack,
    a harmonic interval, and strictly lower confidence.
    """
    if ev.offset_sec - ev.onset_sec > GHOST_MAX_SEC:
        return False
    if ev.onset_sec - prev.onset_sec < GHOST_MIN_LEAD_SEC:
        return False
    interval = abs(int(round(ev.pitch_midi)) - int(round(prev.pitch_midi)))
    if interval not in GHOST_INTERVALS:
        return False
    if ev.confidence is None or prev.confidence is None:
        return False
    return ev.confidence < prev.confidence

@dataclass(frozen=True)
class VoiceSplit:
    """Two monophonic streams partitioned from polyphonic input (#85).

    voices[0] is the upper line (assigned first / higher pitch at a
    shared onset), voices[1] the lower line.
    """

    voices: tuple[tuple[RawNoteEvent, ...], tuple[RawNoteEvent, ...]]
    """(upper, lower) — each internally monophonic."""
    dropped_too_short: int
    merged: int
    ghost_dropped: int
    dropped_beyond_voices: int

    def stats(self) -> dict[str, Any]:
        return {
            "droppedTooShort": self.dropped_too_short,
            "merged": self.merged,
            "ghostDropped": self.ghost_dropped,
            "droppedBeyondVoices": self.dropped_beyond_voices,
            "voiceEventCounts": [len(v) for v in self.voices],
        }


def split_voices(
    events: tuple[RawNoteEvent, ...],
    *,
    min_event_sec: float = MIN_EVENT_SEC,
    merge_gap_sec: float = MERGE_GAP_SEC,
    max_voices: int = 2,
) -> VoiceSplit:
    """Partition raw events into up to max_voices monophonic lines.

    Greedy earliest-free-slot assignment: each event joins the first
    voice whose last note has already ended (onset order, higher pitch
    first at a shared onset so the upper slot tends to carry the
    melody). Same-pitch re-detections merge within their own voice;
    harmonic ghosts are suppressed against the upper voice's tail (an
    overtone artifact under a sustained note is not a second voice).
    Events that fit no free voice count as dropped_beyond_voices.
    """
    ordered = sorted(events, key=lambda e: (e.onset_sec, -e.pitch_midi))
    voices: list[list[RawNoteEvent]] = [[] for _ in range(max_voices)]
    dropped = 0
    merged = 0
    ghosts = 0
    beyond = 0
    for ev in ordered:
        if ev.offset_sec - ev.onset_sec < min_event_sec:
            dropped += 1
            continue
        # Overtone artifact riding on the sustained upper voice — drop
        # it before slotting (a free second voice must not be claimed
        # by a short, weak harmonic ghost).
        if (
            voices[0]
            and voices[0][-1].offset_sec > ev.onset_sec
            and _is_harmonic_ghost(voices[0][-1], ev)
        ):
            ghosts += 1
            continue
        placed = False
        for voice in voices:
            if voice and voice[-1].offset_sec > ev.onset_sec:
                continue
            if voice:
                prev = voice[-1]
                same_pitch = int(round(prev.pitch_midi)) == int(
                    round(ev.pitch_midi)
                )
                if same_pitch and ev.onset_sec - prev.offset_sec < merge_gap_sec:
                    voice[-1] = _extend(prev, ev.offset_sec, ev.confidence)
                    merged += 1
                    placed = True
                    break
            voice.append(ev)
            placed = True
            break
        if not placed:
            beyond += 1
    voices.sort(key=_voice_median_pitch, reverse=True)
    while len(voices) < 2:
        voices.append([])
    return VoiceSplit(
        voices=(tuple(voices[0]), tuple(voices[1])),
        dropped_too_short=dropped,
        merged=merged,
        ghost_dropped=ghosts,
        dropped_beyond_voices=beyond,
    )


def _voice_median_pitch(voice: list[RawNoteEvent]) -> float:
    """Median pitch of a voice's events (ordering key for split_voices)."""
    if not voice:
        return float("-inf")
    pitches = sorted(round(e.pitch_midi) for e in voice)
    mid = len(pitches) // 2
    if len(pitches) % 2:
        return float(pitches[mid])
    return (pitches[mid - 1] + pitches[mid]) / 2.0


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
