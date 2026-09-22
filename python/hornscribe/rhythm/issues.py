"""ReviewIssue generation from quantizer output (QNT-005; design 20, 40).

Turns the rank-1 diagnostics' review-reason strings into domain
:class:`~hornscribe.domain.review.ReviewIssue` objects with deterministic
canonical note IDs, second-domain time ranges and evidence payloads. The
Japanese UI copy for both reasons already exists
(``quantization_ambiguous`` → リズムの解釈を確認してください,
``possible_triplet`` → 三連符の可能性があります).

Covered reasons — the ones QNT-005 makes mappable to the domain enum:

* ``quantization_ambiguous`` — one issue per contiguous run of notes whose
  rank-1/rank-2 notation differs (design 20: close alternatives only flag
  when the written score actually changes);
* ``possible_triplet`` — one issue per triplet-evidence region where the
  rank-1 path committed no triplet atoms.

Other diagnostics reasons (``beat_alignment_uncertain``,
``pickup_ambiguous``, ``overlapping_candidates``, ``offset_ambiguous``)
remain diagnostic strings — they have no domain enum member yet, matching
the QNT-003/004 convention.
"""

from __future__ import annotations

import math
from fractions import Fraction
from typing import Any

from hornscribe.domain.ids import ScoreNoteId, ScoreRevisionId
from hornscribe.domain.review import (
    IssueIdAllocator,
    ReviewIssue,
    ReviewReason,
    Severity,
    TimeRange,
)
from hornscribe.rhythm.contracts import (
    NormalizedNote,
    QuantizationAlternative,
    RhythmAtom,
)
from hornscribe.rhythm.meter import MeterMap
from hornscribe.rhythm.profile import QuantizationProfile
from hornscribe.rhythm.timewarp import TimeWarp
from hornscribe.rhythm.triplet import TripletRegion, region_evidence

_AtomSignature = tuple[Fraction, str, int, str | None, bool, bool]


def _atoms_signature(
    atoms: tuple[RhythmAtom, ...],
) -> tuple[_AtomSignature, ...]:
    """Notation-comparable fingerprint of one atom sequence."""
    return tuple(
        (a.duration_ql, a.symbol, a.dots, a.tuplet, a.is_rest, a.tie_to_next)
        for a in atoms
    )


def _differing_note_indices(
    a: QuantizationAlternative, b: QuantizationAlternative
) -> tuple[int, ...]:
    """Note indices whose *notation* differs between two alternatives."""
    out = []
    for i, (na, nb) in enumerate(zip(a.notes, b.notes, strict=True)):
        sig_a = _atoms_signature(na.notation.atoms) if na.notation else ()
        sig_b = _atoms_signature(nb.notation.atoms) if nb.notation else ()
        if (
            na.onset_ql != nb.onset_ql
            or na.duration_ql != nb.duration_ql
            or sig_a != sig_b
        ):
            out.append(i)
    return tuple(out)


def _index_runs(indices: tuple[int, ...]) -> tuple[tuple[int, ...], ...]:
    """Split sorted indices into contiguous runs (one ambiguous region each)."""
    if not indices:
        return ()
    runs: list[list[int]] = [[indices[0]]]
    for i in indices[1:]:
        if i == runs[-1][-1] + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    return tuple(tuple(r) for r in runs)


def _alternative_has_triplet_atoms(
    alternative: QuantizationAlternative, region: TripletRegion
) -> bool:
    """Whether rank-1 notation carries a triplet atom inside ``region``."""
    for note in alternative.notes:
        if note.notation is None:
            continue
        pos = note.onset_ql
        for atom in note.notation.atoms:
            if atom.tuplet is not None and region.start_ql <= pos < region.end_ql:
                return True
            pos += atom.duration_ql
    for rest in alternative.rests:
        pos = rest.onset_ql
        for atom in rest.notation.atoms:
            if atom.tuplet is not None and region.start_ql <= pos < region.end_ql:
                return True
            pos += atom.duration_ql
    return False


def _seconds(warp: TimeWarp, pos_ql: Fraction) -> float:
    return warp.ql_to_seconds(pos_ql)


def generate_review_issues(
    alternatives: tuple[QuantizationAlternative, ...],
    notes: tuple[NormalizedNote, ...] | list[NormalizedNote],
    meter_map: MeterMap,
    profile: QuantizationProfile,
    *,
    score_revision: ScoreRevisionId,
    warp: TimeWarp,
) -> tuple[ReviewIssue, ...]:
    """Materialize review issues for one quantization run (design 20, 40).

    ``alternatives`` is the full ranked output of ``quantize_*``; ``notes``
    is the *same* normalized input that produced it (the triplet-evidence
    gate is recomputed deterministically so regions match exactly).
    ``warp`` maps exact quarterLength positions back to seconds for the
    issue time ranges. Issues are ordered by ``(start_sec, reason)`` and
    carry ``ri-000001...`` ids allocated in that order — fully
    deterministic for identical input.
    """
    if not alternatives:
        return ()
    best = alternatives[0]
    reasons = set(best.diagnostics.review_reasons)
    pending: list[
        tuple[float, str, tuple[ScoreNoteId, ...], TimeRange, dict[str, Any]]
    ] = []

    if "quantization_ambiguous" in reasons and len(alternatives) >= 2:
        runner_up = alternatives[1]
        differing = _differing_note_indices(best, runner_up)
        margin = (
            (runner_up.total_cost - best.total_cost) / len(differing)
            if differing
            else math.inf
        )
        for run in _index_runs(differing):
            ids = tuple(best.notes[i].canonical_note_id for i in run)
            lo = best.notes[run[0]].onset_ql
            hi = best.notes[run[-1]].end_ql
            rng = TimeRange(start_sec=_seconds(warp, lo), end_sec=_seconds(warp, hi))
            evidence: dict[str, Any] = {
                "top1Cost": best.total_cost,
                "top2Cost": runner_up.total_cost,
                "marginPerNote": margin,
                "affectedNoteCount": len(run),
            }
            pending.append((rng.start_sec, ReviewReason.QUANTIZATION_AMBIGUOUS.value,
                            ids, rng, evidence))

    if "possible_triplet" in reasons:
        for ev in region_evidence(tuple(notes), meter_map, profile):
            if ev.relevant_onsets < 1:
                continue
            if _alternative_has_triplet_atoms(best, ev.region):
                continue
            ids = tuple(
                n.canonical_note_id
                for n in best.notes
                if ev.region.start_ql <= n.onset_ql < ev.region.end_ql
            )
            if not ids:
                continue
            rng = TimeRange(
                start_sec=_seconds(warp, ev.region.start_ql),
                end_sec=_seconds(warp, ev.region.end_ql),
            )
            evidence = {
                "beatStartQl": str(ev.region.start_ql),
                "relevantOnsets": ev.relevant_onsets,
                "binaryCost": ev.binary_cost,
                "tripletCost": ev.triplet_cost,
            }
            pending.append((rng.start_sec, ReviewReason.POSSIBLE_TRIPLET.value,
                            ids, rng, evidence))

    pending.sort(key=lambda item: (item[0], item[1]))
    allocator = IssueIdAllocator()
    issues: list[ReviewIssue] = []
    severity_by_reason = {
        ReviewReason.QUANTIZATION_AMBIGUOUS.value: Severity.CAUTION,
        ReviewReason.POSSIBLE_TRIPLET.value: Severity.CAUTION,
    }
    for _, reason_value, ids, rng, evidence in pending:
        issues.append(
            ReviewIssue(
                id=allocator.allocate(),
                score_revision=score_revision,
                canonical_note_ids=ids,
                time_range=rng,
                reason=ReviewReason(reason_value),
                severity=severity_by_reason[reason_value],
                evidence=evidence,
            )
        )
    return tuple(issues)


__all__ = ["generate_review_issues"]
