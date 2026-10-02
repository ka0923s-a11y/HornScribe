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
* contained-lower suppression (``prefer="onset"``, #129): an event
  fully inside a sustained note's span, lower in pitch and at a real
  confidence deficit, is a rumble/subharmonic artifact — the mono
  contract is one sounding line, and real melodic motion is
  sequential (it extends past the sustain's end), never contained.
  Dropping it keeps the sustain whole instead of clipping the tail.

Pitch is rounded to the nearest semitone here — canonical notes are
integer MIDI (pitch spelling is a downstream concern, flagged via
``pitch_spelling_ambiguous`` review issues, not guessed silently).
"""

from __future__ import annotations

from collections.abc import Callable
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
# Seam-evidence pollution guard (reverb-4-4): when ANOTHER event
# attacks inside the seam's flux window, the measured onset peak is
# that attack's energy — not evidence the same-pitch pair re-
# articulated. A ringing tail that re-triggers under the next note's
# onset shows exactly this shape; abstain from the seam check so the
# fragment merges back instead of clipping the real note away.
SEAM_BUSY_SEC = 0.09
# Tail re-trigger (reverb-4-4): a note's ringing tail re-attacks a
# frame or two after the real next onset, producing a short event
# contained inside the new note at the PREDECESSOR's pitch. A plain
# confidence deficit alone cannot separate it from a quiet real
# interleave (#129 caution); the pitch match with the pre-container
# note is the tell. Bounded length: re-detected tails are short.
TAIL_RETRIGGER_MAX_SEC = 0.25
# The tail must connect to the pre-container note — a pitch twin
# that ended long ago is a coincidence, not a re-trigger.
TAIL_RETRIGGER_GAP_SEC = 0.12

# Melody texture (prefer="top") overlay rescue (#143): a strummed
# chord tone above the melody claims the top slot when the mode
# blindly keeps the higher pitch. Two signatures rescue the real
# line: the interrupted lower line resumes its own pitch inside or
# right after the higher claimant's span; and a simultaneous lower
# attack outlives the top while carrying melody evidence (vibrato or
# decisively higher confidence). Both arbitrate only inside a
# melody-band interval — a bass two octaves down is accompaniment
# even when it is louder.
OVERLAY_MAX_INTERVAL = 12
OVERLAY_RESUME_GAP_SEC = 0.08
LOWER_LINE_CONF_RATIO = 1.3
VIBRATO_MIN_BENDS = 5
VIBRATO_MIN_SPAN_SEMITONES = 0.5

# prefer="top" adds a span-coverage requirement: a true concurrent
# ghost rides its fundamental -- attacks with it AND rings most of its
# length. On mixes the stronger concurrent note at a harmonic interval
# is usually a sustained pad/bass (accompaniment), while the real
# melody fragment above it is short; without coverage the accompaniment
# gets to "own" the melody as its overtone (#130).
CONCURRENT_GHOST_SPAN_RATIO = 0.5

# Mono (prefer="onset") contained-lower suppression (#129): an event
# that lives ENTIRELY inside a sustained note's span (its tail does
# not extend past), sits lower in pitch and carries a real confidence
# deficit is a rumble/subharmonic/bleed artifact — breath noise, key
# clicks, room rumble make Basic Pitch posit low hypotheses mid-
# sustain, and onset-clipping at them deletes the sustain's tail.
# Sequential movement is safe: a real next note extends past the
# sustain's end, so it is never "contained".
CONTAINED_GHOST_CONF_RATIO = 0.7
CONTAINED_GHOST_CONF_GAP = 0.15


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
    """Overtone-family artifacts suppressed instead of clipping —
    harmonic-interval ghosts, concurrent octave ghosts and (#129)
    contained-lower rumble hypotheses."""
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
    edge_evidence: Callable[[RawNoteEvent, RawNoteEvent], bool] | None = None,
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

    ``edge_evidence`` is an ``(a, b) -> bool`` seam check consulted
    only under ``prefer="onset"`` when two same-pitch events sit
    within ``merge_gap_sec``: True means the audio carries a real
    articulation at the seam (attack / silence trough / f0 move), so
    the re-articulated note stays separate instead of merging away
    (boundary-4-4: a tongued repeat was being absorbed into one note).
    Polyphonic textures must not supply it — accompaniment and other
    -voice onsets pollute the seam envelope, and under "top" a mix
    transient is precisely the false attack a merge exists to heal.
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
                # Under prefer="top" the same crossing guard applies to
                # adjacent fragments too: a higher attack inside the
                # bridged span is real melodic movement, not a split —
                # merging across it would hide the overlap the clip
                # pass must resolve (#143).
                pi_adj = int(round(ev.pitch_midi))
                crossed = prefer == "top" and any(
                    int(round(k.pitch_midi)) > pi_adj
                    and k.onset_sec < ev.onset_sec
                    and k.offset_sec > prev.onset_sec
                    for k in kept
                )
                # Mono texture only: the boundary expert's seam
                # evidence vetoes the merge when the audio shows a real
                # articulation — a re-detected attack at the same pitch
                # is a tongued repeat, not a split of one held note.
                # The check abstains while a third event attacks on the
                # seam: the flux peak then belongs to that attack
                # (tail re-trigger under the next note, reverb-4-4).
                separated = (
                    prefer == "onset"
                    and edge_evidence is not None
                    and not any(
                        k is not ev
                        and k is not prev
                        and abs(k.onset_sec - ev.onset_sec)
                        <= SEAM_BUSY_SEC
                        for k in ordered
                    )
                    and edge_evidence(prev, ev)
                )
                if not crossed and not separated:
                    kept[-1] = _extend(
                        prev, ev.offset_sec, ev.confidence, ev.pitch_bends
                    )
                    merged += 1
                    continue
        if prefer == "top" and kept:
            pi = int(round(ev.pitch_midi))
            j = last_same_pitch.get(pi)
            if j is not None and ev.onset_sec - kept[j].offset_sec < merge_gap_sec:
                # Interleaved = rings at any point inside the bridged
                # span [anchor.onset, ev.onset). An index scan misses a
                # higher event indexed earlier — e.g. a merged melody
                # note that attacked before the fragment but still
                # rings while the bridge would hide the overlap (#143).
                anchor = kept[j]
                crossed_higher = any(
                    int(round(k.pitch_midi)) > pi
                    and k.onset_sec < ev.onset_sec
                    and k.offset_sec > anchor.onset_sec
                    for k in kept
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
    for i, ev in enumerate(kept):
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
                # #129: under the mono contract a fully-contained
                # lower hypothesis is a rumble/subharmonic artifact —
                # drop it rather than amputating the sustain's tail.
                # (prefer="top" already drops every lower overlap.)
                if prefer == "onset" and _is_contained_lower_ghost(
                    prev, ev
                ):
                    ghosts += 1
                    continue
                # Tail re-trigger (reverb-4-4): a short event contained
                # inside prev at the pitch of the note just before it
                # is that note's ringing tail re-firing under the new
                # attack — suppress it instead of letting it clip the
                # real note down to a too-short stub. The confidence
                # test stays a plain deficit: the pitch match is the
                # discriminator, not the depth of the gap (#129).
                if (
                    prefer == "onset"
                    and len(final_events) > 1
                    and _is_tail_retrigger(
                        final_events[-2], prev, ev
                    )
                ):
                    ghosts += 1
                    continue
                if (
                    int(round(prev.pitch_midi)) % 12
                    != int(round(ev.pitch_midi)) % 12
                ):
                    polyphonic += 1
                if prefer == "top":
                    if ev.pitch_midi < prev.pitch_midi:
                        # Melody mode: the lower overlapping hypothesis
                        # is accompaniment, not the line — unless it
                        # attacked with the current top, outlives it,
                        # and shows melody evidence, in which case the
                        # top was the overlay (#143).
                        if not _lower_line_survives(kept, i, ev, prev):
                            continue
                    elif ev.pitch_midi > prev.pitch_midi and (
                        _line_resumes_under(kept, i, prev, ev)
                    ):
                        # The interrupted lower line resumes its own
                        # pitch inside the claimant's span — a strum
                        # stab riding over the melody, not melodic
                        # movement (#143).
                        ghosts += 1
                        continue
                final_events[-1] = _replace_offset(prev, ev.onset_sec)
                clipped += 1
            elif (
                prefer == "top"
                and merge_gap_sec > 0
                and int(round(prev.pitch_midi))
                == int(round(ev.pitch_midi))
                and ev.onset_sec - prev.offset_sec < merge_gap_sec
            ):
                # Recompose the line: dropping an overlay can leave a
                # pitch split into adjacent fragments that the merge
                # pass never saw side by side (#143).
                final_events[-1] = _extend(
                    prev, ev.offset_sec, ev.confidence, ev.pitch_bends
                )
                merged += 1
                continue
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


def _is_contained_lower_ghost(
    prev: RawNoteEvent,
    ev: RawNoteEvent,
) -> bool:
    """True when *ev* is a contained lower hypothesis inside *prev*'s
    sustain (#129).

    Under the monophonic contract a note entirely inside a longer
    sounding note's span — attacking after its onset AND releasing
    before its offset — that sits lower and carries a real confidence
    deficit is a rumble/subharmonic artifact (handling noise, key
    clicks, room modes make Basic Pitch posit brief low notes mid-
    sustain). Real melodic motion is sequential: the next note
    extends past the sustain's end, so it is never contained.
    Both a ratio and an absolute confidence gap are required so a
    genuinely quiet real interleave is not eaten (#129 caution).
    """
    if ev.onset_sec - prev.onset_sec < GHOST_MIN_LEAD_SEC:
        return False
    if ev.offset_sec > prev.offset_sec:
        return False
    if ev.pitch_midi >= prev.pitch_midi:
        return False
    if ev.confidence is None or prev.confidence is None:
        return False
    return (
        ev.confidence < prev.confidence * CONTAINED_GHOST_CONF_RATIO
        and prev.confidence - ev.confidence >= CONTAINED_GHOST_CONF_GAP
    )


def _is_tail_retrigger(
    before: RawNoteEvent | None,
    prev: RawNoteEvent,
    ev: RawNoteEvent,
) -> bool:
    """True when *ev* is *before*'s ringing tail re-firing under *prev*.

    Shape (reverb-4-4): ``before`` and ``ev`` share a pitch, ``before``
    ended just as ``prev`` attacked, and ``ev`` is a short event fully
    contained in ``prev``'s span at lower confidence. Reverb tails keep
    the old pitch detectable past the written end; the new note's
    attack re-triggers the backend on the residual energy. Sequential
    melody is safe: a real continuation of ``before``'s pitch starts
    AFTER ``prev`` releases, so it is never contained.
    """
    if before is None:
        return False
    if int(round(ev.pitch_midi)) != int(round(before.pitch_midi)):
        return False
    if int(round(ev.pitch_midi)) == int(round(prev.pitch_midi)):
        return False
    if ev.onset_sec - prev.onset_sec < GHOST_MIN_LEAD_SEC:
        return False
    if ev.offset_sec > prev.offset_sec:
        return False
    if ev.offset_sec - ev.onset_sec > TAIL_RETRIGGER_MAX_SEC:
        return False
    if before.offset_sec < ev.onset_sec - TAIL_RETRIGGER_GAP_SEC:
        return False
    if ev.confidence is None or prev.confidence is None:
        return False
    return ev.confidence < prev.confidence


def _bend_span(ev: RawNoteEvent) -> float:
    """Peak-to-peak pitch modulation in semitones — the vibrato marker
    (#143). A steady tone (synth strum, pad) bends ~0 even with many
    bend samples; a sung lead oscillates ±25c+."""
    bends = ev.pitch_bends or ()
    if len(bends) < VIBRATO_MIN_BENDS:
        return 0.0
    vals = [b.bend_semitones for b in bends]
    return max(vals) - min(vals)


def _pitch_resumes(
    kept: list[RawNoteEvent],
    i: int,
    pitch_midi: float,
    span_end: float,
    *,
    inside_only: bool = False,
) -> bool:
    """A later kept event at ~pitch_midi starts inside span_end or just
    after it — the line at that pitch continues under the top note's
    span instead of ending where it does (#143). inside_only requires
    the resume to land strictly inside the span — a note that returns
    only after the top ended is ordinary succession, not a buried
    line."""
    resume_until = (
        span_end if inside_only else span_end + OVERLAY_RESUME_GAP_SEC
    )
    target = int(round(pitch_midi))
    for cand in kept[i + 1 :]:
        if cand.onset_sec > resume_until:
            break
        if int(round(cand.pitch_midi)) == target:
            return True
    return False


def _lower_line_survives(
    kept: list[RawNoteEvent],
    i: int,
    ev: RawNoteEvent,
    prev: RawNoteEvent,
) -> bool:
    """prefer="top" rescue (#143): the lower overlapping event is the
    melody — not accompaniment — when it attacked together with the
    current top, continues under it (outlives the top's span or its own
    pitch resumes inside/right after it), and carries melody evidence
    (vibrato, or decisively higher confidence than the top claimant).

    A strum stab shares the melody's attack while the line keeps
    running underneath; a pad or bass root does not modulate. The
    interval guard keeps a loud bass two octaves down from outvoting
    the lead.
    """
    if abs(
        int(round(prev.pitch_midi)) - int(round(ev.pitch_midi))
    ) > OVERLAY_MAX_INTERVAL:
        return False
    same_onset = (
        abs(ev.onset_sec - prev.onset_sec) <= CONCURRENT_GHOST_ONSET_SEC
    )
    if same_onset:
        continues = ev.offset_sec > prev.offset_sec or _pitch_resumes(
            kept, i, ev.pitch_midi, prev.offset_sec
        )
    else:
        # A late attack inside a held note: the lower line must still
        # be running underneath — resuming strictly inside the top's
        # span (after its honest end is ordinary succession) or
        # continuing well past it.
        continues = _pitch_resumes(
            kept, i, ev.pitch_midi, prev.offset_sec, inside_only=True
        ) or ev.offset_sec > prev.offset_sec + 0.15
    if not continues:
        return False
    if same_onset:
        # Simultaneous attack — the overlay shape: vibrato or a
        # decisively stronger lower line identifies the melody.
        if _bend_span(ev) >= VIBRATO_MIN_SPAN_SEMITONES:
            return True
        if ev.confidence is not None and prev.confidence is not None:
            return ev.confidence >= prev.confidence * LOWER_LINE_CONF_RATIO
        return False
    # The late-attacking lower wins only when it is at least as loud as
    # the tail it would displace; a weaker repetition under a sustained
    # melody stays accompaniment.
    if ev.confidence is not None and prev.confidence is not None:
        return ev.confidence >= prev.confidence
    return False


def _line_resumes_under(
    kept: list[RawNoteEvent],
    i: int,
    prev: RawNoteEvent,
    ev: RawNoteEvent,
) -> bool:
    """prefer="top" rescue (#143): the higher claimant *ev* is an
    overlay stab — not melodic movement — when the line it interrupts
    (*prev*) continues at ~the same pitch inside ev's span or just
    after it, and ev is not stronger than the line it would displace.
    The melody-band guard keeps a repeating bass arpeggio underneath
    a real high note from cancelling the melody.
    """
    if (
        int(round(ev.pitch_midi)) - int(round(prev.pitch_midi))
        > OVERLAY_MAX_INTERVAL
    ):
        return False
    if prev.confidence is None or ev.confidence is None:
        return False
    if ev.confidence > prev.confidence:
        return False
    return _pitch_resumes(kept, i, prev.pitch_midi, ev.offset_sec)


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
