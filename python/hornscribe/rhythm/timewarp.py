"""Monotonic seconds <-> quarterLength warp (QUANTIZER_DESIGN.md section 6).

The quantizer never rounds raw seconds to a grid directly: every onset first
passes through a :class:`TimeWarp` into musical time (quarterLength units), so
tempo changes and rubato are absorbed by the warp rather than by the search
(design sections 4 and 23).

Two construction modes are supported:

* :meth:`TimeWarp.fixed_bpm` — linear map ``ql = (t - zero_sec) * bpm / 60``
  (design 6.2); the most trustworthy MVP fallback.
* :meth:`TimeWarp.from_beat_map` — piecewise-linear interpolation through the
  anchors of a :class:`~hornscribe.rhythm.BeatMap` (design 6.1). Piecewise
  linear is used because it passes exactly through every anchor, stays
  monotonic, never overshoots, and is debuggable.

Out-of-range inputs are extrapolated with the nearest segment slope.

Positions are exact :class:`~fractions.Fraction` quarterLength values;
seconds are measured ``float`` values (the raw-evidence domain).
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Iterable
from enum import Enum
from fractions import Fraction

from hornscribe.domain.events import RawNoteEvent
from hornscribe.rhythm._util import as_exact_fraction
from hornscribe.rhythm.beatmap import BeatAnchor, BeatMap
from hornscribe.rhythm.contracts import NormalizedNote


class TimeWarpMode(Enum):
    """How a :class:`TimeWarp` is defined."""

    FIXED_BPM = "fixed_bpm"
    """Linear map from a manual tempo (design 6.2)."""
    BEAT_MAP = "beat_map"
    """Piecewise-linear map through beat anchors (design 6.1)."""


def _segment_index(points: tuple[Fraction, ...], x: Fraction) -> int:
    """Return the index ``i`` of the segment ``[points[i], points[i+1]]``.

    Out-of-range *x* clamps to the first/last segment, which implements the
    nearest-segment-slope extrapolation rule (design 6.1). ``points`` must be
    strictly increasing and contain at least two entries.
    """
    i = bisect_right(points, x) - 1
    if i < 0:
        return 0
    return min(i, len(points) - 2)


class TimeWarp:
    """Monotonic seconds -> quarterLength mapping (design section 6).

    Construct with :meth:`fixed_bpm` or :meth:`from_beat_map`; direct
    construction is reserved for those factories.
    """

    __slots__ = ("_mode", "_ql_per_sec", "_zero_sec", "_beat_map", "_times", "_positions")

    def __init__(
        self,
        *,
        mode: TimeWarpMode,
        ql_per_sec: Fraction | None = None,
        zero_sec: Fraction | None = None,
        beat_map: BeatMap | None = None,
        times: tuple[Fraction, ...] = (),
        positions: tuple[Fraction, ...] = (),
    ) -> None:
        self._mode = mode
        self._ql_per_sec = ql_per_sec
        self._zero_sec = zero_sec
        self._beat_map = beat_map
        self._times = times
        self._positions = positions

    @classmethod
    def fixed_bpm(cls, bpm: float, zero_sec: float = 0.0) -> TimeWarp:
        """Linear warp ``ql = (time_sec - zero_sec) * bpm / 60`` (design 6.2).

        ``zero_sec`` is the physical time of score position ``0 ql`` — the
        global alignment offset between audio time and score time.
        """
        if not math.isfinite(bpm) or bpm <= 0.0:
            raise ValueError(f"bpm must be a positive finite number, got {bpm!r}")
        if not math.isfinite(zero_sec):
            raise ValueError(f"zero_sec must be finite, got {zero_sec!r}")
        return cls(
            mode=TimeWarpMode.FIXED_BPM,
            ql_per_sec=Fraction(bpm) / 60,
            zero_sec=Fraction(zero_sec),
        )

    @classmethod
    def from_beat_map(cls, beat_map: BeatMap) -> TimeWarp:
        """Piecewise-linear warp through *beat_map* anchors (design 6.1).

        Between anchors ``(t0, q0)`` and ``(t1, q1)``:

        ``W(t) = q0 + (t - t0) / (t1 - t0) * (q1 - q0)``

        computed in exact rational arithmetic, so the warp passes through
        every anchor exactly. Outside the anchor range the nearest segment
        slope is used for extrapolation.
        """
        anchors = beat_map.anchors
        return cls(
            mode=TimeWarpMode.BEAT_MAP,
            beat_map=beat_map,
            times=tuple(Fraction(a.time_sec) for a in anchors),
            positions=tuple(a.score_pos_ql for a in anchors),
        )

    @classmethod
    def from_anchors(cls, anchors: Iterable[BeatAnchor]) -> TimeWarp:
        """Convenience wrapper: build a :class:`BeatMap` then warp it."""
        return cls.from_beat_map(BeatMap(tuple(anchors)))

    @property
    def mode(self) -> TimeWarpMode:
        return self._mode

    @property
    def bpm(self) -> float | None:
        """Tempo for :attr:`TimeWarpMode.FIXED_BPM` warps, else ``None``."""
        if self._ql_per_sec is None:
            return None
        return float(self._ql_per_sec * 60)

    @property
    def zero_sec(self) -> float | None:
        """Score-origin offset for fixed-BPM warps, else ``None``."""
        if self._zero_sec is None:
            return None
        return float(self._zero_sec)

    @property
    def beat_map(self) -> BeatMap | None:
        """The backing beat map for :attr:`TimeWarpMode.BEAT_MAP` warps."""
        return self._beat_map

    def seconds_to_ql(self, time_sec: float) -> Fraction:
        """Map a time in seconds to an exact quarterLength position.

        The result is always a :class:`Fraction`: at anchor times it is
        *exactly* the anchor's ``score_pos_ql``.
        """
        if not math.isfinite(time_sec):
            raise ValueError(f"time_sec must be finite, got {time_sec!r}")
        t = Fraction(time_sec)
        if self._mode is TimeWarpMode.FIXED_BPM:
            assert self._ql_per_sec is not None and self._zero_sec is not None
            return (t - self._zero_sec) * self._ql_per_sec
        i = _segment_index(self._times, t)
        t0, t1 = self._times[i], self._times[i + 1]
        q0, q1 = self._positions[i], self._positions[i + 1]
        return q0 + (t - t0) * (q1 - q0) / (t1 - t0)

    def ql_to_seconds(self, pos_ql: Fraction) -> float:
        """Inverse map: exact quarterLength position -> seconds (design 6.1).

        ``pos_ql`` must be an exact :class:`Fraction` (or ``int``); ``float``
        is rejected so drifted positions cannot be mapped silently.
        """
        q = as_exact_fraction(pos_ql, name="pos_ql")
        if self._mode is TimeWarpMode.FIXED_BPM:
            assert self._ql_per_sec is not None and self._zero_sec is not None
            return float(self._zero_sec + q / self._ql_per_sec)
        i = _segment_index(self._positions, q)
        q0, q1 = self._positions[i], self._positions[i + 1]
        t0, t1 = self._times[i], self._times[i + 1]
        return float(t0 + (q - q0) * (t1 - t0) / (q1 - q0))

    def __repr__(self) -> str:
        if self._mode is TimeWarpMode.FIXED_BPM:
            return f"TimeWarp.fixed_bpm(bpm={self.bpm}, zero_sec={self.zero_sec})"
        n = 0 if self._beat_map is None else len(self._beat_map)
        return f"TimeWarp.from_beat_map(<{n} anchors>)"


def normalize_to_score_time(
    events: Iterable[RawNoteEvent],
    warp: TimeWarp,
    alignment_shift_sec: float = 0.0,
) -> tuple[NormalizedNote, ...]:
    """Map raw events through *warp* into musical time (design section 32, step 1).

    ``alignment_shift_sec`` is added to raw event seconds before mapping; it
    carries the global latency/alignment shift estimated upstream (design
    section 6.3) and defaults to no shift.

    Positions stay ``float`` here (:class:`NormalizedNote`); they become exact
    ``Fraction`` only when the quantizer commits to grid boundaries
    (design 5.4). Event order is preserved.
    """
    if not math.isfinite(alignment_shift_sec):
        raise ValueError(f"alignment_shift_sec must be finite, got {alignment_shift_sec!r}")
    normalized: list[NormalizedNote] = []
    for event in events:
        normalized.append(
            NormalizedNote(
                source_id=event.id,
                pitch_midi=int(round(event.pitch_midi)),
                onset_ql=float(warp.seconds_to_ql(event.onset_sec + alignment_shift_sec)),
                offset_ql=float(warp.seconds_to_ql(event.offset_sec + alignment_shift_sec)),
                confidence=event.confidence,
            )
        )
    return tuple(normalized)
