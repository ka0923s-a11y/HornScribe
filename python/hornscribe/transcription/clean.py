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

from hornscribe.domain.events import PitchBendPoint, RawNoteEvent

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

# Concurrent octave ghosts (#92): Basic Pitch also emits octave errors
# that attack WITH the fundamental and ring just as long, so neither
# GHOST_MAX_SEC nor GHOST_MIN_LEAD_SEC can see them. The tells are
# simultaneity, an octave-family interval, and a confidence gap too
# large for a genuine second voice -- BOTH a ratio and an absolute
# gap are required so a merely quieter real octave doubling survives.
CONCURRENT_GHOST_ONSET_SEC = 0.06
CONCURRENT_GHOST_INTERVALS = (12, 19, 24)  # octave, octave+P5, 2oct
CONCURRENT_GHOST_CONF_RATIO = 0.7
CONCURRENT_GHOST_CONF_GAP = 0.15

# prefer="top" interruption repair: a short note that deviates on
# BOTH sides of the line and is locally weak (or an octave-scale
# excursion) is a bleed/flicker artifact, not melody — on a mix the
# backend emits high/low blips that ride ON the melodic note and clip
# it. Drop the blip and restore the tail it interrupted (#130).
BLIP_MAX_SEC = 0.12
BLIP_MIN_DEVIATION = 3  # semitones from each neighbour
BLIP_EXCURSION = 12     # octave-scale deviation needs no conf test
BLIP_MAX_CONF = 0.5
BLIP_EXTEND_MAX_SEC = 0.3  # cap on the restored tail

# prefer="top" adds a span-coverage requirement: a true concurrent
# ghost rides its fundamental -- attacks with it AND rings most of its
# length. On mixes the stronger concurrent note at a harmonic interval
# is usually a sustained pad/bass (accompaniment), while the real
# melody fragment above it is short; without coverage the accompaniment
# gets to "own" the melody as its overtone (#130).
CONCURRENT_GHOST_SPAN_RATIO = 0.5


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
    interruption_dropped: int = 0
    """Short off-line blips suppressed under prefer="top" (#130)"""

    def stats(self) -> dict[str, Any]:
        return {
            "droppedTooShort": self.dropped_too_short,
            "merged": self.merged,
            "clippedOverlaps": self.clipped_overlaps,
            "octaveCorrected": self.octave_corrected,
            "polyphonicOverlaps": self.polyphonic_overlaps,
            "ghostDropped": self.ghost_dropped,
            "interruptionDropped": self.interruption_dropped,
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
                # #192: keep the bend evidence inside the new span —
                # clipping must not silently drop performed vibrato.
                pitch_bends=tuple(
                    b for b in ev.pitch_bends if onset <= b.time_sec <= offset
                ),
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
    concurrent_ghosts = _concurrent_ghost_ids(
        ordered,
        min_event_sec,
        # Melody texture: the stronger concurrent note at a harmonic
        # interval is usually accompaniment, not a fundamental that
        # owns the weaker note above it — require the ghost to ride
        # most of the span before suppressing (#130).
        span_coverage=prefer == "top",
    )
    kept: list[RawNoteEvent] = []
    dropped = 0
    merged = 0
    # prefer="top" (melody texture): merge a fragment back into the last
    # kept event *of the same pitch*, not only the adjacent one. On a
    # mix the backend splits a sustained lead note on each strong grid
    # position (drum/pad transients) and interleaves lower hypotheses
    # between the fragments — the adjacent-only merge never sees them.
    # The merge is only allowed across interleaved events that are all
    # lower than the fragment: a higher event is real melodic movement,
    # and under "top" those lowers would be dropped as accompaniment in
    # the clip pass anyway. prefer="onset" keeps the old behaviour —
    # there an interleaved lower note is kept, so bridging it would
    # swallow the re-articulation.
    last_same_pitch: dict[int, int] = {}  # rounded midi -> kept index
    for i, ev in enumerate(ordered):
        if i in concurrent_ghosts:
            continue  # overtone artifact -- counted with ghosts below
        if ev.offset_sec - ev.onset_sec < min_event_sec:
            dropped += 1
            continue
        if kept:
            prev = kept[-1]
            same_pitch = int(round(prev.pitch_midi)) == int(round(ev.pitch_midi))
            if same_pitch and ev.onset_sec - prev.offset_sec < merge_gap_sec:
                kept[-1] = _extend(
                    prev, ev.offset_sec, ev.confidence, ev.pitch_bends
                )
                merged += 1
                continue
        if prefer == "top" and kept:
            pi = int(round(ev.pitch_midi))
            j = last_same_pitch.get(pi)
            if j is not None and ev.onset_sec - kept[j].offset_sec < merge_gap_sec:
                crossed_higher = any(
                    int(round(k.pitch_midi)) > pi for k in kept[j + 1 :]
                )
                if not crossed_higher:
                    kept[j] = _extend(
                        kept[j], ev.offset_sec, ev.confidence, ev.pitch_bends
                    )
                    merged += 1
                    continue
        kept.append(ev)
        if prefer == "top":
            last_same_pitch[int(round(ev.pitch_midi))] = len(kept) - 1

    clipped = 0
    polyphonic = 0
    ghosts = len(concurrent_ghosts)
    final_events: list[RawNoteEvent] = []
    for ev in kept:
        if final_events:
            prev = final_events[-1]
            if prev.offset_sec > ev.onset_sec:
                if _is_harmonic_ghost(
                    prev,
                    ev,
                    # Melody texture: a higher note cutting in is the
                    # mode's own contract, so calling it the lower
                    # note's overtone needs a real confidence deficit,
                    # not merely "less than" (#130 — a weak melody
                    # fragment at conf 0.40 was being eaten by a strum
                    # at conf 0.42 a fifth below).
                    conf_ratio=(
                        CONCURRENT_GHOST_CONF_RATIO
                        if prefer == "top"
                        and ev.pitch_midi > prev.pitch_midi
                        else 0.0
                    ),
                ):
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

    # Melody texture: suppress interruption blips — short notes that
    # leave the line on both sides. The artifact clipped the real
    # note's tail when it cut in, so dropping it also restores the
    # interrupted span (#130).
    interruptions = 0
    if prefer == "top":
        final, interruptions = _drop_interruption_blips(final)

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
        interruption_dropped=interruptions,
    )


def _is_concurrent_ghost(
    ev: RawNoteEvent,
    other: RawNoteEvent,
    *,
    span_coverage: bool = False,
) -> bool:
    """True when *ev* is an overtone artifact attacking with *other*.

    Unlike _is_harmonic_ghost this does not need a later, shorter
    attack: the octave error starts at the fundamental's own onset and
    sustains as long as the real note, so the signal is the
    simultaneous attack plus a large confidence deficit (#92).

    When ``span_coverage`` is set (melody texture, #130) the candidate
    must also ring at least CONCURRENT_GHOST_SPAN_RATIO of the
    fundamental's span — the "rides the whole note" half of the ghost
    signature. Without it a sustained accompaniment note owns every
    weak same-interval melody fragment starting near its attack.
    """
    if abs(ev.onset_sec - other.onset_sec) > CONCURRENT_GHOST_ONSET_SEC:
        return False
    interval = abs(
        int(round(ev.pitch_midi)) - int(round(other.pitch_midi))
    )
    if interval not in CONCURRENT_GHOST_INTERVALS:
        return False
    if span_coverage and (
        ev.offset_sec - ev.onset_sec
        < (other.offset_sec - other.onset_sec) * CONCURRENT_GHOST_SPAN_RATIO
    ):
        return False
    if ev.confidence is None or other.confidence is None:
        return False
    return (
        ev.confidence < other.confidence * CONCURRENT_GHOST_CONF_RATIO
        and other.confidence - ev.confidence >= CONCURRENT_GHOST_CONF_GAP
    )


def _concurrent_ghost_ids(
    ordered: list[RawNoteEvent],
    min_event_sec: float,
    *,
    span_coverage: bool = False,
) -> set[int]:
    """Indexes of concurrent octave ghosts inside one event list.

    Pairwise rather than order-dependent -- the fundamental may sort
    after its ghost, and a too-short partner cannot kill (it is not
    even a note). O(n^2) on the raw count, trivial at job sizes.
    """
    out: set[int] = set()
    for i, ev in enumerate(ordered):
        if ev.confidence is None:
            continue
        for j, other in enumerate(ordered):
            if i == j or other.confidence is None:
                continue
            if other.offset_sec - other.onset_sec < min_event_sec:
                continue
            if _is_concurrent_ghost(
                ev, other, span_coverage=span_coverage
            ):
                out.add(i)
                break
    return out


def _is_harmonic_ghost(
    prev: RawNoteEvent,
    ev: RawNoteEvent,
    *,
    conf_ratio: float = 0.0,
) -> bool:
    """True when *ev* is an overtone artifact riding on *prev*.

    Basic Pitch frequently emits a short, weaker note a stable harmonic
    interval (octave/fifth/third) away that starts under a sustained
    note. Under the monophonic contract clipping the sustained note at
    the ghost's onset throws away the real tail, so the ghost loses.
    Deliberately conservative: requires a short span, a later attack,
    a harmonic interval, and strictly lower confidence.

    ``conf_ratio`` > 0 tightens the confidence leg to a real deficit
    (below ``prev * conf_ratio`` AND the absolute gap) — melody mode
    uses it when the candidate sits ABOVE the sustained note, where a
    near-equal-confidence note is melodic movement, not an overtone
    (#130).
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
    if conf_ratio:
        return (
            ev.confidence < prev.confidence * conf_ratio
            and prev.confidence - ev.confidence
            >= CONCURRENT_GHOST_CONF_GAP
        )
    return ev.confidence < prev.confidence


def _drop_interruption_blips(
    events: list[RawNoteEvent],
) -> tuple[list[RawNoteEvent], int]:
    """Suppress short off-line blips in a monophonic top line (#130).

    On mixes the backend emits brief high/low artifacts that ride ON
    the melodic note and clip it (an 84 fragment splitting a sustained
    76, bass bleed during a rest). The signature: the note is short,
    deviates at least BLIP_MIN_DEVIATION semitones from BOTH
    neighbours, and is locally weak — or deviates a full octave, which
    needs no confidence evidence. The underlying note was still
    sounding when the blip cut in, so dropping it also restores the
    interrupted tail (same pitch on both sides re-merges into one
    note; a pitch change restores the tail up to the next onset).
    """
    if len(events) < 3:
        return events, 0
    out: list[RawNoteEvent] = [events[0]]
    dropped = 0
    k = 1
    while k < len(events) - 1:
        ev = events[k]
        nxt = events[k + 1]
        prev = out[-1]
        duration = ev.offset_sec - ev.onset_sec
        dev = min(
            abs(ev.pitch_midi - prev.pitch_midi),
            abs(ev.pitch_midi - nxt.pitch_midi),
        )
        weak = False
        if (
            ev.confidence is not None
            and prev.confidence is not None
            and nxt.confidence is not None
        ):
            weak = ev.confidence <= BLIP_MAX_CONF or ev.confidence < (
                max(prev.confidence, nxt.confidence)
                * CONCURRENT_GHOST_CONF_RATIO
            )
        is_blip = (
            duration <= BLIP_MAX_SEC
            and dev >= BLIP_MIN_DEVIATION
            and (weak or dev >= BLIP_EXCURSION)
        )
        if not is_blip:
            out.append(ev)
            k += 1
            continue
        dropped += 1
        contiguous = prev.offset_sec >= ev.onset_sec - 1e-6
        if contiguous:
            same_pitch = int(round(prev.pitch_midi)) == int(
                round(nxt.pitch_midi)
            )
            if same_pitch:
                # The blip split one note: absorb the far fragment.
                out[-1] = _extend(
                    prev, nxt.offset_sec, nxt.confidence, nxt.pitch_bends
                )
                k += 2
                continue
            extension = nxt.onset_sec - prev.offset_sec
            if 0 < extension <= BLIP_EXTEND_MAX_SEC:
                out[-1] = _replace_offset(prev, nxt.onset_sec)
        k += 1
    out.append(events[-1])
    return out, dropped


@dataclass(frozen=True)
class VoiceSplit:
    """Monophonic streams partitioned from polyphonic input (#85).

    voices[0] is the upper line (assigned first / higher pitch at a
    shared onset); the rest descend by median pitch. Length equals
    max_voices — trailing voices may be empty.
    """

    voices: tuple[tuple[RawNoteEvent, ...], ...]
    """Highest-to-lowest lines — each internally monophonic."""
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

    Greedy assignment, onset order with higher pitch first at a shared
    onset (the upper slot tends to carry the melody). Each event joins
    the free voice whose last pitch is closest to it — voice-leading
    continuity beats slot order, so crossing lines keep their own
    stream. Same-pitch re-detections merge within their own voice;
    harmonic ghosts are suppressed against ANY sustained voice's tail
    (an overtone artifact under a held note is not another voice).
    Events that fit no free voice count as dropped_beyond_voices.
    """
    ordered = sorted(events, key=lambda e: (e.onset_sec, -e.pitch_midi))
    concurrent_ghosts = _concurrent_ghost_ids(ordered, min_event_sec)
    voices: list[list[RawNoteEvent]] = [[] for _ in range(max_voices)]
    dropped = 0
    merged = 0
    ghosts = len(concurrent_ghosts)
    beyond = 0
    for i, ev in enumerate(ordered):
        if i in concurrent_ghosts:
            continue
        if ev.offset_sec - ev.onset_sec < min_event_sec:
            dropped += 1
            continue
        # Overtone artifact riding on any sustained voice — drop it
        # before slotting (a free voice must not be claimed by a short,
        # weak harmonic ghost, whichever line it hangs under).
        if any(
            voice
            and voice[-1].offset_sec > ev.onset_sec
            and _is_harmonic_ghost(voice[-1], ev)
            for voice in voices
        ):
            ghosts += 1
            continue
        placed = False
        free = [
            v for v in voices if not v or v[-1].offset_sec <= ev.onset_sec
        ]
        if free:
            # The free voice continuing nearest this pitch keeps the
            # line; min() is stable so ties keep the earlier slot.
            best = min(
                free,
                key=lambda v: (
                    abs(v[-1].pitch_midi - ev.pitch_midi)
                    if v
                    else float("inf")
                ),
            )
            if best:
                prev = best[-1]
                same_pitch = int(round(prev.pitch_midi)) == int(
                    round(ev.pitch_midi)
                )
                if same_pitch and ev.onset_sec - prev.offset_sec < merge_gap_sec:
                    best[-1] = _extend(
                        prev, ev.offset_sec, ev.confidence, ev.pitch_bends
                    )
                    merged += 1
                    placed = True
            if not placed:
                best.append(ev)
                placed = True
        if not placed:
            beyond += 1
    voices.sort(key=_voice_median_pitch, reverse=True)
    while len(voices) < max_voices:
        voices.append([])
    return VoiceSplit(
        voices=tuple(tuple(v) for v in voices[:max_voices]),
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


def _extend(
    ev: RawNoteEvent,
    offset_sec: float,
    confidence: float | None,
    incoming_bends: tuple[PitchBendPoint, ...] = (),
) -> RawNoteEvent:
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
        # #192: a same-pitch merge stitches two detections — keep both
        # bend series (dedup on identical points) inside the union span.
        pitch_bends=tuple(
            dict.fromkeys(
                tuple(
                    b for b in ev.pitch_bends
                    if ev.onset_sec <= b.time_sec <= offset_sec
                )
                + tuple(incoming_bends)
            )
        ),
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
        # #192: the tail was clipped at the next onset — drop bend
        # points that now live past the new offset.
        pitch_bends=tuple(
            b for b in ev.pitch_bends if b.time_sec <= offset_sec
        ),
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
        pitch_bends=ev.pitch_bends,
    )
