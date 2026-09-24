"""Beat tracking -> TimeWarp and tempo map (ENG-002, design sections 6/29).

Two paths:

* ``tempo_bpm`` pinned (manual): ``TimeWarp.fixed_bpm`` — the beat grid
  is a straight line; ``zero_sec`` is set to the first detected onset so
  score position 0 lands on the first note, not on the file's t=0
  (otherwise a leading silence becomes leading rests).
* automatic: ``librosa.beat.beat_track`` anchors ->
  ``TimeWarp.from_beat_map`` — piecewise-linear warp that follows tempo
  drift (rit./accel.), which is exactly what a fixed grid cannot.

Beat anchors are mapped ``beat_i -> i * beat_unit_ql + shift`` where
``shift`` lifts the whole anchor row by whole beat units when the first
detected onset would otherwise land before score position 0 — the
common pickup/anacrusis case. The shift amount becomes the pickup
length (``measure_phase_ql`` on the meter segment, see scorebuild), so
the first tracked beat stays the first downbeat.

The tempo map for the exported score is derived from adjacent-anchor
instantaneous tempo, one :class:`TempoSegment` per measure boundary,
with sub-2 % jitter merged so the printed score gets a clean tempo map
instead of per-beat noise.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from hornscribe.domain.score import TempoSegment
from hornscribe.rhythm.beatmap import BeatAnchor, BeatMap, BeatSource
from hornscribe.rhythm.meter import MeterSegment
from hornscribe.rhythm.timewarp import TimeWarp

from .backend import require_module

# Merge adjacent tempo estimates differing by less than this ratio —
# beat-tracker jitter under ~2 % is not a real tempo change.
_TEMPO_MERGE_RATIO = 0.02


@dataclass(frozen=True)
class TempoEstimate:
    """Warp + estimated tempo facts for one transcription run."""

    warp: TimeWarp
    beat_times_sec: tuple[float, ...]
    """Detected beat anchor times (empty for the fixed-BPM path)."""
    median_bpm: float
    """Primary-beat BPM (median inter-beat interval, or the manual value)."""
    auto: bool
    """True when the tempo came from tracking, False when user-pinned."""
    pickup_len_ql: Fraction = Fraction(0)
    """Anacrusis span before the first downbeat (0 = no pickup)."""


def estimate_tempo(
    samples: Any,
    sample_rate: int,
    meter: MeterSegment,
    *,
    tempo_bpm: float | None,
    first_onset_sec: float | None,
) -> TempoEstimate:
    """Build the seconds->ql warp for this run.

    ``first_onset_sec`` anchors the fixed-BPM path and the beat-map
    alignment shift; pass ``None`` for an empty event list (the warp is
    then anchored at t=0 and the score will be empty anyway).
    """
    beat_unit_ql = meter.beat_unit_ql
    if tempo_bpm is not None:
        # Manual tempo: bpm counts *primary beats* per minute, so the
        # quarterLength rate is bpm * beat_unit_ql / 60.
        quarter_bpm = tempo_bpm * float(beat_unit_ql)
        warp = TimeWarp.fixed_bpm(
            bpm=quarter_bpm, zero_sec=first_onset_sec or 0.0
        )
        return TempoEstimate(
            warp=warp,
            beat_times_sec=(),
            median_bpm=float(tempo_bpm),
            auto=False,
        )

    require_module("librosa")
    import librosa  # noqa: PLC0415 - lazy optional dependency

    _tempo, beat_frames = librosa.beat.beat_track(
        y=samples, sr=sample_rate, units="frames"
    )
    # BeatMap requires strictly increasing times; drop duplicates/zeros.
    beat_times_list: list[float] = []
    for t in librosa.frames_to_time(beat_frames, sr=sample_rate):
        ft = float(t)
        if not beat_times_list or ft > beat_times_list[-1]:
            beat_times_list.append(ft)
    beat_times = tuple(beat_times_list)
    if len(beat_times) < 2:
        # Tracking found no usable pulse — fall back to a conservative
        # fixed grid anchored on the first onset rather than failing.
        warp = TimeWarp.fixed_bpm(bpm=120.0, zero_sec=first_onset_sec or 0.0)
        return TempoEstimate(
            warp=warp, beat_times_sec=(), median_bpm=120.0, auto=True
        )

    # Anchor beat i to score position i * beat_unit_ql, then lift the
    # whole row by whole beats when the first onset precedes beat 0 —
    # the lift is the pickup length (the first tracked beat stays the
    # first downbeat).
    shift_ql = Fraction(0)
    if first_onset_sec is not None:
        # Provisional warp to measure the pre-beat-0 gap.
        probe = TimeWarp.from_beat_map(
            BeatMap(
                tuple(
                    BeatAnchor(
                        time_sec=t,
                        score_pos_ql=Fraction(i) * beat_unit_ql,
                        source=BeatSource.BEAT_TRACKER,
                    )
                    for i, t in enumerate(beat_times)
                )
            )
        )
        first_ql = probe.seconds_to_ql(first_onset_sec)
        if first_ql < 0:
            shift_ql = (-first_ql // beat_unit_ql + 1) * beat_unit_ql
    anchors = [
        BeatAnchor(
            time_sec=t,
            score_pos_ql=Fraction(i) * beat_unit_ql + shift_ql,
            source=BeatSource.BEAT_TRACKER,
        )
        for i, t in enumerate(beat_times)
    ]
    warp = TimeWarp.from_beat_map(BeatMap(tuple(anchors)))
    # Beat 0 lands at ql=shift_ql; the pickup measure is the last
    # (shift mod measure) beats before it. A whole-measure lift needs
    # no anacrusis (beat 0 is itself a downbeat).
    measure_ql = meter.measure_length_ql
    pickup_len = shift_ql % measure_ql

    intervals = [b - a for a, b in zip(beat_times, beat_times[1:], strict=False)]
    intervals = [d for d in intervals if d > 0]
    median_sec = sorted(intervals)[len(intervals) // 2] if intervals else 0.5
    median_bpm = float(beat_unit_ql) * 60.0 / median_sec
    return TempoEstimate(
        warp=warp,
        beat_times_sec=beat_times,
        median_bpm=median_bpm,
        auto=True,
        pickup_len_ql=pickup_len,
    )


def tempo_map_from_estimate(
    estimate: TempoEstimate,
    meter: MeterSegment,
) -> tuple[TempoSegment, ...]:
    """Derive the score's tempo map (primary-beat BPM per measure).

    Fixed/manual runs get a single segment at beat 0. Tracked runs emit
    one segment per measure boundary whose instantaneous tempo differs
    from the running value by more than ~2 %, so rit./accel. survive
    without one tempo mark per beat.
    """
    if not estimate.auto or len(estimate.beat_times_sec) < 2:
        return (TempoSegment(start_beat=Fraction(0), bpm=round(estimate.median_bpm, 2)),)

    beat_unit = meter.beat_unit_ql
    times = estimate.beat_times_sec
    # Instantaneous tempo between consecutive anchors, keyed to the
    # *segment start's* ql position (anchor i -> i*beat_unit after the
    # alignment shift, recovered through the warp's beat map).
    segments: list[TempoSegment] = []
    beat_ql = Fraction(4, meter.denominator)
    last_bpm: float | None = None
    for i in range(len(times) - 1):
        dt = times[i + 1] - times[i]
        if dt <= 0:
            continue
        bpm = float(beat_unit) * 60.0 / dt
        pos_ql = estimate.warp.seconds_to_ql(times[i])
        pos_beats = pos_ql / beat_ql
        if last_bpm is None or abs(bpm - last_bpm) / last_bpm > _TEMPO_MERGE_RATIO:
            segments.append(
                TempoSegment(start_beat=pos_beats, bpm=round(bpm, 2))
            )
            last_bpm = bpm
    if not segments or segments[0].start_beat != 0:
        segments.insert(
            0, TempoSegment(start_beat=Fraction(0), bpm=round(estimate.median_bpm, 2))
        )
    return tuple(segments)
