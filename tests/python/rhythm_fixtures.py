"""Deterministic QNT-002 test fixtures (QUANTIZER_DESIGN.md section 38).

Every fixture returns ``(events, warp, expected_onsets_ql, meter_map)`` where
``expected_onsets_ql`` are the exact grid positions the quantizer should
recover. Jitter uses ``random.Random`` with fixed seeds — deterministic
across runs and platforms. No fixture touches audio, the filesystem, or
wall-clock time.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.rhythm import (
    BeatAnchor,
    BeatMap,
    BeatSource,
    MeterMap,
    MeterSegment,
    TimeWarp,
)

TEST_REVISION = TranscriptionRevisionId("tr-" + "f" * 16)
"""Shared fake transcription revision for fixture events."""


@dataclass(frozen=True)
class RhythmFixture:
    """One deterministic quantization fixture.

    ``expected_*`` fields are the ground-truth intent the benchmark scores
    against (QNT-007): onsets are required, while durations, rest spans and
    triplet-group counts are optional — ``None`` means "not scored on this
    fixture". ``layer`` groups the fixture into the issue's test matrix
    (``straight``/``jitter``/``latency``/``rests``/``meter``/``triplet``/
    ``boundary``/``horn``) for the benchmark report.
    """

    name: str
    events: tuple[RawNoteEvent, ...]
    warp: TimeWarp
    expected_onsets_ql: tuple[Fraction, ...]
    meter_map: MeterMap | None = None
    bpm: float | None = None
    """Configured tempo for fixed-BPM fixtures (documentation/metrics)."""
    expected_durations_ql: tuple[Fraction, ...] | None = None
    """Intended notated durations, index-aligned with ``expected_onsets_ql``."""
    expected_rest_spans_ql: tuple[tuple[Fraction, Fraction], ...] | None = None
    """Intended written rests as ``(onset_ql, duration_ql)`` spans."""
    expected_tuplet_groups: int | None = None
    """Intended visual triplet-group count (triplet classification)."""
    layer: str = "straight"
    """Issue test-matrix layer name, for benchmark report grouping."""


def make_events(
    onsets_sec: Sequence[float],
    *,
    duration_sec: float = 0.2,
    durations_sec: Sequence[float] | None = None,
    pitch_midi: float = 60.0,
    confidence: float | None = 0.95,
) -> tuple[RawNoteEvent, ...]:
    """Build raw events with deterministic ``rne-*`` ids in input order.

    ``durations_sec`` gives per-note performed durations (articulation,
    breath-gap and overlap fixtures need non-uniform values);
    ``duration_sec`` is the scalar fallback.
    """
    durations = (
        tuple(durations_sec)
        if durations_sec is not None
        else tuple(duration_sec for _ in onsets_sec)
    )
    return tuple(
        RawNoteEvent(
            id=RawNoteEventId(f"rne-{i + 1:06d}"),
            transcription_revision=TEST_REVISION,
            pitch_midi=pitch_midi,
            onset_sec=t,
            offset_sec=t + d,
            confidence=confidence,
        )
        for i, (t, d) in enumerate(zip(onsets_sec, durations, strict=True))
    )


def _meter_44() -> MeterMap:
    return MeterMap((MeterSegment(Fraction(0), 4, 4),))


def straight_fixture(
    name: str,
    onsets_ql: Sequence[int | Fraction],
    *,
    bpm: float = 120.0,
    jitter_ms: Sequence[float] | None = None,
    latency_sec: float = 0.0,
    seed: int | None = None,
    jitter_range_ms: float = 0.0,
    expected_ql: Sequence[int | Fraction] | None = None,
    meter_map: MeterMap | None = None,
    duration_ql: Fraction | None = None,
    durations_ql: Sequence[Fraction] | None = None,
    expected_durations_ql: Sequence[Fraction] | None = None,
    expected_rest_spans_ql: Sequence[tuple[Fraction, Fraction]] | None = None,
    expected_tuplet_groups: int | None = None,
    layer: str = "straight",
) -> RhythmFixture:
    """Fixed-BPM fixture: notes at ``onsets_ql`` (+ optional jitter/latency).

    ``onsets_ql`` are the *performed* positions; ``expected_ql`` overrides
    the expected quantized grid (defaults to ``onsets_ql`` — use it when the
    performance sits off-grid on purpose, e.g. the IOI pair fixture).
    ``jitter_ms`` is a per-note millisecond offset list; ``seed`` +
    ``jitter_range_ms`` instead draw symmetric uniform jitter from a fixed
    RNG seed. Both are deterministic.

    ``meter_map`` overrides the default 4/4 map (QNT-004 meter fixtures);
    ``duration_ql`` overrides the default 0.9-beat raw duration — sub-beat
    fixtures pass a shorter value so consecutive notes do not overlap;
    ``durations_ql`` gives per-note performed durations for horn-like
    articulation/breath/overlap cases. The ``expected_*`` arguments carry
    the intended notation the QNT-007 benchmark scores (``None`` = not
    scored).
    """
    warp = TimeWarp.fixed_bpm(bpm)
    onsets = [float(q) * 60.0 / bpm + latency_sec for q in onsets_ql]
    if jitter_ms is not None:
        onsets = [t + ms / 1000.0 for t, ms in zip(onsets, jitter_ms, strict=True)]
    elif seed is not None and jitter_range_ms > 0:
        rng = random.Random(seed)
        onsets = [
            t + rng.uniform(-jitter_range_ms, jitter_range_ms) / 1000.0 for t in onsets
        ]
    default_duration = (
        duration_ql if duration_ql is not None else Fraction(9, 10)
    )  # default: sustained but not overlapping at beat spacing
    durations = (
        tuple(durations_ql)
        if durations_ql is not None
        else tuple(default_duration for _ in onsets_ql)
    )
    durations_sec = [float(d) * 60.0 / bpm for d in durations]
    return RhythmFixture(
        name=name,
        events=make_events(onsets, durations_sec=durations_sec),
        warp=warp,
        expected_onsets_ql=tuple(
            Fraction(q) for q in (expected_ql if expected_ql is not None else onsets_ql)
        ),
        meter_map=meter_map if meter_map is not None else _meter_44(),
        bpm=bpm,
        expected_durations_ql=(
            tuple(Fraction(d) for d in expected_durations_ql)
            if expected_durations_ql is not None
            else None
        ),
        expected_rest_spans_ql=(
            tuple((Fraction(o), Fraction(d)) for o, d in expected_rest_spans_ql)
            if expected_rest_spans_ql is not None
            else None
        ),
        expected_tuplet_groups=expected_tuplet_groups,
        layer=layer,
    )


# --- required fixtures (issue #16) ------------------------------------------------


def quarters_exact() -> RhythmFixture:
    """8 quarter notes @120 BPM, exactly on grid."""
    return straight_fixture(
        "quarters_exact",
        [Fraction(i) for i in range(8)],
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
    )


def quarters_jitter20() -> RhythmFixture:
    """Quarter notes @120 BPM with deterministic ±20 ms jitter."""
    return straight_fixture(
        "quarters_jitter20",
        [Fraction(i) for i in range(8)],
        seed=20260922,
        jitter_range_ms=20.0,
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="jitter",
    )


def quarters_jitter50() -> RhythmFixture:
    """Quarter notes @120 BPM with deterministic ±50 ms jitter."""
    return straight_fixture(
        "quarters_jitter50",
        [Fraction(i) for i in range(8)],
        seed=777,
        jitter_range_ms=50.0,
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="jitter",
    )


def eighths_jitter80() -> RhythmFixture:
    """12 eighth notes @120 BPM with deterministic ±80 ms jitter (QNT-007).

    ±80 ms exceeds half the sixteenth grid period (62.5 ms at 120 BPM), so
    some onsets sit closer to a neighboring grid point — the joint DP
    recovers more of them than independent snapping does.
    """
    return straight_fixture(
        "eighths_jitter80",
        [Fraction(i, 2) for i in range(12)],
        seed=133,
        jitter_range_ms=80.0,
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 11 + [Fraction(1, 2)],
        # The run ends mid-measure (last eighth ends at 6 QL inside a 4/4
        # bar), so the realized score carries the designed trailing rest
        # [6,8) — assemble_path_rests tiles every touched measure.
        expected_rest_spans_ql=[(Fraction(6), Fraction(2))],
        expected_tuplet_groups=0,
        layer="jitter",
    )


def eighths_exact() -> RhythmFixture:
    """16 eighth notes @120 BPM, exactly on grid.

    The run ends on the barline: the last eighth is performed detached
    (``9/20 ql``) so its intended written value is unambiguous — earlier
    notes keep the default legato offsets (clipped overlaps, design 27).
    """
    return straight_fixture(
        "eighths_exact",
        [Fraction(i, 2) for i in range(16)],
        durations_ql=[Fraction(9, 10)] * 15 + [Fraction(9, 20)],
        expected_durations_ql=[Fraction(1, 2)] * 16,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
    )


def sixteenths_exact() -> RhythmFixture:
    """16 sixteenth notes @120 BPM, exactly on grid (detached final 16th)."""
    return straight_fixture(
        "sixteenths_exact",
        [Fraction(i, 4) for i in range(16)],
        durations_ql=[Fraction(9, 10)] * 15 + [Fraction(1, 5)],
        expected_durations_ql=[Fraction(1, 4)] * 16,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
    )


def syncopated_exact() -> RhythmFixture:
    """Offbeat-eighth syncopation @120 BPM (onsets on the 'and' of beats)."""
    return straight_fixture(
        "syncopated_exact",
        [Fraction(1, 2), Fraction(3, 2), Fraction(5, 2), Fraction(3), Fraction(7, 2)],
        expected_durations_ql=[
            Fraction(1),
            Fraction(1),
            Fraction(1, 2),
            Fraction(1, 2),
            Fraction(1),
        ],
        expected_rest_spans_ql=[
            (Fraction(0), Fraction(1, 2)),
            (Fraction(9, 2), Fraction(7, 2)),
        ],
        expected_tuplet_groups=0,
        layer="boundary",
    )


def quarters_latency40() -> RhythmFixture:
    """Quarter notes @120 BPM shifted +40 ms (AMT-style global latency).

    At 120 BPM the 16th grid period is 125 ms, so a +85 ms shift is a
    perfect alias of the true -40 ms compensation — the search reports both
    the deterministic argmin and the ambiguity flag (design 6.3).
    """
    return straight_fixture(
        "quarters_latency40",
        [Fraction(i) for i in range(8)],
        latency_sec=0.040,
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="latency",
    )


def quarters_latency40_slow() -> RhythmFixture:
    """Quarter notes @60 BPM shifted +40 ms.

    At 60 BPM the grid-alias shift (+210 ms) falls outside the ±120 ms
    search band, so -40 ms is the unique minimum and is applied directly.
    """
    return straight_fixture(
        "quarters_latency40_slow",
        [Fraction(i) for i in range(8)],
        bpm=60.0,
        latency_sec=0.040,
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="latency",
    )


def quarters_latency65() -> RhythmFixture:
    """Quarter notes @120 BPM shifted +65 ms with ±8 ms jitter (QNT-007).

    +65 ms exceeds the half-grid distance (62.5 ms at 120 BPM), so
    independent nearest-grid snapping lands on the wrong sixteenth for most
    notes. The meter-aware alignment search (design 6.3 + #78) resolves the
    band-aliased surface: among the competing phases the metrical tie-break
    prefers -65 ms - it lands every onset on beats rather than odd
    sixteenths - so the correct shift applies silently instead of surfacing
    as ``beat_alignment_uncertain``.
    """
    return straight_fixture(
        "quarters_latency65",
        [Fraction(i) for i in range(8)],
        latency_sec=0.065,
        seed=42,
        jitter_range_ms=8.0,
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="latency",
    )


def tempo_change_beatmap() -> RhythmFixture:
    """Explicit BeatMap tempo change: 120 BPM for 2 beats, then 60 BPM.

    Anchors: ``0 s -> 0 ql``, ``1 s -> 2 ql`` (2 ql/s), ``3 s -> 4 ql``
    (1 ql/s). Notes land on score positions ``0..5 ql`` at seconds
    ``0, 0.5, 1, 2, 3, 4`` (the last two extrapolated at the final slope).
    """
    anchors = (
        BeatAnchor(time_sec=0.0, score_pos_ql=Fraction(0), source=BeatSource.MANUAL),
        BeatAnchor(time_sec=1.0, score_pos_ql=Fraction(2), source=BeatSource.MANUAL),
        BeatAnchor(time_sec=3.0, score_pos_ql=Fraction(4), source=BeatSource.MANUAL),
    )
    warp = TimeWarp.from_beat_map(BeatMap(anchors))
    expected = tuple(Fraction(i) for i in range(6))
    onsets_sec = [warp.ql_to_seconds(q) for q in expected]
    return RhythmFixture(
        name="tempo_change_beatmap",
        events=make_events(onsets_sec, duration_sec=0.4),
        warp=warp,
        expected_onsets_ql=expected,
        meter_map=_meter_44(),
        bpm=None,
        # The 60 BPM section's 0.4 s performed notes are detached eighths
        # (0.4 ql) — the honest notation is eighth + eighth rest per beat.
        expected_durations_ql=(
            Fraction(1),
            Fraction(1),
            Fraction(1, 2),
            Fraction(1, 2),
            Fraction(1, 2),
            Fraction(1, 2),
        ),
        expected_rest_spans_ql=(
            (Fraction(5, 2), Fraction(1, 2)),
            (Fraction(7, 2), Fraction(1, 2)),
            (Fraction(9, 2), Fraction(1, 2)),
            (Fraction(11, 2), Fraction(5, 2)),
        ),
        expected_tuplet_groups=0,
        layer="tempo",
    )


def ioi_pair_fixture() -> RhythmFixture:
    """Two onsets at 0.11 / 1.13 ql @120 BPM — the IOI showcase (design 10.2).

    Independent snapping picks ``1.25`` for the second onset (distance
    ``0.12 < 0.13``), but the observed IOI ``1.02 ql`` is a quarter: the DP's
    IOI term pulls the pair back to ``[0, 1]`` where onset *and* interval
    errors stay consistent. Baselines B0/B1 fail; HSQ recovers.
    """
    return straight_fixture(
        "ioi_pair",
        [Fraction(11, 100), Fraction(113, 100)],
        bpm=120.0,
        expected_ql=[Fraction(0), Fraction(1)],
        expected_durations_ql=[Fraction(1), Fraction(1)],
        expected_rest_spans_ql=[(Fraction(2), Fraction(2))],
        expected_tuplet_groups=0,
        layer="timing",
    )


# --- meter fixtures (issue #18 / QNT-004) ----------------------------------------


def meter_34_quarters() -> RhythmFixture:
    """3/4: nine quarter onsets over exactly three bars (measure closure)."""
    return straight_fixture(
        "meter_34_quarters",
        [Fraction(i) for i in range(9)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 3, 4),)),
        expected_durations_ql=[Fraction(1)] * 9,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="meter",
    )


def meter_24_eighths() -> RhythmFixture:
    """2/4: eighth-note stream over exactly two bars."""
    return straight_fixture(
        "meter_24_eighths",
        [Fraction(i, 2) for i in range(8)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 2, 4),)),
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="meter",
    )


def meter_68_eighths() -> RhythmFixture:
    """6/8: native eighth stream over two bars — must not become tuplets."""
    return straight_fixture(
        "meter_68_eighths",
        [Fraction(i, 2) for i in range(12)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 6, 8),)),
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 12,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="meter",
    )


def meter_68_dotted_beats() -> RhythmFixture:
    """6/8: dotted-quarter compound beats — low notation complexity."""
    return straight_fixture(
        "meter_68_dotted_beats",
        [Fraction(0), Fraction(3, 2), Fraction(3), Fraction(9, 2)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 6, 8),)),
        duration_ql=Fraction(3, 2),
        expected_durations_ql=[Fraction(3, 2)] * 4,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="meter",
    )


def pickup_44_quarter() -> RhythmFixture:
    """4/4 with a one-quarter anacrusis (``measure_phase_ql = 3``).

    Onsets 0..5: position 0 sits in the implicit pickup measure (measure 0),
    1..4 fill the first full measure, 5 begins the second.
    """
    return straight_fixture(
        "pickup_44_quarter",
        [Fraction(i) for i in range(6)],
        meter_map=MeterMap(
            (MeterSegment(Fraction(0), 4, 4, measure_phase_ql=Fraction(3)),)
        ),
        expected_durations_ql=[Fraction(1)] * 6,
        expected_rest_spans_ql=[(Fraction(6), Fraction(3))],
        expected_tuplet_groups=0,
        layer="meter",
    )


def meter_change_44_68() -> RhythmFixture:
    """Mid-piece meter change: two 4/4 bars, then 6/8 at ql 8."""
    return straight_fixture(
        "meter_change_44_68",
        [Fraction(i) for i in range(8)]
        + [Fraction(8) + Fraction(i, 2) for i in range(6)],
        meter_map=MeterMap(
            (MeterSegment(Fraction(0), 4, 4), MeterSegment(Fraction(8), 6, 8))
        ),
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 14,
        expected_rest_spans_ql=[
            (Fraction(2 * i + 1, 2), Fraction(1, 2)) for i in range(8)
        ],
        expected_tuplet_groups=0,
        layer="meter",
    )


def barline_tie_44() -> RhythmFixture:
    """A sustained note crossing the barline — committed barline tie.

    Onsets at 0, 3, 6 with 3-beat spans: the middle note covers ``[3, 6)``
    and must be written as tied atoms across the barline at beat 4.
    """
    return straight_fixture(
        "barline_tie_44",
        [Fraction(0), Fraction(3), Fraction(6)],
        duration_ql=Fraction(3),
        expected_durations_ql=[Fraction(3)] * 3,
        expected_rest_spans_ql=[(Fraction(9), Fraction(3))],
        expected_tuplet_groups=0,
        layer="boundary",
    )


def rests_44() -> RhythmFixture:
    """Sparse quarter onsets -> realized rest spans between notes.

    Onsets 0/2/5/8 leave rest gaps ``[1,2)``, ``[3,5)``, ``[6,8)`` plus a
    trailing rest to the final barline — exercises explicit rest atoms and
    the measure-rest convention.
    """
    return straight_fixture(
        "rests_44",
        [Fraction(0), Fraction(2), Fraction(5), Fraction(8)],
        duration_ql=Fraction(1),
        expected_durations_ql=[Fraction(1)] * 4,
        expected_rest_spans_ql=[
            (Fraction(1), Fraction(1)),
            (Fraction(3), Fraction(2)),
            (Fraction(6), Fraction(2)),
            (Fraction(9), Fraction(3)),
        ],
        expected_tuplet_groups=0,
        layer="rests",
    )


def rests_sixteenth() -> RhythmFixture:
    """A real sixteenth rest mid-phrase (QNT-007, design 38 rests layer).

    Quarter at 0 ends exactly on beat 1, then a sixteenth rest before the
    ``5/4`` onset — the tiny-rest penalty must not erase a *real* 16th rest
    whose raw offset evidence supports it.
    """
    return straight_fixture(
        "rests_sixteenth",
        [Fraction(0), Fraction(5, 4), Fraction(2), Fraction(3)],
        durations_ql=[Fraction(1), Fraction(3, 4), Fraction(9, 10), Fraction(9, 10)],
        expected_durations_ql=[Fraction(1), Fraction(3, 4), Fraction(1), Fraction(1)],
        expected_rest_spans_ql=[(Fraction(1), Fraction(1, 4))],
        expected_tuplet_groups=0,
        layer="rests",
    )


def articulation_gaps() -> RhythmFixture:
    """Tongued quarters with ~140 ms separation gaps — NOT rests (QNT-007).

    Raw offsets end ``0.28 ql`` before each next onset (tongue/breath
    separation at 120 BPM). Design 13: onset evidence outranks offset
    evidence, so these are written as sustained quarters — the timing-only
    arm (B3) and the no-tiny-rest ablation emit sixteenth rests instead.
    The phrase-final note is held to the barline.
    """
    return straight_fixture(
        "articulation_gaps",
        [Fraction(i) for i in range(4)],
        durations_ql=[
            Fraction(18, 25),
            Fraction(18, 25),
            Fraction(18, 25),
            Fraction(9, 10),
        ],
        expected_durations_ql=[Fraction(1)] * 4,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="rests",
    )


# --- triplet fixtures (issue #19 / QNT-005) ----------------------------------------


def triplet_eighths_exact() -> RhythmFixture:
    """Exact 8th-note triplets over two beats in 4/4."""
    return straight_fixture(
        "triplet_eighths_exact",
        [
            Fraction(0),
            Fraction(1, 3),
            Fraction(2, 3),
            Fraction(1),
            Fraction(4, 3),
            Fraction(5, 3),
        ],
        duration_ql=Fraction(1, 4),
        expected_durations_ql=[Fraction(1, 3)] * 6,
        expected_rest_spans_ql=[(Fraction(2), Fraction(2))],
        expected_tuplet_groups=2,
        layer="triplet",
    )


def triplet_eighths_jitter() -> RhythmFixture:
    """8th-note triplets with deterministic ±15 ms timing jitter."""
    return straight_fixture(
        "triplet_eighths_jitter",
        [
            Fraction(0),
            Fraction(1, 3),
            Fraction(2, 3),
            Fraction(1),
            Fraction(4, 3),
            Fraction(5, 3),
        ],
        seed=5107,
        jitter_range_ms=15.0,
        duration_ql=Fraction(1, 4),
        expected_durations_ql=[Fraction(1, 3)] * 6,
        expected_rest_spans_ql=[(Fraction(2), Fraction(2))],
        expected_tuplet_groups=2,
        layer="triplet",
    )


def eighths_jitter_straight() -> RhythmFixture:
    """Straight 8ths with deterministic ±20 ms jitter — must stay binary."""
    return straight_fixture(
        "eighths_jitter_straight",
        [Fraction(i, 2) for i in range(8)],
        seed=2609,
        jitter_range_ms=20.0,
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="triplet",
    )


def isolated_late_note() -> RhythmFixture:
    """One isolated off-grid note (2.62 ql) in a straight-8th passage.

    Region [2, 3) holds only one triplet-relevant onset — below the region
    evidence gate — so the note snaps to the binary grid (2.5) and the
    region stays binary; the evidence still surfaces ``possible_triplet``
    for review.
    """
    return straight_fixture(
        "isolated_late_note",
        [
            Fraction(0),
            Fraction(1, 2),
            Fraction(1),
            Fraction(3, 2),
            Fraction(2),
            Fraction(131, 50),  # 2.62 — 120 ms late of the 8th at 2.5
            Fraction(3),
            Fraction(7, 2),
        ],
        expected_ql=[
            Fraction(0),
            Fraction(1, 2),
            Fraction(1),
            Fraction(3, 2),
            Fraction(2),
            Fraction(5, 2),
            Fraction(3),
            Fraction(7, 2),
        ],
        duration_ql=Fraction(2, 5),
        expected_durations_ql=[Fraction(1, 2)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="triplet",
    )


def triplet_run_jittered() -> RhythmFixture:
    """AMT-jittered 8th-triplet run (#88): every beat shows triplet
    evidence but most regions see only one relevant onset — the
    per-beat gate cannot open them alone. The contiguous run (with
    first-third hits) must commit the whole passage to triplets."""
    interior = (
        (Fraction(31, 100), Fraction(13, 20)),
        (Fraction(7, 25), Fraction(3, 5)),
        (Fraction(27, 100), Fraction(31, 50)),
        (Fraction(31, 100), Fraction(13, 20)),
        (Fraction(7, 25), Fraction(3, 5)),
        (Fraction(27, 100), Fraction(31, 50)),
        (Fraction(3, 10), Fraction(31, 50)),
        (Fraction(7, 25), Fraction(31, 50)),
    )
    onsets: list[Fraction] = []
    for b, (a, c) in enumerate(interior):
        onsets += [Fraction(b), Fraction(b) + a, Fraction(b) + c]
    thirds = [Fraction(3 * b + k, 3) for b in range(8) for k in range(3)]
    return straight_fixture(
        "triplet_run_jittered",
        onsets,
        expected_ql=thirds,
        duration_ql=Fraction(3, 10),
        expected_durations_ql=[Fraction(1, 3)] * 24,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=8,
        layer="triplet",
    )


def swing_eighths_run() -> RhythmFixture:
    """Swung eighths at 2:1 (#88): the 2/3-only offbeat run is a shuffle,
    not triplets — notation must stay straight eighths so the
    ``swingFeel`` direction can carry the feel."""
    onsets: list[Fraction] = []
    for b in range(8):
        onsets += [Fraction(b), Fraction(b) + Fraction(2, 3)]
    return straight_fixture(
        "swing_eighths_run",
        onsets,
        expected_ql=[Fraction(i, 2) for i in range(16)],
        duration_ql=Fraction(3, 10),
        expected_durations_ql=[Fraction(1, 2)] * 16,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="triplet",
    )


def swing_with_dotted_pickup() -> RhythmFixture:
    """Swung passage with one real dotted-16th figure (#88): the
    swing snap band ends below the dotted point, so the 0.75 onset
    keeps its dotted notation amid the straightened eighths."""
    onsets: list[Fraction] = []
    for b in range(8):
        if b == 5:
            onsets += [Fraction(b), Fraction(b) + Fraction(3, 4)]
        else:
            onsets += [Fraction(b), Fraction(b) + Fraction(2, 3)]
    expected = [Fraction(i, 2) for i in range(16)]
    expected[11] = Fraction(23, 4)  # 5.75 stays dotted
    return straight_fixture(
        "swing_with_dotted_pickup",
        onsets,
        expected_ql=expected,
        duration_ql=Fraction(3, 10),
        expected_tuplet_groups=0,
        layer="triplet",
    )


def binary_triplet_binary() -> RhythmFixture:
    """Binary -> triplet -> binary passage (design 38 fixture).

    Quarter, eighths, one full beat of triplet eighths, then quarters — the
    triplet beat is the only region with enough evidence to open the gate.
    """
    return straight_fixture(
        "binary_triplet_binary",
        [
            Fraction(0),
            Fraction(1),
            Fraction(3, 2),
            Fraction(2),
            Fraction(7, 3),
            Fraction(8, 3),
            Fraction(3),
            Fraction(4),
        ],
        duration_ql=Fraction(1, 4),
        expected_durations_ql=[
            Fraction(1, 2),
            Fraction(1, 2),
            Fraction(1, 2),
            Fraction(1, 3),
            Fraction(1, 3),
            Fraction(1, 3),
            Fraction(1, 2),
            Fraction(1, 4),
        ],
        expected_rest_spans_ql=[
            (Fraction(1, 2), Fraction(1, 2)),
            (Fraction(7, 2), Fraction(1, 2)),
            (Fraction(17, 4), Fraction(15, 4)),
        ],
        expected_tuplet_groups=1,
        layer="triplet",
    )


def weak_start_crossing() -> RhythmFixture:
    """Offbeat ('and' of 1) dotted-quarter crossing beat 2 (QNT-007).

    The ``[1/2, 2)`` span hides a primary beat boundary; the boundary cost
    writes it as eighth-tied-to-quarter, while the timing-only arm writes a
    bare dotted quarter obscuring beat 2 (design 15). A leading eighth and
    a closing quarter complete the bar.
    """
    return straight_fixture(
        "weak_start_crossing",
        [Fraction(0), Fraction(1, 2), Fraction(2)],
        durations_ql=[Fraction(9, 20), Fraction(7, 5), Fraction(9, 10)],
        expected_durations_ql=[Fraction(1, 2), Fraction(3, 2), Fraction(1)],
        expected_rest_spans_ql=[(Fraction(3), Fraction(1))],
        expected_tuplet_groups=0,
        layer="boundary",
    )


# --- horn-like fixtures (issue #21 / QNT-007) ------------------------------------


def horn_repeated_tongued() -> RhythmFixture:
    """Eight tongued same-pitch eighths — repeated-note boundaries kept.

    Horn tonguing produces distinct onsets at the same pitch; the quantizer
    must never merge them (design 26). Detached offsets (0.45 ql) notate as
    plain eighths, not eighth+sixteenth-rest fragments.
    """
    return straight_fixture(
        "horn_repeated_tongued",
        [Fraction(i, 2) for i in range(8)],
        durations_ql=[Fraction(9, 20)] * 8,
        expected_durations_ql=[Fraction(1, 2)] * 8,
        expected_rest_spans_ql=(),
        expected_tuplet_groups=0,
        layer="horn",
    )


def horn_sustained_whole() -> RhythmFixture:
    """A four-beat sustained note, then two quarters (long horn tones)."""
    return straight_fixture(
        "horn_sustained_whole",
        [Fraction(0), Fraction(4), Fraction(5)],
        durations_ql=[Fraction(39, 10), Fraction(9, 10), Fraction(9, 10)],
        expected_durations_ql=[Fraction(4), Fraction(1), Fraction(1)],
        expected_rest_spans_ql=[(Fraction(6), Fraction(2))],
        expected_tuplet_groups=0,
        layer="horn",
    )


def horn_breath_gaps() -> RhythmFixture:
    """Sustained half notes separated by breath-size gaps (design 13).

    Each note's raw offset ends ~0.1–0.2 ql early — a breath lift, not a
    rest. HSQ writes sustained half notes; the timing-only arm and the
    no-tiny-rest ablation fragment the line with sixteenth rests.
    """
    return straight_fixture(
        "horn_breath_gaps",
        [Fraction(0), Fraction(2), Fraction(4)],
        durations_ql=[Fraction(9, 5), Fraction(89, 50), Fraction(19, 10)],
        expected_durations_ql=[Fraction(2), Fraction(2), Fraction(2)],
        expected_rest_spans_ql=[(Fraction(6), Fraction(2))],
        expected_tuplet_groups=0,
        layer="horn",
    )


def horn_legato_overlap() -> RhythmFixture:
    """Legato overlap: raw offsets overrun the next onset (AMT legato).

    Design 27: notated ends clip to the next onset — the overrun is
    diagnostics evidence (``overlap_clipped_count``), never a rest.
    """
    return straight_fixture(
        "horn_legato_overlap",
        [Fraction(0), Fraction(1), Fraction(2)],
        durations_ql=[Fraction(11, 10), Fraction(23, 20), Fraction(19, 20)],
        expected_durations_ql=[Fraction(1), Fraction(1), Fraction(1)],
        expected_rest_spans_ql=[(Fraction(3), Fraction(1))],
        expected_tuplet_groups=0,
        layer="horn",
    )


def horn_phrase_gap() -> RhythmFixture:
    """Two four-quarter phrases separated by a full measure of breath/reset.

    The four-beat silence is a real whole-bar rest, not phrase-internal
    articulation — exercising the rest-realization convention at phrase
    scale.
    """
    return straight_fixture(
        "horn_phrase_gap",
        [
            Fraction(0),
            Fraction(1),
            Fraction(2),
            Fraction(3),
            Fraction(8),
            Fraction(9),
            Fraction(10),
            Fraction(11),
        ],
        expected_durations_ql=[Fraction(1)] * 8,
        expected_rest_spans_ql=[(Fraction(4), Fraction(4))],
        expected_tuplet_groups=0,
        layer="horn",
    )


ALL_FIXTURES: tuple[Callable[[], RhythmFixture], ...] = (
    quarters_exact,
    eighths_exact,
    sixteenths_exact,
    quarters_jitter20,
    quarters_jitter50,
    eighths_jitter80,
    quarters_latency40,
    quarters_latency40_slow,
    quarters_latency65,
    tempo_change_beatmap,
    ioi_pair_fixture,
    syncopated_exact,
    meter_34_quarters,
    meter_24_eighths,
    meter_68_eighths,
    meter_68_dotted_beats,
    pickup_44_quarter,
    meter_change_44_68,
    barline_tie_44,
    weak_start_crossing,
    rests_44,
    rests_sixteenth,
    articulation_gaps,
    triplet_eighths_exact,
    triplet_eighths_jitter,
    eighths_jitter_straight,
    isolated_late_note,
    binary_triplet_binary,
    horn_repeated_tongued,
    horn_sustained_whole,
    horn_breath_gaps,
    horn_legato_overlap,
    horn_phrase_gap,
)
"""Every required fixture, for parametrized acceptance tests."""


METER_GOLDEN_FACTORIES: tuple[Callable[[], RhythmFixture], ...] = (
    meter_34_quarters,
    meter_68_eighths,
    pickup_44_quarter,
    meter_change_44_68,
    binary_triplet_binary,
    barline_tie_44,
    rests_44,
)
"""Fixtures whose quantized output is committed as MusicXML golden files
(``fixtures/musicxml/<name>_concert.musicxml`` / ``_horn_in_f.musicxml``) —
regenerate via ``scripts/generate_fixtures.py``.  QNT-006 extended the set
to cover the realization features: meter changes, tuplets, barline ties,
and explicit rests."""
