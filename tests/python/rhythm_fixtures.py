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
    """One deterministic quantization fixture."""

    name: str
    events: tuple[RawNoteEvent, ...]
    warp: TimeWarp
    expected_onsets_ql: tuple[Fraction, ...]
    meter_map: MeterMap | None = None
    bpm: float | None = None
    """Configured tempo for fixed-BPM fixtures (documentation/metrics)."""


def make_events(
    onsets_sec: Sequence[float],
    *,
    duration_sec: float = 0.2,
    pitch_midi: float = 60.0,
    confidence: float | None = 0.95,
) -> tuple[RawNoteEvent, ...]:
    """Build raw events with deterministic ``rne-*`` ids in input order."""
    return tuple(
        RawNoteEvent(
            id=RawNoteEventId(f"rne-{i + 1:06d}"),
            transcription_revision=TEST_REVISION,
            pitch_midi=pitch_midi,
            onset_sec=t,
            offset_sec=t + duration_sec,
            confidence=confidence,
        )
        for i, t in enumerate(onsets_sec)
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
    fixtures pass a shorter value so consecutive notes do not overlap.
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
    duration_ql = (
        duration_ql if duration_ql is not None else Fraction(9, 10)
    )  # default: sustained but not overlapping at beat spacing
    duration = float(duration_ql) * 60.0 / bpm
    return RhythmFixture(
        name=name,
        events=make_events(onsets, duration_sec=duration),
        warp=warp,
        expected_onsets_ql=tuple(
            Fraction(q) for q in (expected_ql if expected_ql is not None else onsets_ql)
        ),
        meter_map=meter_map if meter_map is not None else _meter_44(),
        bpm=bpm,
    )


# --- required fixtures (issue #16) ------------------------------------------------


def quarters_exact() -> RhythmFixture:
    """8 quarter notes @120 BPM, exactly on grid."""
    return straight_fixture("quarters_exact", [Fraction(i) for i in range(8)])


def quarters_jitter20() -> RhythmFixture:
    """Quarter notes @120 BPM with deterministic ±20 ms jitter."""
    return straight_fixture(
        "quarters_jitter20",
        [Fraction(i) for i in range(8)],
        seed=20260922,
        jitter_range_ms=20.0,
    )


def quarters_jitter50() -> RhythmFixture:
    """Quarter notes @120 BPM with deterministic ±50 ms jitter."""
    return straight_fixture(
        "quarters_jitter50",
        [Fraction(i) for i in range(8)],
        seed=777,
        jitter_range_ms=50.0,
    )


def eighths_exact() -> RhythmFixture:
    """16 eighth notes @120 BPM, exactly on grid."""
    return straight_fixture("eighths_exact", [Fraction(i, 2) for i in range(16)])


def sixteenths_exact() -> RhythmFixture:
    """16 sixteenth notes @120 BPM, exactly on grid."""
    return straight_fixture("sixteenths_exact", [Fraction(i, 4) for i in range(16)])


def syncopated_exact() -> RhythmFixture:
    """Offbeat-eighth syncopation @120 BPM (onsets on the 'and' of beats)."""
    return straight_fixture(
        "syncopated_exact",
        [Fraction(1, 2), Fraction(3, 2), Fraction(5, 2), Fraction(3), Fraction(7, 2)],
    )


def quarters_latency40() -> RhythmFixture:
    """Quarter notes @120 BPM shifted +40 ms (AMT-style global latency).

    At 120 BPM the 16th grid period is 125 ms, so a +85 ms shift is a
    perfect alias of the true -40 ms compensation — the search reports both
    the deterministic argmin and the ambiguity flag (design 6.3).
    """
    return straight_fixture(
        "quarters_latency40", [Fraction(i) for i in range(8)], latency_sec=0.040
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
    )


# --- meter fixtures (issue #18 / QNT-004) ----------------------------------------


def meter_34_quarters() -> RhythmFixture:
    """3/4: nine quarter onsets over exactly three bars (measure closure)."""
    return straight_fixture(
        "meter_34_quarters",
        [Fraction(i) for i in range(9)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 3, 4),)),
    )


def meter_24_eighths() -> RhythmFixture:
    """2/4: eighth-note stream over exactly two bars."""
    return straight_fixture(
        "meter_24_eighths",
        [Fraction(i, 2) for i in range(8)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 2, 4),)),
        duration_ql=Fraction(2, 5),
    )


def meter_68_eighths() -> RhythmFixture:
    """6/8: native eighth stream over two bars — must not become tuplets."""
    return straight_fixture(
        "meter_68_eighths",
        [Fraction(i, 2) for i in range(12)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 6, 8),)),
        duration_ql=Fraction(2, 5),
    )


def meter_68_dotted_beats() -> RhythmFixture:
    """6/8: dotted-quarter compound beats — low notation complexity."""
    return straight_fixture(
        "meter_68_dotted_beats",
        [Fraction(0), Fraction(3, 2), Fraction(3), Fraction(9, 2)],
        meter_map=MeterMap((MeterSegment(Fraction(0), 6, 8),)),
        duration_ql=Fraction(3, 2),
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
    )


def eighths_jitter_straight() -> RhythmFixture:
    """Straight 8ths with deterministic ±20 ms jitter — must stay binary."""
    return straight_fixture(
        "eighths_jitter_straight",
        [Fraction(i, 2) for i in range(8)],
        seed=2609,
        jitter_range_ms=20.0,
        duration_ql=Fraction(2, 5),
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
    )


ALL_FIXTURES: tuple[Callable[[], RhythmFixture], ...] = (
    quarters_exact,
    quarters_jitter20,
    quarters_jitter50,
    eighths_exact,
    sixteenths_exact,
    syncopated_exact,
    quarters_latency40,
    quarters_latency40_slow,
    tempo_change_beatmap,
    ioi_pair_fixture,
    meter_34_quarters,
    meter_24_eighths,
    meter_68_eighths,
    meter_68_dotted_beats,
    pickup_44_quarter,
    meter_change_44_68,
    barline_tie_44,
    rests_44,
    triplet_eighths_exact,
    triplet_eighths_jitter,
    eighths_jitter_straight,
    isolated_late_note,
    binary_triplet_binary,
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
