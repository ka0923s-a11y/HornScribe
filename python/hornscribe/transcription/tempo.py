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
    pulse_unit_ql: Fraction | None = None
    """Grid unit each tracked beat anchors (None = meter.beat_unit_ql)."""


def estimate_tempo(
    samples: Any,
    sample_rate: int,
    meter: MeterSegment,
    *,
    tempo_bpm: float | None,
    first_onset_sec: float | None,
    beat_times: tuple[float, ...] | None = None,
    pulse_unit_ql: Fraction | None = None,
) -> TempoEstimate:
    """Build the seconds->ql warp for this run.

    ``first_onset_sec`` anchors the fixed-BPM path and the beat-map
    alignment shift; pass ``None`` for an empty event list (the warp is
    then anchored at t=0 and the score will be empty anyway).

    ``beat_times`` reuses an already-computed beat track (the pipeline
    needs it for meter estimation first); ``pulse_unit_ql`` overrides
    ``meter.beat_unit_ql`` as the grid unit each tracked beat anchors —
    auto-detected 6/8 tracks eighths, not dotted quarters.
    """
    beat_unit_ql = pulse_unit_ql if pulse_unit_ql is not None else meter.beat_unit_ql
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

    if beat_times is None:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency

        _tempo, beat_frames = librosa.beat.beat_track(
            y=samples, sr=sample_rate, units="frames"
        )
        # BeatMap requires strictly increasing times; drop dupes/zeros.
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

    intervals = [b - a for a, b in zip(beat_times, beat_times[1:], strict=False)]
    intervals = [d for d in intervals if d > 0]
    median_sec = sorted(intervals)[len(intervals) // 2] if intervals else 0.5

    # The tracker often drops the very first beat (it prefers a settled
    # pulse over the attack at t=0). When the first onset sits roughly
    # one interval before beat 0, prepend a synthesized beat at the
    # onset — otherwise the real downbeat gets misread as a pickup.
    leading_beats: list[float] = []
    if first_onset_sec is not None:
        gap = beat_times[0] - first_onset_sec
        if 0.55 * median_sec <= gap < 1.5 * median_sec:
            leading_beats.append(float(first_onset_sec))
        elif 0.02 < gap < 0.55 * median_sec:
            # Beat 0 sits a fraction of a pulse after the first onset:
            # the tracker landed late on the same downbeat — snap the
            # anchor to the onset so the first note is not a phantom
            # pickup.
            leading_beats.append(float(first_onset_sec))
            beat_times = beat_times[1:]
        elif gap >= 1.5 * median_sec:
            # Multiple missing beats: walk back on the median grid and
            # land the earliest grid point on the onset itself.
            n_missing = int(gap / median_sec + 0.5)
            for k in range(n_missing, 0, -1):
                if k == n_missing:
                    leading_beats.append(float(first_onset_sec))
                else:
                    leading_beats.append(
                        float(first_onset_sec) + (n_missing - k) * median_sec
                    )
    all_beats = tuple(leading_beats) + beat_times

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
                    for i, t in enumerate(all_beats)
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
        for i, t in enumerate(all_beats)
    ]
    warp = TimeWarp.from_beat_map(BeatMap(tuple(anchors)))
    # Beat 0 lands at ql=shift_ql; the pickup measure is the last
    # (shift mod measure) beats before it. A whole-measure lift needs
    # no anacrusis (beat 0 is itself a downbeat).
    measure_ql = meter.measure_length_ql
    pickup_len = shift_ql % measure_ql

    # Report in primary-beat units (musician BPM): the tracked pulse
    # interval maps to one pulse_unit_ql of score time.
    median_bpm = (
        float(beat_unit_ql) * 60.0 / (median_sec * float(meter.beat_unit_ql))
    )
    return TempoEstimate(
        warp=warp,
        beat_times_sec=all_beats,
        median_bpm=median_bpm,
        auto=True,
        pickup_len_ql=pickup_len,
        pulse_unit_ql=pulse_unit_ql,
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

    # Tracked anchors sit on the *pulse* unit (eighths for auto-6/8);
    # the exported BPM must be in primary-beat units (midi.py divides
    # by meter.beat_unit), so convert through the ql ratio.
    pulse_unit = (
        estimate.pulse_unit_ql
        if estimate.pulse_unit_ql is not None
        else meter.beat_unit_ql
    )
    beat_unit = meter.beat_unit_ql
    times = estimate.beat_times_sec
    beat_ql = Fraction(4, meter.denominator)
    # #248: aggregate instantaneous tempo per MEASURE before emitting —
    # beat-tracker jitter inside a measure is not a tempo change. The
    # pickup measure is index 0 (span [0, pickup)); full measures tile
    # from pickup_ql, matching the measure_starts layout in pipeline.py.
    measure_len_ql = meter.measure_length_ql
    # MeterSegment.measure_index already implements the pickup-aware
    # layout (phase -> the short first measure is index 0). When the
    # caller passed a phase-less meter but the estimate carries a
    # pickup, derive the phase from it so bucketing still matches the
    # score's measure grid.
    phase_ql = meter.measure_phase_ql
    if not phase_ql and estimate.pickup_len_ql:
        phase_ql = (measure_len_ql - estimate.pickup_len_ql) % measure_len_ql

    def measure_index(pos_ql: Fraction) -> int:
        return int((pos_ql - meter.start_ql + phase_ql) // measure_len_ql)

    def measure_start_beats(index: int) -> Fraction:
        ql = meter.start_ql + index * measure_len_ql - phase_ql
        return max(Fraction(0), ql) / beat_ql

    # Instantaneous tempo between consecutive anchors, bucketed by the
    # measure containing the interval's start anchor (ql positions come
    # from the warp's beat map, which already carries the pickup shift).
    measure_bpms: dict[int, list[float]] = {}
    for i in range(len(times) - 1):
        dt = times[i + 1] - times[i]
        if dt <= 0:
            continue
        bpm = float(pulse_unit) * 60.0 / (dt * float(beat_unit))
        pos_ql = estimate.warp.seconds_to_ql(times[i])
        measure_bpms.setdefault(measure_index(pos_ql), []).append(bpm)
    # One robust value per measure (median rejects single-beat jitter);
    # a segment is emitted only when the measure's tempo differs from
    # the last EMITTED value by more than the merge ratio — a genuine
    # rit./accel. survives as a stair-step across measure boundaries.
    segments: list[TempoSegment] = []
    last_bpm: float | None = None
    for index in sorted(measure_bpms):
        values = sorted(measure_bpms[index])
        bpm = values[len(values) // 2]
        if last_bpm is None or abs(bpm - last_bpm) / last_bpm > _TEMPO_MERGE_RATIO:
            segments.append(
                TempoSegment(start_beat=measure_start_beats(index), bpm=round(bpm, 2))
            )
            last_bpm = bpm
    if not segments or segments[0].start_beat != 0:
        segments.insert(
            0, TempoSegment(start_beat=Fraction(0), bpm=round(estimate.median_bpm, 2))
        )
    return tuple(segments)
