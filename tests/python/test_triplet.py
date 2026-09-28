"""QNT-005 acceptance: triplet model, grid-mode consistency, ambiguity (issue #19).

Covers the issue acceptance criteria: exact/jittered 8th-triplet recovery,
straight-jitter passages staying binary, 6/8 native ternary never becoming a
tuplet, the triplet evidence gate (AUTO/NEVER/ALWAYS), the mode-switch
penalty against one-note grid flicker, notation-sensitive k-best ambiguity
(``quantization_ambiguous``), ``possible_triplet`` review issues with
canonical note IDs + time ranges, and determinism.
"""

from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

import pytest

import rhythm_fixtures as fx
from hornscribe.domain.ids import RawNoteEventId, ScoreRevisionId
from hornscribe.domain.review import ReviewReason
from hornscribe.rhythm import (
    MeterMap,
    MeterSegment,
    NormalizedNote,
    QuantizationProfile,
    TripletRegion,
    enabled_triplet_regions,
    generate_onset_candidates,
    generate_review_issues,
    normalize_to_score_time,
    quantize_events,
    quantize_normalized,
    region_evidence,
    simple_meter_regions,
    strict_triplet_regions,
)
from hornscribe.rhythm.dp import kbest_onset_paths
from hornscribe.rhythm.lattice import CandidateGrid, OnsetCandidate
from hornscribe.rhythm.profile import TripletPolicy
from hornscribe.rhythm.triplet import TRIPLET_TUPLET_LABEL

METER_44 = MeterMap((MeterSegment(Fraction(0), 4, 4),))
METER_68 = MeterMap((MeterSegment(Fraction(0), 6, 8),))
PROFILE = QuantizationProfile.standard()
REVISION = ScoreRevisionId("sr-" + "t" * 16)


def _note(i: int, onset: float, offset: float) -> NormalizedNote:
    return NormalizedNote(
        source_id=RawNoteEventId(f"rne-{i:06d}"),
        pitch_midi=60,
        onset_ql=onset,
        offset_ql=offset,
    )


def _onsets(alternative) -> list[Fraction]:
    return [n.onset_ql for n in alternative.notes]


def _triplet_atoms(alternative) -> list:
    return [
        a
        for n in alternative.notes
        if n.notation is not None
        for a in n.notation.atoms
        if a.tuplet is not None
    ]


# --- exact / jittered triplet recovery (acceptance) ---------------------------------


def test_exact_triplets_recovered() -> None:
    """Acceptance: exact 8th triplets quantize to third positions + triplet atoms."""
    fixture = fx.triplet_eighths_exact()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    atoms = _triplet_atoms(best)
    assert len(atoms) == 6  # every note is one eighth-triplet atom
    assert all(a.tuplet == TRIPLET_TUPLET_LABEL for a in atoms)
    assert all(a.duration_ql == Fraction(1, 3) for a in atoms)
    assert best.diagnostics.tuplet_group_count == 2  # one bracket per beat


def test_jittered_triplets_recovered() -> None:
    fixture = fx.triplet_eighths_jitter()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    assert len(_triplet_atoms(best)) == 6


def test_binary_triplet_binary_passage() -> None:
    """Binary -> triplet -> binary: only the evidenced beat turns tuplet."""
    fixture = fx.binary_triplet_binary()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    triplet_atoms = _triplet_atoms(best)
    assert len(triplet_atoms) == 3
    assert best.diagnostics.tuplet_group_count == 1
    # the triplet atoms sit exactly inside beat [2, 3)
    seen: list[Fraction] = []
    for note in best.notes:
        assert note.notation is not None
        pos = note.onset_ql
        for atom in note.notation.atoms:
            if atom.tuplet is not None:
                seen.append(pos)
            pos += atom.duration_ql
    assert seen and all(Fraction(2) <= p < Fraction(3) for p in seen)


# --- straight jitter stays binary (acceptance) ---------------------------------------


def test_straight_jittered_eighths_stay_binary() -> None:
    """Acceptance: human jitter on straight 8ths must not mint tuplets."""
    fixture = fx.eighths_jitter_straight()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    assert _triplet_atoms(best) == []
    assert best.diagnostics.tuplet_group_count == 0


def test_jittered_eighths_open_no_region() -> None:
    """The evidence gate stays shut on jittered binary content (design 17.2)."""
    fixture = fx.eighths_jitter_straight()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    evidence = region_evidence(notes, fixture.meter_map, PROFILE)
    assert evidence  # simple-meter beats were evaluated
    assert not any(ev.gate_open(PROFILE) for ev in evidence)
    assert enabled_triplet_regions(evidence, PROFILE) == ()


# --- 6/8 native ternary is not a tuplet (acceptance) ---------------------------------


def test_compound_meter_native_ternary_not_tuplet() -> None:
    """Acceptance: 6/8 eighth subdivisions are meter structure, not tuplets."""
    fixture = fx.meter_68_dotted_beats()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    assert _onsets(alts[0]) == list(fixture.expected_onsets_ql)
    assert _triplet_atoms(alts[0]) == []
    assert alts[0].diagnostics.tuplet_group_count == 0


def test_compound_meter_yields_no_triplet_regions() -> None:
    assert simple_meter_regions(METER_68, Fraction(0), Fraction(12)) == ()
    # simple meters still yield one region per primary beat
    regions = simple_meter_regions(METER_44, Fraction(0), Fraction(4))
    assert [r.start_ql for r in regions] == [Fraction(0), Fraction(1), Fraction(2), Fraction(3)]


# --- evidence gate (acceptance: candidates require configured/evidence gate) ---------


def test_triplet_policy_never_suppresses_candidates() -> None:
    """``NEVER`` -> the exact-triplet passage snaps onto the binary grid."""
    fixture = fx.triplet_eighths_exact()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    never = replace(PROFILE, triplet_policy=TripletPolicy.NEVER)
    alts = quantize_normalized(notes, fixture.meter_map, never)
    best = alts[0]
    assert _triplet_atoms(best) == []
    assert all(
        onset.denominator in (1, 2, 4, 8, 16) for onset in _onsets(best)
    )  # binary grid only


def test_isolated_late_note_does_not_flip_region() -> None:
    """Acceptance: one relevant onset is below the AUTO gate -> stays binary."""
    fixture = fx.isolated_late_note()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    assert _triplet_atoms(best) == []
    # but the triplet-fitting evidence is real -> surfaced for review
    assert "possible_triplet" in best.diagnostics.review_reasons


def test_evidence_gate_requires_two_relevant_onsets() -> None:
    """AUTO opens only at >= ``triplet_gate_min_relevant_onsets`` (design 17.2)."""
    triplet_notes = normalize_to_score_time(
        fx.triplet_eighths_exact().events, fx.triplet_eighths_exact().warp
    )
    evidence = region_evidence(triplet_notes, METER_44, PROFILE)
    opened = {ev.region.start_ql for ev in evidence if ev.gate_open(PROFILE)}
    assert opened == {Fraction(0), Fraction(1)}
    # the isolated-note fixture: region [2,3) has exactly one relevant onset
    lone_notes = normalize_to_score_time(
        fx.isolated_late_note().events, fx.isolated_late_note().warp
    )
    lone = {ev.region.start_ql: ev for ev in region_evidence(lone_notes, METER_44, PROFILE)}
    assert lone[Fraction(2)].relevant_onsets == 1
    assert not lone[Fraction(2)].gate_open(PROFILE)


def test_policy_always_enables_without_evidence() -> None:
    """``ALWAYS`` opts every simple-meter beat in (explicit user setting)."""
    notes = (_note(1, 0.0, 0.3), _note(2, 0.5, 0.8))
    evidence = region_evidence(notes, METER_44, PROFILE)
    always = replace(PROFILE, triplet_policy=TripletPolicy.ALWAYS)
    enabled = enabled_triplet_regions(evidence, always)
    assert enabled == tuple(ev.region for ev in evidence)
    never = replace(PROFILE, triplet_policy=TripletPolicy.NEVER)
    assert enabled_triplet_regions(evidence, never) == ()


def test_lattice_triplet_candidates_inside_enabled_region() -> None:
    """Design 8.2: third points join the lattice only inside enabled regions."""
    note = _note(1, 1.0 / 3.0, 0.6)
    region = TripletRegion(start_ql=Fraction(0))
    cands = generate_onset_candidates(note, PROFILE, triplet_regions=(region,))
    triplet = [c for c in cands if c.grid is CandidateGrid.TRIPLET]
    # all third points inside the candidate window: beat start + interior thirds
    assert Fraction(1, 3) in [c.position_ql for c in triplet]
    assert all(c.position_ql in region.third_positions_ql for c in triplet)
    # no enabled region -> binary family only
    cands_no = generate_onset_candidates(note, PROFILE)
    assert all(c.grid is CandidateGrid.BINARY for c in cands_no)


# --- grid-mode consistency (acceptance: mode-switch prevents flicker) ----------------


def test_mode_switch_penalty_blocks_one_note_flicker() -> None:
    """Design 18: a single note must not flick the path to the triplet grid.

    The middle note sits nearer a triplet third than the binary grid point;
    with ``mode_switch = 0`` the DP flicks binary->triplet->binary, while the
    configured penalty keeps the whole passage binary.
    """
    notes = (_note(1, 0.0, 0.3), _note(2, 0.30, 0.6), _note(3, 1.0, 1.3))

    def cand(pos: Fraction, grid: CandidateGrid) -> OnsetCandidate:
        return OnsetCandidate(position_ql=pos, grid=grid, distance_ql=0.0)

    candidates = (
        (cand(Fraction(0), CandidateGrid.BINARY), cand(Fraction(1, 4), CandidateGrid.BINARY)),
        (cand(Fraction(1, 4), CandidateGrid.BINARY), cand(Fraction(1, 3), CandidateGrid.TRIPLET)),
        (cand(Fraction(3, 4), CandidateGrid.BINARY), cand(Fraction(1), CandidateGrid.BINARY)),
    )
    no_penalty = replace(PROFILE, weights=replace(PROFILE.weights, mode_switch=0.0))
    flicked = kbest_onset_paths(notes, candidates, no_penalty)[0]
    assert flicked.grids[1] is CandidateGrid.TRIPLET

    steady = kbest_onset_paths(notes, candidates, PROFILE)[0]
    assert steady.positions == (Fraction(0), Fraction(1, 4), Fraction(1))
    assert all(g is CandidateGrid.BINARY for g in steady.grids)


# --- ambiguity (acceptance: ReviewIssue only when notation differs) ------------------


def test_close_alternatives_with_same_notation_not_flagged() -> None:
    """Design 20: equal-cost grid-*labels* with identical atoms never flag.

    In ``binary_triplet_binary`` the note on beat 2 is both the binary grid
    point and the triplet region start — rank 1/2 differ only in the grid
    family label and write the identical score, so no ambiguity is raised.
    """
    fixture = fx.binary_triplet_binary()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    alts = quantize_normalized(notes, fixture.meter_map)
    assert len(alts) >= 2
    assert alts[1].total_cost - alts[0].total_cost < 0.15  # close enough to flag
    sig = [
        (n.onset_ql, n.duration_ql, tuple(a.tuplet for a in n.notation.atoms))
        for n in alts[0].notes
    ]
    sig2 = [
        (n.onset_ql, n.duration_ql, tuple(a.tuplet for a in n.notation.atoms))
        for n in alts[1].notes
    ]
    assert sig == sig2  # notation identical
    assert "quantization_ambiguous" not in alts[0].diagnostics.review_reasons
    issues = generate_review_issues(
        alts, notes, fixture.meter_map, PROFILE, score_revision=REVISION, warp=fixture.warp
    )
    assert not any(i.reason is ReviewReason.QUANTIZATION_AMBIGUOUS for i in issues)


def test_close_alternatives_with_different_notation_flagged() -> None:
    """Design 19-20: a coin-flip onset writes a different score -> flag."""
    # 0.125 sits exactly between binary grid points 0 and 1/4.
    notes = (_note(1, 0.125, 0.6),)
    alts = quantize_normalized(notes, METER_44)
    assert len(alts) >= 2
    assert alts[0].notes[0].onset_ql != alts[1].notes[0].onset_ql
    assert "quantization_ambiguous" in alts[0].diagnostics.review_reasons
    assert alts[0].diagnostics.ambiguous_region_count == 1

    issues = generate_review_issues(
        alts, notes, METER_44, PROFILE, score_revision=REVISION, warp=fx.quarters_exact().warp
    )
    ambiguous = [i for i in issues if i.reason is ReviewReason.QUANTIZATION_AMBIGUOUS]
    assert len(ambiguous) == 1
    issue = ambiguous[0]
    # the issue points at the canonical note + its seconds-domain range
    assert issue.canonical_note_ids == (alts[0].notes[0].canonical_note_id,)
    warp = fx.quarters_exact().warp
    assert issue.time_range.start_sec == pytest.approx(
        warp.ql_to_seconds(alts[0].notes[0].onset_ql)
    )
    assert issue.time_range.end_sec == pytest.approx(
        warp.ql_to_seconds(alts[0].notes[0].end_ql)
    )
    assert issue.evidence["top1Cost"] == alts[0].total_cost
    assert issue.evidence["top2Cost"] == alts[1].total_cost
    assert issue.evidence["affectedNoteCount"] == 1


def test_possible_triplet_issue_carries_region_and_ids() -> None:
    """Acceptance: ambiguous range -> canonical note IDs + time range."""
    fixture = fx.isolated_late_note()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    alts = quantize_normalized(notes, fixture.meter_map)
    issues = generate_review_issues(
        alts, notes, fixture.meter_map, PROFILE, score_revision=REVISION, warp=fixture.warp
    )
    triplet = [i for i in issues if i.reason is ReviewReason.POSSIBLE_TRIPLET]
    assert len(triplet) == 1
    issue = triplet[0]
    # the issue covers exactly the notes whose onsets fall in region [2, 3)
    expected_ids = tuple(
        n.canonical_note_id
        for n in alts[0].notes
        if Fraction(2) <= n.onset_ql < Fraction(3)
    )
    assert issue.canonical_note_ids == expected_ids
    assert issue.time_range.start_sec == pytest.approx(
        fixture.warp.ql_to_seconds(Fraction(2))
    )
    assert issue.time_range.end_sec == pytest.approx(
        fixture.warp.ql_to_seconds(Fraction(3))
    )
    assert issue.evidence["relevantOnsets"] == 1


def test_issue_ids_deterministic() -> None:
    """ri-000001... ids allocated in (start_sec, reason) order — reproducible."""
    fixture = fx.isolated_late_note()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    alts = quantize_normalized(notes, fixture.meter_map)
    a = generate_review_issues(
        alts, notes, fixture.meter_map, PROFILE, score_revision=REVISION, warp=fixture.warp
    )
    b = generate_review_issues(
        alts, notes, fixture.meter_map, PROFILE, score_revision=REVISION, warp=fixture.warp
    )
    assert a == b
    assert a[0].id == "ri-000001"


# --- determinism (acceptance) ---------------------------------------------------------


def test_triplet_quantization_deterministic() -> None:
    for make in (fx.triplet_eighths_exact, fx.triplet_eighths_jitter,
                 fx.binary_triplet_binary, fx.isolated_late_note):
        fixture = make()
        a = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
        b = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
        assert a == b


# --- #88: triplet runs + swing snap -------------------------------------


def test_jittered_triplet_run_commits_fully() -> None:
    """#88: a detected-jitter triplet passage must not mix grids.

    Per-beat evidence is below the two-relevant gate on most beats,
    but the contiguous run carries first-third evidence — every beat
    must land on the third lattice, never a sixteenth."""
    fixture = fx.triplet_run_jittered()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    # interior positions are all thirds — no sixteenth leaked in
    assert all(o.denominator == 3 for o in _onsets(best) if o.denominator != 1)
    assert best.diagnostics.tuplet_group_count == 8


def test_run_regions_open_strict() -> None:
    """#88: the run qualifies every contiguous region — and goes
    strict, so interior binary candidates cannot break it up."""
    fixture = fx.triplet_run_jittered()
    notes = normalize_to_score_time(fixture.events, fixture.warp)
    evidence = region_evidence(notes, fixture.meter_map, PROFILE)
    enabled = enabled_triplet_regions(evidence, PROFILE)
    strict = strict_triplet_regions(evidence, PROFILE)
    # regions 0..7 all carry >=1 relevant onset and the run holds
    # first-third evidence — the whole passage enables
    assert {r.start_ql for r in enabled} == {Fraction(b) for b in range(8)}
    assert strict == tuple(enabled)


def test_first_third_marks_real_triplets_not_shuffle() -> None:
    """#88: first-third evidence distinguishes triplets from swing."""
    triplet_notes = normalize_to_score_time(
        fx.triplet_run_jittered().events, fx.triplet_run_jittered().warp
    )
    triplet_ev = region_evidence(triplet_notes, METER_44, PROFILE)
    assert sum(ev.first_third_relevant for ev in triplet_ev) >= 1
    swing_notes = normalize_to_score_time(
        fx.swing_eighths_run().events, fx.swing_eighths_run().warp
    )
    swing_ev = region_evidence(swing_notes, METER_44, PROFILE)
    assert sum(ev.first_third_relevant for ev in swing_ev) == 0
    # the swing run does not qualify — the passage stays binary so
    # the swing census can mark it straight + swingFeel
    assert strict_triplet_regions(swing_ev, PROFILE) == ()


def test_swung_run_writes_straight_eighths() -> None:
    """#88: swung eighths notate straight under the swingFeel
    direction — never dotted-16th pairs or literal triplets."""
    fixture = fx.swing_eighths_run()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    assert _triplet_atoms(best) == []
    assert best.diagnostics.tuplet_group_count == 0
    # the swing census explains the off-grid evidence — no
    # misleading 'maybe triplets' flag
    assert "possible_triplet" not in best.diagnostics.review_reasons


def test_swing_snap_preserves_real_dotted_figure() -> None:
    """#88: a genuine dotted-16th onset (phase 0.75) sits outside the
    snap band — it keeps its dotted notation inside a swung piece."""
    fixture = fx.swing_with_dotted_pickup()
    alts = quantize_events(fixture.events, fixture.warp, fixture.meter_map)
    best = alts[0]
    assert _onsets(best) == list(fixture.expected_onsets_ql)
    assert Fraction(23, 4) in _onsets(best)


def test_region_covering_first_beat_evaluated() -> None:
    """#88: an onset a few ms into beat 0 still evaluates its
    containing region — the beat is not silently skipped."""
    regions = simple_meter_regions(METER_44, Fraction(1, 50), Fraction(4))
    assert regions[0].start_ql == Fraction(0)
    notes = normalize_to_score_time(
        fx.triplet_run_jittered().events, fx.triplet_run_jittered().warp
    )
    evidence = region_evidence(notes, METER_44, PROFILE)
    starts = {ev.region.start_ql for ev in evidence}
    assert Fraction(0) in starts
