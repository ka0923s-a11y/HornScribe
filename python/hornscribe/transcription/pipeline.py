"""The ``transcription`` job: audio file -> canonical score (ENG-002).

Staged exactly as the UI progress contract (GUI_UX_SPEC §5,
``TRANSCRIPTION_STAGE_IDS``) — every stage emits a ``progress`` event
carrying ``stage`` so the transcribing screen never has to guess.
#385: stage transitions are honest boundaries — they carry NO job
fraction (the old fixed milestones 0.15/0.55/... read as real
percentages without measuring anything). Real measured work is
reported separately as ``step``/``totalSteps`` counts inside the
stage that owns the loop; the only ``progress`` fraction left is
``1.0`` on the terminal ``completed`` event.

    preparing_audio -> transcribing -> cleaning -> analyzing_rhythm
    -> quantizing -> building_score -> rendering

Cancellation is cooperative *between* stages (Basic Pitch inference is
one blocking ONNX call — ENGINE_RUNTIME_MATRIX.md). ``deadline_ms``
mirrors ``demoLongTask``: an engine-side wall-clock cap checked at the
same boundaries, ending in ``JOB_TIMEOUT``.

Failure mapping (all honest terminal ``failed`` events, never a crash):

* missing engine packages -> ``ENGINE_DEPENDENCY_MISSING``
* undecodable audio / backend error -> ``JOB_FAILED``
* zero pitched notes after cleaning -> ``NO_PITCHED_CONTENT``
  (retrying cannot help; the UI tailors its copy to this code)
"""

from __future__ import annotations

import contextlib
import hashlib
import math
import os
import tempfile
import threading
import time
import wave
from array import array
from collections.abc import Callable, Iterable
from dataclasses import replace
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import Any

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import (
    RawNoteEventId,
    ScoreNoteId,
    ScoreRevisionId,
    TranscriptionRevisionId,
)
from hornscribe.domain.review import (
    IssueIdAllocator,
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.domain.score import (
    ChordSymbol,
    KeyChange,
    PitchSpace,
    QuantizedNote,
)
from hornscribe.export.musicxml import (
    export_b_flat_musicxml,
    export_concert_musicxml,
    export_horn_in_f_musicxml,
)
from hornscribe.instruments.horn_f import HornRangeStatus, sounding_range_status
from hornscribe.notation.tone_spelling import fifths_at_beat, is_diatonic
from hornscribe.rhythm.issues import generate_review_issues
from hornscribe.rhythm.meter import MeterMap, MeterSegment, UnsupportedMeterError
from hornscribe.rhythm.quantizer import quantize_events
from hornscribe.rhythm.timewarp import (
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)
from hornscribe.worker.protocol import (
    ERR_ENGINE_DEPENDENCY_MISSING,
    ERR_JOB_FAILED,
    ERR_JOB_TIMEOUT,
    ERR_NO_PITCHED_CONTENT,
)

from .backend import (
    BACKEND_ID,
    BACKEND_VERSION,
    MELODY_MAX_FREQUENCY_HZ,
    PYIN_BACKEND_ID,
    EngineDependencyError,
    load_mono_audio,
    new_transcription_revision,
    predict_note_events,
    predict_note_events_pyin,
    predict_note_events_rescued,
    require_module,
)
from .boundary import (
    OCTAVE_MIN_SPAN_SEC,
    boundary_flags,
    compute_envelopes,
    low_octave_evidence,
    low_octave_suspected,
    octave_prefers,
    seam_evidence,
)
from .chord import (
    LOW_CONFIDENCE as CHORD_LOW_CONFIDENCE,
)
from .chord import (
    LOW_MARGIN as CHORD_LOW_MARGIN,
)
from .chord import (
    ChordEstimate,
    diatonic_chords,
    estimate_chords,
)
from .clean import (
    MERGE_GAP_SEC,
    CleanedEvents,
    _extend,
    clean_monophonic,
    clip_to_range,
    split_voices,
)
from .key import analyze_key, key_uncertainty, refine_key_with_harmony
from .leadvoice import lead_track_agreement
from .meter import estimate_meter
from .options import TranscriptionParams
from .scorebuild import build_score
from .swing import detect_swing
from .tempo import (
    estimate_tempo,
    pickup_uncertainty,
    tempo_map_from_estimate,
)
from .tempo_octave import detect_tempo_octave
from .vocal import (
    accompaniment_wav_for,
    demucs_available,
    demucs_weights_pending,
    vocal_wav,
    wav_rms,
)

JOB_KIND_TRANSCRIPTION = "transcription"

STAGES: tuple[str, ...] = (
    "preparing_audio",
    "transcribing",
    "cleaning",
    "analyzing_rhythm",
    "quantizing",
    "building_score",
    "rendering",
)

# Review thresholds (evidence-bearing, surfaced as issues — never silent
# corrections):
LOW_CONFIDENCE = 0.5
"""Backend amplitude below this flags ``low_model_confidence``."""
VERY_SHORT_SEC = 0.09
"""Surviving detections shorter than this flag ``very_short_detection``."""
MAX_EXTRA_ISSUES = 60
"""Cap on hand-built issues so a noisy take cannot flood the review UI."""
MAX_BOUNDARY_ISSUES = 20
"""Cap on boundary re-scoring flags (#423) - one suspicious edge per
hotspot is enough; a flickery take must not bury the queue."""
PITCH_DIP_MAX_SEC = 0.28
"""#264: a chromatic note must be SHORTER than this to count as a
possible tracker bin-snap — a deliberate semitone is normally held."""
MAX_CHORD_ISSUES = 10
"""Cap on chord-uncertainty segments (#419) - a harmonically muddy
piece flags its worst spans, not every bar."""

# ``auto`` texture: when the onset-clean pass still saw this many
# different-pitch overlaps (absolute floor + share of surviving events),
# the source is a mix, not a monophonic line — re-clean keeping the top
# voice so the melody survives instead of being clipped by accompaniment.
AUTO_TEXTURE_MIN_OVERLAPS = 4
AUTO_TEXTURE_OVERLAP_RATIO = 0.05

# #191: isolated-estimate RMS / source-slice RMS below which the lead
# counts as "buried" — the point where missed notes become plausible
# enough to tell the user about. A demucs stem carries near-true vocal
# energy, so a -9.5 dB lead (the #165 failure case) reads ~0.33 and
# the bar sits just under it; a center extraction attenuates even a
# healthy lead (side-channel loss + soft mask), so its bar is lower.
_LOW_LEAD_RMS_RATIO = {"demucs": 0.30}
_LOW_LEAD_RMS_RATIO_DEFAULT = 0.20

EventEmitter = Callable[..., None]
NoteBackend = Callable[[str], tuple[RawNoteEvent, ...]]
AudioLoader = Callable[[str], tuple[Any, int]]


# _track_beats: tempo-change handling (#93). librosa's global tracker
# forces ONE pulse for the whole file, so a mid-piece 100->140 step
# leaves the fast section anchored off-grid (the warp then converts
# score positions back to seconds ~60 ms wrong). The fix: segment the
# frame-level tempo curve into stable regions and re-track each with
# its own bpm.
# Plateau tolerance for the dyn curve: autocorr quantizes tempo to lag
# bins, so adjacent plateau levels sit ~4-5 % apart — 2 % splits each
# level (catching a continuous rit./accel. as a staircase) while in-
# plateau jitter stays inside its run (rubato-4-4).
_TEMPO_PLATEAU_BAND = 0.02
# Regions shorter than this merge into a neighbour -- a one-beat rit.
# is not a tempo section.
_TEMPO_REGION_MIN_SEC = 1.5
# Region tracking windows overlap the nominal bounds by this much so
# beats near the seam are still found; kept beats stay strictly inside.
_TEMPO_REGION_PAD_SEC = 0.6
# A gap wider than interval * this between region tracks means the
# boundary beat was lost -- refill it from the onset envelope.
_TEMPO_GAP_FILL_RATIO = 1.4
# A short region whose tempo sits within the plateau band of a
# small-integer metrical ratio of the dominant tempo is the autocorr
# reading a triplet/double pulse level, not a real tempo change --
# it is snapped to the dominant grid. Spans longer than this cap keep
# their own reading: a real double-time section holds for more than a
# few seconds.
_TEMPO_REGION_SNAP_MAX_SEC = 6.0
_TEMPO_METRICAL_RATIOS = (
    0.5,
    2.0 / 3.0,
    0.75,
    0.8,
    5.0 / 6.0,
    6.0 / 5.0,
    1.25,
    4.0 / 3.0,
    1.5,
    2.0,
)
# The tracker quantizes anchors to whole hop frames (~23 ms at
# 512/22050). On a regular pulse every anchor rounds to the SAME
# integer interval, so the measured tempo inherits a systematic
# bias (auto-3-4 read 129.2 bpm of a true 132 -- a 2 % drift that
# pushes every mapped onset off-grid). Peak refinement inside
# this radius recovers the fractional position.
_SUBFRAME_RADIUS_FRAMES = 2


def _refine_beat_frame(onset_env: Any, frame: int) -> float:
    """Fractional frame of the envelope peak near the tracked frame.

    Finds the strongest onset within +/-_SUBFRAME_RADIUS_FRAMES,
    interpolates the peak parabolically, then clamps the result to
    +-1 frame of the tracked position. The clamp matters: a 2-frame
    argmax jump alternating sign turns into interval sawtooth, and
    a 4-anchor measure slope swings ~5 % (tempo-step bench). Edge
    or too-short windows return the integer frame unchanged.
    """
    n = len(onset_env)
    lo = max(0, frame - _SUBFRAME_RADIUS_FRAMES)
    hi = min(n, frame + _SUBFRAME_RADIUS_FRAMES + 1)
    if hi - lo < 3:
        return float(frame)
    peak = lo + int(onset_env[lo:hi].argmax())
    refined = float(peak)
    if 0 < peak < n - 1:
        a = float(onset_env[peak - 1])
        b = float(onset_env[peak])
        c = float(onset_env[peak + 1])
        denom = a - 2.0 * b + c
        shift = 0.5 * (a - c) / denom if denom != 0.0 else 0.0
        refined += max(-1.0, min(1.0, shift))
    # Pull toward the peak but never leave the tracked frame's
    # neighbourhood -- the anchor moves at most +-1 frame.
    return float(frame) + max(-1.0, min(1.0, refined - float(frame)))


def _stem_analysis(stem_path: str | None) -> tuple[Any, int, Any]:
    """Decode a separation stem once for meter + chord evidence.

    Returns ``(samples, sample_rate, onset_env)``. The no_vocals
    accompaniment stem keeps the drums/bass/guitars that carry the
    downbeat structure a vocal line lacks (#233) and the harmony the
    chord map should read instead of the vocal-heavy full mix (#259);
    one decode feeds both plus the accompaniment octave evidence the
    caller already needed. ``(None, 0, None)`` when there is no stem
    or the audio stack is unavailable -- a silent miss costs the
    caller only the stem evidence pools, never the job.
    """
    if not stem_path:
        return None, 0, None
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
    except Exception:
        return None, 0, None
    try:
        y, sr = librosa.load(stem_path, sr=22050, mono=True)
    except Exception:
        return None, 0, None
    if y.size == 0:
        return None, 0, None
    return y, sr, librosa.onset.onset_strength(y=y, sr=sr)


def _drop_stem_bleed_lows(
    lead: CleanedEvents,
    accomp: list[CleanedEvents],
) -> CleanedEvents:
    """#236: drop lead notes that are accompaniment-stem bleed.

    Neural separation leaks stable bass/low f0 into the vocal stem;
    the lead tracker then notates phantom sub-bass melody (real
    capture: 22 of 36 notes >15 st under the melodic median matched
    the accompaniment stem pitch-for-pitch). A lead note below the
    duration-weighted melodic median minus the register band that is
    overlapped pitch-for-pitch by an accompaniment event is bleed --
    it already lives in the accompaniment part, so dropping it loses
    nothing. Vocal-stem-only lows stay: a real low vocal phrase must
    not be eaten by the register prior alone.
    """
    if not lead.events or not accomp:
        return lead
    pairs = sorted(
        (e.pitch_midi, max(e.offset_sec - e.onset_sec, 0.001))
        for e in lead.events
    )
    half = sum(w for _, w in pairs) / 2.0
    acc = 0.0
    median = pairs[-1][0]
    for p_, w in pairs:
        acc += w
        if acc >= half:
            median = p_
            break
    floor = median - 15.0
    accomp_events = [e for c in accomp for e in c.events]
    dropped_ids: set[RawNoteEventId] = set()

    def _is_bleed(e: RawNoteEvent) -> bool:
        return any(
            abs(a.pitch_midi - e.pitch_midi) <= 1.5
            and a.onset_sec < e.offset_sec
            and a.offset_sec > e.onset_sec
            for a in accomp_events
        )

    kept: list[RawNoteEvent] = []
    for e in lead.events:
        if e.pitch_midi < floor and _is_bleed(e):
            dropped_ids.add(e.id)
            continue
        kept.append(e)
    # Bleed spans interleave corroborated and uncorroborated frames --
    # a sub-floor fragment sitting inside a dropped bleed region is the
    # same physical event, not a coincidence the register prior missed.
    dropped_spans = [
        (e.onset_sec, e.offset_sec) for e in lead.events if e.id in dropped_ids
    ]
    still: list[RawNoteEvent] = []
    for e in kept:
        if e.pitch_midi < floor and any(
            e.onset_sec - b <= 0.6 and a - e.offset_sec <= 0.6
            for a, b in dropped_spans
        ):
            dropped_ids.add(e.id)
            continue
        # Below ~D2 a melodic line is never a usable lead vocal --
        # uncorroborated sub-bass frames are tracker artifacts.
        if e.pitch_midi < 38.0:
            dropped_ids.add(e.id)
            continue
        still.append(e)
    if not dropped_ids:
        return lead
    return replace(
        lead, events=tuple(still), bleed_dropped=len(dropped_ids)
    )


# #244: accompaniment-stem detections are flicker-heavy -- Basic
# Pitch hallucinates harmonic partials on the "other" stem, and the
# surviving part reads as wall-to-wall 16ths (reference mix: 1186 of
# 1497 events under 0.5 confidence, median flicker duration 151 ms vs
# 383 ms for the confident half). Confident detections always stay;
# mid-confidence notes earn a slot only by sustaining. The floor runs
# before voice splitting so the dropped flicker never votes for a
# voice and never gates a lead note as bleed.
_ACCOMP_CONF_KEEP = 0.50
_ACCOMP_CONF_SUSTAIN = 0.35
_ACCOMP_SUSTAIN_MIN_SEC = 0.30

# #132: accompaniment re-articulates the same pitch constantly — bass
# quarters, repeated chord stabs — and the lead-line 30 ms merge gap
# swallowed those onsets wholesale (58 floored detections collapsed to
# 19 on the JPOP-mix stem; the recall collapse behind a near-empty
# 伴奏 staff).  Zero keeps true overlaps merging — a split
# detection's fragments still overlap — while every real re-attack
# survives.  Applied at BOTH merge gates on the accomp path
# (split_voices and the per-voice clean) so neither re-fuses what the
# other released.
_ACCOMP_MERGE_GAP_SEC = 0.0
# #183: a concurrent-ghost pair needs two real attacks — a
# same-pitch note ending within this slack of the would-be
# fundamental's onset marks a continuation fragment that anchors
# nothing, so a pad chord tone is not eaten by a bass detector split.
_ACCOMP_GHOST_ATTACK_SLACK_SEC = 0.03
# #147: accompaniment onsets need a couple of periods of coverage
# before they vote on meter — below this the stem-envelope channel
# supplies the accompaniment evidence instead (and a same-source
# channel is never scored twice).
_ACCOMP_METER_MIN_ACCENTS = 8


def _accomp_confidence_floor(
    events: tuple[RawNoteEvent, ...],
) -> tuple[RawNoteEvent, ...]:
    """Drop short low-confidence flicker from accompaniment events.

    Keep when confident (>= _ACCOMP_CONF_KEEP), or when the note at
    least reaches the sustain floor AND holds long enough to be a real
    backing tone rather than a partial flicker.
    """
    kept = [
        e
        for e in events
        if float(e.confidence or 0.0) >= _ACCOMP_CONF_KEEP
        or (
            float(e.confidence or 0.0) >= _ACCOMP_CONF_SUSTAIN
            and float(e.offset_sec - e.onset_sec) >= _ACCOMP_SUSTAIN_MIN_SEC
        )
    ]
    return tuple(kept)


# #155: a contained same-pitch event within this tolerance of the
# covering event's edges describes the same physical tone — the two
# detections are not a performable unison.
_ACCOMP_UNISON_TOL_SEC = 0.03


def _dedup_accomp_unison(
    accomp_cleaned: list[CleanedEvents],
    bands: _AccompBands | None = None,
) -> list[CleanedEvents]:
    """Drop same-pitch events fully contained in a longer one (#155).

    One physical tone can be detected twice — once per surviving
    voice after split_voices, or once by the tracker and once by the
    spectral pad miner (_accomp_pad_completion): the shorter
    duplicate stacks a unison no player can perform and reads as
    score clutter. Containment (same pitch, a longer event covering
    the span within _ACCOMP_UNISON_TOL_SEC) means the two detections
    describe one tone, so the shorter goes. Identical twins keep
    the first occurrence.

    With band evidence a second pass unions a partially overlapping
    same-pitch pair shaped exactly like the mid-sustain failure: the
    miner's run started first and the tracker fired INSIDE it — the
    band says the tone began at the mined onset, so the detected
    onset is a phantom and the pair unions into the mined event.
    A later mined fragment of the same run unions in the same way —
    the miner can split one held tone across a local mask dip, and
    ``run_start`` reaching back to the union's onset proves the piece
    belongs to it rather than to a re-attack (#172). The mirror
    shape (tracker event first, a fresh mined run starting inside
    it) is kept: the miner's own run boundary is a re-attack
    signature, and a detector+detector overlap cannot be told from a
    real re-attack at all.
    """
    events = [e for c in accomp_cleaned for e in c.events]
    if len(events) < 2:
        return accomp_cleaned
    drop: set[int] = set()
    grown: dict[int, RawNoteEvent] = {}
    for i, e in enumerate(events):
        e_len = e.offset_sec - e.onset_sec
        for j, o in enumerate(events):
            if i == j:
                continue
            if int(round(o.pitch_midi)) != int(round(e.pitch_midi)):
                continue
            if (
                o.onset_sec > e.onset_sec + _ACCOMP_UNISON_TOL_SEC
                or o.offset_sec < e.offset_sec - _ACCOMP_UNISON_TOL_SEC
            ):
                continue
            # The cover must be a strictly better representative:
            # longer always wins; exact twins keep the first entry.
            # The old 'longer or j < i' dropped BOTH members of a
            # mutual-tolerance pair -- each found the other a legal
            # killer (the shorter via 'longer', the longer via 'first
            # listed') -- and two covers of one strike died together
            # (#185, mined 14.512-15.0 vs backdated det 14.533-14.986).
            o_len = o.offset_sec - o.onset_sec
            if o_len > e_len or (o_len == e_len and j < i):
                drop.add(i)
                break
    if bands is not None:
        by_pitch: dict[int, list[int]] = {}
        for k, e in enumerate(events):
            if k not in drop:
                by_pitch.setdefault(int(round(e.pitch_midi)), []).append(k)
        for idxs in by_pitch.values():
            idxs.sort(key=lambda k: events[k].onset_sec)
            cur = idxs[0]
            cur_ev = grown.get(cur, events[cur])
            for k in idxs[1:]:
                e = events[k]
                if e.onset_sec >= cur_ev.offset_sec - _ACCOMP_UNISON_TOL_SEC:
                    cur, cur_ev = k, e
                    continue
                run = bands.run_start(e.pitch_midi, e.onset_sec)
                if (
                    cur_ev.source == "pad-completion"
                    and run is not None
                    and run <= cur_ev.onset_sec + _ACCOMP_UNISON_TOL_SEC
                ):
                    cur_ev = _extend(
                        cur_ev, e.offset_sec, e.confidence, e.pitch_bends
                    )
                    grown[cur] = cur_ev
                    drop.add(k)
                else:
                    cur, cur_ev = k, e
    if not drop and not grown:
        return accomp_cleaned
    out: list[CleanedEvents] = []
    base = 0
    for c in accomp_cleaned:
        kept = tuple(
            grown.get(base + k, e)
            for k, e in enumerate(c.events)
            if (base + k) not in drop
        )
        base += len(c.events)
        if kept != c.events:
            c = replace(c, events=kept)
        if c.events:
            out.append(c)
    return out


def _pad_event_voices(
    pad_extra: tuple[RawNoteEvent, ...],
) -> list[CleanedEvents]:
    """Mined pad events -> one monophonic voice per pitch (#169).

    A single blob would read as one monophonic voice and the
    quantizer would stagger simultaneous chord members into adjacent
    grid slots (each extra 16th pushes a member out of its truth's
    onset window). Per-pitch voices keep chord onsets aligned; the
    score build merges them back into one accompaniment staff as
    real chords.
    """
    by_pitch: dict[int, list[RawNoteEvent]] = {}
    for e in pad_extra:
        by_pitch.setdefault(int(round(e.pitch_midi)), []).append(e)
    return [
        CleanedEvents(
            events=tuple(
                sorted(grp, key=lambda e: (e.onset_sec, e.offset_sec))
            ),
            dropped_too_short=0,
            merged=0,
            clipped_overlaps=0,
        )
        for grp in by_pitch.values()
    ]


# #160: the accompaniment stem answers seam questions per pitch — a
# drum hit inside the broadband flux window reads as a re-attack to
# the lead-line seam check and vetoes the merge of a held pad the
# detector split (14 of 20 split seams on the JPOP-mix stem sat under
# an unrelated transient). The stem's per-midi band energy asks the
# right question instead: when the band dips through the seam the
# neighbour is a real re-articulation (bass quarters measure 0.26-
# 0.57 of their span level), when it stays elevated the fragments are
# one sustained tone (pad splits measure 0.87-1.40).
_ACCOMP_SEAM_BAND_DIP = 0.70
# A wider silence is a real rest — merging across it would notate a
# held tone where the player breathed.
_ACCOMP_SEAM_MAX_GAP_SEC = 0.12

# #155: a sustained accompaniment tone can be "found" late — Basic
# Pitch fires a mid-sustain onset inside a held pad member and the
# onset lands as a false note (the band evidence says the tone has
# been sounding for seconds). Walk the band's hot mask back to where
# the run actually started; only a gain beyond this floor is a real
# late-onset correction, anything smaller is window smear.
_ACCOMP_BACKDATE_MIN_SEC = 0.18
# #172: a same-pitch re-onset folds into its predecessor when the band
# run containing it reaches back to the predecessor's own onset — the
# dropout bridge inside run_start says the tone never released (a
# local mask dip let go mid-sustain and the detector re-fired). A real
# re-attack starts a LATER run instead. The epsilon covers detector
# onset lateness vs the band's measured rise.
_ACCOMP_RUN_CONT_EPS_SEC = 0.1
# A few cold frames inside a run are a transient dip (a drum hit or
# the pad's own beating envelope), not the end of the tone — bridged
# unconditionally because the only consumer is onset backdating,
# which is bounded below by the predecessor's offset anyway.
_ACCOMP_RUN_HOLE_FRAMES = 4
# A vocal-mask dropout has a signature a real release cannot fake:
# the WHOLE band census collapses for a bounded span while the lead
# sings (measured 9-16 hot bands -> ~3 on the JPOP stem). A real
# release silences its own band only. Bridging is refused in sparse
# textures — with only a couple of bands standing, a solo line's
# rest is indistinguishable from a mask event, and today's behaviour
# is the honest one.
_ACCOMP_DROPOUT_MAX_SEC = 0.6
_ACCOMP_DROPOUT_MIN_SURROUND = 6
_ACCOMP_DROPOUT_MIN_COLLAPSE = 0.5
# The detector can split a note at a real re-attack boundary into
# <note><sliver><note>: a sub-90 ms island abutting same-pitch events
# on both sides is boundary noise, not a playable 32nd.
_ACCOMP_SLIVER_MAX_SEC = 0.09
_ACCOMP_SLIVER_GAP_SEC = 0.03
# #136 pad-mining bounds — hoisted above _AccompBands because the
# class defaults run_start/sustained kwargs off them.
_ACCOMP_PAD_MIN_SUSTAIN_SEC = 0.45
_ACCOMP_PAD_MIDI_LO = 36
_ACCOMP_PAD_MIDI_HI = 84
_ACCOMP_PAD_AMP_RATIO = 0.40
# A real chord pads out at a handful of simultaneous tones; a broadband
# wash (cymbals, noise bed) lights up dozens of bands at once. Cap the
# simultaneous count so a wash cannot mint a wall of fake pads.
_ACCOMP_PAD_MAX_SIMULTANEOUS = 6
# A pad chord restrikes on the beat even though one member's band can
# run straight through the boundary (its energy never dipped). The
# re-strike is still visible: the OTHER members' runs all start
# together. Two or more new pad-band onsets inside this window are a
# chord onset; a sustained band crossing one is split so the score
# shows the repeated hit instead of one long tied tone. The margin
# keeps genuine short re-strikes while refusing hairline cuts.
_ACCOMP_PAD_REATTACK_CLUSTER_SEC = 0.15
_ACCOMP_PAD_SPLIT_MARGIN_SEC = 0.3
# #171: the 0.3 s margin was sized for half-bar chord moves — an
# eighth-note strike train (234 ms at 128 BPM) fails it on both sides
# and every re-strike merges into one held note. The margin now adapts
# to the locally observed onset spacing (40% of the nearest neighbour
# interval) with this floor, below which a mined "note" is hairline
# notation noise anyway.
_ACCOMP_PAD_SPLIT_MARGIN_MIN_SEC = 0.12
# #171: a fast-tier chord onset needs more members than a strong one —
# a drum hit raises broadband flux everywhere at once, so the pad-only
# re-strike signature is several previously-hot bands rising together.
# #177: >=3 was unreachable on attenuated stems — a center-extraction
# stem cuts panned members below the amp floor, so a real 3-note pad
# strike shows only 1-2 usable bands. The strong tier already treats
# >=2 simultaneous starts as a chord; the flux tier now matches, and
# the lattice pass below recovers the strikes that still fall short.
_ACCOMP_PAD_FLUX_MIN_MEMBERS = 2
# A flux-tier onset is refused when the census was already dead this
# long — ~5 frames and up is a mask-dropout recovery, not the 1-2
# frame release gap of a real re-strike (#171).
_ACCOMP_PAD_FLUX_DEAD_MAX_SEC = 0.115
# #177 lattice promotion — once strict events prove a strike grid
# exists, the interior grid points only need a soft signature: a real
# eighth-note ostinato lets every OTHER hit fall under the per-band
# flux threshold (weak strikes sit at the band's own jitter median).
# A peak qualifies for support at this fraction of its band's
# threshold; a promoted grid point still needs >=3 support members
# with >=1 hard peak among them.
_ACCOMP_PAD_FLUX_SOFT = 0.45
_ACCOMP_PAD_LATTICE_MIN_SUPPORT = 3
# Grid sanity bounds: only gaps this size or smaller subdivide (a
# longer span is a held-chord region, not a strike train), grid steps
# outside this range are notation noise, and a support peak aligns
# with a grid point inside this tolerance.
_ACCOMP_PAD_LATTICE_MAX_GAP_SEC = 1.4
_ACCOMP_PAD_LATTICE_STEP_MIN_SEC = 0.15
_ACCOMP_PAD_LATTICE_STEP_MAX_SEC = 0.7
_ACCOMP_PAD_LATTICE_ALIGN_SEC = 0.1
_ACCOMP_PAD_LATTICE_MAX_SUBDIV = 8
# Interior coverage — a subdivision is only adopted when this share
# of its interior grid points actually carries a support cluster, so
# a partial grid (one lucky jitter coincidence) mints nothing.
_ACCOMP_PAD_LATTICE_COVERAGE = 0.6
# #177: one strike's members can straggle across the cluster window
# and mint two flux onsets ~150 ms apart. Events this close sharing
# a member are one strike — fuse them (the lattice never mints steps
# below _ACCOMP_PAD_LATTICE_STEP_MIN_SEC, so same-tier neighbours
# this near are duplicates, not a finer real grid).
_ACCOMP_PAD_FLUX_FUSE_SEC = 0.19
# #179: a re-struck pad member releases for ~1-2 frames between hits;
# on an attenuated stem that dip drops the whole band under its hot
# threshold, fragmenting the run below the min-sustain floor so the
# miner never sees the member at all. Bridge release gaps this short
# inside the mining walk only — a real release holds the band cold
# far longer, and the strong tier keeps its unbridged runs because a
# merged strike train would erase the chord-change starts it needs.
_ACCOMP_PAD_BRIDGE_FRAMES = 4


def _pitch_band_energy(spec: Any, freqs: Any, midi: int) -> Any:
    """One +-45 cent pitch band's energy track over an STFT magnitude."""
    lo = 440.0 * 2 ** ((midi - 69 - 0.45) / 12)
    hi = 440.0 * 2 ** ((midi - 69 + 0.45) / 12)
    return spec[(freqs >= lo) & (freqs <= hi)].sum(axis=0)


def _sustained_band_matrix(
    spec: Any, freqs: Any, mids: list[int] | tuple[int, ...]
) -> tuple[Any, list[Any]]:
    """(band_e, hot) — per-midi band energy + the sustain signature.

    hot = band is the local MIDI maximum (+-1 semitone) AND elevated
    above the stem-wide spectral floor (crest-relative backstop). One
    definition shared by the pad miner (#136), the onset backdater and
    the continuity merge (#155) so "sustained tone" means the same
    thing to all three.
    """
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    band_e = np.stack([_pitch_band_energy(spec, freqs, m) for m in mids])
    # Elevated = clearly above the stem's quiet spectral floor. A
    # per-band history baseline fails on a pure-sustain stem (the
    # pad IS its own baseline) — measure against the floor shared
    # by every band instead, with a crest-relative backstop.
    floor_g = float(np.percentile(band_e, 30))
    hot: list[Any] = []
    for i in range(len(mids)):
        e = band_e[i]
        lo = max(0, i - 1)
        hi = min(len(mids), i + 2)
        is_peak = e >= band_e[lo:hi].max(axis=0) * 0.999
        peak = (
            float(np.percentile(e[is_peak], 90)) if bool(is_peak.any()) else 0.0
        )
        thresh = max(floor_g * 2.0, peak * 0.22)
        hot.append((e > thresh) & is_peak)
    return band_e, hot


def _hot_run_spans(
    mids: list[int] | tuple[int, ...],
    band_e: Any,
    hot: list[Any],
    times: Any,
    min_sustain_sec: float,
    *,
    hole_frames: int = 0,
) -> list[tuple[float, float, int, float]]:
    """Contiguous hot runs >= min_sustain_sec -> (onset, offset, midi, mean_amp).

    ``hole_frames`` (#179) bridges cold gaps that short inside a run:
    a re-struck member releases for only ~1-2 frames between hits —
    on an attenuated stem that dip drops the whole band under its
    threshold, leaving sub-minimum fragments that vanish before the
    miner ever sees them. A real release holds the band cold far
    longer, so nothing real fuses. The strong-tier callers keep 0 —
    bridging a strike train into one run would erase the chord-change
    starts it exists to find.
    """
    out: list[tuple[float, float, int, float]] = []
    dt = float(times[1] - times[0])
    for i, m in enumerate(mids):
        e = band_e[i]
        h = hot[i]
        k = 0
        while k < len(h):
            if not h[k]:
                k += 1
                continue
            j = k
            while j < len(h) and h[j]:
                j += 1
            while hole_frames:
                # j sits on the first cold frame after the hot block;
                # extend through the gap only if it ends inside the
                # hole budget AND something hot still follows.
                jj = j
                while jj < len(h) and not h[jj] and jj - j <= hole_frames:
                    jj += 1
                if jj < len(h) and h[jj] and jj - j <= hole_frames:
                    j = jj
                    while j < len(h) and h[j]:
                        j += 1
                else:
                    break
            if (j - k) * dt >= min_sustain_sec:
                out.append(
                    (
                        float(times[k]),
                        float(times[min(j, len(times) - 1)]),
                        m,
                        float(e[k:j].mean()),
                    )
                )
            k = j
    return out


def _fuse_flux_events(
    events: list[tuple[float, frozenset[int], str]],
) -> list[tuple[float, frozenset[int], str]]:
    """Merge same-tier neighbour onsets that are one strike (#177).

    One hit's member bands can straggle across the cluster window and
    mint two flux onsets ~150 ms apart. Same-tier neighbours this
    close that share a member band are one strike — fuse them, keep
    the larger cluster's measured time, union the members so every
    re-attacked band's run is still cut. The lattice never mints
    steps below _ACCOMP_PAD_LATTICE_STEP_MIN_SEC, so flux neighbours
    this near are duplicates rather than a finer real grid.
    """
    fused: list[tuple[float, frozenset[int], str]] = []
    for t, mem, kind in events:
        if (
            fused
            and kind == "flux"
            and fused[-1][2] == "flux"
            and t - fused[-1][0] <= _ACCOMP_PAD_FLUX_FUSE_SEC
            and mem & fused[-1][1]
        ):
            pt, pmem, pk = fused[-1]
            keep_t = pt if len(pmem) >= len(mem) else t
            fused[-1] = (keep_t, pmem | mem, pk)
        else:
            fused.append((t, mem, kind))
    return fused


def _expand_flux_members(
    events: list[tuple[float, frozenset[int], str]],
    support_peaks: list[tuple[float, int]],
) -> list[tuple[float, frozenset[int], str]]:
    """Grow each flux onset's member set to every band that rose (#181).

    A member whose re-strike lands just under its hard flux bar still
    re-attacked for real — the member set decides which held runs a
    flux onset may cut, so membership must be the whole support
    signature at the strike, not only the hard proof bands that
    certified the event itself. Strong-tier events keep their
    measured member set: they cut every held run regardless.
    """
    if not support_peaks:
        return events
    out: list[tuple[float, frozenset[int], str]] = []
    for t, mem, kind in events:
        if kind != "flux":
            out.append((t, mem, kind))
            continue
        soft = frozenset(
            m
            for s, m in support_peaks
            if abs(s - t) <= _ACCOMP_PAD_LATTICE_ALIGN_SEC
        )
        out.append((t, soft or mem, kind))
    return out


class _AccompBands:
    """Per-midi band evidence over one accompaniment stem (#155).

    The accompaniment stem answers three spectral questions — seam
    continuity (#160), onset-run backdating (#155) and sustained-band
    mining (#136). Each needs the same magnitude STFT, so build it
    once here and let every consumer read from it.

    ``time_offset_sec`` maps job-timeline seconds onto the stem's own
    axis (the stem covers the backend input span only): public methods
    take and return job-timeline seconds.
    """

    __slots__ = (
        "_band_e",
        "_cache",
        "_chord_events",
        "_chord_onsets",
        "_frames",
        "_freqs",
        "_hot",
        "_hot_matrix",
        "_mids",
        "_n_hot",
        "_offset",
        "_spec",
        "_spf",
    )

    def __init__(
        self, spec: Any, sample_rate: int, *, time_offset_sec: float = 0.0
    ) -> None:
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        self._spec = spec
        self._freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=4096)
        self._spf = 512.0 / sample_rate
        self._frames = spec.shape[1]
        self._offset = float(time_offset_sec)
        self._cache: dict[int, Any] = {}
        self._mids = tuple(
            range(_ACCOMP_PAD_MIDI_LO, _ACCOMP_PAD_MIDI_HI + 1)
        )
        self._band_e, self._hot = _sustained_band_matrix(
            spec, self._freqs, self._mids
        )
        self._hot_matrix = np.stack(self._hot)
        self._n_hot = self._hot_matrix.sum(axis=0)
        # Chord onsets (stem-axis seconds): times where >=2 sustained
        # pad-band runs start together — a chord re-strike signature.
        # A band can hold straight through it, so a hot-run walk that
        # crosses one may be looking at a re-attacked tone, not the
        # run's true start (the same evidence the pad miner's
        # re-strike split uses).
        # Consolidate + amp-gate exactly like the pad miner first: a
        # lone weak fragment restarting mid-bar is band noise, not a
        # chord — real re-strikes start several strong members at once.
        # Chord onsets (stem-axis seconds): moments where several
        # sustained bands start together — the re-strike signature.
        # Two tiers (#171):
        #   "strong": merged-run starts — the classic chord move.
        #   "flux":   per-band log-flux re-attack peaks — a pad
        #             restruck every eighth note never lets the hot
        #             mask toggle off (the 186 ms window smears the
        #             release) but every hit RISES the band energy.
        #             Admitted only when >=3 distinct bands rise
        #             together (a drum hit's broadband rise is wider
        #             but its members were not recently-hot pad
        #             bands), the band was hot recently before the
        #             rise (a re-attack, not a fresh attack), and the
        #             preceding census did not collapse (mask
        #             recovery, not a replayed chord).
        runs = _merge_band_fragments(
            _hot_run_spans(
                self._mids,
                self._band_e,
                self._hot,
                np.arange(self._frames, dtype=np.float64) * self._spf,
                _ACCOMP_PAD_MIN_SUSTAIN_SEC,
            )
        )
        amp_floor = (
            max(a for *_x, a in runs) * _ACCOMP_PAD_AMP_RATIO
            if runs
            else 0.0
        )

        def cluster(
            starts: list[tuple[float, int]],
        ) -> list[tuple[float, frozenset[int]]]:
            out: list[tuple[float, frozenset[int]]] = []
            i = 0
            while i < len(starts):
                j = i
                while (
                    j + 1 < len(starts)
                    and starts[j + 1][0] - starts[i][0]
                    <= _ACCOMP_PAD_REATTACK_CLUSTER_SEC
                ):
                    j += 1
                members = {m for _s, m in starts[i : j + 1]}
                if len(members) >= 2:
                    out.append((starts[i][0], frozenset(members)))
                i = j + 1
            return out

        events: list[tuple[float, frozenset[int], str]] = [
            (t, mem, "strong")
            for t, mem in cluster(
                sorted((s, m) for s, _e, m, a in runs if a >= amp_floor)
            )
        ]
        # #177: the amp gate is calibrated per band — a member panned
        # off-centre survives the stem at half the level of the loudest
        # run and a global floor on the max would mute its every hit.
        # Bands with at least one sustained run answer to their own
        # scale; run-less bands keep the global floor (a noise band
        # cannot self-certify).
        band_amp: dict[int, float] = {}
        for _s, _e, m, a in runs:
            band_amp[m] = max(band_amp.get(m, 0.0), a)
        band_floor = {
            m: min(amp_floor, a * _ACCOMP_PAD_AMP_RATIO)
            for m, a in band_amp.items()
        }
        hard_peaks = self._reattack_peaks(amp_floor, band_floor)
        for t, mem in cluster(hard_peaks):
            if len(mem) < _ACCOMP_PAD_FLUX_MIN_MEMBERS:
                continue
            if any(
                abs(t - t0) <= _ACCOMP_PAD_REATTACK_CLUSTER_SEC
                for t0, _m, _k in events
            ):
                continue
            jt = int(t / self._spf)
            if self._dead_span_sec(jt) >= _ACCOMP_PAD_FLUX_DEAD_MAX_SEC:
                continue
            events.append((t, mem, "flux"))
        events.sort(key=lambda x: x[0])
        # #177: strict events anchor the strike grid — interior grid
        # points join on the softer support signature.
        support_peaks = self._reattack_peaks(
            amp_floor, band_floor, thr_scale=_ACCOMP_PAD_FLUX_SOFT
        )
        events.extend(
            self._lattice_flux(hard_peaks, support_peaks, events)
        )
        events.sort(key=lambda x: x[0])
        events = _fuse_flux_events(events)
        # #181: a member whose rise lands just under the hard bar
        # still re-attacked — the member set decides which held runs
        # a flux onset may cut, so count every band with a
        # support-level peak at the strike.
        events = _expand_flux_members(events, support_peaks)
        self._chord_events = events
        self._chord_onsets = [t for t, _m, _k in events]

    def _reattack_peaks(
        self,
        amp_floor: float,
        band_floor: dict[int, float] | None = None,
        thr_scale: float = 1.0,
    ) -> list[tuple[float, int]]:
        """(sec, midi) per-band re-attack rises over the hot mask (#171).

        A re-struck pad raises its band's log-energy sharply at every
        hit even though the release between hits is too short for the
        hot mask to toggle — the mask sees one long run, the flux sees
        every strike. A peak counts only when the band was hot within
        the preceding ~0.23 s: a fresh attack is the strong tier's
        job, and a band coming back after a real rest is not a
        re-attack either. The absolute amp gate matters too — noise
        floor bands flicker "hot" whenever the real bands breathe, and
        their mid-gap rises would otherwise mint aligned fake onsets
        that shadow the true strikes.

        ``band_floor`` (#177) overrides the global amp gate for bands
        that already proved they sustain — a quiet member answers to
        its own scale. ``thr_scale`` admits softer peaks for the
        lattice pass: real strikes alternate around the per-band
        threshold on an attenuated stem.
        """
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        le = np.log1p(self._band_e * 1e4)
        flux = np.maximum(0.0, np.diff(le, axis=1))
        recent = int(0.23 / self._spf)
        out: list[tuple[float, int]] = []
        for i, m in enumerate(self._mids):
            f = flux[i]
            pos = f[f > 0]
            if pos.size == 0:
                continue
            thr = (
                max(0.22 * float(f.max()), 1.5 * float(np.median(pos)))
                * thr_scale
            )
            hot = self._hot[i]
            e = self._band_e[i]
            floor = (
                band_floor.get(m, amp_floor)
                if band_floor is not None
                else amp_floor
            )
            for k in range(1, f.size - 1):
                if (
                    f[k] < thr
                    or f[k] < f[k - 1]
                    or f[k] <= f[k + 1]
                ):
                    continue
                if not hot[max(0, k - recent) : k].any():
                    continue
                if float(e[k : k + 3].mean()) < floor:
                    continue
                out.append((k * self._spf, m))
        return sorted(out)

    def _lattice_flux(
        self,
        hard: list[tuple[float, int]],
        support: list[tuple[float, int]],
        events: list[tuple[float, frozenset[int], str]],
    ) -> list[tuple[float, frozenset[int], str]]:
        """Interior grid onsets between established anchors (#177).

        A strict event proves a strike grid exists locally; an
        eighth-note ostinato lets every OTHER hit dip under the
        per-band flux threshold (a weak strike sits at the band's own
        jitter median, so amplitude alone cannot certify it). Between
        two anchors <=1.4 s apart where at least one is already a
        flux event, try evenly spaced subdivisions: the finest grid
        whose interior points mostly carry a support cluster is the
        measured strike rate, and each covered interior point mints a
        flux onset at its members' measured rise.

        Guards that keep a held chord honest:
          * a support peak is assigned to its NEAREST grid point only
            — a loose alignment window cannot count one rise twice;
          * a point needs >=3 support members including >=1 hard
            peak — held-chord jitter on one band mints nothing;
          * the gap needs a flux anchor — strong-to-strong spans
            (real chord changes) never subdivide, so a sustained pad
            under a drum grid is left whole;
          * coverage must reach the threshold or the whole
            subdivision is refused — partial grids mint nothing.
        """
        import math  # noqa: PLC0415 - lazy optional dependency

        if len(events) < 2 or not support:
            return []
        win = _ACCOMP_PAD_LATTICE_ALIGN_SEC
        out: list[tuple[float, frozenset[int], str]] = []
        sup_t = [s for s, _m in support]
        hard_t = [s for s, _m in hard]
        for i in range(len(events) - 1):
            t0, _m0, k0 = events[i]
            t1, _m1, k1 = events[i + 1]
            if "flux" not in (k0, k1):
                continue
            gap = t1 - t0
            if not (0.3 <= gap <= _ACCOMP_PAD_LATTICE_MAX_GAP_SEC):
                continue
            for sub in range(_ACCOMP_PAD_LATTICE_MAX_SUBDIV, 1, -1):
                step = gap / sub
                if (
                    step < _ACCOMP_PAD_LATTICE_STEP_MIN_SEC
                    or step > _ACCOMP_PAD_LATTICE_STEP_MAX_SEC
                ):
                    continue
                pts = [t0 + j * step for j in range(1, sub)]
                # Each peak belongs to exactly its nearest grid point
                # (ties break to the earlier one) — one rise must not
                # certify two candidates.
                nearest = [
                    min(range(len(pts)), key=lambda jj: abs(s - pts[jj]))
                    for s, _m in support
                ]
                nearest_hard = [
                    min(range(len(pts)), key=lambda jj: abs(s - pts[jj]))
                    for s in hard_t
                ]
                covered: list[tuple[float, frozenset[int]]] = []
                for j, tp in enumerate(pts):
                    mem = {
                        support[p][1]
                        for p, s in enumerate(sup_t)
                        if abs(s - tp) <= win and nearest[p] == j
                    }
                    has_hard = any(
                        abs(s - tp) <= win and nearest_hard[p] == j
                        for p, s in enumerate(hard_t)
                    )
                    if (
                        len(mem) >= _ACCOMP_PAD_LATTICE_MIN_SUPPORT
                        and has_hard
                    ):
                        covered.append((tp, frozenset(mem)))
                need = max(
                    1, math.ceil(_ACCOMP_PAD_LATTICE_COVERAGE * len(pts))
                )
                if len(covered) < need:
                    continue
                for tp, mem in covered:
                    if any(
                        abs(tp - t) <= _ACCOMP_PAD_REATTACK_CLUSTER_SEC
                        for t, _m, _k in events
                    ):
                        continue
                    jt = int(tp / self._spf)
                    if (
                        self._dead_span_sec(jt)
                        >= _ACCOMP_PAD_FLUX_DEAD_MAX_SEC
                    ):
                        continue
                    out.append((tp, mem, "flux"))
                break
        return out

    def _band(self, m: int) -> Any:
        if m not in self._cache:
            self._cache[m] = _pitch_band_energy(self._spec, self._freqs, m)
        return self._cache[m]

    def separated(self, a: RawNoteEvent, b: RawNoteEvent) -> bool:
        """True when the band dips through the a->b seam (#160)."""
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        m = int(round(0.5 * (a.pitch_midi + b.pitch_midi)))
        e = self._band(m)
        # The union span's median is the band's own "sounding" level —
        # a trough below _ACCOMP_SEAM_BAND_DIP of it means the tone
        # actually stopped between the two detections.
        i0 = max(0, int((a.onset_sec - self._offset) / self._spf))
        i1 = min(self._frames, int((b.offset_sec - self._offset) / self._spf) + 1)
        if i1 <= i0:
            return True  # out-of-range events: keep the seam
        med = float(np.median(e[i0:i1]))
        if med <= 0.0:
            return True  # silent band carries no merge evidence
        lo = a.offset_sec - self._offset
        hi = b.onset_sec - self._offset
        if hi - lo > self._spf:
            j0 = max(0, int(lo / self._spf))
            j1 = min(self._frames, int(hi / self._spf) + 1)
            trough = float(e[j0:j1].min())
        else:
            # Abutting/overlapping detections: the seam is one instant —
            # take the band minimum within a frame of it so a real
            # 30 ms release still registers.
            mid = 0.5 * (lo + hi)
            j0 = max(0, int((mid - self._spf) / self._spf))
            j1 = min(self._frames, int((mid + self._spf) / self._spf) + 1)
            trough = float(e[j0:j1].min()) if j1 > j0 else 0.0
        return trough < _ACCOMP_SEAM_BAND_DIP * med

    def attack_evidence(self, midi: float, onset_sec: float) -> bool:
        """True when the band posts a real attack at ``onset_sec`` (#172).

        Both conjuncts required: the hot mask is on at the onset
        instant (a mask-recovery refire happens while the band is
        still cold and ramping back), AND the band's log-flux at the
        onset is attack-strength — measured on the JPOP stem the
        mask's re-hot edge posts ~0.12 while even the softest real
        re-strike (bass quarter) posts ~0.29, so 0.15 sits between.
        A near-legato re-strike that never toggles the hot mask
        still passes — its flux carries the signature — while a
        refire on the dip's falling edge shows flux ~0.
        """
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        m = int(round(midi))
        if m < self._mids[0] or m > self._mids[-1]:
            return True  # outside the mined range: cannot veto
        j = int((onset_sec - self._offset) / self._spf)
        if not 0 <= j < self._frames:
            return True
        i = m - self._mids[0]
        hot = self._hot[i]
        if not bool(hot[max(0, j - 2) : min(self._frames, j + 3)].any()):
            return False
        le = np.log1p(self._band_e[i] * 1e4)
        flux = np.maximum(0.0, np.diff(le))
        w = flux[max(0, j - 3) : min(self._frames - 1, j + 4)]
        return bool(w.size) and float(w.max()) >= 0.15

    def run_start(self, midi: float, onset_sec: float) -> float | None:
        """Job-time start of the sustained run containing ``onset_sec``.

        The tone under a detection may have started long before the
        tracker fired — walk the pitch band's hot mask left until the
        run ends. Returns job-timeline seconds, or None when the band
        offers no evidence (pitch out of the mined range, or no hot
        frame near the onset — a genuine attack). Cold stretches of at
        most ``_ACCOMP_RUN_HOLE_FRAMES`` frames always bridge;
        longer ones bridge only when ``_mask_dropout`` sees the
        whole band census collapse — the vocal mask's signature, not
        a real release.
        """
        m = int(round(midi))
        if m < self._mids[0] or m > self._mids[-1]:
            return None
        j0 = int((onset_sec - self._offset) / self._spf)
        if not 0 <= j0 < self._frames:
            return None
        hot = self._hot[m - self._mids[0]]
        # The detector onset may itself land inside a mask dropout —
        # a cold frame or two — while the tone runs on underneath.
        # Anchor the walk on the nearest hot frame instead of
        # refusing outright.
        j = j0
        if not bool(hot[j0]):
            nxt = j0 + 1
            while (
                nxt < self._frames
                and nxt <= j0 + _ACCOMP_RUN_HOLE_FRAMES
                and not bool(hot[nxt])
            ):
                nxt += 1
            if nxt >= self._frames or not bool(hot[nxt]):
                return None
            j = nxt
        k = j - 1
        while k >= 0:
            if bool(hot[k]):
                j = k
                k -= 1
                continue
            # A cold stretch: tiny holes always bridge; longer ones
            # only when the whole band census collapsed — the vocal
            # mask's signature — not when this one band released.
            e = k
            while e >= 0 and not bool(hot[e]):
                e -= 1
            stretch = k - e
            if (
                stretch <= _ACCOMP_RUN_HOLE_FRAMES
                or self._mask_dropout(e + 1, k)
            ):
                k = e
                continue
            break
        rs = j * self._spf
        onset_stem = onset_sec - self._offset
        # A chord onset inside the run is a likely re-strike — the
        # tone may re-attack there while its own band never dips.
        # Return the latest one instead of the run's older start.
        later = [
            t
            for t, mem, tier in self._chord_events
            if rs + 0.05 < t <= onset_stem
            # #171: a flux-tier onset is a re-attack signature of ITS
            # member bands only — a foreign pad re-striking elsewhere
            # must not pull this band's sustained onset forward.
            and (tier != "flux" or int(round(midi)) in mem)
        ]
        if later:
            rs = max(later)
        return rs + self._offset

    def _mask_dropout(self, cold_lo: int, cold_hi: int) -> bool:
        """True when a cold stretch is the vocal mask eating the stem.

        The mask suppresses every non-vocal band while the lead sings:
        at the stretch's deepest frame almost none of the bands that
        were hot just before it are still standing. A real release
        silences its own band only — the rest of the matrix keeps
        sounding. Bounded in length — a longer silence is trusted as
        a rest — and refused under sparse textures where a solo
        line's band is nearly the whole census anyway.
        """
        span_sec = (cold_hi - cold_lo + 1) * self._spf
        if span_sec > _ACCOMP_DROPOUT_MAX_SEC:
            return False
        return self._census_collapsed(cold_lo, cold_hi)

    def _dead_span_sec(self, jt: int) -> float:
        """Contiguous near-silent census ending at frame ``jt`` (#171).

        A vocal-mask dropout silences the WHOLE stem for a stretch
        (0.2-0.6 s) before the bands come back together — that recovery
        is not a chord re-strike. A re-struck pad silences its members
        for only a frame or two, and only the struck bands. Depth alone
        cannot tell them apart (a pad-only texture's strike gap IS a
        census collapse), so measure the contiguous low-census run just
        before the candidate onset instead; the level tracks the local
        census median so dense textures are untouched.
        """
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        look = max(1, int(0.5 / self._spf))
        base = self._n_hot[max(0, jt - look) : jt + 1]
        lvl = max(
            2.0, 0.25 * float(np.median(base)) if base.size else 2.0
        )
        j = jt - 1
        while j >= 0 and self._n_hot[j] <= lvl:
            j -= 1
        return (jt - 1 - j) * self._spf

    def _census_collapsed(self, cold_lo: int, cold_hi: int) -> bool:
        """Whole-census collapse inside [cold_lo, cold_hi] frames.

        The shared core of the dropout signature (#171 also applies it
        to the window before a fragment-level chord onset: aligned
        restarts after a real collapse are mask recovery, not a pad
        being replayed).
        """
        seg = self._n_hot[cold_lo : cold_hi + 1]
        if seg.size == 0:
            return False
        jdeep = cold_lo + int(seg.argmin())
        prev = self._hot_matrix[:, max(0, cold_lo - 4) : cold_lo].any(axis=1)
        n_prev = int(prev.sum())
        if n_prev < _ACCOMP_DROPOUT_MIN_SURROUND:
            return False
        survived = prev & self._hot_matrix[:, jdeep]
        return (
            1.0 - float(survived.sum()) / float(n_prev)
            >= _ACCOMP_DROPOUT_MIN_COLLAPSE
        )

    def sustained(
        self,
        min_sustain_sec: float = _ACCOMP_PAD_MIN_SUSTAIN_SEC,
        *,
        hole_frames: int = 0,
    ) -> list[tuple[float, float, int, float]]:
        """Stem-axis sustained-band candidates — the #136 pad evidence."""
        import numpy as np  # noqa: PLC0415 - lazy optional dependency

        times = np.arange(self._frames, dtype=np.float64) * self._spf
        return _hot_run_spans(
            self._mids,
            self._band_e,
            self._hot,
            times,
            min_sustain_sec,
            hole_frames=hole_frames,
        )


def _accomp_band_evidence(
    samples: Any,
    sample_rate: int,
    *,
    time_offset_sec: float = 0.0,
) -> _AccompBands | None:
    """One shared STFT pass -> _AccompBands | None.

    None when the stem/audio stack is unavailable — callers then keep
    the merge_gap=0 status quo rather than guessing from no evidence.
    """
    if samples is None or sample_rate <= 0:
        return None
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415 - lazy optional dependency
    except Exception:
        return None
    try:
        y = np.asarray(samples, dtype=np.float64)
        sr = int(sample_rate)
        if sr != 22050:
            y = librosa.resample(y, orig_sr=sr, target_sr=22050)
            sr = 22050
        spec = np.abs(librosa.stft(y, n_fft=4096, hop_length=512))
    except Exception:
        return None
    if spec.shape[1] < 2:
        return None
    return _AccompBands(spec, sr, time_offset_sec=time_offset_sec)


def _accomp_band_verdict(
    samples: Any,
    sample_rate: int,
    *,
    time_offset_sec: float = 0.0,
) -> Callable[[RawNoteEvent, RawNoteEvent], bool] | None:
    """Per-midi band continuity verdict for accompaniment seams (#160).

    Thin wrapper over :func:``_accomp_band_evidence`` for callers that
    only need the seam question — the band matrix itself now feeds
    backdating and pad mining too.
    """
    bands = _accomp_band_evidence(
        samples, sample_rate, time_offset_sec=time_offset_sec
    )
    return bands.separated if bands is not None else None


def _heal_accomp_fragments(
    events: tuple[RawNoteEvent, ...],
    separated: Callable[[RawNoteEvent, RawNoteEvent], bool] | None,
) -> tuple[tuple[RawNoteEvent, ...], int]:
    """Merge adjacent same-pitch fragments the band calls one tone (#160).

    The accomp clean path keeps merge_gap=0 so real re-attacks survive
    (#132) — which also keeps every detector split of a sustained pad
    or bass note. Heal those here: a same-pitch neighbour inside
    _ACCOMP_SEAM_MAX_GAP_SEC folds into the running event ONLY when the
    stem's per-midi band energy does not dip at the seam. Chains fold
    transitively (a+b merged, then c measured against the union).
    """
    if separated is None or len(events) < 2:
        return events, 0
    ordered = sorted(events, key=lambda e: (e.onset_sec, e.offset_sec))
    out: list[RawNoteEvent] = []
    merged = 0
    for ev in ordered:
        if out:
            prev = out[-1]
            same_pitch = int(round(prev.pitch_midi)) == int(round(ev.pitch_midi))
            gap = ev.onset_sec - prev.offset_sec
            if (
                same_pitch
                and gap < _ACCOMP_SEAM_MAX_GAP_SEC
                and not separated(prev, ev)
            ):
                out[-1] = _extend(
                    prev, ev.offset_sec, ev.confidence, ev.pitch_bends
                )
                merged += 1
                continue
        out.append(ev)
    return tuple(out), merged


def _fold_accomp_slivers(
    events: tuple[RawNoteEvent, ...],
) -> tuple[tuple[RawNoteEvent, ...], int]:
    """Fold sub-90 ms same-pitch slivers into their predecessor (#155).

    Around a real re-attack boundary the detector can emit
    <note><sliver><note>: a ~70 ms island abutting same-pitch events
    on both sides is boundary noise, not a playable 32nd — a real fast
    articulation shows a detectable gap on at least one side. The
    sliver folds into its predecessor, which keeps the surviving pair
    honest (the re-attack count stays put).
    """
    if len(events) < 3:
        return tuple(events), 0
    evs = list(events)
    out: list[RawNoteEvent] = [evs[0]]
    folded = 0
    i = 1
    while i < len(evs) - 1:
        prev = out[-1]
        e = evs[i]
        nxt = evs[i + 1]
        if (
            int(round(prev.pitch_midi)) == int(round(e.pitch_midi))
            and int(round(nxt.pitch_midi)) == int(round(e.pitch_midi))
            and e.offset_sec - e.onset_sec <= _ACCOMP_SLIVER_MAX_SEC
            and e.onset_sec - prev.offset_sec <= _ACCOMP_SLIVER_GAP_SEC
            and nxt.onset_sec - e.offset_sec <= _ACCOMP_SLIVER_GAP_SEC
        ):
            out[-1] = _extend(
                prev, e.offset_sec, e.confidence, e.pitch_bends
            )
            folded += 1
            i += 1
            continue
        out.append(e)
        i += 1
    out.append(evs[-1])
    return tuple(out), folded


def _backdate_accomp_onsets(
    events: tuple[RawNoteEvent, ...],
    bands: _AccompBands | None,
) -> tuple[tuple[RawNoteEvent, ...], int, int]:
    """Move late detections back to where their band actually rose (#155).

    Basic Pitch can "find" a held accompaniment tone mid-sustain — on
    the JPOP-mix stem the detector wrote a midi-64 onset 1.3 s into a
    sounding pad member, scoring as a false note on top of the pad's
    true (missed) onset. The band's hot mask knows when the tone
    actually started: walk it back via ``bands.run_start`` and move
    the onset there when the recovered span beats
    ``_ACCOMP_BACKDATE_MIN_SEC``.

    Two evidences fold the event into a same-pitch predecessor:
    the seam staying elevated (the #160 dip test — ``bands.separated``
    False), and — #172 — the onset's own run reaching back to the
    predecessor's onset with no band-level attack at the re-onset
    (``run_start`` bridging a mask dropout says the tone never
    released even though the seam measured a local dip: the lead's
    mask suppressed this one band mid-sustain and the detector
    re-fired as it let go). A real re-attack either starts a later
    run or posts ``attack_evidence`` at its onset — both are kept.

    Returns (events, backdated, continuity_merged).
    """
    if bands is None or not events:
        return tuple(events), 0, 0
    out: list[RawNoteEvent] = []
    backdated = 0
    merged = 0
    for ev in sorted(events, key=lambda e: (e.onset_sec, e.offset_sec)):
        if ev.source == "pad-completion":
            out.append(ev)
            continue
        run = bands.run_start(ev.pitch_midi, ev.onset_sec)
        if run is None:
            out.append(ev)
            continue
        prev = out[-1] if out else None
        if (
            prev is not None
            and int(round(prev.pitch_midi)) == int(round(ev.pitch_midi))
            and (
                not bands.separated(prev, ev)
                or (
                    # #172: mask-recovery refire — the run containing
                    # this onset reaches back to the predecessor's own
                    # onset AND the band shows no attack at the re-onset
                    # (still cold mid-ramp, or a falling edge into the
                    # dip). A real re-attack starts a later run and
                    # carries an attack signature, so this folds only
                    # genuine continuations.
                    run <= prev.onset_sec + _ACCOMP_RUN_CONT_EPS_SEC
                    and not bands.attack_evidence(
                        ev.pitch_midi, ev.onset_sec
                    )
                )
            )
        ):
            out[-1] = _extend(
                prev, ev.offset_sec, ev.confidence, ev.pitch_bends
            )
            merged += 1
            continue
        floor = prev.offset_sec if prev is not None else 0.0
        onset = max(run, floor)
        if ev.onset_sec - onset >= _ACCOMP_BACKDATE_MIN_SEC:
            ev = replace(ev, onset_sec=onset)
            backdated += 1
        out.append(ev)
    return tuple(out), backdated, merged


# #136: sustained-harmony completion for the accompaniment part. Basic
# Pitch tracks attacks — a held pad chord fades under the mix and the
# detector either skips it or writes sub-floor flicker (JPOP-mix stem:
# 3/24 pad truths reached the staff). The spectrum keeps them: each pad
# tone is a pitch band that stays locally peaked and elevated for the
# whole bar. Mine the stem's magnitude spectrogram for that signature
# and emit the survivors as extra accompaniment events. The _ACCOMP_PAD_*
# constants live above _AccompBands, which defaults kwargs off them.


def _sustained_pitch_bands(
    samples: Any,
    sample_rate: int,
    *,
    min_sustain_sec: float = _ACCOMP_PAD_MIN_SUSTAIN_SEC,
    midi_lo: int = _ACCOMP_PAD_MIDI_LO,
    midi_hi: int = _ACCOMP_PAD_MIDI_HI,
) -> list[tuple[float, float, int, float]]:
    """STFT magnitude -> sustained pitch-band candidates.

    For each MIDI bin a narrow (+-45 cent) band energy track is built.
    A candidate span requires the band to be the local MIDI maximum AND
    elevated above its own quiet baseline for a contiguous run of at
    least ``min_sustain_sec`` — the signature of a held pad/string tone
    rather than attack flicker or a neighbour's spectral leakage.
    Returns ``(onset_sec, offset_sec, midi, mean_amp)`` tuples.
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    if sample_rate != 22050:
        samples = librosa.resample(
            samples, orig_sr=sample_rate, target_sr=22050
        )
        sample_rate = 22050
    hop = 512
    n_fft = 4096
    spec = np.abs(librosa.stft(samples, n_fft=n_fft, hop_length=hop))
    if spec.shape[1] < 2:
        return []
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=n_fft)
    times = librosa.frames_to_time(
        np.arange(spec.shape[1]), sr=sample_rate, hop_length=hop
    )
    mids = list(range(midi_lo, midi_hi + 1))
    band_e, hot = _sustained_band_matrix(spec, freqs, mids)
    # #179: same release-dip bridging as the shared-evidence path.
    return _hot_run_spans(
        mids,
        band_e,
        hot,
        times,
        min_sustain_sec,
        hole_frames=_ACCOMP_PAD_BRIDGE_FRAMES,
    )


def _merge_band_fragments(
    cands: list[tuple[float, float, int, float]],
    *,
    gap_sec: float = 0.45,
) -> list[tuple[float, float, int, float]]:
    """Join same-pitch band fragments across threshold dips —
    a held pad dipping under a bass/strum transient (or a separation
    dropout) must not re-onset mid-bar (the split second half scored
    as a false note). #162: raised 0.15 -> 0.45 — center-extraction
    stems lose a pad band for ~0.4 s mid-bar, so a 150 ms bridge left
    one held tone split into a late "phantom" second onset."""
    out: list[tuple[float, float, int, float]] = []
    for s, e, m, a in sorted(cands, key=lambda c: (c[2], c[0])):
        if out and out[-1][2] == m and s - out[-1][1] <= gap_sec:
            ps, pe, pm, pa = out[-1]
            out[-1] = (ps, max(pe, e), pm, max(pa, a))
        else:
            out.append((s, e, m, a))
    return out


def _accomp_pad_completion(
    samples: Any,
    sample_rate: int,
    existing: tuple[RawNoteEvent, ...],
    revision: TranscriptionRevisionId,
    *,
    time_offset_sec: float = 0.0,
    band_evidence: _AccompBands | None = None,
) -> tuple[RawNoteEvent, ...]:
    """Spectral pad completion -> extra accompaniment events (#136).

    Candidates are consolidated argmax-amp-first: a weaker candidate
    within +-2 semitones that overlaps a stronger one is spectral
    leakage from that note, not a chord member (pad triads sit >=3
    semitones apart). The relative amp gate keeps only bands carrying
    a real share of the stem's sustained energy. Candidates already
    covered by detection (same pitch, the detector spans half the
    candidate's span) are skipped; at most
    ``_ACCOMP_PAD_MAX_SIMULTANEOUS`` simultaneous bands are admitted so
    a broadband wash cannot fabricate a wall of pads.

    The stem's own axis starts at 0 while ``existing`` and every
    downstream consumer speak job-timeline seconds — for a selection
    job those differ by ``time_offset_sec``. Candidates are shifted
    INTO job time at emission, and the coverage check compares
    ``existing`` back on the stem axis, so both sides stay honest.
    """
    if band_evidence is None and (samples is None or sample_rate <= 0):
        return ()
    if band_evidence is not None:
        # #155: the shared band matrix already paid the STFT — reuse it
        # instead of resampling + re-transforming the same stem.
        # #179: bridge release dips inside the mining walk — a
        # restruck member toggles cold ~1-2 frames each hit on an
        # attenuated stem, and unbridged fragments die under the
        # min-sustain floor before the strike grid can cut them.
        cands = band_evidence.sustained(
            _ACCOMP_PAD_MIN_SUSTAIN_SEC,
            hole_frames=_ACCOMP_PAD_BRIDGE_FRAMES,
        )
    else:
        try:
            cands = _sustained_pitch_bands(samples, sample_rate)
        except Exception:
            return ()
    if not cands:
        return ()
    cands = _merge_band_fragments(cands)
    max_amp = max(c[3] for c in cands)
    cands = [c for c in cands if c[3] >= max_amp * _ACCOMP_PAD_AMP_RATIO]
    accepted: list[tuple[float, float, int, float]] = []
    for s, e, m, a in sorted(cands, key=lambda c: -c[3]):
        clash = any(
            abs(m - m2) <= 2
            and (min(e, e2) - max(s, s2)) > 0.5 * min(e - s, e2 - s2)
            for s2, e2, m2, _a2 in accepted
        )
        if not clash:
            accepted.append((s, e, m, a))
    # Re-strike split: a band held through a moment when >=2 sibling
    # pad bands newly start is a chord member carried across a
    # re-strike (the pad replays the chord but this tone's energy
    # never dipped). Cut the surviving span at the shared onset.
    accepted_midis = {m for _s, _e, m, _a in accepted}
    if band_evidence is not None:
        # #171: the shared band evidence also carries fragment-level
        # onsets (a fast re-strike train dips each hit; merging hides
        # every boundary). Keep only onsets where >=2 members are pads
        # we actually accepted — an unrelated coincident restrike
        # (bass + drum-fill bands) must not cut a held pad.
        chord_events = sorted(
            (t, mem, tier)
            for t, mem, tier in band_evidence._chord_events
            if len(mem & accepted_midis) >= 2
        )
        chord_onsets = [t for t, _m, _k in chord_events]
    else:
        starts = sorted((s, m) for s, _e, m, _a in accepted)
        chord_events = []
        i = 0
        while i < len(starts):
            j = i
            while (
                j + 1 < len(starts)
                and starts[j + 1][0] - starts[i][0]
                <= _ACCOMP_PAD_REATTACK_CLUSTER_SEC
            ):
                j += 1
            members = {m for _s, m in starts[i : j + 1]}
            if len(members) >= 2:
                chord_events.append(
                    (starts[i][0], frozenset(members), "strong")
                )
            i = j + 1
        chord_onsets = [t for t, _m, _k in chord_events]
    if chord_onsets:
        # #171: margin adapts to the locally observed onset spacing —
        # a fixed 0.3 s refuses every split inside an eighth-note
        # strike train (234 ms at 128 BPM). 40% of the nearest
        # neighbour interval, floored where shorter pieces stop being
        # notatable.
        margins: list[float] = []
        for k, t in enumerate(chord_onsets):
            left = t - chord_onsets[k - 1] if k else float("inf")
            right = (
                chord_onsets[k + 1] - t
                if k + 1 < len(chord_onsets)
                else float("inf")
            )
            near = min(left, right)
            margins.append(
                _ACCOMP_PAD_SPLIT_MARGIN_SEC
                if near == float("inf")
                else min(
                    _ACCOMP_PAD_SPLIT_MARGIN_SEC,
                    max(_ACCOMP_PAD_SPLIT_MARGIN_MIN_SEC, 0.4 * near),
                )
            )
        split: list[tuple[float, float, int, float]] = []
        for s, e, m, a in accepted:
            prev = s
            for (t, mem, tier), mg in zip(chord_events, margins):
                if not (s + mg < t < e - mg):
                    continue
                # A fast-tier onset is a re-attack signature: cut only
                # the bands that demonstrably re-attacked — a stranger
                # tone held through an ostinato it does not belong to
                # stays whole (pedal point honesty). Strong-tier
                # onsets keep the legacy cut-everything behaviour.
                if tier == "flux" and m not in mem:
                    continue
                split.append((prev, t, m, a))
                prev = t
            split.append((prev, e, m, a))
        accepted = split
    out: list[RawNoteEvent] = []
    for s, e, m, _a in accepted:
        span = e - s
        if span <= 0.0:
            continue
        # Cumulative same-pitch coverage: a pad-length band is already
        # written when DETECTED notes at that pitch cover half of it —
        # four quarter-note bass hits together own their whole span.
        covered_span = 0.0
        for k in existing:
            if abs(k.pitch_midi - m) <= 1:
                covered_span += max(
                    0.0,
                    min(e, k.offset_sec - time_offset_sec)
                    - max(s, k.onset_sec - time_offset_sec),
                )
        covered = covered_span > 0.5 * span
        if covered:
            continue
        simultaneous = sum(
            1
            for x in out
            if x.onset_sec - time_offset_sec < e
            and x.offset_sec - time_offset_sec > s
        )
        if simultaneous >= _ACCOMP_PAD_MAX_SIMULTANEOUS:
            continue
        out.append(
            RawNoteEvent(
                id=RawNoteEventId(f"rne-p{len(out) + 1:06d}"),
                transcription_revision=revision,
                pitch_midi=float(m),
                onset_sec=s + time_offset_sec,
                offset_sec=e + time_offset_sec,
                confidence=None,
                source="pad-completion",
            )
        )
    return tuple(out)


def _track_beats(samples: Any, sample_rate: int) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """Beat times + onset strength sampled at each beat (librosa).

    Shared by the meter estimator (needs strengths at beats) and the
    tempo warp (needs the beat times themselves). A failed or empty
    track returns empty tuples — callers degrade to the 4/4 default.
    When the frame-level tempo curve shows more than one stable
    region, each region is re-tracked at its own tempo so a mid-piece
    tempo step stays on-grid (#93).
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency

    onset_env = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    _tempo, beat_frames = librosa.beat.beat_track(
        y=samples, sr=sample_rate, onset_envelope=onset_env, units="frames"
    )

    def collect(frames: Any) -> tuple[list[float], list[float]]:
        times: list[float] = []
        strengths: list[float] = []
        for frame in frames:
            refined = _refine_beat_frame(onset_env, int(frame))
            ft = float(librosa.frames_to_time(refined, sr=sample_rate))
            if times and ft <= times[-1]:
                continue
            s_idx = int(round(refined))
            strength = float(onset_env[s_idx]) if 0 <= s_idx < len(onset_env) else 0.0
            times.append(ft)
            strengths.append(strength)
        return times, strengths

    times, strengths = collect(beat_frames)

    regions = _tempo_regions(onset_env, sample_rate)
    if len(regions) < 2 or not times:
        return tuple(times), tuple(strengths)

    duration = float(len(samples)) / sample_rate if len(samples) else 0.0
    merged: list[tuple[float, int]] = []
    region_intervals: list[float] = []
    for r_i, (lo, hi, bpm) in enumerate(regions):
        pad_lo = max(0.0, lo - _TEMPO_REGION_PAD_SEC)
        pad_hi = min(duration, hi + _TEMPO_REGION_PAD_SEC)
        f0 = int(librosa.time_to_frames(pad_lo, sr=sample_rate))
        f1 = int(librosa.time_to_frames(pad_hi, sr=sample_rate)) + 1
        seg = onset_env[f0:f1]
        if len(seg) < 4:
            continue
        _seg_tempo, seg_frames = librosa.beat.beat_track(
            onset_envelope=seg,
            sr=sample_rate,
            units="frames",
            bpm=float(bpm),
        )
        seg_times, _seg_strengths = collect(seg_frames + f0)
        region_intervals.append(60.0 / float(bpm) if bpm > 0 else 0.5)
        for t in seg_times:
            if lo <= t < hi:
                merged.append((t, r_i))
    merged.sort()

    if len(merged) < 2:
        return tuple(times), tuple(strengths)

    # Refill a beat the per-region DP dropped -- at a seam or inside a
    # region. The expected interval is the region being ENTERED, so a
    # fast region's short interval never judges the slow region's
    # honest gaps (the first version filled those with phantom beats).
    filled: list[tuple[float, int]] = []
    for i, (t, r_i) in enumerate(merged):
        if i:
            prev_t = filled[-1][0]
            interval = region_intervals[r_i]
            while t - prev_t > interval * _TEMPO_GAP_FILL_RATIO:
                predicted = prev_t + interval
                f_lo = int(
                    librosa.time_to_frames(
                        max(prev_t + 0.05, predicted - 0.2 * interval),
                        sr=sample_rate,
                    )
                )
                f_hi = int(
                    librosa.time_to_frames(
                        min(t - 0.05, predicted + 0.2 * interval),
                        sr=sample_rate,
                    )
                )
                if not (0 <= f_lo < f_hi <= len(onset_env)):
                    break
                peak = f_lo + int(onset_env[f_lo:f_hi].argmax())
                if float(onset_env[peak]) <= 0:
                    break
                prev_t = float(
                    librosa.frames_to_time(_refine_beat_frame(onset_env, peak), sr=sample_rate)
                )
                filled.append((prev_t, r_i))
        filled.append((t, r_i))

    # Onset-strength samples must stay index-parallel with the merged
    # beats (the tempo estimate consumes them pairwise).
    out_times: list[float] = []
    out_strengths: list[float] = []
    for t, _r in filled:
        if out_times and t <= out_times[-1]:
            continue
        idx = int(librosa.time_to_frames(t, sr=sample_rate))
        strength = float(onset_env[idx]) if 0 <= idx < len(onset_env) else 0.0
        out_times.append(t)
        out_strengths.append(strength)
    return tuple(out_times), tuple(out_strengths)


def _tempo_regions(onset_env: Any, sample_rate: int) -> list[tuple[float, float, float]]:
    """Stable-tempo regions from the frame-level tempo curve.

    Returns (start_sec, end_sec, mean_bpm) per region in order. The
    curve comes from librosa's autocorr tracker; the grouping itself is
    pure so the unit tests drive it without a librosa install.
    Regions shorter than _TEMPO_REGION_MIN_SEC fold into the tempo-
    nearer neighbour; fewer than two survivors returns [] (the caller
    keeps the single global track).
    """
    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    dyn = np.asarray(
        librosa.feature.tempo(onset_envelope=onset_env, sr=sample_rate, aggregate=None),
        dtype=float,
    )
    dyn = dyn[np.isfinite(dyn) & (dyn > 0)]
    return _tempo_regions_from_dyn(dyn, 512.0 / float(sample_rate))


def _tempo_regions_from_dyn(dyn: Any, frame_sec: float) -> list[tuple[float, float, float]]:
    """Plateau-group a frame-level tempo curve into stable regions.

    The autocorr tempo curve is piecewise-constant (one lag bin per
    run). Grouping by the run's own mean — not the whole region's
    running median — lets a continuous rit./accel. surface as a
    staircase of regions to re-track individually, instead of
    collapsing to a single averaged tempo the per-region DP cannot
    follow (rubato-4-4: a 120->90 drift previously read as one 112-bpm
    region and the tracker lost the first five beats).
    """
    import numpy as np  # noqa: PLC0415 - lazy optional dependency

    if len(dyn) < 4:
        return []

    # Regions live in FRAME units until the final report: fold weights
    # need true durations in frames, and the median recompute slices
    # dyn by index.
    regions: list[list[float]] = []
    run = [float(dyn[0])]
    start = 0
    for i in range(1, len(dyn)):
        mean = float(np.mean(run))
        v = float(dyn[i])
        if mean > 0 and abs(v - mean) / mean > _TEMPO_PLATEAU_BAND:
            regions.append([float(start), float(i), mean])
            run = [v]
            start = i
        else:
            run.append(v)
    regions.append([float(start), float(len(dyn)), float(np.mean(run))])

    # Fold too-short regions into the tempo-nearer neighbour, weighting
    # each side by its duration. The earlier unweighted mean let a
    # single-frame autocorr blip halve a 100 s plateau's tempo: 152
    # scattered 95.7 bpm triplet-level flickers dragged 0-101 s of a
    # steady 143.5 bpm song down to a fictitious 119.6 bpm region, and
    # the region re-track then locked the wrong pulse for half the
    # piece (milk-crescendo).
    min_frames = max(1, int(round(_TEMPO_REGION_MIN_SEC / frame_sec)))
    changed = True
    while changed and len(regions) > 1:
        changed = False
        for i, r in enumerate(regions):
            span = r[1] - r[0]
            if span >= min_frames:
                continue
            left = regions[i - 1] if i > 0 else None
            right = regions[i + 1] if i + 1 < len(regions) else None
            if left is None and right is None:
                break
            merge_left = left is not None and (
                right is None or abs(left[2] - r[2]) <= abs(right[2] - r[2])
            )
            target = left if merge_left else right
            if target is None:
                break
            tn = target[1] - target[0]
            target[2] = (target[2] * tn + r[2] * span) / (tn + span)
            if merge_left:
                target[1] = r[1]
            else:
                target[0] = r[0]
            regions.pop(i)
            changed = True
            break
    if len(regions) < 2:
        return []

    # A region that absorbed scattered blips still carries the muddled
    # running mean; the member-frame median is the tempo to prime the
    # per-region DP with.
    for r in regions:
        seg = dyn[int(r[0]) : int(r[1])]
        if len(seg):
            r[2] = float(np.median(seg))

    # Snap short metrical-ratio regions to the dominant grid (see the
    # constants above).
    dominant = float(np.median(dyn))
    for r in regions:
        if (r[1] - r[0]) * frame_sec > _TEMPO_REGION_SNAP_MAX_SEC:
            continue
        for ratio in _TEMPO_METRICAL_RATIOS:
            target = dominant * ratio
            if (
                target > 0
                and abs(r[2] - target) / target <= _TEMPO_PLATEAU_BAND
            ):
                r[2] = dominant
                break

    # Neighbours that landed on the same tempo (post-snap) are one
    # region; splitting would re-track an identical pulse twice and
    # risk a seam glitch at the boundary.
    merged: list[list[float]] = [regions[0]]
    for r in regions[1:]:
        last = merged[-1]
        if abs(r[2] - last[2]) / last[2] <= _TEMPO_PLATEAU_BAND:
            ln = last[1] - last[0]
            rn = r[1] - r[0]
            last[2] = (last[2] * ln + r[2] * rn) / (ln + rn)
            last[1] = r[1]
        else:
            merged.append(r)
    if len(merged) < 2:
        return []
    return [(r[0] * frame_sec, r[1] * frame_sec, r[2]) for r in merged]


def _accomp_detected_events(
    cleaned: Iterable[CleanedEvents],
) -> Iterable[RawNoteEvent]:
    """Detected accompaniment attacks only.

    ``pad-completion`` onsets are band-threshold crossings, not
    articulations: they fire wherever a sustain crosses its own
    gate — mid-bar as often as on a downbeat — so a pool of them
    votes compound meters on straight pop (#162: the mined-onset
    pool read 12/8 on the 4/4 JPOP mix while the detected pool
    read 4/4 at 0.32 confidence). Meter channels and the pickup
    phase evidence both drink from this pool, so the mined onsets
    are kept out of rhythm evidence while still reaching the score.
    """
    return (
        e
        for c in cleaned
        for e in c.events
        if e.source != "pad-completion"
    )


def _event_accents(
    events: Iterable[RawNoteEvent],
    samples: Any,
    sample_rate: int,
    time_offset_sec: float = 0.0,
) -> tuple[tuple[float, float], ...]:
    """(onset_sec, post-onset RMS) per event -- meter accent evidence.

    The tracker's onset envelope is too noisy to read performed
    accents (#87), but the audio energy in a short window after each
    detected onset tracks them closely. Pure-Python RMS keeps this a
    no-op on engines without numpy.

    time_offset_sec maps absolute event times into the analysis
    buffer — a selection slice or an isolation stem both start at
    their span's source offset, not at source t=0 (#256).
    """
    window = int(0.12 * sample_rate)
    out: list[tuple[float, float]] = []
    n = len(samples)
    for ev in events:
        i0 = max(0, int((ev.onset_sec - time_offset_sec) * sample_rate))
        i1 = min(n, i0 + window)
        if i1 - i0 < 8:
            continue
        seg = samples[i0:i1]
        ss = sum(float(v) * float(v) for v in seg)
        out.append((float(ev.onset_sec), math.sqrt(ss / len(seg))))
    out.sort(key=lambda p: p[0])
    return tuple(out)


def _warp_evidence(warp: TimeWarp) -> dict[str, Any]:
    """Serialize the seconds->ql warp for later requantization (#226).

    A beat-map warp stores its anchors (absolute source seconds ->
    score position); a fixed-BPM warp stores bpm/zero_sec. Rebuilding
    the warp from this evidence reproduces the exact grid the original
    quantization ran on.
    """
    if warp.mode is TimeWarpMode.BEAT_MAP and warp.beat_map is not None:
        return {
            "kind": "beatMap",
            "anchors": [
                {
                    "timeSec": a.time_sec,
                    "posQl": str(a.score_pos_ql),
                }
                for a in warp.beat_map.anchors
            ],
        }
    return {
        "kind": "fixedBpm",
        "bpm": warp.bpm,
        "zeroSec": warp.zero_sec,
    }


def _shift_event_times(
    events: tuple[RawNoteEvent, ...], offset_sec: float
) -> tuple[RawNoteEvent, ...]:
    """Translate slice-relative event times to absolute source seconds.

    #229: a selection job stages only the chosen range for the backend,
    so every timestamp it emits is relative to the slice start. The
    downstream stages (clip_to_range, review seek targets, project
    provenance) all speak absolute source seconds — shift once here.
    """
    if offset_sec == 0.0:
        return events
    return tuple(
        replace(
            ev,
            onset_sec=ev.onset_sec + offset_sec,
            offset_sec=ev.offset_sec + offset_sec,
            pitch_bends=tuple(replace(b, time_sec=b.time_sec + offset_sec) for b in ev.pitch_bends),
        )
        for ev in events
    )


def _samples_rms(samples: Any) -> float:
    """RMS of a decoded mono buffer (#191) — numpy lazily, matching the
    module's optional-dependency convention."""
    import numpy as np  # noqa: PLC0415

    arr = np.asarray(samples, dtype=np.float64)
    if arr.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(arr * arr)))


def _stage_selection_wav(samples: Any, sample_rate: int) -> str | None:
    """Write *samples* to a temp PCM16 WAV; return its path or None.

    #229: both backends take a file path, so a sliced selection is
    staged on disk. The caller deletes the file after inference.
    """
    try:
        pcm = array(
            "h",
            (max(-32768, min(32767, int(round(float(v) * 32768.0)))) for v in samples),
        )
        if pcm.itemsize != 2:  # platform 'h' must be 16-bit for WAV
            return None
        fd, path = tempfile.mkstemp(prefix="hornscribe-sel-", suffix=".wav")
        try:
            with os.fdopen(fd, "wb") as handle, wave.open(handle, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(sample_rate)
                wav.writeframes(pcm.tobytes())
        except BaseException:
            with contextlib.suppress(OSError):
                os.close(fd)
            with contextlib.suppress(OSError):
                os.unlink(path)
            return None
        return path
    except (OSError, ValueError, TypeError):
        return None


def _sha256_file(path: str) -> str | None:
    """Streaming SHA-256 for the project sourceAudio.contentHash contract.

    Returns None when the file cannot be read — provenance is
    best-effort, never a reason to fail the job.
    """
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _extra_issues(
    built_notes: tuple[QuantizedNote, ...],
    confidence: dict[ScoreNoteId, float],
    onsets_sec: dict[ScoreNoteId, float],
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
    score_revision: ScoreRevisionId,
) -> list[ReviewIssue]:
    """Confidence/range/duration issues the quantizer cannot see.

    ``built_notes`` are the canonical QuantizedNote rows; ids are the
    ``sn-*`` values the review workspace highlights.
    """
    issues: list[ReviewIssue] = []
    for note in built_notes:
        conf = confidence.get(note.id)
        onset = onsets_sec.get(note.id, 0.0)
        rng = TimeRange(start_sec=onset, end_sec=onset + 0.05)
        if conf is not None and conf < LOW_CONFIDENCE:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.LOW_MODEL_CONFIDENCE,
                    severity=(Severity.WARNING if conf < 0.3 else Severity.CAUTION),
                    evidence={"modelConfidence": round(conf, 3)},
                )
            )
        status = sounding_range_status(note.pitch_midi)
        if status is not HornRangeStatus.NORMAL:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.OUTSIDE_PREFERRED_HORN_RANGE,
                    severity=(
                        Severity.WARNING if status is HornRangeStatus.EXTREME else Severity.CAUTION
                    ),
                    evidence={"pitchMidi": note.pitch_midi},
                )
            )
        raw_spans = [
            event_by_id[e].offset_sec - event_by_id[e].onset_sec
            for e in note.source_event_ids
            if e in event_by_id
        ]
        if raw_spans and min(raw_spans) < VERY_SHORT_SEC:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(note.id,),
                    time_range=rng,
                    reason=ReviewReason.VERY_SHORT_DETECTION,
                    severity=Severity.INFO,
                    evidence={},
                )
            )
    # #272: return every detected issue; the caller applies the
    # severity-priority cap so a flood of early low-severity notes
    # cannot silently drop later warnings.
    return issues


# #166: chromatic pitch classes whose enharmonic spelling the key cannot
# decide — one issue per pitch class, capped so a chromatic-heavy piece
# cannot flood the review list.
_MAX_SPELLING_ISSUES = 8
_MAX_SPELLING_NOTE_IDS = 6


def _spelling_issues(
    payload_notes: tuple[QuantizedNote, ...],
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    onsets_sec: dict[ScoreNoteId, float],
    score_revision: ScoreRevisionId,
    chord_map: tuple[ChordEstimate, ...] = (),
    prefer_flats: bool = False,
) -> list[ReviewIssue]:
    """Flag chromatic notes whose enharmonic spelling is ambiguous (#166).

    The notation layer already spells every note against the active key
    (#165); a pitch class outside that key has two defensible spellings
    (raised-below vs lowered-above), so the note is surfaced for review
    rather than guessed silently — the contract clean.py documents.
    Grouped by pitch class so a repeated chromatic tone raises one
    issue, not one per occurrence.
    """
    by_pc: dict[int, list[QuantizedNote]] = {}
    for n in payload_notes:
        fifths = fifths_at_beat(head_fifths, key_changes, n.start_beat)
        if not is_diatonic(n.pitch_midi, fifths):
            by_pc.setdefault(n.pitch_midi % 12, []).append(n)
    issues: list[ReviewIssue] = []
    for pc, notes in sorted(by_pc.items()):
        if len(issues) >= _MAX_SPELLING_ISSUES:
            break
        first = min(notes, key=lambda n: n.start_beat)
        onset = onsets_sec.get(first.id, 0.0)
        # #419: the chord sounding under this note is the context
        # the reviewer needs - is the chromatic tone a chord tone
        # (secondary dominant, blues) or a passing artifact?
        est = next(
            (c for c in chord_map if c.start_sec <= onset < c.end_sec),
            None,
        )
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=tuple(n.id for n in notes[:_MAX_SPELLING_NOTE_IDS]),
                time_range=TimeRange(start_sec=onset, end_sec=onset + 0.05),
                reason=ReviewReason.PITCH_SPELLING_AMBIGUOUS,
                severity=Severity.INFO,
                evidence={
                    "pitchClass": pc,
                    "occurrences": len(notes),
                    **(
                        {
                            "localChord": est.label(prefer_flats),
                            "chordTone": pc in est.chord_tones(),
                        }
                        if est is not None
                        else {}
                    ),
                },
            )
        )
    return issues


def _boundary_issues(
    samples: Any,
    sample_rate: int,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    event_by_id: dict[RawNoteEventId, RawNoteEvent],
    warp: TimeWarp,
    beat_ql: Fraction,
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
) -> list[ReviewIssue]:
    """Audio-evidence second opinion on note edges (#423).

    boundary_flags re-scores every cleaned edge per voice; this maps
    the survivors onto canonical notes so the suggestion is a real
    score edit, not a raw-event hint. A flag only becomes an issue
    when the matching one-click fix can actually apply:

    - ``merge``     - both events must map to different canonical
      notes in the same part, same written pitch, exactly adjacent
      (``a.end_beat == b.start_beat``) so ``mergeNotes`` applies.
    - ``split``     - the event must map to a canonical note whose
      beat span strictly contains the flagged second, so ``splitNote``
      lands inside the note (the beat rides along as
      ``suggestedSplitBeat``).
    - ``uncertain`` - no fix is suggested; both sides are attached
      for highlighting and the user decides.

    Flags whose events quantized away (or onto the same note, or a
    deleted note) are dropped - the score no longer has that edge.
    """
    canon_by_event: dict[RawNoteEventId, QuantizedNote] = {}
    part_of: dict[ScoreNoteId, int] = {}
    for pi, part in enumerate(parts):
        for n in part.notes:
            part_of[n.id] = pi
            for e in n.source_event_ids:
                canon_by_event.setdefault(e, n)
    issues: list[ReviewIssue] = []
    for c in cleaneds:
        for flag in boundary_flags(samples, sample_rate, c.events, time_offset_sec=time_offset_sec):
            note_ids: list[ScoreNoteId] = []
            evidence: dict[str, Any] = {
                "suggestedKind": flag.kind,
                "boundarySec": round(flag.boundary_sec, 3),
                "boundaryScore": flag.score,
                **flag.detail,
            }
            if flag.kind == "split":
                n = canon_by_event.get(flag.event_ids[0])
                if n is None or n.deleted:
                    continue
                split_beat = warp.seconds_to_ql(flag.boundary_sec) / beat_ql
                if not (n.start_beat < split_beat < n.end_beat):
                    continue
                evidence["suggestedSplitBeat"] = str(split_beat)
                note_ids.append(n.id)
                severity = Severity.CAUTION
            else:
                a = canon_by_event.get(flag.event_ids[0])
                b = canon_by_event.get(flag.event_ids[1])
                if a is None or b is None or a.deleted or b.deleted:
                    continue
                if a.id == b.id:
                    continue  # both events already fed one canonical note
                if flag.kind == "merge" and (
                    part_of.get(a.id) != part_of.get(b.id)
                    or a.pitch_midi != b.pitch_midi
                    or a.end_beat != b.start_beat
                ):
                    continue
                severity = Severity.CAUTION if flag.kind == "merge" else Severity.INFO
                note_ids.extend((a.id, b.id))
            ev_a = event_by_id.get(flag.event_ids[0])
            ev_b = event_by_id.get(flag.event_ids[1]) if len(flag.event_ids) > 1 else None
            if ev_a is not None and ev_b is not None:
                lo, hi = ev_a.offset_sec, ev_b.onset_sec
            else:
                lo = flag.boundary_sec - 0.1
                hi = flag.boundary_sec + 0.1
            if hi - lo < 0.04:
                mid = 0.5 * (lo + hi)
                lo, hi = mid - 0.02, mid + 0.02
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=tuple(note_ids),
                    time_range=TimeRange(start_sec=max(0.0, lo), end_sec=hi),
                    reason=ReviewReason.BOUNDARY_UNCERTAIN,
                    severity=severity,
                    evidence=evidence,
                )
            )
    _rank = {Severity.CAUTION: 0, Severity.INFO: 1}
    issues.sort(key=lambda i: (_rank.get(i.severity, 2), i.time_range.start_sec))
    return issues[:MAX_BOUNDARY_ISSUES]


def _span_pitch_median(
    events: tuple[RawNoteEvent, ...],
    lo_sec: float,
    hi_sec: float,
) -> float | None:
    """Span-overlap-weighted median pitch of events covering [lo, hi].

    Robust to flicker: an octave jump inside a note only moves the
    median when it persists for most of the span — exactly the
    signal a real octave disagreement produces.
    """
    vals: list[tuple[float, float]] = []
    for e in events:
        w = min(hi_sec, e.offset_sec) - max(lo_sec, e.onset_sec)
        if w > 0.02:
            vals.append((w, e.pitch_midi))
    if not vals:
        return None
    vals.sort(key=lambda t: t[1])
    total = sum(w for w, _ in vals)
    acc = 0.0
    for w, p in vals:
        acc += w
        if acc >= total / 2.0:
            return p
    return vals[-1][1]


# The two tracks must disagree by roughly an octave — a chord-tone
# gap (3-7st) is a different question.
ARBITER_OCTAVE_MIN_ST = 10.5
ARBITER_OCTAVE_MAX_ST = 13.5
#: #103: how many phrase neighbours each side contribute to the
#: context median -- three per side (up to six) follows the local
#: contour without letting one flagged outlier tip it.
_CONTEXT_ARBITER_NEIGHBORS = 3


def _octave_issues(
    samples: Any,
    sample_rate: int,
    warp: Any,
    beat_ql: Fraction,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
    arbiter_events: tuple[RawNoteEvent, ...] = (),
    arbiter_backend: str = "",
) -> list[ReviewIssue]:
    """Low-octave audit (#264) — flag-only second opinion on pitch.

    A tracker that locks onto the 2nd harmonic writes the note an
    octave too high. Two independent readings must agree before a
    flag is raised: the spectrum carries energy at f(P-12) AND at
    1.5*f(P) (slots the written pitch's own harmonics never fill),
    AND the waveform is periodic at the low octave's lag while NOT
    at the written pitch's — a true low note's odd harmonics
    decorrelate every half-period, so the written pitch cannot
    explain its own waveform.

    The measurement spans the SCORE NOTE's written extent — its beat
    span pushed back through the warp into audio seconds — not any
    raw event's span. A detection shorter than the written note
    (an early release, a clipped tail) can sit under the FFT floor
    even on a long written note, and a raw-event audit silently
    skipped those; on the reference mix the atom-level reading
    flagged one suspect where the note-level one finds eight. The
    written pitch is what the flag describes, so it is also what
    the spectrum is asked about — a note whose pitch a repair
    already corrected is no longer judged on the stale raw pitch.

    Only notes whose source events were detected on THIS buffer are
    audited: the accompaniment staff's notes would read lead-stem
    energy (or its absence) as evidence about pitches that were
    never measured there. Octave truth on the accompaniment stem is
    a different, polyphonic-instrument question (#264).

    Flag-only by design: an octave-doubled backing voice is
    spectrally indistinguishable from a tracking error, so the score
    keeps the detected pitch and the issue carries the suggested
    -12 fix the review bar can apply after the user listens.

    Deleted notes are skipped — the score no longer carries that
    pitch.
    """
    audited_events: set[RawNoteEventId] = {
        ev.id for c in cleaneds for ev in c.events
    }
    issues: list[ReviewIssue] = []
    flagged: set[ScoreNoteId] = set()
    for part in parts:
        for n in part.notes:
            if n.deleted:
                continue
            if not any(e in audited_events for e in n.source_event_ids):
                continue
            lo_sec = warp.ql_to_seconds(n.start_beat * beat_ql)
            hi_sec = warp.ql_to_seconds(n.end_beat * beat_ql)
            evidence = low_octave_evidence(
                samples,
                sample_rate,
                lo_sec,
                hi_sec,
                n.pitch_midi,
                time_offset_sec=time_offset_sec,
            )
            if not low_octave_suspected(evidence):
                continue
            flagged.add(n.id)
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(n.id,),
                    time_range=TimeRange(start_sec=lo_sec, end_sec=hi_sec),
                    reason=ReviewReason.OCTAVE_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "pitchMidi": int(n.pitch_midi),
                        "suggestedMidi": int(n.pitch_midi) - 12,
                        "lowFundRatio": round(evidence.low_fund_ratio, 3),
                        "oddHarmonicRatio": round(evidence.odd_harm_ratio, 3),
                        "lowPeriodScore": round(evidence.low_period_score, 3),
                        "highPeriodScore": round(evidence.high_period_score, 3),
                    },
                )
            )
    # #80: second-track arbitration — the lead gate's losing engine is
    # an independent pitch read on the same stem buffer, already paid
    # for. A ~±12st disagreement over the note's own span means one
    # engine tracked an octave error; the note's spectrum arbitrates
    # (fundamental-band dominance), so only a confirmed disagreement
    # flags — a bare disagreement with no spectral support stays
    # silent, and a note the spectral audit already flagged is not
    # double-counted.
    if arbiter_events:
        for part in parts:
            for n in part.notes:
                if n.deleted or n.id in flagged:
                    continue
                if not any(e in audited_events for e in n.source_event_ids):
                    continue
                lo_sec = warp.ql_to_seconds(n.start_beat * beat_ql)
                hi_sec = warp.ql_to_seconds(n.end_beat * beat_ql)
                median = _span_pitch_median(arbiter_events, lo_sec, hi_sec)
                if median is None:
                    continue
                diff = median - n.pitch_midi
                if not (
                    ARBITER_OCTAVE_MIN_ST
                    <= abs(diff)
                    <= ARBITER_OCTAVE_MAX_ST
                ):
                    continue
                suggested = int(n.pitch_midi) + (12 if diff > 0 else -12)
                if not octave_prefers(
                    samples,
                    sample_rate,
                    lo_sec,
                    hi_sec,
                    n.pitch_midi,
                    float(suggested),
                    time_offset_sec=time_offset_sec,
                ):
                    continue  # spectrum keeps the written pitch
                issues.append(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(n.id,),
                        time_range=TimeRange(start_sec=lo_sec, end_sec=hi_sec),
                        reason=ReviewReason.OCTAVE_UNCERTAIN,
                        severity=Severity.CAUTION,
                        evidence={
                            "pitchMidi": int(n.pitch_midi),
                            "suggestedMidi": suggested,
                            # The second engine's own reading — the
                            # disagreement the flag describes.
                            "arbiterMidi": round(median, 1),
                            "arbiterBackend": arbiter_backend or None,
                        },
                    ),
                )
    # #103: melodic-context arbitration — a second opinion that costs
    # no inference at all, so it also covers the non-isolated path
    # where no second engine ran. A note sitting ~±12st off its local
    # phrase median carries the phrase-boundary octave-error signature
    # (#264's residual class). The spectrum still decides: a real
    # octave leap keeps its written pitch and stays silent — only a
    # context outlier the note's own harmonics can't explain flags.
    # Neighbours already flagged are excluded so one error cannot
    # anchor another.
    for part in parts:
        seq = sorted(
            (n for n in part.notes if not n.deleted),
            key=lambda n: (n.start_beat, n.id),
        )
        for i, n in enumerate(seq):
            if n.id in flagged:
                continue
            if not any(
                e in audited_events for e in n.source_event_ids
            ):
                continue
            lo = max(0, i - _CONTEXT_ARBITER_NEIGHBORS)
            hi = min(len(seq), i + _CONTEXT_ARBITER_NEIGHBORS + 1)
            ctx = [
                m.pitch_midi
                for m in seq[lo:i] + seq[i + 1 : hi]
                if m.id not in flagged
            ]
            if len(ctx) < 2:
                continue
            ctx.sort()
            mid = len(ctx) // 2
            median = (
                float(ctx[mid])
                if len(ctx) % 2
                else (ctx[mid - 1] + ctx[mid]) / 2.0
            )
            diff = median - n.pitch_midi
            if not (
                ARBITER_OCTAVE_MIN_ST
                <= abs(diff)
                <= ARBITER_OCTAVE_MAX_ST
            ):
                continue
            suggested = int(n.pitch_midi) + (12 if diff > 0 else -12)
            lo_sec = warp.ql_to_seconds(n.start_beat * beat_ql)
            hi_sec = warp.ql_to_seconds(n.end_beat * beat_ql)
            if not octave_prefers(
                samples,
                sample_rate,
                lo_sec,
                hi_sec,
                n.pitch_midi,
                float(suggested),
                time_offset_sec=time_offset_sec,
            ):
                continue  # a real leap — the spectrum stands by the jump
            flagged.add(n.id)
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(n.id,),
                    time_range=TimeRange(start_sec=lo_sec, end_sec=hi_sec),
                    reason=ReviewReason.OCTAVE_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "pitchMidi": int(n.pitch_midi),
                        "suggestedMidi": suggested,
                        # The melodic neighbourhood's own reading —
                        # the disagreement the flag describes.
                        "contextMedian": round(median, 1),
                        "contextNoteCount": len(ctx),
                    },
                ),
            )
    issues.sort(key=lambda i: i.time_range.start_sec)
    return issues[:MAX_BOUNDARY_ISSUES]


def _pitch_dip_issues(
    samples: Any,
    sample_rate: int,
    cleaneds: tuple[CleanedEvents, ...],
    parts: tuple[Any, ...],
    head_fifths: int,
    key_changes: tuple[KeyChange, ...],
    score_revision: ScoreRevisionId,
    time_offset_sec: float,
) -> list[ReviewIssue]:
    """Isolated semitone dips (#264) — flag-only second opinion.

    A sub-280 ms note exactly one semitone off a diatonic neighbour,
    chromatic under the local key while the line around it stays
    diatonic, is far more often a tracker bin-snap than a sung
    semitone — a deliberate passing tone is normally longer or part
    of a repeated chromatic figure. The suggestion is the diatonic
    neighbour it probably belongs to; when the span allows it, the
    note's own spectrum arbitrates (suggested band dominant = the
    dip is audio-verified).

    Flag-only: chromatic passing tones do exist, so the score keeps
    the detected pitch and the issue offers the semitone fix after
    the user listens.
    """
    canon_by_event: dict[RawNoteEventId, QuantizedNote] = {}
    for part in parts:
        for n in part.notes:
            for e in n.source_event_ids:
                canon_by_event.setdefault(e, n)
    issues: list[ReviewIssue] = []
    seen: set[ScoreNoteId] = set()
    for c in cleaneds:
        events = c.events
        for i, ev in enumerate(events):
            span = ev.offset_sec - ev.onset_sec
            if span <= 0.0 or span >= PITCH_DIP_MAX_SEC:
                continue
            n = canon_by_event.get(ev.id)
            if n is None or n.deleted or n.id in seen:
                continue
            fifths = fifths_at_beat(head_fifths, key_changes, n.start_beat)
            pitch = int(round(ev.pitch_midi))
            if is_diatonic(pitch, fifths):
                continue  # not chromatic — not a dip suspect
            prev_ev = events[i - 1] if i > 0 else None
            next_ev = events[i + 1] if i + 1 < len(events) else None
            prev_midi = (
                int(round(prev_ev.pitch_midi)) if prev_ev is not None else None
            )
            next_midi = (
                int(round(next_ev.pitch_midi)) if next_ev is not None else None
            )
            if prev_midi is not None and not is_diatonic(prev_midi, fifths):
                continue  # inside a chromatic passage
            if next_midi is not None and not is_diatonic(next_midi, fifths):
                continue
            suggested: int | None = None
            if prev_midi is not None and abs(pitch - prev_midi) == 1:
                suggested = prev_midi
            elif next_midi is not None and abs(pitch - next_midi) == 1:
                suggested = next_midi
            if suggested is None:
                continue  # a chromatic note unrelated to its neighbours
            spectral: bool | None = None
            if span >= OCTAVE_MIN_SPAN_SEC:
                spectral = octave_prefers(
                    samples,
                    sample_rate,
                    ev.onset_sec,
                    ev.offset_sec,
                    ev.pitch_midi,
                    float(suggested),
                    time_offset_sec=time_offset_sec,
                )
            seen.add(n.id)
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(n.id,),
                    time_range=TimeRange(
                        start_sec=ev.onset_sec, end_sec=ev.offset_sec
                    ),
                    reason=ReviewReason.PITCH_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "pitchMidi": pitch,
                        "suggestedMidi": suggested,
                        "prevMidi": prev_midi,
                        "nextMidi": next_midi,
                        **(
                            {"spectralSupport": spectral}
                            if spectral is not None
                            else {}
                        ),
                    },
                )
            )
    issues.sort(key=lambda i: i.time_range.start_sec)
    return issues[:MAX_BOUNDARY_ISSUES]


def _chord_issues(
    chord_map: tuple[ChordEstimate, ...],
    canonical_notes: tuple[QuantizedNote, ...],
    warp: TimeWarp,
    beat_ql: Fraction,
    score_revision: ScoreRevisionId,
    prefer_flats: bool,
) -> list[ReviewIssue]:
    """Low-confidence chord segments as review issues (#419).

    A segment is flagged when the best template explains the chroma
    weakly (``confidence < LOW_CONFIDENCE``) or two candidates are
    nearly tied (``margin < LOW_MARGIN``). Segments with no note
    onsets are skipped - interludes and tails carry no spelling or
    rhythm decisions for the chord context to inform.
    """
    issues: list[ReviewIssue] = []
    note_secs = sorted(
        (
            warp.ql_to_seconds(n.start_beat * beat_ql),
            n.id,
        )
        for n in canonical_notes
        if not n.deleted
    )
    for est in chord_map:
        if est.confidence >= CHORD_LOW_CONFIDENCE and (est.margin >= CHORD_LOW_MARGIN):
            continue
        ids = tuple(nid for sec, nid in note_secs if est.start_sec <= sec < est.end_sec)[:6]
        if not ids:
            continue
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=ids,
                time_range=TimeRange(
                    start_sec=max(0.0, est.start_sec),
                    end_sec=est.end_sec,
                ),
                reason=ReviewReason.CHORD_UNCERTAIN,
                severity=Severity.INFO,
                evidence={
                    "suggestedChord": est.label(prefer_flats),
                    "runnerUpChord": est.runner_up,
                    "chordConfidence": round(est.confidence, 3),
                    "chordMargin": round(est.margin, 3),
                },
            )
        )
        if len(issues) >= MAX_CHORD_ISSUES:
            break
    return issues


def _merged_chord_dicts(
    chord_map: tuple[ChordEstimate, ...], prefer_flats: bool
) -> list[dict[str, Any]]:
    """Consecutive same-chord segments merged into readable spans -
    the meta progression reads "C | G | C", not sixteen half-bars."""
    out: list[dict[str, Any]] = []
    for est in chord_map:
        if out and out[-1]["rootPc"] == est.root_pc and out[-1]["quality"] == est.quality:
            out[-1]["endSec"] = round(est.end_sec, 3)
            out[-1]["confidence"] = round(min(out[-1]["confidence"], est.confidence), 3)
            continue
        out.append(est.to_dict(prefer_flats))
    return out


# pYIN is adopted on an isolated-vocal estimate only when its track
# agrees with the Basic Pitch melody line on most of its note-time —
# 60% sits far above the ~0 a tracker earns while following a
# bleed-dominated bass/pad line, and below the ~90% a genuinely
# shared vocal line scores.
LEAD_GATE_MIN_AGREEMENT = 0.6


def _lead_track_gate(
    backend_path: str,
    *,
    bp_revision: TranscriptionRevisionId,
    pyin_revision: TranscriptionRevisionId,
    hz_kwargs: dict[str, Any],
    prefer: str,
) -> tuple[bool, float, tuple[RawNoteEvent, ...], tuple[RawNoteEvent, ...]]:
    """Run pYIN and rescued Basic Pitch on the isolated estimate and
    return ``(adopt_pyin, agreement, winner, loser)`` (#165, #80).

    The losing track is returned too - it is an independent pitch
    opinion the gate already paid for, and the octave audit uses it
    as the disagreement arbiter (two engines an octave apart on the
    same span is exactly the case that needs a flag).

    #316 resolved pYIN unconditionally for an isolated vocal — the
    estimate was assumed monophonic.  In practice the centre
    extractor can leave a bass/pad line louder than the buried lead,
    and the tracker then follows that line end-to-end while the lead
    goes unheard (very-quiet-lead: pYIN scored 0/38 where Basic
    Pitch's melody arbitration found 35 of 38).  The gate adopts
    pYIN only when its track substantially agrees with the line
    Basic Pitch calls the melody — on a clean estimate both engines
    hear the vocal and pYIN's superior frame tracking wins
    legitimately; on a bleed-heavy one the polyphonic model's
    arbitration survives instead.
    """
    bp_events = predict_note_events_rescued(backend_path, revision=bp_revision, **hz_kwargs)
    pyin_events = predict_note_events_pyin(backend_path, revision=pyin_revision, **hz_kwargs)
    # The arbitration line mirrors the downstream clean — the gate
    # asks "did the tracker follow THE LINE", so the comparison
    # line is built with the texture's own overlap rule.
    bp_line = clean_monophonic(bp_events, merge_gap_sec=MERGE_GAP_SEC, prefer=prefer).events
    agreement = lead_track_agreement(bp_line, pyin_events)
    adopt_pyin = agreement >= LEAD_GATE_MIN_AGREEMENT or (not bp_line and bool(pyin_events))
    winner = pyin_events if adopt_pyin else bp_events
    loser = bp_events if adopt_pyin else pyin_events
    return adopt_pyin, agreement, winner, loser


def run_transcription_job(
    *,
    job_id: str,
    params: TranscriptionParams,
    emit: EventEmitter,
    cancel: threading.Event,
    backend: NoteBackend | None = None,
    loader: AudioLoader | None = None,
) -> None:
    """Run the staged transcription job, emitting job.event phases.

    ``backend`` defaults to Basic Pitch; tests inject a deterministic
    fake so the pipeline is exercised without the model stack. ``loader``
    defaults to librosa decode; tests inject synthetic samples so the
    whole stage order runs without the audio stack too.
    """
    started = time.monotonic()

    def stage(index: int) -> None:
        # #385: a stage boundary is position, not fraction — no
        # fabricated percentage rides along (GUI_UX_SPEC honesty).
        emit("progress", stage=STAGES[index])

    def step(index: int, done: int, total: int) -> None:
        # #385: the only in-stage progress allowed — counted work
        # units the stage actually finished (decoded chunks, cleaned
        # voices, quantized voices, verified parts).
        emit(
            "progress",
            stage=STAGES[index],
            step=done,
            totalSteps=total,
        )

    def cancelled(stage_index: int) -> bool:
        if cancel.is_set():
            emit(
                "cancelled",
                stage=STAGES[stage_index],
                reason="cancel requested between stages",
            )
            return True
        return False

    def timed_out(stage_index: int) -> bool:
        if (
            params.deadline_ms is not None
            and (time.monotonic() - started) * 1000.0 > params.deadline_ms
        ):
            emit(
                "failed",
                stage=STAGES[stage_index],
                error={
                    "code": ERR_JOB_TIMEOUT,
                    "message": f"job exceeded deadlineMs={params.deadline_ms}",
                },
            )
            return True
        return False

    def stop(stage_index: int) -> bool:
        return cancelled(stage_index) or timed_out(stage_index)

    # #229: a first-run demucs weight download can sit inside the
    # separation call for minutes with no stage progress -- name the
    # silence once per job, right before the call that triggers it.
    # demucs_available() keeps the note honest: no demucs install
    # means no download is coming.
    _model_download_noted = False

    def emit_model_download_note() -> None:
        nonlocal _model_download_noted
        if _model_download_noted:
            return
        if not (demucs_available() and demucs_weights_pending()):
            return
        _model_download_noted = True
        emit("progress", note="model_download")

    emit("started", stage=STAGES[0])
    try:
        # ---- preparing_audio ------------------------------------------
        if not os.path.isfile(params.audio_path):
            emit(
                "failed",
                stage=STAGES[0],
                error={
                    "code": ERR_JOB_FAILED,
                    "message": f"audio file not found: {params.audio_path}",
                },
            )
            return
        audio_hash = _sha256_file(params.audio_path)
        step(0, 1, 2)
        samples, sample_rate = (loader or load_mono_audio)(params.audio_path)
        step(0, 2, 2)
        duration_sec = len(samples) / float(sample_rate)

        # #229: a selection job slices the decoded audio BEFORE inference
        # — the backend, the beat track, and tempo estimation all see
        # only the chosen span instead of the whole file. Events come
        # back slice-relative; selection_offset_sec maps them to absolute
        # source seconds so clip_to_range, review seek targets, and
        # provenance stay on the original timeline.
        selection_offset_sec = 0.0
        if params.range_kind == "selection":
            sel_lo = params.selection_start_sec or 0.0
            sel_hi = (
                params.selection_end_sec if params.selection_end_sec is not None else duration_sec
            )
            sel_lo = max(0.0, min(sel_lo, duration_sec))
            sel_hi = max(sel_lo, min(sel_hi, duration_sec))
            if sel_hi - sel_lo <= 0.0:
                emit(
                    "failed",
                    stage=STAGES[1],
                    error={
                        "code": ERR_NO_PITCHED_CONTENT,
                        "message": "selection is empty or outside the audio",
                    },
                )
                return
            i0 = int(sel_lo * sample_rate)
            i1 = min(len(samples), math.ceil(sel_hi * sample_rate))
            samples = samples[i0:i1]
            selection_offset_sec = sel_lo

        # #321: whole-piece issues describe the span the engine actually
        # analysed — the selected slice for a selection job, the full
        # file otherwise. duration_sec stays the SOURCE length (meta),
        # it must not double as the analysis scope.
        analysis_range = TimeRange(
            start_sec=selection_offset_sec,
            end_sec=selection_offset_sec + len(samples) / float(sample_rate),
        )

        if stop(0):
            return

        # ---- transcribing (blocking ONNX call) ------------------------
        stage(1)
        # #229: the backend reads a file path — stage the slice as a
        # temp WAV so inference only processes the selected span. A
        # staging failure falls back to the original file (correct, just
        # slower); the temp is always removed after the blocking call.
        # #187: opt-in vocal isolation replaces the staged input with a
        # center-extracted vocal estimate (cache-managed when possible).
        staged_path: str | None = None
        vocal_path: str | None = None
        vocal_managed = False
        vocal_reason: str | None = None
        vocal_method: str | None = None
        vocal_method_version: str | None = None
        # #203: the accompaniment stem travels with the vocal stem —
        # produced by the same separation pass, so it exists whenever
        # vocal_path does (and survives being ignored when the option
        # or texture says no).
        accomp_path: str | None = None
        accomp_managed = False
        # Octave-repair arbitration must read the audio the events
        # were detected on — a stem line judged on the full mix lets
        # accompaniment energy veto real octave snaps and fabricates
        # support for bleed pitches the vocal never carried (the bass
        # is in the mix, not in the stem).  Decoded once here — the
        # temp stem may be unlinked before the clean stage reads it.
        stem_evidence: tuple[Any, int] | None = None
        # #256: the buffer every audio-evidence consumer reads for the
        # LEAD line — the stem when isolation (opt-in or rescue)
        # produced it, the source slice otherwise.  Boundary flags,
        # seam envelopes, octave verdicts and meter event-accents all
        # describe the detected line; on a separated run the mix
        # carries accompaniment transients the line never had.
        lead_evidence: tuple[Any, int] | None = None
        # #203/#204: the isolation span is needed by BOTH the opt-in
        # call below and the auto-rescue in the cleaning stage —
        # hoisted out of the elif so the rescue sees the same bounds.
        vis_lo = params.selection_start_sec or 0.0 if params.range_kind == "selection" else 0.0
        vis_hi = params.selection_end_sec if params.range_kind == "selection" else None
        # #322: vocal isolation is a solo-melody preprocess — under
        # voices/chords the user asked to KEEP the overlapping lines,
        # so stripping the accompaniment first would silently defeat
        # the texture. Skip it and report the conflict instead.
        polyphonic_texture = params.texture in ("voices", "chords")
        # #385: counted sub-steps — vocal isolation (when it will
        # run), selection staging (when needed), the backend call.
        # Each blocks internally; the honest count moves between them.
        transcribe_done = 0
        transcribe_total = (
            1
            + int(params.vocal_isolation and not polyphonic_texture)
            + int(params.range_kind == "selection")
        )
        if params.vocal_isolation and polyphonic_texture:
            vocal_reason = "polyphonic_texture"
        elif params.vocal_isolation:
            # Isolation covers exactly the backend's span: the
            # selection when one is set, else the whole file. A stray
            # selection_start_sec under range=all must not leak in.
            emit_model_download_note()
            (
                vocal_path,
                vocal_reason,
                vocal_managed,
                vocal_method,
                vocal_method_version,
            ) = vocal_wav(
                params.audio_path,
                audio_hash,
                vis_lo,
                vis_hi,
                sample_rate,
                quality=params.vocal_isolation_quality,
            )
            # #203: the companion stem shares the vocal file's
            # lifecycle — managed flag included.
            accomp_path = accompaniment_wav_for(vocal_path)
            accomp_managed = vocal_managed
            if vocal_path is not None:
                # Isolation produced the backend input — the staging
                # unit below is no longer part of the plan.
                transcribe_total -= int(params.range_kind == "selection")
                try:
                    stem_evidence = load_mono_audio(vocal_path)
                except Exception:
                    stem_evidence = None
                lead_evidence = stem_evidence
            transcribe_done += 1
            step(1, transcribe_done, transcribe_total)
        if vocal_path is None and params.range_kind == "selection":
            staged_path = _stage_selection_wav(samples, sample_rate)
            transcribe_done += 1
            step(1, transcribe_done, transcribe_total)
        backend_path = vocal_path or staged_path or params.audio_path
        # #189: "auto" picks the engine that fits the declared
        # texture — a declared-mono source gets the monophonic
        # tracker; mixes keep the polyphonic model.
        # #316/#165: an isolated vocal is USUALLY monophonic — but a
        # bleed-heavy estimate still carries the accompaniment, and
        # the monophonic tracker then locks the loudest surviving
        # line (very-quiet-lead: pYIN followed the bass end-to-end and
        # never heard the lead).  Under "auto" the isolated input
        # therefore goes through the lead-track gate: BOTH engines
        # run, and pYIN's track is adopted only when it agrees with
        # the melody line Basic Pitch arbitrates out of the
        # polyphony.  voices/chords keep the polyphonic model (the
        # user asked for every line); an explicit backend pin still
        # wins over everything; a declared-mono source without
        # isolation keeps the direct pYIN resolution.
        dual_track = (
            backend is None
            and params.backend == "auto"
            and vocal_path is not None
            and params.texture not in ("voices", "chords")
        )
        resolved_pyin = params.backend == "pyin" or (
            params.backend == "auto"
            and (
                params.texture == "mono"
                or (
                    vocal_path is not None
                    and params.texture not in ("voices", "chords")
                    # An injected backend keeps the legacy
                    # resolution — tests drive one deterministic
                    # engine and the gate must not see it.
                    and backend is not None
                )
            )
        )
        # Resolved backend identity for provenance — used by the
        # ScoreDocument fields, the job meta, AND the transcription
        # revision id (#237: the tr-* id must name the backend that
        # actually ran so a backend upgrade mints a new identity).
        backend_id = PYIN_BACKEND_ID if resolved_pyin else BACKEND_ID
        backend_version = BACKEND_VERSION
        if resolved_pyin:
            try:
                import librosa  # noqa: PLC0415

                # #421: the pyin path decodes with the lead-voice Viterbi
                # segmenter — name it in the version so tr-* identities
                # change when the decoder does.
                backend_version = librosa.__version__ + "+lead"
            except Exception:
                backend_version = "unknown"
        elif vocal_path is not None and backend is None:
            # #165: the isolated estimate also gets the two-pass
            # sensitive recall below — name the detection chain in
            # the identity like any other engine version (#319).
            backend_version = BACKEND_VERSION + "+rescue"
        # #319: the revision must name the preprocess that actually
        # ran — the same settings on two installs can feed different
        # audio to the backend (demucs vs center vs raw fallback),
        # so the tr-* identity follows the effective chain, not the
        # request. Recorded on the result meta for provenance too.
        preprocess: dict[str, Any] | None = None
        # #80: the lead-gate's losing track — an independent pitch
        # opinion on the same stem buffer, kept for the octave audit's
        # disagreement arbitration (empty when no gate ran).
        arbiter_events: tuple[RawNoteEvent, ...] = ()
        arbiter_backend = ""
        if params.vocal_isolation:
            preprocess = {
                "vocalIsolation": True,
                "method": vocal_method or "none",
                "methodVersion": vocal_method_version,
                # Why isolation did not apply (mono_source /
                # unavailable) — absent on a successful run.
                **({"fallbackReason": vocal_reason} if vocal_path is None and vocal_reason else {}),
            }
        revision = new_transcription_revision(
            audio_hash or params.audio_path,
            params.settings_dict(),
            backend_id=backend_id,
            backend_version=backend_version,
            preprocess=preprocess,
        )
        # Melody/auto/polyphonic textures widen the detection band:
        # JPOP vocals and mix melodies sit above the 880 Hz horn cap
        # (#236: auto must detect before it can judge — an 880 Hz
        # ceiling would drop the melody before the auto classifier
        # ever sees it).  Only the explicitly-monophonic texture
        # keeps the narrow horn band.
        max_hz = MELODY_MAX_FREQUENCY_HZ if params.texture != "mono" else None
        hz_kwargs: dict[str, Any] = {"max_frequency_hz": max_hz} if max_hz else {}
        try:
            if backend is not None:
                raw_events = backend(backend_path)
            elif dual_track:
                # The gate runs both engines under their own
                # provenance — the discarded track's revision is
                # thrown away with it, the winner's becomes THE
                # transcription revision (#237).
                pyin_version = "unknown"
                try:
                    import librosa  # noqa: PLC0415

                    pyin_version = librosa.__version__ + "+lead"
                except Exception:
                    pass
                pyin_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=PYIN_BACKEND_ID,
                    backend_version=pyin_version,
                    preprocess=preprocess,
                )
                adopt_pyin, agreement, gate_events, gate_loser = _lead_track_gate(
                    backend_path,
                    bp_revision=revision,
                    pyin_revision=pyin_revision,
                    hz_kwargs=hz_kwargs,
                    prefer="top" if params.texture == "melody" else "onset",
                )
                raw_events = gate_events
                arbiter_events = gate_loser
                arbiter_backend = BACKEND_ID if adopt_pyin else PYIN_BACKEND_ID
                if adopt_pyin:
                    resolved_pyin = True
                    revision = pyin_revision
                    backend_id = PYIN_BACKEND_ID
                    backend_version = pyin_version
                if preprocess is not None:
                    # Gate bookkeeping rides the meta's preprocess
                    # echo — the identity itself already names the
                    # adopted chain, so it stays out of the hash.
                    preprocess["leadTrackGate"] = {
                        "pyinAgreement": round(agreement, 4),
                        "adopted": "pyin" if adopt_pyin else "basicPitch",
                    }
            elif resolved_pyin:
                # #175: monophonic tracker — better for a single
                # sung line.
                raw_events = predict_note_events_pyin(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
            elif vocal_path is not None:
                # #165: two-pass sensitive recall on the isolated
                # estimate — a buried lead can sit under production
                # thresholds where the model still tracks it faintly.
                raw_events = predict_note_events_rescued(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
            else:
                raw_events = predict_note_events(
                    backend_path,
                    revision=revision,
                    **hz_kwargs,
                )
        finally:
            if staged_path is not None:
                with contextlib.suppress(OSError):
                    os.unlink(staged_path)
            if vocal_path is not None and not vocal_managed:
                with contextlib.suppress(OSError):
                    os.unlink(vocal_path)
        if staged_path is not None or vocal_path is not None:
            raw_events = _shift_event_times(raw_events, selection_offset_sec)
            # The arbiter rides the same timeline — it came off the
            #  same staged buffer, so the selection shift applies too.
            if arbiter_events:
                arbiter_events = _shift_event_times(
                    arbiter_events, selection_offset_sec
                )
        step(1, transcribe_done + 1, transcribe_total)
        if stop(1):
            return

        # ---- cleaning --------------------------------------------------
        stage(2)
        ranged = clip_to_range(raw_events, params.selection_start_sec, params.selection_end_sec)
        prefer = "top" if params.texture == "melody" else "onset"
        # #180: pyin already bridges tracker dropouts and splits real
        # re-articulations at onset times — re-merging same-pitch
        # neighbours inside clean_monophonic would undo that split.
        clean_merge_gap = 0.0 if resolved_pyin else MERGE_GAP_SEC

        # Octave-flicker repair evidence: when the neighbour pitch-class
        # rule proposes snapping a note across an octave, the note's own
        # spectrum arbitrates — a played octave figure carries its real
        # fundamental, a tracker flicker does not (octave-leaps-4-4:
        # honest C4->C5->C4 figures were being flattened).  The verdict
        # reads the analysis buffer, so event times map back through
        # selection_offset_sec exactly like the seam envelopes do.
        # Stem-detected events are judged on the STEM buffer (decoded
        # above), never on the full mix — the detected line's evidence
        # is only honest in the audio it was tracked from.
        def _octave_verdict_on(
            buffer: tuple[Any, int],
        ) -> Callable[[RawNoteEvent, float], bool]:
            buf, sr = buffer

            def _verdict(ev: RawNoteEvent, target: float) -> bool:
                return octave_prefers(
                    buf,
                    sr,
                    ev.onset_sec,
                    ev.offset_sec,
                    ev.pitch_midi,
                    target,
                    time_offset_sec=selection_offset_sec,
                )

            return _verdict

        _octave_ev = _octave_verdict_on(
            lead_evidence if lead_evidence is not None else (samples, sample_rate)
        )

        voice_split = None
        if params.texture in ("voices", "chords"):
            # #85: keep detected lines as separate parts — a chord
            # survives as voices instead of dropping the lowest note.
            # #155: the chords texture splits the same way, then merges
            # the voices into one part at build time.  #355: the cap is
            # the job's maxVoices (default 3, up to 8) — four-part
            # harmony is ordinary in chord-oriented sources.
            voice_split = split_voices(ranged, max_voices=params.max_voices)
            clean_total = len(voice_split.voices)
            cleaned = clean_monophonic(
                voice_split.voices[0],
                merge_gap_sec=clean_merge_gap,
                octave_verdict=_octave_ev,
            )
            step(2, 1, clean_total)
            cleaned_lowers = []
            for i, v in enumerate(voice_split.voices[1:]):
                cleaned_lowers.append(
                    clean_monophonic(
                        v,
                        merge_gap_sec=clean_merge_gap,
                        octave_verdict=_octave_ev,
                    )
                )
                step(2, 2 + i, clean_total)
        else:
            # boundary-4-4: same-pitch re-articulations (tongued
            # repeats) were being merged into one note. The boundary
            # expert's seam evidence arbitrates — but only under the
            # mono contract, where any attack on the seam belongs to
            # this line. Under melody/voices textures accompaniment
            # and other-voice onsets pollute the envelope, so their
            # merges stay unconditional (a mix transient is exactly
            # the false attack healing exists for). pyin already
            # splits articulations itself, hence clean_merge_gap > 0.
            edge_ev = None
            if prefer == "onset" and clean_merge_gap > 0:
                # #256: seam evidence describes the line being cleaned
                # — the stem when the events were detected on one;
                # the mix would invent attacks the vocal never had.
                _ev_buf, _ev_sr = (
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                )
                edge_env = compute_envelopes(
                    _ev_buf,
                    _ev_sr,
                    time_offset_sec=selection_offset_sec,
                )

                def _separated(a: RawNoteEvent, b: RawNoteEvent) -> bool:
                    return seam_evidence(a, b, edge_env).separated

                edge_ev = _separated
            cleaned = clean_monophonic(
                ranged,
                merge_gap_sec=clean_merge_gap,
                prefer=prefer,
                edge_evidence=edge_ev,
                octave_verdict=_octave_ev,
            )
            cleaned_lowers = []
            step(2, 1, 1)
        # #148: remember when auto detected a mix — the overlap warning
        # then suggests re-transcribing with the voices texture so the
        # accompaniment is not silently merged into the melody.
        # #204: the mix signature is BOTH the auto re-clean trigger and
        # the rescue gate — read it once off the first clean, before a
        # prefer="top" pass could fold the overlaps it counts.
        mix_signature = (
            bool(cleaned.events)
            and cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
            and cleaned.polyphonic_overlaps / len(cleaned.events) >= AUTO_TEXTURE_OVERLAP_RATIO
        )
        auto_mix_detected = params.texture == "auto" and mix_signature
        # #204: under auto/melody a detected mix now tries vocal
        # isolation BEFORE settling for the top-voice clip — the user
        # asked for the melody of a mix, and the isolated stem keeps
        # far more of it than clip-the-overlaps ever could. Explicit
        # contracts are honoured: an injected test backend, a pinned
        # pyin engine, an explicit vocalIsolation=False under voices/
        # chords (already skipped above), or a declared-mono source
        # all stay on the raw path.
        rescue_applied = False
        if (
            mix_signature
            and params.texture in ("auto", "melody")
            and not params.vocal_isolation
            and params.backend != "pyin"
            and backend is None
            and vocal_path is None
        ):
            emit_model_download_note()
            (
                rescue_vocal_path,
                _rescue_reason,
                rescue_managed,
                rescue_method,
                rescue_method_version,
            ) = vocal_wav(
                params.audio_path,
                audio_hash,
                vis_lo,
                vis_hi,
                sample_rate,
                # Engine-initiated separation keeps the fast tier — a
                # ~4x precision run is the user's explicit choice,
                # not something the pipeline spends silently.
                quality="standard",
            )
            rescue_accomp_path = (
                accompaniment_wav_for(rescue_vocal_path) if rescue_vocal_path is not None else None
            )
            rescue_cleaned = None
            rescue_events: tuple[RawNoteEvent, ...] = ()
            rescue_adopted_pyin = False
            rescue_pyin_revision: TranscriptionRevisionId | None = None
            rescue_pyin_version = ""
            if rescue_vocal_path is not None and not stop(2):
                rescue_preprocess = {
                    "vocalIsolation": True,
                    "method": rescue_method or "none",
                    "methodVersion": rescue_method_version,
                    "auto": True,
                }
                rescue_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=BACKEND_ID,
                    backend_version=BACKEND_VERSION + "+rescue",
                    preprocess=rescue_preprocess,
                )
                # #234: the rescue stem gets the same dual-track
                # arbitration the opt-in path runs (#165) -- on a real
                # mix the ungated Basic Pitch line crushed ~270
                # polyphonic overlaps into the top voice; a pYIN
                # track that agrees with the melody line is the
                # cleaner single-line answer.
                rescue_pyin_version = "unknown"
                try:
                    import librosa  # noqa: PLC0415

                    rescue_pyin_version = librosa.__version__ + "+lead"
                except Exception:
                    pass
                rescue_pyin_revision = new_transcription_revision(
                    audio_hash or params.audio_path,
                    params.settings_dict(),
                    backend_id=PYIN_BACKEND_ID,
                    backend_version=rescue_pyin_version,
                    preprocess=rescue_preprocess,
                )
                try:
                    rescue_adopted_pyin, agreement, gate_events, _ = _lead_track_gate(
                        rescue_vocal_path,
                        bp_revision=rescue_revision,
                        pyin_revision=rescue_pyin_revision,
                        hz_kwargs=hz_kwargs,
                        prefer="top",
                    )
                    rescue_events = gate_events
                    rescue_preprocess["leadTrackGate"] = {
                        "pyinAgreement": round(agreement, 4),
                        "adopted": "pyin" if rescue_adopted_pyin else "basicPitch",
                    }
                except Exception:
                    try:
                        rescue_events = predict_note_events_rescued(
                            rescue_vocal_path,
                            revision=rescue_revision,
                            **hz_kwargs,
                        )
                    except Exception:
                        rescue_events = ()
                rescue_events = _shift_event_times(rescue_events, selection_offset_sec)
                rescue_ranged = clip_to_range(
                    rescue_events,
                    params.selection_start_sec,
                    params.selection_end_sec,
                )
                # Same evidence rule as the opt-in stem: the rescue
                # stem's own buffer arbitrates its octave repairs —
                # the mix would veto true snaps with accompaniment
                # energy that is not in the detected line.
                rescue_evidence: tuple[Any, int] | None = None
                try:
                    rescue_evidence = load_mono_audio(rescue_vocal_path)
                except Exception:
                    rescue_evidence = None
                rescue_cleaned = clean_monophonic(
                    rescue_ranged,
                    # #180: an adopted pYIN track already bridges
                    # dropouts — re-merging would undo its real
                    # re-articulation splits.
                    merge_gap_sec=0.0 if rescue_adopted_pyin else MERGE_GAP_SEC,
                    prefer="top",
                    octave_verdict=_octave_verdict_on(
                        rescue_evidence
                        if rescue_evidence is not None
                        else (samples, sample_rate)
                    ),
                )
            if rescue_cleaned is not None and rescue_cleaned.events:
                # Adopt the rescue: provenance re-mints so the tr-* id
                # names the chain that actually produced the score.
                if rescue_adopted_pyin and rescue_pyin_revision is not None:
                    # #234: the gate picked pYIN — the adopted track's
                    # own identity becomes THE revision (#237), same
                    # rule the opt-in dual_track path follows.
                    revision = rescue_pyin_revision
                    backend_id = PYIN_BACKEND_ID
                    backend_version = rescue_pyin_version
                    resolved_pyin = True
                else:
                    revision = rescue_revision
                    backend_id = BACKEND_ID
                    backend_version = BACKEND_VERSION + "+rescue"
                preprocess = rescue_preprocess
                vocal_path = rescue_vocal_path
                vocal_managed = rescue_managed
                vocal_reason = "applied"
                vocal_method = rescue_method
                vocal_method_version = rescue_method_version
                accomp_path = rescue_accomp_path
                accomp_managed = rescue_managed
                ranged = rescue_ranged
                cleaned = rescue_cleaned
                rescue_applied = True
                # #256: every downstream audio-evidence read for the
                # lead now resolves against the rescue stem — the
                # events were detected on it, not on the mix.
                lead_evidence = rescue_evidence
                auto_mix_detected = params.texture == "auto"
                # Adopting the stem replaces the whole raw-event set —
                # earlier raw detection output is discarded.
                raw_events = rescue_events
                # Same temp lifecycle as the opt-in path — the
                # backend already consumed the stem.
                if not vocal_managed:
                    with contextlib.suppress(OSError):
                        os.unlink(vocal_path)
            else:
                # Stem empty or detection failed — drop the rescue
                # temps; the top-voice fallback below still applies.
                for p, managed in (
                    (rescue_vocal_path, rescue_managed),
                    (rescue_accomp_path, rescue_managed),
                ):
                    if p and not managed:
                        with contextlib.suppress(OSError):
                            os.unlink(p)
            if rescue_applied:
                step(2, 2, 2)
        if auto_mix_detected and not rescue_applied:
            # Mix detected — keep the melody line instead of clipping
            # it (the #204 rescue did not produce a usable stem).
            cleaned = clean_monophonic(
                ranged,
                merge_gap_sec=clean_merge_gap,
                prefer="top",
                octave_verdict=_octave_ev,
            )
            # The re-clean is a second real unit — the total grows
            # from 1 to 2 only when the mix signature actually
            # forced the extra pass.
            step(2, 2, 2)
        # #200: a mono-declared job with the same overlap signature
        # probably means the audio was not actually monophonic — the
        # voices re-run remedy applies there too (melody intentionally
        # folds accompaniment into the top line, so it stays exempt).
        mix_suggest_voices = auto_mix_detected or (
            params.texture == "mono"
            and cleaned.events
            and cleaned.polyphonic_overlaps >= AUTO_TEXTURE_MIN_OVERLAPS
            and cleaned.polyphonic_overlaps / len(cleaned.events) >= AUTO_TEXTURE_OVERLAP_RATIO
        )
        if not cleaned.events:
            emit(
                "failed",
                stage=STAGES[2],
                error={
                    "code": ERR_NO_PITCHED_CONTENT,
                    "message": "no pitched notes detected in the audio",
                },
            )
            return
        # #203/#213: accompaniment staff — when isolation (opt-in or
        # the #204 rescue) produced an accompaniment stem and the job
        # did not opt out, detect its lines on the same grid.  Up to
        # four voices are kept so triads and seventh chords survive;
        # they merge into ONE accompaniment staff at build time, where
        # aligned rhythms render as in-part chords.
        accomp_cleaned: list[CleanedEvents] = []
        # #244: running count of sub-floor flicker dropped from the
        # accompaniment detections, reported in meta for review.
        accomp_conf_dropped = 0
        accomp_seam_merged = 0
        accomp_sliver_folded = 0
        accomp_onsets_backdated = 0
        accomp_continuity_merged = 0
        # Shared per-pitch band evidence over the accompaniment stem —
        # built inside the stem branch below; stays None when no stem
        # ran so every consumer degrades to its no-evidence path.
        accomp_bands: _AccompBands | None = None
        # #233/#260/#259: grab the stem's decoded audio + evidence
        # curves now, while the file still exists -- stage 3 uses the
        # onset/flux pools for meter accents, stage 5 reuses the
        # samples for the chord map.
        accomp_y, accomp_env_sr, accomp_env = _stem_analysis(accomp_path)
        if accomp_path is not None and params.accompaniment_part:
            # The accomp voices were detected on the accompaniment
            # stem — their octave-flicker arbitration must read THAT
            # stem.  _octave_ev is bound to the vocal stem (or the
            # source for unseparated jobs): judging accomp events on
            # the vocal stem vetoes every snap, since the stem's
            # whole point is that the accompaniment is not in it.
            accomp_evidence: tuple[Any, int] | None = (
                (accomp_y, accomp_env_sr) if accomp_y is not None else None
            )
            _accomp_octave_ev = _octave_verdict_on(
                accomp_evidence
                if accomp_evidence is not None
                else (samples, sample_rate)
            )
            try:
                accomp_events = predict_note_events(
                    accomp_path,
                    revision=revision,
                    # The accompaniment band is the full melody band —
                    # a declared-mono texture caps the LEAD at 880 Hz
                    # but backing keys/guitar live far above it.
                    max_frequency_hz=MELODY_MAX_FREQUENCY_HZ,
                )
            except Exception:
                accomp_events = ()
            # A second predict_* call re-mints rne-* ids from zero —
            # identical to the lead line's ids.  Rename BEFORE the
            # events enter the shared event_by_id namespace or an
            # accompaniment note would resolve its pitch/confidence
            # off the colliding lead event and render garbage.
            accomp_events = tuple(
                replace(e, id=RawNoteEventId(f"rne-a{i + 1:06d}"))
                for i, e in enumerate(accomp_events)
            )
            accomp_events = _shift_event_times(accomp_events, selection_offset_sec)
            accomp_ranged = clip_to_range(
                accomp_events,
                params.selection_start_sec,
                params.selection_end_sec,
            )
            # #244: the "other" stem is Basic-Pitch flicker-heavy --
            # drop short sub-confidence detections before they vote
            # for voices or gate lead notes as bleed.
            pre_floor = len(accomp_ranged)
            accomp_ranged = _accomp_confidence_floor(accomp_ranged)
            accomp_conf_dropped += pre_floor - len(accomp_ranged)
            # #160+#155: seam questions, onset backdates and pad
            # mining all read the accompaniment stem's per-pitch
            # band evidence — one shared STFT pass answers all of
            # them (a drum hit must not veto a heal, a real bass
            # re-attack must not merge, a late onset must move
            # back to where the band actually rose).
            accomp_bands = _accomp_band_evidence(
                accomp_y,
                accomp_env_sr,
                time_offset_sec=selection_offset_sec,
            )
            if accomp_ranged:
                a_split = split_voices(
                    accomp_ranged,
                    max_voices=min(4, params.max_voices),
                    merge_gap_sec=_ACCOMP_MERGE_GAP_SEC,
                    ghost_attack_slack_sec=_ACCOMP_GHOST_ATTACK_SLACK_SEC,
                )
                accomp_seam = (
                    accomp_bands.separated if accomp_bands is not None else None
                )
                for v in a_split.voices:
                    c = clean_monophonic(
                        v,
                        merge_gap_sec=_ACCOMP_MERGE_GAP_SEC,
                        octave_verdict=_accomp_octave_ev,
                    )
                    if c.events:
                        healed, seam_merges = _heal_accomp_fragments(
                            c.events, accomp_seam
                        )
                        if seam_merges:
                            accomp_seam_merged += seam_merges
                        healed, slivers = _fold_accomp_slivers(healed)
                        if slivers:
                            accomp_sliver_folded += slivers
                        healed, backdated, cont_merged = (
                            _backdate_accomp_onsets(healed, accomp_bands)
                        )
                        accomp_onsets_backdated += backdated
                        accomp_continuity_merged += cont_merged
                        merges = seam_merges + slivers + cont_merged
                        if merges or backdated:
                            c = replace(
                                c,
                                events=healed,
                                merged=c.merged + merges,
                            )
                        accomp_cleaned.append(c)
            # #136: sustained pads never reach Basic Pitch's attack-
            # driven detector — mine the stem's spectrum for held
            # pitch bands and add them as one more accompaniment
            # voice (deduped against what the detector did find).
            pad_extra = _accomp_pad_completion(
                accomp_y,
                accomp_env_sr,
                accomp_ranged,
                revision,
                time_offset_sec=selection_offset_sec,
                band_evidence=accomp_bands,
            )
            if pad_extra:
                accomp_cleaned.extend(_pad_event_voices(pad_extra))
            # The stem file's job ends at detection — an unmanaged
            # temp is released here, the managed cache copy stays.
            if not accomp_managed:
                with contextlib.suppress(OSError):
                    os.unlink(accomp_path)
            accomp_path = None
        elif accomp_path is not None and not accomp_managed:
            # Part opted out — release the unused stem temp.
            with contextlib.suppress(OSError):
                os.unlink(accomp_path)
            accomp_path = None
        # #155: dedup contained same-pitch events across the surviving
        # accompaniment voices before anything downstream reads them —
        # one stacked unison per physical tone. Band evidence also
        # unions a tracker/miner pair that split one held tone at a
        # mid-sustain detection.
        _accomp_pre_dedup = sum(len(c.events) for c in accomp_cleaned)
        accomp_cleaned = _dedup_accomp_unison(accomp_cleaned, accomp_bands)
        accomp_unison_dropped = _accomp_pre_dedup - sum(
            len(c.events) for c in accomp_cleaned
        )
        # #236: the lead track keeps only notes the accompaniment stem
        # does NOT explain -- sub-register bleed lands in the 伴奏 part
        # where it belongs instead of dragging the melody into bass
        # clef. Runs before rhythm analysis so fake bass onsets never
        # reach the accent pool either.
        if accomp_cleaned and cleaned.events:
            cleaned = _drop_stem_bleed_lows(cleaned, accomp_cleaned)
        if stop(2):
            return

        # ---- analyzing_rhythm -----------------------------------------
        stage(3)
        meter = params.meter_segment()
        meter_estimated = False
        meter_uncertain = False
        meter_est_label: str | None = None
        meter_runner_up: str | None = None
        pulse_unit_ql: Fraction | None = None
        # #385: counted sub-steps — beat track (when needed), meter
        # estimate (auto only), tempo estimate.
        rhythm_done = 0
        rhythm_total = 0
        # #229: the beat track runs on the slice, so it must also run
        # whenever estimate_tempo would track internally on the slice —
        # a pinned meter + auto tempo + selection would otherwise mix
        # slice-relative beat anchors with absolute event times and
        # misplace the whole warp. Shifted beats are absolute seconds,
        # matching the events.
        need_beats = params.meter == "auto" or (
            params.tempo_bpm is None and selection_offset_sec > 0.0
        )
        rhythm_total += int(need_beats) + int(params.meter == "auto") + 1
        if need_beats:
            tracked_times, strengths = _track_beats(samples, sample_rate)
            beat_times = tuple(t + selection_offset_sec for t in tracked_times)
            rhythm_done += 1
            step(3, rhythm_done, rhythm_total)
        else:
            beat_times = None
            strengths = ()
        # #150: the accompaniment part's onsets feed two rhythm-stage
        # consumers — the meter estimate's independent accent channel
        # and the pickup analysis's downbeat-phase evidence. Build the
        # pool once here so a pinned meter still gets the latter.
        accomp_accent_pool: tuple[tuple[float, float], ...] | None = None
        if accomp_cleaned and accomp_y is not None:
            acc_pool = _event_accents(
                # #162: only detected attacks vote on meter/pickup
                # phase — mined pad onsets are not articulations.
                _accomp_detected_events(accomp_cleaned),
                accomp_y,
                accomp_env_sr,
                time_offset_sec=vis_lo,
            )
            if len(acc_pool) >= _ACCOMP_METER_MIN_ACCENTS:
                accomp_accent_pool = acc_pool
        if params.meter == "auto":
            # #228: auto meter reads accents off a beat track — run it
            # even when the user pinned the tempo (the pinned BPM only
            # replaces the warp; the accent evidence is still real).
            # The same track feeds the tempo warp when tempo is auto.
            accents = _event_accents(
                (e for c in (cleaned, *cleaned_lowers) for e in c.events),
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                time_offset_sec=selection_offset_sec,
            )
            # #147: independent evidence scores as INDEPENDENT
            # channels inside estimate_meter — a slot-max merge with
            # the flat four-on-the-floor stem envelope used to bury
            # every real period ratio under a ~1.0 floor and force a
            # refusal on straight 4/4 pop.
            channel_accents: dict[str, tuple[tuple[float, float], ...]] = {}
            # The accompaniment PART's onsets are the strongest
            # downbeat evidence a separated mix offers — bass/chord
            # changes land on barlines (measured ratio4 1.58 vs 1.08
            # for the merged pool on the reference J-pop mix). They
            # already exist here: the part transcribed before the
            # rhythm stage, and the pool was built above for the
            # pickup phase evidence too (#150).
            if accomp_accent_pool is not None:
                channel_accents["accompaniment"] = accomp_accent_pool
            # #233: on a separated mix the melody line's onsets are
            # the WORST meter evidence (vocal phrases start off-beat);
            # the no_vocals stem still carries the drums/bass that
            # mark downbeats. The env samples ride their own channel
            # now — and only when the detected part produced no pool,
            # since two channels drawn from the same stem would
            # double-vote one source. The pool is scale-free, so the
            # old p90 normalisation is gone with the merge.
            if (
                accomp_env is not None
                and beat_times
                and "accompaniment" not in channel_accents
            ):
                stem_acc = tuple(
                    (
                        t,
                        float(accomp_env[i])
                        if 0
                        <= (
                            i := int(
                                round(
                                    (t - vis_lo) * accomp_env_sr / 512.0
                                )
                            )
                        )
                        < len(accomp_env)
                        else 0.0,
                    )
                    for t in beat_times
                )
                if any(a > 0 for _, a in stem_acc):
                    channel_accents["accompaniment_env"] = stem_acc
            meter_est = estimate_meter(
                beat_times or (),
                strengths,
                event_accents=accents,
                channel_accents=channel_accents or None,
            )
            # A refusal abstains: its '4/4' field is the written
            # fallback, not a rejected guess — report no estimate so
            # the review copy reads 'undecidable' instead of
            # 'candidate: 4/4, wrote 4/4' (#147).
            meter_est_label = None if meter_est.refused else meter_est.meter
            # #24 contract fix: an uncertain estimate never writes its
            # guess — the estimator contract (meter.py) says the caller
            # falls back to 4/4 and lets the meter_conflict review
            # issue carry the rejected label, so the user overrides a
            # readable score instead of living under a coin flip.
            label = "4/4" if meter_est.uncertain else meter_est.meter
            meter = MeterSegment(
                start_ql=Fraction(0),
                numerator=int(label.split("/")[0]),
                denominator=int(label.split("/")[1]),
            )
            meter_estimated = True
            meter_uncertain = meter_est.uncertain
            meter_confidence = meter_est.confidence
            meter_runner_up = meter_est.runner_up
            # A non-beat tracked pulse anchors only when the meter read
            # was trusted — an uncertain guess must not re-denominate
            # the tracked beat (that is exactly how a misread 6/8
            # printed "37.45" for a ~108 bpm source).
            if meter_est.tracked_unit_ql is not None and not meter_est.uncertain:
                pulse_unit_ql = meter_est.tracked_unit_ql
            rhythm_done += 1
            step(3, rhythm_done, rhythm_total)
        else:
            meter_confidence = 1.0
        estimate = estimate_tempo(
            samples,
            sample_rate,
            meter,
            tempo_bpm=params.tempo_bpm,
            first_onset_sec=cleaned.events[0].onset_sec,
            beat_times=beat_times,
            pulse_unit_ql=pulse_unit_ql,
            beat_strengths=strengths,
            phase_accents=accomp_accent_pool,
        )
        rhythm_done += 1
        step(3, rhythm_done, rhythm_total)
        if estimate.pickup_len_ql:
            meter = MeterSegment(
                start_ql=Fraction(0),
                numerator=meter.numerator,
                denominator=meter.denominator,
                measure_phase_ql=(meter.measure_length_ql - estimate.pickup_len_ql),
            )
        meter_map = MeterMap((meter,))
        if stop(3):
            return

        # ---- quantizing ------------------------------------------------
        stage(4)
        profile = params.quantization_profile()
        alternatives = quantize_events(cleaned.events, estimate.warp, meter_map, profile)
        # #385: one real unit per quantized voice.
        quantize_total = 1 + sum(1 for c in cleaned_lowers if c.events)
        # #203: each surviving accompaniment voice is a real unit too.
        quantize_total += len(accomp_cleaned)
        step(4, 1, quantize_total)
        if not alternatives:
            emit(
                "failed",
                stage=STAGES[4],
                error={
                    "code": ERR_NO_PITCHED_CONTENT,
                    "message": "quantization produced no notes",
                },
            )
            return
        best = alternatives[0]
        # #85 (voices texture): the second voice quantizes against the
        # SAME tempo/meter map AND the same alignment shift — separate
        # searches would let the parts drift against each other.
        lower_alternatives = []
        quantize_done = 1
        for cleaned_lower in cleaned_lowers:
            if not cleaned_lower.events:
                continue
            alts = quantize_events(
                cleaned_lower.events,
                estimate.warp,
                meter_map,
                profile,
                alignment_shift_sec=best.diagnostics.alignment_shift_sec,
            )
            if alts:
                lower_alternatives.append(alts)
            quantize_done += 1
            step(4, quantize_done, quantize_total)
        if stop(4):
            return
        # #203: accompaniment voices quantize against the SAME warp,
        # meter map and alignment shift — the two staves must stay
        # glued to one grid.
        accomp_alternatives = []
        # #213: the voices merge into ONE accompaniment part at build
        # time, so their events merge into ONE evidence list too —
        # raw_evidence.parts must line up 1:1 with payload.parts or
        # requantize silently falls back to the synthetic path.
        accomp_evidence: list[RawNoteEvent] = []
        for c in accomp_cleaned:
            alts = quantize_events(
                c.events,
                estimate.warp,
                meter_map,
                profile,
                alignment_shift_sec=best.diagnostics.alignment_shift_sec,
            )
            if alts:
                accomp_alternatives.append(alts)
                accomp_evidence.extend(c.events)
            quantize_done += 1
            step(4, quantize_done, quantize_total)
        if stop(4):
            return

        # ---- building_score -------------------------------------------
        stage(5)
        # #385: counted sub-steps — key analysis, swing census, tempo
        # octave census (auto tempo only), build_score, evidence doc.
        build_done = 0
        build_total = 4 + int(estimate.auto)
        event_by_id: dict[RawNoteEventId, RawNoteEvent] = {e.id: e for e in cleaned.events}
        for cleaned_lower in cleaned_lowers:
            for e in cleaned_lower.events:
                event_by_id.setdefault(e.id, e)
        for c in accomp_cleaned:
            for e in c.events:
                event_by_id.setdefault(e.id, e)
        key_pitches: list[int] = []
        key_durations: list[Fraction] = []
        key_onsets: list[Fraction] = []
        beat_ql = Fraction(4, meter.denominator)
        for n in best.notes:
            src = [event_by_id[e] for e in n.source_event_ids if e in event_by_id]
            if not src:
                continue
            key_pitches.append(int(round(src[0].pitch_midi)))
            key_durations.append(n.duration_ql)
            key_onsets.append(n.onset_ql / beat_ql)
        # #133: measure boundaries on the canonical BEAT axis — the
        # pickup measure spans [0, pickup), then full measures tile from
        # there. Key segments snap to these starts.
        measure_len_ql = meter.measure_length_ql
        measure_starts: list[Fraction] = [Fraction(0)]
        pos = (estimate.pickup_len_ql or measure_len_ql) / beat_ql
        last_onset = max((n.onset_ql / beat_ql for n in best.notes), default=Fraction(0))
        while pos <= last_onset:
            measure_starts.append(pos)
            pos += measure_len_ql / beat_ql
        # #352: one analysis produces the key map AND the uncertainty
        # evidence — segmentation guards live inside analyze_key.
        # #53: a user-pinned key replaces the analysis entirely —
        # spelling, chord priors and the signature all take the hint,
        # and no key_uncertain issue can fire on a user attestation.
        key_hint_sig = params.key_signature_hint()
        key_analysis = None
        if key_hint_sig is not None:
            key = key_hint_sig
            key_changes: tuple[KeyChange, ...] = ()
            key_confidence = 1.0
        else:
            key_analysis = analyze_key(
                tuple(key_pitches),
                tuple(key_onsets),
                tuple(key_durations),
                tuple(measure_starts),
            )
            key = key_analysis.key
            key_changes = key_analysis.changes
            key_confidence = key_analysis.confidence
        # #419: chord map — half-measure segments snapped to the
        # canonical beat grid, chroma-matched then Viterbi-smoothed
        # under the key prior. Runs on the slice; a failure leaves an
        # empty map rather than sinking the job (enhancement layer).
        prefer_flats = key.fifths < 0
        chord_map: tuple[ChordEstimate, ...] = ()
        chord_symbols: tuple[ChordSymbol, ...] = ()
        try:
            half_beats = measure_len_ql / (2 * beat_ql)
            bounds: set[Fraction] = {Fraction(0)}
            for ms in measure_starts:
                bounds.add(ms + half_beats)
                bounds.add(ms + measure_len_ql / beat_ql)
            ordered_bounds = sorted(bounds)
            # Segment defs keep the canonical BEAT bounds next to the
            # audio seconds - estimate_chords consumes the seconds,
            # and the beat bounds tag the returned estimates one-to-
            # one as ScoreDocument chord symbols (#44).
            seg_beats: list[tuple[Fraction, Fraction]] = []
            seg_secs: list[tuple[float, float]] = []
            for lo_b, hi_b in pairwise(ordered_bounds):
                lo_s = estimate.warp.ql_to_seconds(lo_b * beat_ql) - selection_offset_sec
                hi_s = estimate.warp.ql_to_seconds(hi_b * beat_ql) - selection_offset_sec
                if hi_s > lo_s:
                    seg_beats.append((lo_b, hi_b))
                    seg_secs.append((lo_s, hi_s))
            chord_map = tuple(
                replace(
                    est,
                    start_sec=est.start_sec + selection_offset_sec,
                    end_sec=est.end_sec + selection_offset_sec,
                )
                for est in estimate_chords(
                    # #259: the accompaniment stem carries the harmony
                    # without vocal non-chord tones or the drum mask —
                    # chroma read off it resolves the maj7/min7 pairs
                    # the full mix kept collapsing. Falls back to the
                    # mix when no separation ran.
                    accomp_y if accomp_y is not None else samples,
                    accomp_env_sr if accomp_y is not None else sample_rate,
                    tuple(seg_secs),
                    diatonic=diatonic_chords(key.fifths, key.mode),
                    prefer_flats=prefer_flats,
                )
            )
            # #145: harmony self-check — the melodic K-S estimate can
            # pick a signature the detected chord set contradicts (an
            # F-major chord inside an E-minor signature).  Re-rank the
            # candidates against melody+chord-root coverage before the
            # chord labels and the score spelling commit to that key.
            # Modulating pieces and user-pinned keys keep their answer.
            if key_hint_sig is None and not key_changes and chord_map:
                try:
                    refined = refine_key_with_harmony(
                        tuple(key_pitches),
                        tuple(key_durations),
                        chord_map,
                    )
                except Exception:  # noqa: BLE001 - advisory only
                    refined = None
                if (
                    refined is not None
                    and refined.key != key
                    and key_analysis is not None
                ):
                    key = refined.key
                    key_analysis = replace(
                        key_analysis,
                        head=refined,
                        confidence=refined.confidence,
                    )
                    key_confidence = refined.confidence
                    prefer_flats = key.fifths < 0
            chord_symbols = tuple(
                ChordSymbol(
                    start_beat=lo_b,
                    end_beat=hi_b,
                    root_pc=est.root_pc,
                    quality=est.quality,
                    confidence=est.confidence,
                    margin=est.margin,
                    label=est.label(prefer_flats),
                )
                for (lo_b, hi_b), est in zip(seg_beats, chord_map, strict=True)
            )
        except Exception:  # noqa: BLE001 - enhancement layer
            chord_map = ()
            chord_symbols = ()
        build_done += 1
        step(5, build_done, build_total)
        tempo_map = tempo_map_from_estimate(
            estimate,
            meter,
            # #133: "the music's end" is the latest onset across ALL
            # parts — a pad outro ringing past the lead's last note
            # still defines where measured tempo evidence stops.
            last_onset_sec=max(
                [cleaned.events[-1].onset_sec]
                + [
                    e.onset_sec
                    for c in accomp_cleaned
                    for e in c.events
                ]
            ),
        )
        shift = best.diagnostics.alignment_shift_sec
        # #134 swing feel: census the normalized offbeat onsets — a
        # dominant 2/3-of-beat cluster with a quiet 1/3 cluster reads
        # as shuffle, not triplets. The estimate lands on the payload
        # (notation emits a swing direction) AND feeds a review issue.
        normalized = normalize_to_score_time(
            cleaned.events, estimate.warp, alignment_shift_sec=shift
        )
        swing_est = detect_swing(
            tuple(n.onset_ql for n in normalized),
            Fraction(4, meter.denominator),
        )
        build_done += 1
        step(5, build_done, build_total)
        # #188 tempo octave census — only meaningful when the tempo
        # came from tracking (a pinned BPM is the user's word).
        tempo_octave = (
            detect_tempo_octave(
                tuple(e.onset_sec for e in cleaned.events),
                estimate.beat_times_sec,
            )
            if estimate.auto
            else None
        )
        if estimate.auto:
            build_done += 1
            step(5, build_done, build_total)
        built = build_score(
            best,
            meter,
            tempo_map,
            key,
            pickup_len_ql=estimate.pickup_len_ql,
            event_by_id=event_by_id,
            # #305: the score title is the user's file name, not the
            # path the backend actually read — a staged browser-dev
            # temp would otherwise leak ``staged-<ts>-`` onto the page.
            title=(
                Path(params.display_name).stem
                if params.display_name
                else Path(params.audio_path).stem
            ),
            source_audio_path=params.audio_path,
            source_audio_hash=audio_hash,
            settings=params.settings_dict(),
            extra_voices=(tuple(alts[0] for alts in lower_alternatives)),
            extra_parts=(
                # #213: all surviving accompaniment voices merge into
                # ONE staff — same-rhythm notes become in-part chords,
                # the rest become notation layers, and voice-1 gaps
                # get synthesized measure rests so layer 0 still tiles.
                (("伴奏", tuple(alts[0] for alts in accomp_alternatives)),)
                if accomp_alternatives
                else ()
            ),
            merge_voices=params.texture == "chords",
            voice_names=(
                # #251: the chords texture is an analytical capture of
                # simultaneous notes, not a one-player part — the part
                # name says so wherever the score is exported.
                ("Horn in F (chords)",) if params.texture == "chords" else ()
            ),
            key_changes=key_changes,
            swing_feel=(swing_est.mean_phase if swing_est.detected else None),
            transcription_backend=backend_id,
            transcription_backend_version=backend_version,
        )
        build_done += 1
        step(5, build_done, build_total)
        # #223/#226: persist the raw transcription evidence inline on
        # the document — the cleaned events per part plus the warp that
        # mapped them. A later requantize replays the real performance
        # under new settings instead of re-rounding the notation, and
        # the evidence survives project saves/restarts (the document is
        # already stored inside the project file).
        evidence_parts = (
            [
                sorted(
                    [e for c in (cleaned, *cleaned_lowers) for e in c.events],
                    key=lambda e: (e.onset_sec, e.pitch_midi, str(e.id)),
                )
            ]
            if params.texture == "chords"
            else [list(c.events) for c in (cleaned, *cleaned_lowers)]
        )
        # #203/#213: the merged accompaniment part keeps its events in
        # evidence too — one entry per emitted part (positional parity
        # with payload.parts is what lets requantize replay them).
        if accomp_evidence:
            evidence_parts.append(
                sorted(
                    accomp_evidence,
                    key=lambda e: (e.onset_sec, e.pitch_midi, str(e.id)),
                )
            )
        document = replace(
            built.document,
            raw_evidence={
                "transcriptionRevision": str(revision),
                "warp": _warp_evidence(estimate.warp),
                "parts": [{"events": [e.to_dict() for e in evs]} for evs in evidence_parts],
            },
            # #44: the chord map rides along as document-level
            # analysis - MusicXML export renders it as <harmony>.
            chord_symbols=chord_symbols,
        )
        build_done += 1
        step(5, build_done, build_total)
        payload = built.payload
        score_revision = payload.revision_id()

        # Review issues: quantizer reasons + confidence/range/length.
        issues = list(
            generate_review_issues(
                alternatives,
                normalized,
                meter_map,
                profile,
                score_revision=score_revision,
                warp=estimate.warp,
                beat_ql=beat_ql,
            )
        )
        quantizer_issues_count = len(issues)
        # #249: per-note checks (confidence / horn range / duration)
        # only make sense on the transposing horn staves -- the
        # accompaniment part is covered by the single
        # ACCOMPANIMENT_PART marker (#212), and flagging its notes
        # floods the review list (a piano bass line reads as hundreds
        # of "outside horn range" cautions that also crowd real lead
        # warnings out of the severity cap).
        issues.extend(
            _extra_issues(
                tuple(
                    n
                    for p in built.payload.parts
                    if p.transposing
                    for n in p.notes
                ),
                built.note_confidence,
                built.note_onset_sec,
                event_by_id,
                score_revision,
            )
        )
        # #272: severity-priority cap — warnings surface before
        # cautions before infos, ties broken by time. A flood of
        # early low-severity detections can no longer silently drop
        # a later warning; the omitted count lands in reviewSummary.
        _severity_rank = {
            Severity.WARNING: 0,
            Severity.CAUTION: 1,
            Severity.INFO: 2,
        }
        extras = issues[quantizer_issues_count:]
        extras.sort(
            key=lambda i: (
                _severity_rank.get(i.severity, 3),
                i.time_range.start_sec,
            )
        )
        omitted_extras = extras[MAX_EXTRA_ISSUES:]
        issues = issues[: len(issues) - len(extras)] + extras[:MAX_EXTRA_ISSUES]
        # #360: the cap trims what the review UI SURFACES, not what the
        #  result knows — omitted extras ride along so the desktop can
        #  expand the full list on demand (and the project save keeps
        #  them). Detection must never be silently dropped.
        omitted_by_severity: dict[str, int] = {}
        for i in omitted_extras:
            sev = i.severity.value
            omitted_by_severity[sev] = omitted_by_severity.get(sev, 0) + 1
        # #166: chromatic notes whose enharmonic spelling the active key
        # cannot decide — surfaced for review instead of guessed.
        issues.extend(
            _spelling_issues(
                tuple(n for p in built.payload.parts for n in p.notes),
                payload.key_signature.fifths,
                payload.key_changes,
                built.note_onset_sec,
                score_revision,
                chord_map,
                prefer_flats,
            )
        )
        # #423: audio-evidence boundary re-scoring - a missed
        # re-articulation (split), a phantom edge (merge), or an
        # unprovable one (uncertain) surfaces as a one-click score
        # fix instead of a silent quantizer artifact.
        issues.extend(
            _boundary_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                event_by_id,
                estimate.warp,
                beat_ql,
                score_revision,
                selection_offset_sec,
            )
        )
        # #264: low-octave audit — the same detected-on stem evidence.
        # A tracker that locked onto the 2nd harmonic left the note an
        # octave too high; the spectrum proves it (real fundamental +
        # odd harmonic at -12), but octave doubling is identical so the
        # score keeps the pitch and the flag carries the -12 remedy.
        issues.extend(
            _octave_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                estimate.warp,
                beat_ql,
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                score_revision,
                selection_offset_sec,
                arbiter_events=arbiter_events,
                arbiter_backend=arbiter_backend,
            )
        )
        # #264: isolated semitone dips — a short chromatic note one
        # semitone off a diatonic neighbour, inside a diatonic line,
        # is a tracker bin-snap until proven sung. Same detected-on
        # stem buffer arbitrates when the span allows a reading.
        issues.extend(
            _pitch_dip_issues(
                *(
                    lead_evidence
                    if lead_evidence is not None
                    else (samples, sample_rate)
                ),
                (cleaned, *cleaned_lowers),
                built.payload.parts,
                payload.key_signature.fifths,
                payload.key_changes,
                score_revision,
                selection_offset_sec,
            )
        )
        # #419: chord segments whose chroma the estimator cannot
        # back up - the harmony context rides the issue as evidence
        # (suggested chord + runner-up), there is no auto-fix.
        issues.extend(
            _chord_issues(
                chord_map,
                tuple(n for p in built.payload.parts for n in p.notes),
                estimate.warp,
                beat_ql,
                score_revision,
                prefer_flats,
            )
        )
        if meter_uncertain:
            # Whole-piece issue: auto meter could not justify its pick.
            # `meter_conflict` copy exists in the UI deck.
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.METER_CONFLICT,
                    severity=Severity.CAUTION,
                    evidence={
                        # The rejected guess, not the written 4/4 —
                        # the user needs to see what the estimator
                        # nearly picked to judge the fallback. A
                        # refusal carries None instead: 4/4 is the
                        # written fallback, not a candidate, and the
                        # UI has dedicated 'undecidable' copy for a
                        # missing estimate (#147).
                        "estimatedMeter": meter_est_label,
                        "meterConfidence": round(meter_confidence, 3),
                        # The ambiguity the confidence margin describes —
                        # '4/4 vs 2/4 by a coin flip' is actionable in a
                        # way 'confidence 0' alone is not (#264).
                        "runnerUpMeter": meter_runner_up,
                    },
                )
            )
        # #358: a wrong anacrusis ripples into every barline, rest
        # grouping, tie decomposition and the measure-level tempo/key
        # maps — a heuristic pickup never writes silently when the
        # evidence cannot justify it.
        pickup_uncertain = pickup_uncertainty(estimate)
        if pickup_uncertain is not None:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.PICKUP_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence=pickup_uncertain,
                )
            )
        # #352: a wrong key ripples into the signature, enharmonic
        # spelling and the Horn-in-F transposition — never write a
        # low-confidence or two-candidate estimate silently.
        # #53: a pinned key is user attestation — certainty by
        # definition, so no uncertainty issue can fire.
        key_uncertain = key_uncertainty(key_analysis) if key_analysis is not None else None
        if key_uncertain is not None:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.KEY_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence=key_uncertain,
                )
            )
        if voice_split is not None:
            # #85 voices texture: overlaps were kept as a second part —
            # report what the split saw (second-voice note count + notes
            # beyond two voices that had to be dropped).
            extra_counts = [len(v) for v in voice_split.voices[1:]]
            if any(extra_counts) or voice_split.dropped_beyond_voices:
                issues.append(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(),
                        time_range=analysis_range,
                        reason=ReviewReason.OVERLAPPING_CANDIDATES,
                        severity=Severity.CAUTION,
                        evidence={
                            "secondVoiceNotes": extra_counts[0],
                            "extraVoiceNotes": sum(extra_counts),
                            "voiceCounts": [len(voice_split.voices[0])] + extra_counts,
                            "droppedBeyondVoices": voice_split.dropped_beyond_voices,
                            "note": (
                                "overlapping pitches were kept as extra parts"
                                if params.texture == "voices"
                                else "overlapping pitches were kept as chords/voices in one part"
                            ),
                        },
                    )
                )
        elif cleaned.polyphonic_overlaps:
            # The monophonic contract silently collapsed real overlaps —
            # warn so the user knows a second voice may have been lost.
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.OVERLAPPING_CANDIDATES,
                    severity=Severity.CAUTION,
                    evidence={
                        "polyphonicOverlaps": cleaned.polyphonic_overlaps,
                        "note": "overlapping pitches were merged into a single line",
                        # #148: auto detected a real mix — the voices
                        # texture would keep those lines as separate
                        # parts, so the UI offers a one-click re-run.
                        "suggestVoicesTexture": mix_suggest_voices,
                        # #314: for a lead-vocal mix (the common JPOP
                        # case) the better remedy is isolating the
                        # vocal first — offered alongside voices only
                        # when isolation was not already used.
                        "suggestVocalIsolation": (
                            # #204: an isolation that ran (opt-in or
                            # auto-rescue) already applied the remedy —
                            # and one the user already asked for is
                            # reported by its own issue, so re-suggesting
                            # would be noise either way.
                            mix_suggest_voices and vocal_path is None and not params.vocal_isolation
                        ),
                    },
                )
            )
        # #181: pYIN is a monophonic tracker — under voices/auto the
        # user asked for (or allowed) polyphony, so surface that the
        # result is one line by construction.
        # #316: when vocal isolation fed pYIN a genuinely monophonic
        # vocal the tracker was the *right* engine — the one-line
        # result is intentional, not a collapsed-mix warning — but
        # only for single-line textures; voices/chords still warn.
        if (
            resolved_pyin
            and params.texture in ("voices", "chords", "auto")
            and (vocal_path is None or params.texture in ("voices", "chords"))
        ):
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.MONOPHONIC_BACKEND,
                    severity=(
                        Severity.WARNING
                        if params.texture in ("voices", "chords")
                        else Severity.CAUTION
                    ),
                    evidence={
                        "backend": "pyin",
                        "texture": params.texture,
                        # Offer the one-click remedy: re-run with the
                        # polyphonic-capable default backend.
                        "suggestBasicPitch": True,
                    },
                )
            )
        # #134 swing issue — the estimate was computed above (it also
        # lands on the payload as swing_feel for the notation).
        # #187: vocal-isolation provenance — the option is opt-in, so
        # the result must say whether the backend actually saw the
        # isolated estimate (info) or fell back to the raw mix and why
        # (caution). Never silent either way.
        if vocal_reason == "applied":
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.VOCAL_ISOLATION_APPLIED,
                    severity=Severity.INFO,
                    evidence={"stage": vocal_method or "center_extraction"},
                )
            )
            # #191: buried-lead honesty — a missed note can never be its
            # own review item, so when the isolated estimate carries
            # only a small share of the source's energy we surface the
            # possibility itself. demucs stems carry near-true vocal
            # energy (the -9.5 dB lead of #165 reads ~0.33), while a
            # center extraction attenuates even healthy leads
            # (side-channel loss + soft mask) — separate bars.
            if vocal_path is not None and len(samples):
                estimate_rms = wav_rms(vocal_path)
                source_rms = _samples_rms(samples)
                if estimate_rms is not None and source_rms > 0:
                    ratio = estimate_rms / source_rms
                    threshold = _LOW_LEAD_RMS_RATIO.get(vocal_method, _LOW_LEAD_RMS_RATIO_DEFAULT)
                    if ratio < threshold:
                        issues.append(
                            ReviewIssue(
                                id="",
                                score_revision=score_revision,
                                canonical_note_ids=(),
                                time_range=analysis_range,
                                reason=ReviewReason.LOW_LEAD_LEVEL,
                                severity=Severity.CAUTION,
                                evidence={
                                    "sourceRms": round(source_rms, 5),
                                    "vocalRms": round(estimate_rms, 5),
                                    "ratioDb": round(20.0 * math.log10(ratio), 1),
                                    "method": vocal_method or "center_extraction",
                                    # #222: the remedy depends on what
                                    # already ran — the requested demucs
                                    # tier + engine-side availability let
                                    # the UI pick between an addon-install
                                    # hint, a precision-tier retry, or a
                                    # plain listen-and-fix message.
                                    "tier": params.vocal_isolation_quality,
                                    "demucsAvailable": demucs_available(),
                                    "suggestPrecisionIsolation": (
                                        vocal_method == "demucs"
                                        and params.vocal_isolation_quality != "precision"
                                    ),
                                },
                            )
                        )
        elif vocal_reason in (
            "mono_source",
            "unavailable",
            # #322: requested but skipped — voices/chords keep the
            # overlapping lines, so isolation would defeat the texture.
            "polyphonic_texture",
        ):
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.VOCAL_ISOLATION_UNAVAILABLE,
                    severity=Severity.CAUTION,
                    evidence={"detail": vocal_reason},
                )
            )
        # #212: the accompaniment staff is separation-derived — the
        # detection there is necessarily rougher than the lead line's,
        # so the whole part gets ONE provenance marker instead of
        # per-note flags (which would double the review list).
        if accomp_alternatives:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.ACCOMPANIMENT_PART,
                    severity=Severity.INFO,
                    evidence={
                        # Read the emitted names off the document — the
                        # issue's part list can never drift from the
                        # staves the user actually sees.
                        "partNames": [
                            p.name for p in built.payload.parts if not p.transposing
                        ],
                        "method": vocal_method or "none",
                    },
                )
            )
        # #188: the tracked tempo looks like a half/double pick —
        # surface it with the corrected value so the UI can offer a
        # one-click setTempo.
        if tempo_octave is not None and tempo_octave.suggestion:
            suggested = (
                estimate.median_bpm * 2.0
                if tempo_octave.suggestion == "double"
                else estimate.median_bpm / 2.0
            )
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.TEMPO_UNCERTAIN,
                    severity=Severity.CAUTION,
                    evidence={
                        "estimatedBpm": round(estimate.median_bpm, 1),
                        "suggestedBpm": round(suggested, 1),
                        "direction": tempo_octave.suggestion,
                    },
                )
            )
        if swing_est.detected:
            issues.append(
                ReviewIssue(
                    id="",
                    score_revision=score_revision,
                    canonical_note_ids=(),
                    time_range=analysis_range,
                    reason=ReviewReason.SWING_FEEL,
                    severity=Severity.CAUTION,
                    evidence={
                        "offbeatOnsets": swing_est.offbeats,
                        "swingOnsets": swing_est.swing,
                        "tripletOnsets": swing_est.triplet,
                        "straightOnsets": swing_est.straight,
                        "swingRatio": round(swing_est.swing_ratio, 3),
                    },
                )
            )
        # Deterministic renumber across the merged set.
        issues.sort(key=lambda i: (i.time_range.start_sec, i.reason.value))
        allocator = IssueIdAllocator()
        issues = [replace(issue, id=allocator.allocate()) for issue in issues]
        # #360: deferred extras need real ids too — they were sliced
        #  out before the renumber, so continue the same allocator or
        #  the desktop's lazy expansion meets empty/duplicate ids.
        omitted_extras = [replace(issue, id=allocator.allocate()) for issue in omitted_extras]
        if stop(5):
            return

        # ---- rendering -------------------------------------------------
        stage(6)
        musicxml_concert = export_concert_musicxml(document)
        # #385: three exports plus five per-part verification passes -
        # every unit is a real completed check, nothing estimated.
        render_total = 3 + 5 * len(payload.parts)
        render_done = 0
        step(6, 1, render_total)
        musicxml_horn = export_horn_in_f_musicxml(document)
        step(6, 2, render_total)
        # #156: the B-flat view is a third artifact — same canonical
        # document, +M2 projection, -M2 <transpose> declaration.
        musicxml_b_flat = export_b_flat_musicxml(document)
        step(6, 3, render_total)

        # The export path is verified, not trusted: read the emitted
        # MusicXML back and compare committed rhythm per part (multi-
        # voice scores verify every part, not just the first).
        from hornscribe.export.musicxml import (  # noqa: PLC0415
            verify_rhythm_roundtrip,
            verify_written_projection,
        )

        rhythm_problems: list[str] = []
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_concert, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        # #370: the Horn in F file is the product's main artifact — it
        # gets the same structural round-trip plus the written->sounding
        # projection invariant (transpose block, per-note pitch
        # recovery, written key = canonical key +1 fifth). Corruption
        # that parses but transposes wrong used to ship silently.
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"hornF part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_horn, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"hornF part {pi}: {p}"
                for p in verify_written_projection(
                    document,
                    musicxml_horn,
                    PitchSpace.WRITTEN_HORN_F,
                    part_index=pi,
                )
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        # #156: the B-flat view gets the identical structural +
        # projection verification - a third artifact is only useful
        # when it is held to the same contract as the F-horn file.
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"bFlat part {pi}: {p}"
                for p in verify_rhythm_roundtrip(document, musicxml_b_flat, part_index=pi)
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        for pi in range(len(payload.parts)):
            rhythm_problems += [
                f"bFlat part {pi}: {p}"
                for p in verify_written_projection(
                    document,
                    musicxml_b_flat,
                    PitchSpace.WRITTEN_B_FLAT,
                    part_index=pi,
                )
            ]
            render_done += 1
            step(6, 3 + render_done, render_total)
        if rhythm_problems:
            # Late verification issue: allocate an id like the others
            # (issue ids were already renumbered above — keep them
            # unique by continuing the same allocator).
            issues.append(
                replace(
                    ReviewIssue(
                        id="",
                        score_revision=score_revision,
                        canonical_note_ids=(),
                        time_range=analysis_range,
                        reason=ReviewReason.STRUCTURAL_MEASURE_CONFLICT,
                        severity=Severity.WARNING,
                        evidence={
                            "rhythmRoundtripProblems": rhythm_problems[:10],
                        },
                    ),
                    id=allocator.allocate(),
                ),
            )

        emit(
            "completed",
            stage=STAGES[6],
            progress=1.0,
            result={
                "scoreRevision": str(score_revision),
                "scoreDocument": document.to_dict(),
                "reviewIssues": [i.to_dict() for i in issues],
                # #360: cap-omitted detections stay in the result — the
                #  desktop lazily expands them into the review list
                #  (ids were allocated at detection, so they are stable).
                "omittedReviewIssues": [i.to_dict() for i in omitted_extras],
                "musicXmlConcert": musicxml_concert,
                "musicXmlHornF": musicxml_horn,
                "musicXmlBFlat": musicxml_b_flat,
                "meta": {
                    "backend": backend_id,
                    "backendVersion": backend_version,
                    # #100: project.save needs the tr-* id for the
                    # TranscriptionRecord in .hornscribe.json.
                    "transcriptionRevision": str(revision),
                    "audioPath": params.audio_path,
                    "durationSec": round(duration_sec, 3),
                    # #319: the effective pre-backend chain — which
                    # isolation method+version (or why it did not run)
                    # produced the audio the backend saw. Absent when
                    # no preprocessing was requested.
                    **({"preprocess": preprocess} if preprocess is not None else {}),
                    "tempoBpm": round(estimate.median_bpm, 2),
                    "tempoAuto": estimate.auto,
                    "meter": f"{meter.numerator}/{meter.denominator}",
                    "meterEstimated": meter_estimated,
                    "meterConfidence": round(meter_confidence, 3),
                    "keyFifths": key.fifths,
                    "keyMode": key.mode,
                    "keyConfidence": round(key_confidence, 3),
                    # #53: True when the user pinned the key — an
                    # estimate and an attestation must not read alike.
                    "keyHinted": key_hint_sig is not None,
                    # #419: measure-segmented chord map - consecutive
                    # same-chord spans merged for readability.
                    "chordProgression": _merged_chord_dicts(chord_map, prefer_flats),
                    "noteCount": sum(len(p.notes) for p in payload.parts),
                    "partCount": len(payload.parts),
                    "pickupBeats": str(payload.pickup_beats),
                    "alignmentShiftSec": round(shift, 4),
                    "alignmentMeterResolved": bool(best.diagnostics.alignment_meter_resolved),
                    "reviewReasons": list(best.diagnostics.review_reasons),
                    # #272: the surfacing cap is never silent — how
                    # many detected issues were left out, by severity.
                    "reviewSummary": {
                        "surfaced": len(issues),
                        "omitted": len(omitted_extras),
                        "omittedBySeverity": omitted_by_severity,
                    },
                    "cleaning": (
                        voice_split.stats() if voice_split is not None else cleaned.stats()
                    ),
                    # #244: accompaniment-side filtering is separate
                    # from the lead-cleaning counters above -- the
                    # drop count tells reviewers how much flicker the
                    # confidence floor removed.
                    "accompanimentCleaning": {
                        "confidenceDropped": accomp_conf_dropped,
                        "unisonDropped": accomp_unison_dropped,
                        "seamMerged": accomp_seam_merged,
                        "sliverFolded": accomp_sliver_folded,
                        "onsetBackdated": accomp_onsets_backdated,
                        "continuityMerged": accomp_continuity_merged,
                        "voiceCount": len(accomp_cleaned),
                        "eventCount": sum(
                            len(c.events) for c in accomp_cleaned
                        ),
                    },
                    "settings": params.settings_dict(),
                },
            },
        )
    except EngineDependencyError as exc:
        emit(
            "failed",
            error={
                "code": ERR_ENGINE_DEPENDENCY_MISSING,
                "message": str(exc),
                "details": {"package": exc.package},
            },
        )
    except UnsupportedMeterError as exc:
        emit(
            "failed",
            error={"code": ERR_JOB_FAILED, "message": str(exc)},
        )
    except ValueError as exc:
        emit(
            "failed",
            error={"code": ERR_JOB_FAILED, "message": str(exc)},
        )
