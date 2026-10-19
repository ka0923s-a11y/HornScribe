"""#385 stage 1: repeated-section detection (no folding).

JPOP repeats its chorus two or three times nearly identically - a
230 s song tiles ~138 measures through-played. Folding identical
phrases under repeat signs would make the printed part far more
readable, but folding breaks the app's core contract of one display
measure <-> one audio span (canonical ids, review markers, playback
table, waveform sync). Stage 1 therefore only DETECTS maximal repeat
runs and reports them as informational issues - the evidence
validates whether folding is worth building later.

Two tracks are tried, harmony first. The chord-root progression is
the robust signal on real audio: chorus statements re-decode the
melody differently each time (note counts, ornaments, spellings all
drift), but the underlying root motion survives. Chord root pitch
classes are windowed per measure, normalized by the window's first
root (transposition-invariant, so a +1 last chorus still matches),
and compared by sequence-edit similarity. When the job produced no
chord track (harmony off or no coverage), the lead-melody signature
- per-measure pitch offsets relative to the first note plus a
quantized (onset, duration) rhythm track - is used instead; it is
stricter and mostly fires on clean synthetic scores.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from fractions import Fraction
from statistics import median

from hornscribe.domain.ids import ScoreNoteId, ScoreRevisionId
from hornscribe.domain.review import (
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.domain.score import (
    ChordSymbol,
    MeasureSpan,
    QuantizedNote,
    ScoreRevisionPayload,
    measure_spans,
)
from hornscribe.rhythm.timewarp import TimeWarp

#: Melody track: a section, not a riff - runs shorter than four
#: measures are normal JPOP riffing, not repeat signs.
MIN_RUN_MEASURES = 4
#: Melody sequence-match floor - tolerates a dropped pickup note or
#: an ornament while rejecting same-length different melodies.
MATCH_THRESHOLD = 0.85
#: The canonical window must carry a real phrase: at least ~1.5
#: notes per measure (and never fewer than six total) - a run of
#: long-note pad measures would "repeat" trivially and prove nothing.
_MIN_RUN_NOTES = 6
_MIN_NOTES_PER_MEASURE = Fraction(3, 2)

#: Harmony track: section scale. An 8-measure chord-root repeat is a
#: chorus-class claim; 4-measure root echoes are riffing.
CHORD_RUN_MEASURES = 8
#: Windowed root-sequence edit similarity - observed clean repeats
#: land at 0.81-0.88 on real audio while same-length different
#: progressions stay below ~0.7.
CHORD_MATCH_THRESHOLD = 0.80
#: Trust the harmony track only when at least half the measures
#: carry a chord - sparser coverage makes "repeats" out of silence.
_CHORD_MIN_COVERAGE = 0.5
#: ...and each candidate window must itself be chord-dense: the
#: flattened window signature skips chordless measures, so without
#: this floor [4m of chords + 4m of silence] "repeats" as an 8m
#: window when only the first half ever sounded.
_CHORD_MIN_WINDOW_COVERAGE = 0.6
#: No JPOP section outlasts 32 measures; bounding the window growth
#: keeps the (i, j) scan linear in practice.
_MAX_WINDOW_MEASURES = 32
#: Slack added to the short-window pre-gate so a repeat whose first
#: measures are noisy is not pruned before its body can be scored.
_GATE_SLACK = 0.08
#: More occurrences than this is a vamp/loop, and the evidence list
#: would drown the genuinely useful ones.
_MAX_OCCURRENCES = 12


@dataclass(frozen=True)
class _MeasureSig:
    """One measure's match signature on the lead staff.

    ``pc_rel`` is pitch offsets from the measure's first note -
    transposition-invariant, so a +1 final chorus still matches.
    ``rhythm`` is (onset offset inside the measure, duration) pairs.
    """

    pc_rel: tuple[int, ...]
    rhythm: tuple[tuple[Fraction, Fraction], ...]
    note_ids: tuple[ScoreNoteId, ...]
    pitches: tuple[int, ...]

    @property
    def empty(self) -> bool:
        return not self.pc_rel


def _measure_signatures(
    notes: Iterable[QuantizedNote],
    spans: tuple[MeasureSpan, ...],
) -> list[_MeasureSig]:
    """Bucket the lead notes into per-measure signatures."""
    by_measure: list[list[QuantizedNote]] = [[] for _ in spans]
    live = sorted(
        (n for n in notes if not n.deleted), key=lambda n: n.start_beat
    )
    idx = 0
    for i, span in enumerate(spans):
        while idx < len(live) and live[idx].start_beat < span.start_beat:
            idx += 1
        j = idx
        while j < len(live) and live[j].start_beat < span.end_beat:
            by_measure[i].append(live[j])
            j += 1
    sigs: list[_MeasureSig] = []
    for span, members in zip(spans, by_measure, strict=True):
        members.sort(key=lambda n: (n.start_beat, n.pitch_midi))
        first = members[0].pitch_midi if members else 0
        sigs.append(
            _MeasureSig(
                pc_rel=tuple(n.pitch_midi - first for n in members),
                rhythm=tuple(
                    (n.start_beat - span.start_beat, n.duration_beats)
                    for n in members
                ),
                note_ids=tuple(n.id for n in members),
                pitches=tuple(n.pitch_midi for n in members),
            )
        )
    return sigs


def _chord_root_sigs(
    chord_symbols: Iterable[ChordSymbol],
    spans: tuple[MeasureSpan, ...],
) -> list[tuple[int, ...]]:
    """Per-measure absolute root pitch classes in segment order."""
    syms = sorted(chord_symbols, key=lambda s: (s.start_beat, s.end_beat))
    out: list[tuple[int, ...]] = []
    idx = 0
    for sp in spans:
        roots: list[int] = []
        while idx < len(syms) and syms[idx].start_beat < sp.end_beat:
            if syms[idx].start_beat >= sp.start_beat:
                roots.append(syms[idx].root_pc)
            idx += 1
        out.append(tuple(roots))
    return out


def _edit_similarity(a: tuple, b: tuple) -> float:
    """1 - levenshtein/max(len). Small sequences - plain DP."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for k, y in enumerate(b, 1):
            cur[k] = min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (x != y))
        prev = cur
    dist = prev[len(b)]
    return 1.0 - dist / max(len(a), len(b))


def _measure_sim(a: _MeasureSig, b: _MeasureSig) -> float:
    if a.empty and b.empty:
        return 1.0  # rest = rest; runs still need notes in the window
    if a.empty != b.empty:
        return 0.0
    pitch_sim = _edit_similarity(a.pc_rel, b.pc_rel)
    rhythm_sim = _edit_similarity(a.rhythm, b.rhythm)
    return 0.5 * pitch_sim + 0.5 * rhythm_sim


@dataclass(frozen=True)
class RepeatOccurrence:
    start: int  # index into the spans array
    similarity: float
    transposition: int  # median semitone shift vs the canonical window


@dataclass(frozen=True)
class RepeatRun:
    """A canonical window [start, start+length) and its later echoes."""

    start: int
    length: int
    occurrences: tuple[RepeatOccurrence, ...]


def _transposition_melody(
    sigs: list[_MeasureSig], a_start: int, b_start: int, length: int
) -> int:
    """Median-of-medians semitone shift between the two windows."""
    a = [p for s in sigs[a_start : a_start + length] for p in s.pitches]
    b = [p for s in sigs[b_start : b_start + length] for p in s.pitches]
    if not a or not b:
        return 0
    return int(round(median(b) - median(a)))


def _chord_delta(
    mroots: list[tuple[int, ...]], i: int, j: int
) -> int:
    """First-root shift between the two windows, folded to -6..+6."""
    a = next((r for m in mroots[i:] for r in m), None)
    b = next((r for m in mroots[j:] for r in m), None)
    if a is None or b is None:
        return 0
    d = (b - a) % 12
    return d - 12 if d > 6 else d


def _select_runs(
    candidates: list[tuple[int, int, int, float, int]],
) -> list[RepeatRun]:
    """Shared greedy: longest-first, majority-unexplained keep.

    Each candidate is (i, j, L, meanSim, transposition). Periodic
    content yields a lattice of sliding runs ((i,j,L),(i+1,j+1,L)...)
    that all describe ONE repeat - each shift only extends coverage
    by a measure - so a run must repeat at least half fresh measures.
    Runs surviving are grouped by canonical window.
    """
    candidates.sort(key=lambda c: (-c[2], c[0], c[1]))
    explained: set[int] = set()
    kept: dict[tuple[int, int], list[RepeatOccurrence]] = {}
    for i, j, length, mean_sim, delta in candidates:
        repeated = set(range(j, j + length))
        if len(repeated - explained) * 2 < length:
            continue
        canonical = set(range(i, i + length))
        explained |= canonical | repeated
        kept.setdefault((i, length), []).append(
            RepeatOccurrence(
                start=j,
                similarity=round(mean_sim, 3),
                transposition=delta,
            )
        )
    runs = [
        RepeatRun(
            start=i,
            length=length,
            occurrences=tuple(sorted(occs, key=lambda o: o.start)),
        )
        for (i, length), occs in kept.items()
    ]
    runs.sort(key=lambda r: (r.start, r.length))
    return runs


def find_repeat_runs(
    sigs: list[_MeasureSig],
    *,
    min_len: int = MIN_RUN_MEASURES,
    threshold: float = MATCH_THRESHOLD,
) -> list[RepeatRun]:
    """Melody track: maximal per-measure match runs.

    Candidates (i, j, L) match at ``threshold`` for L consecutive
    measures with non-overlapping spans (j >= i + L). Selection then
    applies the shared majority-unexplained greedy.
    """
    n = len(sigs)
    candidates: list[tuple[int, int, int, float, int]] = []
    for i in range(n):
        for j in range(i + 1, n):
            length = 0
            sim_sum = 0.0
            while j + length < n and i + length < j:
                s = _measure_sim(sigs[i + length], sigs[j + length])
                if s < threshold:
                    break
                sim_sum += s
                length += 1
            if length >= min_len:
                note_count = sum(len(s.pc_rel) for s in sigs[i : i + length])
                if note_count >= max(
                    _MIN_RUN_NOTES,
                    int(_MIN_NOTES_PER_MEASURE * length + Fraction(1, 2)),
                ):
                    candidates.append(
                        (i, j, length, sim_sum / length,
                         _transposition_melody(sigs, i, j, length))
                    )
    return _select_runs(candidates)


def _window_chord_seq(
    mroots: list[tuple[int, ...]], start: int, length: int
) -> tuple[int, ...]:
    """Flattened root sequence of a measure window, normalized by its
    first root - transposition-invariant by construction."""
    flat = [r for m in mroots[start : start + length] for r in m]
    if not flat:
        return ()
    base = flat[0]
    return tuple((r - base) % 12 for r in flat)


def _window_chord_sim(
    mroots: list[tuple[int, ...]], i: int, j: int, length: int
) -> float:
    a = _window_chord_seq(mroots, i, length)
    b = _window_chord_seq(mroots, j, length)
    if not a or not b:
        return 0.0
    return _edit_similarity(a, b)


def find_repeat_runs_chords(
    mroots: list[tuple[int, ...]],
    *,
    min_len: int = CHORD_RUN_MEASURES,
    threshold: float = CHORD_MATCH_THRESHOLD,
    max_len: int = _MAX_WINDOW_MEASURES,
) -> list[RepeatRun]:
    """Harmony track: windowed chord-root repeats.

    For every non-overlapping pair (i, j) a short gate at min_len
    (with _GATE_SLACK tolerance) prunes hopeless pairs; survivors grow
    the window to the longest stretch still at ``threshold``. The
    shared greedy then keeps section-scale runs only.
    """
    n = len(mroots)
    candidates: list[tuple[int, int, int, float, int]] = []
    for i in range(n):
        for j in range(i + min_len, n):
            if j + min_len > n:
                break
            if (
                _window_chord_sim(mroots, i, j, min_len)
                < threshold - _GATE_SLACK
            ):
                continue
            best_l = 0
            best_s = 0.0
            for length in range(min_len, min(max_len, j - i, n - j) + 1):
                s = _window_chord_sim(mroots, i, j, length)
                if s >= threshold:
                    best_l, best_s = length, s
            if best_l and (
                min(
                    sum(1 for m in mroots[i : i + best_l] if m),
                    sum(1 for m in mroots[j : j + best_l] if m),
                )
                >= _CHORD_MIN_WINDOW_COVERAGE * best_l
            ):
                candidates.append(
                    (i, j, best_l, best_s, _chord_delta(mroots, i, j))
                )
    return _select_runs(candidates)


def repeat_section_issues(
    payload: ScoreRevisionPayload,
    warp: TimeWarp,
    beat_ql: Fraction,
    score_revision: ScoreRevisionId,
    *,
    chord_symbols: Iterable[ChordSymbol] = (),
) -> list[ReviewIssue]:
    """Emit one REPEATED_SECTION info issue per repeated phrase.

    Harmony track first (robust on real audio); the lead-melody
    signature path is the fallback when no chord coverage exists.
    The marker's time range covers the FIRST repeated span; evidence
    names the canonical measures, every later occurrence with its
    similarity and transposition, and the detection track used.
    """
    spans = measure_spans(payload)
    chord_list = tuple(chord_symbols)
    runs: list[RepeatRun] = []
    track = ""
    if chord_list:
        mroots = _chord_root_sigs(chord_list, spans)
        covered = sum(1 for m in mroots if m)
        if covered >= _CHORD_MIN_COVERAGE * len(spans):
            runs = find_repeat_runs_chords(mroots)
            track = "chords"
    if not runs:
        lead = next((p for p in payload.parts if p.transposing), None)
        if lead is None or not lead.notes:
            return []
        if len(spans) < MIN_RUN_MEASURES * 2:
            return []
        sigs = _measure_signatures(lead.notes, spans)
        runs = find_repeat_runs(sigs)
        track = "melody"
    if not runs:
        return []

    # Anchors come from the lead staff when present, else the first
    # part - the repeated span still gets score markers.
    lead = next(
        (p for p in payload.parts if p.transposing),
        payload.parts[0] if payload.parts else None,
    )
    issues: list[ReviewIssue] = []
    for run in runs:
        canon_span = (spans[run.start], spans[run.start + run.length - 1])
        occurrences = run.occurrences[:_MAX_OCCURRENCES]
        first = occurrences[0]
        rep_start = spans[first.start]
        rep_end = spans[first.start + run.length - 1]
        anchors: list[ScoreNoteId] = []
        if lead is not None:
            for n in lead.notes:
                if rep_start.start_beat <= n.start_beat < rep_end.end_beat:
                    anchors.append(n.id)
                if len(anchors) >= 8:
                    break
        issues.append(
            ReviewIssue(
                id="",
                score_revision=score_revision,
                canonical_note_ids=tuple(anchors[:8]),
                time_range=TimeRange(
                    start_sec=warp.ql_to_seconds(
                        rep_start.start_beat * beat_ql
                    ),
                    end_sec=warp.ql_to_seconds(rep_end.end_beat * beat_ql),
                ),
                reason=ReviewReason.REPEATED_SECTION,
                severity=Severity.INFO,
                evidence={
                    "track": track,
                    "measures": [
                        {
                            "start": canon_span[0].number,
                            "end": canon_span[1].number,
                        }
                    ],
                    "occurrences": [
                        {
                            "startMeasure": spans[o.start].number,
                            "endMeasure": spans[
                                o.start + run.length - 1
                            ].number,
                            "similarity": o.similarity,
                            "transposition": o.transposition,
                        }
                        for o in occurrences
                    ],
                    "phraseMeasures": run.length,
                    "occurrenceCount": len(run.occurrences),
                },
            )
        )
    return issues
