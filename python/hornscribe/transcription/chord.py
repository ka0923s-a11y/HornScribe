"""Chord-map estimation (orig #419).

Harmony context for the transcription pipeline - a fully local,
free chord estimator. CQT chroma is averaged inside measure-aligned
segments, matched against a small chord-template set (cosine
similarity), then smoothed by a Viterbi pass whose switch cost
follows circle-of-fifths distance and whose emissions get a small
diatonic bonus from the already-estimated key. No model weights,
no external service; the map is deterministic and inspectable.

The map answers "which chord sounded under this span" well enough to
enrich spelling/review evidence and to flag segments whose harmony
the estimator cannot justify (``chord_uncertain``). It deliberately
does not chase passing chords - segments stay at half-measure
granularity, the harmonic rhythm JPOP choruses actually use.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Chord qualities the estimator can name. Each entry maps interval-
# above-root (semitones) to a template weight; the seventh sits at
# 0.9 and the dim7 extension at 0.7 because real mixes voice them
# more weakly than triad tones.
_QUALITIES: dict[str, tuple[tuple[int, float], ...]] = {
    "maj": ((0, 1.0), (4, 1.0), (7, 1.0)),
    "min": ((0, 1.0), (3, 1.0), (7, 1.0)),
    "7": ((0, 1.0), (4, 1.0), (7, 1.0), (10, 0.9)),
    "maj7": ((0, 1.0), (4, 1.0), (7, 1.0), (11, 0.9)),
    "m7": ((0, 1.0), (3, 1.0), (7, 1.0), (10, 0.9)),
    "m7b5": ((0, 1.0), (3, 1.0), (6, 1.0), (10, 0.9)),
    "dim": ((0, 1.0), (3, 1.0), (6, 1.0), (9, 0.7)),
    "aug": ((0, 1.0), (4, 1.0), (8, 1.0)),
    "sus4": ((0, 1.0), (5, 1.0), (7, 1.0)),
}

# JPOP-faithful symbol spelling (m7b5 renders as m7-5).
_QUALITY_SUFFIX = {
    "maj": "",
    "min": "m",
    "7": "7",
    "maj7": "maj7",
    "m7": "m7",
    "m7b5": "m7-5",
    "dim": "dim",
    "aug": "aug",
    "sus4": "sus4",
}

_ROOT_SHARP = (
    "C", "C#", "D", "D#", "E", "F",
    "F#", "G", "G#", "A", "A#", "B",
)
_ROOT_FLAT = (
    "C", "Db", "D", "Eb", "E", "F",
    "Gb", "G", "Ab", "A", "Bb", "B",
)

# Confidence gates for a chord_uncertain review issue: the segment
# is flagged when the best template explains the chroma weakly OR
# when two candidates explain it almost equally well.
LOW_CONFIDENCE = 0.35
LOW_MARGIN = 0.04

# Viterbi geometry: a same-chord self loop is free, a root change
# costs proportionally to circle-of-fifths distance, and a quality-
# only change (same root) costs half - C -> C7 inside one dominant
# area is a smaller claim than C -> F#m.
_SWITCH_BASE = 0.09
_SWITCH_FIFTHS_STEP = 0.045
_QUALITY_ONLY_FACTOR = 0.5
# Diatonic-to-the-estimated-key candidates get a gentle emission
# bonus - a prior, never a veto.
_DIATONIC_BONUS = 0.03

_CHROMA_HOP = 1024

@dataclass(frozen=True)
class ChordEstimate:
    """One smoothed chord call over a seconds span."""

    start_sec: float
    end_sec: float
    root_pc: int
    quality: str
    confidence: float
    margin: float
    runner_up: str | None = None

    def label(self, prefer_flats: bool = False) -> str:
        names = _ROOT_FLAT if prefer_flats else _ROOT_SHARP
        return names[self.root_pc % 12] + _QUALITY_SUFFIX[self.quality]

    def chord_tones(self) -> tuple[int, ...]:
        return tuple(
            (self.root_pc + iv) % 12 for iv, _w in _QUALITIES[self.quality]
        )

    def to_dict(self, prefer_flats: bool = False) -> dict[str, Any]:
        return {
            "startSec": round(self.start_sec, 3),
            "endSec": round(self.end_sec, 3),
            "label": self.label(prefer_flats),
            "rootPc": self.root_pc,
            "quality": self.quality,
            "confidence": round(self.confidence, 3),
            "margin": round(self.margin, 3),
            "runnerUp": self.runner_up,
        }


def chord_label(root_pc: int, quality: str, prefer_flats: bool = False) -> str:
    names = _ROOT_FLAT if prefer_flats else _ROOT_SHARP
    return names[root_pc % 12] + _QUALITY_SUFFIX[quality]


def diatonic_chords(fifths: int, mode: str) -> set[tuple[int, str]]:
    """(root_pc, quality) pairs diatonic to the estimated key.

    Major: I ii iii IV V7 vi vii half-dim. Natural minor: i ii half-dim
    III iv v VI VII7. The dominant 7th is included because real JPOP
    voices V as V7 constantly; matching it should not read as a
    chromatic surprise.
    """
    _TONIC_BY_FIFTHS = (0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5)
    tonic = _TONIC_BY_FIFTHS[fifths % 12]
    if mode == "minor":
        # Fifths name the relative MAJOR signature - the minor
        # tonic sits a minor third below it (+9 semitones).
        tonic = (tonic + 9) % 12
        pcs = (0, 2, 3, 5, 7, 8, 10)  # natural minor degrees
        quals = ("min", "m7b5", "maj", "min", "min", "maj", "7")
    else:
        pcs = (0, 2, 4, 5, 7, 9, 11)  # major degrees
        quals = ("maj", "min", "min", "maj", "7", "min", "m7b5")
    return {(int((tonic + pc) % 12), q) for pc, q in zip(pcs, quals, strict=True)}


def _templates() -> tuple[tuple[tuple[int, str], ...], Any]:
    """108 (root, quality) states + their 12-dim weight vectors."""
    import numpy as np

    states: list[tuple[int, str]] = []
    vecs = []
    for root in range(12):
        for quality, tones in _QUALITIES.items():
            v = np.zeros(12)
            for iv, w in tones:
                v[(root + iv) % 12] = w
            v /= np.linalg.norm(v)
            states.append((root, quality))
            vecs.append(v)
    return tuple(states), np.stack(vecs)


def _fifths_distance(a: int, b: int) -> int:
    """Circle-of-fifths steps between two pitch classes (0..6)."""
    diff = abs(a - b) % 12
    semis = min(diff, 12 - diff)
    steps = (semis * 7) % 12
    return min(steps, 12 - steps)


def _segment_chroma(
    samples: Any, sample_rate: int, segments: tuple[tuple[float, float], ...],
) -> Any:
    """Normalized mean CQT chroma per segment, (n, 12).

    librosa lives in this function (analysis-stage dependency).
    """
    import librosa  # noqa: PLC0415 - analysis-stage dependency
    import numpy as np

    y = np.asarray(samples, dtype=np.float32)
    chroma = librosa.feature.chroma_cqt(
        y=y, sr=sample_rate, hop_length=_CHROMA_HOP
    )
    times = librosa.frames_to_time(
        np.arange(chroma.shape[1]), sr=sample_rate, hop_length=_CHROMA_HOP
    )
    out = np.zeros((len(segments), 12))
    for i, (lo, hi) in enumerate(segments):
        mask = (times >= lo) & (times < hi)
        if not mask.any():
            continue
        mean = chroma[:, mask].mean(axis=1)
        norm = float(np.linalg.norm(mean))
        if norm > 0.0:
            out[i] = mean / norm
    return out


def estimate_chords(
    samples: Any,
    sample_rate: int,
    segments_sec: tuple[tuple[float, float], ...],
    *,
    diatonic: set[tuple[int, str]] | None = None,
    prefer_flats: bool = False,
) -> tuple[ChordEstimate, ...]:
    """Smoothed chord call per seconds segment.

    ``segments_sec`` should be measure-aligned (half-measure splits
    are the caller job); ``diatonic`` is the key prior from
    :func:`diatonic_chords`. Returns one :class:`ChordEstimate` per
    input segment - merging equal neighbours is a presentation
    choice left to the serializer.
    """
    import numpy as np

    if not segments_sec:
        return ()
    chroma = _segment_chroma(samples, sample_rate, segments_sec)
    states, vecs = _templates()
    sims = chroma @ vecs.T  # (n_seg, n_states)
    if diatonic:
        bonus = np.array(
            [
                _DIATONIC_BONUS if (root, q) in diatonic else 0.0
                for root, q in states
            ]
        )
        sims = sims + bonus
    n_seg, n_states = sims.shape
    # Transition cost: same state free, same-root quality change at
    # half price, root changes scaled by fifths distance.
    roots = np.array([s[0] for s in states])
    quals = np.array([s[1] for s in states])
    fdist = np.zeros((n_states, n_states))
    for i in range(n_states):
        for j in range(n_states):
            fdist[i, j] = _fifths_distance(int(roots[i]), int(roots[j]))
    same_root = roots[:, None] == roots[None, :]
    same_qual = quals[:, None] == quals[None, :]
    trans = np.where(
        same_root,
        np.where(same_qual, 0.0, _SWITCH_BASE * _QUALITY_ONLY_FACTOR),
        _SWITCH_BASE + _SWITCH_FIFTHS_STEP * fdist,
    )
    # Viterbi forward pass over emission = template similarity.
    dp = np.full((n_seg, n_states), -np.inf)
    back = np.zeros((n_seg, n_states), dtype=np.int64)
    dp[0] = sims[0]
    for t in range(1, n_seg):
        cand = dp[t - 1][:, None] - trans
        back[t] = np.argmax(cand, axis=0)
        dp[t] = sims[t] + cand[back[t], np.arange(n_states)]
    path = np.zeros(n_seg, dtype=np.int64)
    path[-1] = int(np.argmax(dp[-1]))
    for t in range(n_seg - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    estimates: list[ChordEstimate] = []
    for t, (lo, hi) in enumerate(segments_sec):
        best = int(path[t])
        order = np.argsort(sims[t])[::-1]
        second = int(order[1]) if int(order[0]) == best else int(order[0])
        root, quality = states[best]
        r_root, r_quality = states[second]
        best_sim = float(sims[t, best])
        second_sim = float(sims[t, second])
        estimates.append(
            ChordEstimate(
                start_sec=lo,
                end_sec=hi,
                root_pc=root,
                quality=quality,
                # Diatonic bonus can push the sim past 1.0 - clamp so
                # evidence reads as a plain 0..1 score.
                confidence=round(min(1.0, best_sim), 4),
                margin=round(best_sim - second_sim, 4),
                runner_up=(
                    chord_label(r_root, r_quality, prefer_flats)
                    if second != best
                    else None
                ),
            )
        )
    return tuple(estimates)
