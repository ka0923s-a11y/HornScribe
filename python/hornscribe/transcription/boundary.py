"""Boundary re-scoring expert (orig #423).

A second opinion on note edges, independent of whichever backend drew
them. Boundaries — not pitch — carry most transcription damage: an
onset the backend missed becomes one long note, a re-articulation it
imagined becomes two. This expert re-checks every cleaned edge against
the audio itself and flags three defect classes:

- ``merge``     — same-pitch contiguous events whose shared edge has
                  no separation evidence: no onset peak, no silence
                  gap, and the recorded f0 contour continues through
                  it. One held note the backend split in two.
- ``split``     — an event containing a strong interior onset its own
                  attack could not explain: a missed re-articulation.
- ``uncertain`` — an edge with no confirming evidence at all. The
                  pipeline keeps it but asks the user.

The envelopes are plain numpy spectral flux + RMS, so the expert runs
in every engine env (librosa is a decode-time dependency, never a
scoring one) — deterministic across versions, which keeps the review
thresholds honest.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any

import numpy as np

from hornscribe.domain.events import RawNoteEvent

# Envelope geometry: a ~93 ms window at 22050 Hz with a ~23 ms hop —
# fine enough to separate a re-articulation from a sustained swell.
_FLUX_WIN = 2048
_FLUX_HOP = 512

# Merge: contiguous same-pitch events whose shared edge shows no
# separation evidence. A gap wider than MERGE_MAX_GAP_SEC is a real
# rest; an onset peak above MERGE_ONSET_MIN is a real attack; an f0
# jump above MERGE_F0_JUMP_MAX means the line moved even though the
# written pitch tied.
MERGE_MAX_GAP_SEC = 0.12
MERGE_ONSET_MIN = 0.30
MERGE_RMS_FLOOR = 0.10
MERGE_F0_JUMP_MAX = 0.75

# Seam attack verification: a flux bump at the seam can be the
# predecessor's RELEASE edge (the backend often splits a note right at
# its decay transient) rather than a real attack. A real re-
# articulation sustains — RMS ~110 ms after the seam still reads near
# the pre-seam level; a release edge has collapsed by then
# (rubato-4-4: 0.05 vs 0.75+ on true attacks).
SEAM_SUSTAIN_SEC = 0.11
SEAM_SUSTAIN_WIN_SEC = 0.05
SEAM_SUSTAIN_RATIO = 0.40

# Split: an interior onset must rival the note own attack AND clear
# an absolute floor — quiet pieces carry small fluxes, so the attack
# ratio keeps the check working where an absolute floor stays blind.
SPLIT_ONSET_MIN = 0.40
SPLIT_ATTACK_RATIO = 0.60
SPLIT_ATTACK_FLOOR = 0.15
SPLIT_MIN_SPAN_SEC = 0.40
# Active vibrato with the candidate at a bend extremum reads as a
# swell accent, not a re-articulation — halve the score rather than
# flag a held note as two.
SPLIT_VIBRATO_BEND_RANGE = 0.30
SPLIT_VIBRATO_EXTREMUM_WINDOW_SEC = 0.12
SPLIT_VIBRATO_DAMP = 0.5

# Uncertain: a pitch-changing edge with essentially no attack and no
# gap — legato is legitimate, but the backend asserted a hard boundary
# it cannot back up.
WEAK_ONSET_MAX = 0.20
WEAK_GAP_MAX_SEC = 0.03

_BOUNDARY_HALF_WINDOW_SEC = 0.045
_ATTACK_HALF_WINDOW_SEC = 0.060
_EDGE_INSET_HEAD = 0.25
_EDGE_INSET_TAIL = 0.20

# Octave arbitration for the cleaner's flicker repair: when the
# class-based trigger proposes snapping a note to a neighbour's
# octave, the note's own spectrum is the evidence — a real octave
# figure carries its own fundamental, a flicker artifact does not
# (octave-leaps-4-4: honest C4->C5->C4 figures were being destroyed
# by the pitch-class rule alone).
# OCTAVE_MIN_SPAN_SEC: below ~120 ms the FFT cannot separate a
# horn-range fundamental from its neighbours — abstain (no snap).
# OCTAVE_BAND_RATIO: +-3% covers a +-50c performance drift around the
# semitone centre while staying clear of the adjacent semitone (+-6%).
# OCTAVE_SNAP_ENERGY_RATIO: a true lower note's 2nd harmonic lands ON
# the higher octave's band, so the higher band is never silent on a
# real low note — demanding target > detected * 2.5 keeps the verdict
# one-way (evidence must clearly favour the snap).
OCTAVE_MIN_SPAN_SEC = 0.12
OCTAVE_BAND_RATIO = 0.03
OCTAVE_SNAP_ENERGY_RATIO = 2.5


@dataclass(frozen=True)
class BoundaryFlag:
    """One suspicious edge detected against the audio.

    ``boundary_sec`` is on the caller timeline (event time, absolute
    source seconds); the audio-internal offset is already resolved.
    """

    kind: str  # "merge" | "split" | "uncertain"
    event_ids: tuple[str, ...]
    boundary_sec: float
    score: float
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EdgeEnvelopes:
    """Precomputed spectral envelopes shared by edge re-scoring.

    ``offset`` maps event (absolute-source) seconds into the samples
    clock, exactly like ``boundary_flags``' ``time_offset_sec``.
    """

    times: Any
    flux: Any
    rms: Any
    spf: float
    offset: float = 0.0


def compute_envelopes(
    samples: Any, sample_rate: int, *, time_offset_sec: float = 0.0
) -> EdgeEnvelopes:
    """Build the flux/RMS envelopes once so several consumers (merge
    arbitration, flag re-scoring) share one FFT pass."""
    times, flux, rms, spf = _envelopes(samples, sample_rate)
    return EdgeEnvelopes(
        times=times, flux=flux, rms=rms, spf=spf, offset=time_offset_sec
    )


@dataclass(frozen=True)
class SeamEvidence:
    """Audio evidence on the seam between two same-pitch events.

    ``separated`` is True when the seam carries a real articulation —
    an onset attack, an audible silence trough, or an f0 move — so a
    merge across it would hide a re-articulated note. False means the
    seam has no acoustic backing: one held note the backend split.
    """

    separated: bool
    gap_sec: float
    onset_peak: float
    f0_jump: float


def seam_evidence(
    a: RawNoteEvent, b: RawNoteEvent, env: EdgeEnvelopes
) -> SeamEvidence:
    """Classify the seam between same-pitch neighbours *a* -> *b*.

    Same rule table the ``merge`` flag uses, exported so the cleaner
    can ask the same question *before* stitching events the boundary
    expert would never get to see (a merged seam disappears).
    """
    gap = b.onset_sec - a.offset_sec
    boundary = 0.5 * (a.offset_sec + b.onset_sec)
    onset_pk = _peak(
        env.flux, env.spf, boundary - env.offset, _BOUNDARY_HALF_WINDOW_SEC
    )
    jump = _f0_jump(a, b)
    separated = gap > MERGE_MAX_GAP_SEC
    if not separated and onset_pk >= MERGE_ONSET_MIN:
        # Confirm the bump is an attack, not the predecessor's release
        # edge: a real articulation still sounds SEAM_SUSTAIN_SEC later,
        # a decay transient has collapsed. When the pre-seam level is
        # already ~0 the seam sits inside a rest — the attack is real.
        pre = _peak(
            env.rms,
            env.spf,
            boundary - env.offset - 0.07,
            0.035,
        )
        post = _peak(
            env.rms,
            env.spf,
            b.onset_sec - env.offset + SEAM_SUSTAIN_SEC,
            SEAM_SUSTAIN_WIN_SEC,
        )
        separated = pre <= 0.0 or post >= SEAM_SUSTAIN_RATIO * pre
    if not separated and gap > 0.02:
        trough = _trough(
            env.rms,
            env.spf,
            a.offset_sec - env.offset,
            b.onset_sec - env.offset,
        )
        if trough is not None and trough <= MERGE_RMS_FLOOR:
            separated = True  # audible silence — a real separation
    if not separated and jump > MERGE_F0_JUMP_MAX:
        separated = True  # the line actually moved
    return SeamEvidence(
        separated=separated,
        gap_sec=gap,
        onset_peak=onset_pk,
        f0_jump=jump,
    )


def _envelopes(
    samples: Any, sample_rate: int
) -> tuple[Any, Any, Any, float]:
    """(times, flux, rms, sec-per-frame) numpy envelopes.

    Spectral flux on Hann-windowed rfft frames — positive log-magnitude
    change summed per frame, the classic onset-function shape — plus a
    same-geometry RMS envelope for silence-gap checks. Both normalize
    to their own peak so thresholds are relative to the piece.
    """
    sig = np.asarray(samples, dtype=np.float64)
    n = int(sig.shape[0])
    spf = _FLUX_HOP / float(sample_rate)
    if n <= _FLUX_HOP:
        return np.zeros(1), np.zeros(1), np.zeros(1), spf
    win = min(_FLUX_WIN, n)
    padded = np.pad(sig, win // 2)
    count = 1 + (padded.shape[0] - win) // _FLUX_HOP
    idx = np.arange(win)[None, :] + np.arange(count)[:, None] * _FLUX_HOP
    frames = padded[idx] * np.hanning(win)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    logmag = np.log1p(100.0 * mag)
    flux = np.zeros(count)
    flux[1:] = np.maximum(0.0, np.diff(logmag, axis=0)).sum(axis=1)
    peak = float(flux.max())
    if peak > 0.0:
        flux /= peak
    rms = np.sqrt((frames * frames).mean(axis=1))
    rpeak = float(rms.max())
    if rpeak > 0.0:
        rms /= rpeak
    times = np.arange(count) * spf
    return times, flux, rms, spf


def _peak(env: Any, spf: float, t: float, half_window: float) -> float:
    """Max env within +/- half_window seconds of t (0 when empty)."""
    i0 = max(0, int((t - half_window) / spf))
    i1 = min(len(env), int((t + half_window) / spf) + 1)
    if i1 <= i0:
        return 0.0
    return float(env[i0:i1].max())


def _trough(env: Any, spf: float, lo: float, hi: float) -> float | None:
    """Min env inside [lo, hi] — None when the window has no frames."""
    i0 = max(0, int(lo / spf))
    i1 = min(len(env), int(hi / spf) + 1)
    if i1 <= i0:
        return None
    return float(env[i0:i1].min())


def _f0_jump(a: RawNoteEvent, b: RawNoteEvent) -> float:
    """Absolute-midi pitch step across the shared edge.

    Uses the last/first bend point when the tracker recorded a contour,
    so a legato slide ending near the next pitch reads as continuous.
    """
    a_tail = a.pitch_bends[-1].bend_semitones if a.pitch_bends else 0.0
    b_head = b.pitch_bends[0].bend_semitones if b.pitch_bends else 0.0
    return abs((a.pitch_midi + a_tail) - (b.pitch_midi + b_head))


def _at_bend_extremum(e: RawNoteEvent, t: float) -> bool:
    """True when the bend nearest t is a local vibrato extremum.

    A re-articulation mid-note usually keeps the contour level through
    the attack; a peak/trough AT the candidate time is the vibrato own
    accent swelling, so the split score gets damped.
    """
    pts = e.pitch_bends
    if len(pts) < 4:
        return False
    rng = max(b.bend_semitones for b in pts) - min(
        b.bend_semitones for b in pts
    )
    if rng < SPLIT_VIBRATO_BEND_RANGE:
        return False
    i = min(
        range(1, len(pts) - 1),
        key=lambda j: abs(pts[j].time_sec - t),
    )
    if abs(pts[i].time_sec - t) > SPLIT_VIBRATO_EXTREMUM_WINDOW_SEC:
        return False
    s = pts[i].bend_semitones
    return (s >= pts[i - 1].bend_semitones and s >= pts[i + 1].bend_semitones) or (
        s <= pts[i - 1].bend_semitones and s <= pts[i + 1].bend_semitones
    )


def _split_flag(
    e: RawNoteEvent,
    env: EdgeEnvelopes,
) -> BoundaryFlag | None:
    """One interior onset worth flagging inside a long event."""
    span = e.offset_sec - e.onset_sec
    if span < SPLIT_MIN_SPAN_SEC:
        return None
    lo = e.onset_sec - env.offset + _EDGE_INSET_HEAD * span
    hi = e.offset_sec - env.offset - _EDGE_INSET_TAIL * span
    spf = env.spf
    i0 = max(0, int(lo / spf))
    i1 = min(len(env.flux), int(hi / spf) + 1)
    if i1 <= i0:
        return None
    window = env.flux[i0:i1]
    ci = i0 + int(np.argmax(window))
    peak = float(env.flux[ci])
    if peak < SPLIT_ONSET_MIN:
        return None
    attack = _peak(
        env.flux, spf, e.onset_sec - env.offset, _ATTACK_HALF_WINDOW_SEC
    )
    if peak < SPLIT_ATTACK_RATIO * max(attack, SPLIT_ATTACK_FLOOR):
        return None
    score = min(1.0, peak / max(attack, SPLIT_ATTACK_FLOOR))
    boundary = float(env.times[ci]) + env.offset
    damped = _at_bend_extremum(e, boundary)
    if damped:
        score *= SPLIT_VIBRATO_DAMP
    return BoundaryFlag(
        kind="split",
        event_ids=(str(e.id),),
        boundary_sec=boundary,
        score=round(score, 3),
        detail={
            "interiorPeak": round(peak, 3),
            "attackPeak": round(attack, 3),
            "vibratoDamped": damped,
        },
    )


def _edge_flag(
    a: RawNoteEvent,
    b: RawNoteEvent,
    env: EdgeEnvelopes,
) -> BoundaryFlag | None:
    """Shared-edge re-scoring — merge candidates and weak boundaries."""
    gap = b.onset_sec - a.offset_sec
    boundary = 0.5 * (a.offset_sec + b.onset_sec)
    onset_pk = _peak(
        env.flux, env.spf, boundary - env.offset, _BOUNDARY_HALF_WINDOW_SEC
    )
    if int(round(a.pitch_midi)) == int(round(b.pitch_midi)):
        seam = seam_evidence(a, b, env)
        if seam.separated:
            return None
        return BoundaryFlag(
            kind="merge",
            event_ids=(str(a.id), str(b.id)),
            boundary_sec=boundary,
            score=round(1.0 - seam.onset_peak, 3),
            detail={
                "gapSec": round(seam.gap_sec, 4),
                "onsetPeak": round(seam.onset_peak, 3),
                "f0Jump": round(seam.f0_jump, 3),
           },
       )
    if gap <= WEAK_GAP_MAX_SEC and onset_pk < WEAK_ONSET_MAX:
        return BoundaryFlag(
            kind="uncertain",
            event_ids=(str(a.id), str(b.id)),
            boundary_sec=boundary,
            score=round(1.0 - onset_pk, 3),
            detail={
                "gapSec": round(gap, 4),
                "onsetPeak": round(onset_pk, 3),
            },
        )
    return None


def boundary_flags(
    samples: Any,
    sample_rate: int,
    events: tuple[RawNoteEvent, ...],
    *,
    time_offset_sec: float = 0.0,
) -> tuple[BoundaryFlag, ...]:
    """Re-score every edge in one voice cleaned-events list.

    ``time_offset_sec`` maps event (absolute-source) times into the
    samples clock — a selection job analyses a slice whose event times
    stay absolute. Flags always carry absolute seconds back.
    """
    ordered = sorted(events, key=lambda e: (e.onset_sec, e.offset_sec))
    if not ordered:
        return ()
    env = compute_envelopes(
        samples, sample_rate, time_offset_sec=time_offset_sec
    )
    flags: list[BoundaryFlag] = []
    for e in ordered:
        flag = _split_flag(e, env)
        if flag is not None:
            flags.append(flag)
    for a, b in pairwise(ordered):
        flag = _edge_flag(a, b, env)
        if flag is not None:
            flags.append(flag)
    flags.sort(key=lambda f: f.boundary_sec)
    return tuple(flags)


def octave_prefers(
    samples: Any,
    sample_rate: int,
    onset_sec: float,
    offset_sec: float,
    detected_midi: float,
    target_midi: float,
    *,
    time_offset_sec: float = 0.0,
) -> bool:
    """True when the note's own spectrum favours *target_midi* over
    *detected_midi* at the fundamental level.

    Evidence basis: a true lower note's 2nd harmonic lands on the
    higher octave's band, so E(hi) is never zero on a real low note —
    but on a real HIGH note the low band carries only noise.  The
    snap therefore fires only when the target band clearly dominates
    (x2.5); ambiguous evidence keeps the detected pitch, which makes
    the verdict safe under bleed where the backing may add energy to
    the low band.

    The middle 60% of the span is measured so attack and release
    edges do not leak the neighbours' spectra into the comparison.
    """
    i0 = int((onset_sec - time_offset_sec) * sample_rate)
    i1 = int((offset_sec - time_offset_sec) * sample_rate)
    seg = np.asarray(samples[max(0, i0) : max(0, i1)], dtype=np.float64)
    n = int(seg.shape[0])
    if n < int(OCTAVE_MIN_SPAN_SEC * sample_rate):
        return False
    inset = int(n * 0.2)
    seg = seg[inset : n - inset]
    win = seg * np.hanning(seg.shape[0])
    mag = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(seg.shape[0], 1.0 / sample_rate)

    def _band_peak(midi: float) -> float:
        f = 440.0 * 2.0 ** ((int(round(midi)) - 69) / 12.0)
        mask = (freqs >= f * (1.0 - OCTAVE_BAND_RATIO)) & (
            freqs <= f * (1.0 + OCTAVE_BAND_RATIO)
        )
        return float(mag[mask].max()) if mask.any() else 0.0

    e_det = _band_peak(detected_midi)
    e_tgt = _band_peak(target_midi)
    return e_tgt > e_det * OCTAVE_SNAP_ENERGY_RATIO
