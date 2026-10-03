"""Backend note-tuple -> RawNoteEvent mapping tests (#169).

predict_note_events needs the real ONNX model, so the tuple mapping
lives in pure helpers (_to_raw_event / _bend_points) that unit tests
exercise without basic_pitch installed.
"""

from __future__ import annotations

import pytest

from hornscribe.domain.events import RawNoteEvent
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId
from hornscribe.transcription.backend import (
    _bend_points,
    _rms_velocity,
    _to_raw_event,
    admit_rescue_events,
    frames_to_note_events,
)
from hornscribe.transcription.leadvoice import lead_track_agreement


def _rev() -> TranscriptionRevisionId:
    return TranscriptionRevisionId("tr-000001")


class TestBendPoints:
    def test_center_is_zero_semitones(self):
        pts = _bend_points([8192, 8192], 1.0, 2.0)
        assert [p.bend_semitones for p in pts] == [0.0, 0.0]

    def test_full_range_maps_to_plus_minus_two(self):
        pts = _bend_points([0, 8192, 16383], 0.0, 1.0)
        assert pts[0].bend_semitones == -2.0
        assert pts[2].bend_semitones == (16383 - 8192) / 4096.0

    def test_times_span_the_note(self):
        pts = _bend_points([8192, 8192, 8192, 8192, 8192], 2.0, 3.0)
        assert pts[0].time_sec == 2.0
        assert pts[-1].time_sec == 3.0
        assert pts[2].time_sec == 2.5

    def test_empty_and_malformed_input(self):
        assert _bend_points([], 0.0, 1.0) == ()
        assert _bend_points(None, 0.0, 1.0) == ()
        assert _bend_points(["x", "y"], 0.0, 1.0) == ()

    def test_bp_bins_decode_in_thirds_of_a_semitone(self):
        # basic_pitch emits raw contour-bin offsets (1/3 st, centered
        # at 0) — a perfectly tuned note is all zeros, not -2 st.
        pts = _bend_points([0, 0, 0], 1.0, 2.0, units="bp_bins")
        assert [p.bend_semitones for p in pts] == [0.0, 0.0, 0.0]

    def test_bp_bins_preserve_real_vibrato(self):
        pts = _bend_points([-3, 0, 3], 0.0, 1.0, units="bp_bins")
        assert pts[0].bend_semitones == -1.0
        assert pts[1].bend_semitones == 0.0
        assert pts[2].bend_semitones == 1.0


class TestToRawEvent:
    def test_bends_are_kept(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60, 0.8, [8192, 12288]),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert len(ev.pitch_bends) == 2
        assert ev.pitch_bends[1].bend_semitones == 1.0
        assert ev.pitch_bends[0].time_sec == 0.5
        assert ev.pitch_bends[1].time_sec == 1.5

    def test_bp_bend_units_route_to_bin_decode(self):
        # The basic_pitch tuple slot carries contour bins — decode via
        # bend_units, or the same data would collapse to ~= -2 st.
        ev = _to_raw_event(
            (0.5, 1.5, 60, 0.8, [0, 3]),
            RawNoteEventId("rne-000001"),
            _rev(),
            bend_units="bp_bins",
        )
        assert ev.pitch_bends[0].bend_semitones == 0.0
        assert ev.pitch_bends[1].bend_semitones == 1.0

    def test_missing_bends_yields_empty(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60, 0.8),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert ev.pitch_bends == ()

    def test_scalar_fields(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60.0, 0.8, []),
            RawNoteEventId("rne-000001"),
            _rev(),
        )
        assert ev.pitch_midi == 60.0
        assert ev.confidence == 0.8
        assert ev.velocity == 88
        assert ev.source == "basic_pitch"

    def test_source_override(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60.0, 0.8, []),
            RawNoteEventId("rne-000001"),
            _rev(),
            source="pyin",
        )
        assert ev.source == "pyin"

    def test_velocity_override(self):
        """#214: pYIN passes an RMS-derived velocity; confidence stays put."""
        ev = _to_raw_event(
            (0.5, 1.5, 60.0, 0.8, []),
            RawNoteEventId("rne-000001"),
            _rev(),
            source="pyin",
            velocity=30,
        )
        assert ev.velocity == 30
        assert ev.confidence == 0.8

    def test_velocity_override_is_clamped(self):
        ev = _to_raw_event(
            (0.5, 1.5, 60.0, 0.8, []),
            RawNoteEventId("rne-000001"),
            _rev(),
            velocity=999,
        )
        assert ev.velocity == 127


class TestRmsVelocity:
    """#214: pYIN velocity comes from audio loudness, not voiced prob."""

    def test_loud_beats_quiet(self):
        sr = 22050
        loud = _rms_velocity([0.5] * sr, sr, 0.0, 1.0)
        quiet = _rms_velocity([0.005] * sr, sr, 0.0, 1.0)
        assert loud > quiet

    def test_full_scale_maps_near_ceiling(self):
        sr = 22050
        assert _rms_velocity([0.9] * sr, sr, 0.0, 1.0) >= 120

    def test_silence_is_minimum(self):
        sr = 22050
        assert _rms_velocity([0.0] * sr, sr, 0.0, 1.0) == 1

    def test_empty_span_falls_back(self):
        assert _rms_velocity([], 22050, 0.0, 1.0) == 64

    def test_span_windowing(self):
        """Only the note's own window counts — loud bleed elsewhere
        must not inflate a quiet note's velocity."""
        sr = 100
        samples = [0.9] * 50 + [0.001] * 50
        quiet_note = _rms_velocity(samples, sr, 0.5, 1.0)
        loud_note = _rms_velocity(samples, sr, 0.0, 0.5)
        assert quiet_note < loud_note


class TestFramesToNoteEvents:
    """librosa.pyin frame output -> note tuples (#175)."""

    def _frames(self, midis, voiced=None, dt=0.01):
        """Build (f0_hz, times, voiced_flag, voiced_prob) from MIDI list."""
        n = len(midis)
        f0 = [440.0 * (2 ** ((m - 69) / 12)) for m in midis]
        times = [i * dt for i in range(n)]
        voiced = ([True] * n) if voiced is None else voiced
        prob = [0.9] * n
        # pyin emits NaN f0 on unvoiced frames — mirror that so dropout
        # tests exercise the real merge path.
        for i in range(n):
            if not voiced[i]:
                f0[i] = float("nan")
        return f0, times, voiced, prob

    def test_single_run_one_note(self):
        f0, t, v, p = self._frames([60] * 20)
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 1
        onset, offset, pitch, amp, bends = ev[0]
        assert onset == 0.0
        assert pitch == 60.0

    def test_vibrato_stays_one_note(self):
        # Oscillating +/-0.4 semitone around 60 stays a single note.
        midis = [60 + (0.4 if i % 2 else -0.4) for i in range(20)]
        f0, t, v, p = self._frames(midis)
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 1

    def test_pitch_change_splits(self):
        midis = [60] * 10 + [64] * 10
        f0, t, v, p = self._frames(midis)
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 2
        assert ev[0][2] == 60.0
        assert ev[1][2] == 64.0

    def test_single_frame_dropout_merges(self):
        midis = [60] * 10 + [60] * 10
        voiced = [True] * 10 + [False] + [True] * 9
        f0, t, v, p = self._frames(midis, voiced=voiced)
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 1
        # The merged gap frame borrows the neighbour pitch (bend ~0).
        assert ev[0][4][10] == 8192

    def test_nan_probabilities_ignored(self):
        f0, t, v, p = self._frames([60] * 10)
        p[3] = float("nan")
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 1
        assert abs(ev[0][3] - 0.9) < 1e-9

    def test_short_run_dropped(self):
        f0, t, v, p = self._frames([60] * 3)  # 30ms < 70ms default
        ev = frames_to_note_events(f0, t, v, p)
        assert ev == []

    def test_bends_capture_deviation(self):
        midis = [60.0] * 10 + [60.5] * 10
        f0, t, v, p = self._frames(midis)
        ev = frames_to_note_events(f0, t, v, p)
        assert len(ev) == 1
        bends = ev[0][4]
        # The run quantizes to 60 (banker's rounding of the 60.5
        # median); the second half sits ~+0.5 st above the note pitch.
        assert ev[0][2] == 60.0
        assert bends[-1] > 8192

    def test_empty_input(self):
        assert frames_to_note_events([], [], [], []) == []

    def test_unvoiced_only(self):
        f0, t, v, p = self._frames([60] * 10, voiced=[False] * 10)
        assert frames_to_note_events(f0, t, v, p) == []

    def test_onset_splits_same_pitch_run(self):
        # #180: re-articulated notes — an onset mid-run with a prob
        # dip splits one glued run into two notes.
        f0, t, v, p = self._frames([60] * 40)
        p[20] = 0.3  # voiced-prob dip at the attack
        ev = frames_to_note_events(f0, t, v, p, onset_sec=[0.2])
        assert len(ev) == 2
        assert ev[0][1] == 0.2  # first note ends at the split frame
        assert ev[1][0] == 0.2

    def test_onset_without_prob_dip_does_not_split(self):
        # A solidly voiced frame at the onset = accent inside a held
        # note (consonant, accompaniment peak) — keep it one note.
        f0, t, v, p = self._frames([60] * 40)
        ev = frames_to_note_events(f0, t, v, p, onset_sec=[0.2])
        assert len(ev) == 1

    def test_onset_too_close_to_edges_ignored(self):
        f0, t, v, p = self._frames([60] * 40)
        p[3] = 0.3
        # 30ms in — the left piece would be shorter than min_note_sec.
        ev = frames_to_note_events(f0, t, v, p, onset_sec=[0.03])
        assert len(ev) == 1

    def test_onset_outside_run_ignored(self):
        f0, t, v, p = self._frames([60] * 40)
        ev = frames_to_note_events(f0, t, v, p, onset_sec=[2.0])
        assert len(ev) == 1


class TestLeadVoiceDecoder:
    """#421: Viterbi pitch-track decoder (decoder="lead").

    The same frames go through frames_to_note_events — only the
    segmentation stage differs. These fixtures encode the J-POP vocal
    failure modes the run-grouper gets wrong.
    """

    def _frames(self, midis, voiced=None, dt=0.01):
        n = len(midis)
        f0 = [440.0 * (2 ** ((m - 69) / 12)) for m in midis]
        times = [i * dt for i in range(n)]
        voiced = ([True] * n) if voiced is None else voiced
        prob = [0.9] * n
        for i in range(n):
            if not voiced[i]:
                f0[i] = float("nan")
        return f0, times, voiced, prob

    def _decode(self, midis, voiced=None, **kw):
        f0, t, v, p = self._frames(midis, voiced=voiced)
        return frames_to_note_events(f0, t, v, p, decoder="lead", **kw)

    def test_single_run_one_note(self):
        ev = self._decode([60] * 20)
        assert len(ev) == 1
        assert ev[0][2] == 60.0

    def test_strong_vibrato_stays_one_note(self):
        # +-0.6 st vibrato flips the rounded pitch on the run-grouper
        # (0.6 rounds to 61) — the DP keeps riding the centre state.
        midis = [60 + (0.6 if i % 2 else -0.6) for i in range(30)]
        ev = self._decode(midis)
        assert len(ev) == 1
        assert ev[0][2] == 60.0

    def test_real_pitch_change_still_splits(self):
        # 20 frames at 60 then 20 at 64 — a genuine step must split.
        ev = self._decode([60] * 20 + [64] * 20)
        assert len(ev) == 2
        assert ev[0][2] == 60.0
        assert ev[1][2] == 64.0

    def test_boundary_lands_at_the_f0_step(self):
        # The run-grouper splits where round() flips; the DP picks the
        # cost-optimal boundary — which for an instant step IS the step.
        midis = [60.0] * 10 + [62.0] * 10
        ev = self._decode(midis)
        assert len(ev) == 2
        assert ev[0][1] == pytest.approx(0.10)  # ends at the step frame
        assert ev[1][0] == pytest.approx(0.10)

    def test_short_blip_between_notes_is_absorbed(self):
        # A 2-frame dip to a neighbouring pitch (vibrato overshoot /
        # passing consonant) cannot pay the jump cost twice.
        midis = [60] * 15 + [61, 61] + [60] * 15
        ev = self._decode(midis)
        assert len(ev) == 1
        assert ev[0][2] == 60.0

    def test_portamento_glue_vs_step(self):
        # Slow portamento ramp 60 -> 62 over 8 frames then holds: the DP
        # still lands one boundary — it just picks the cheapest frame.
        midis = (
            [60.0] * 10
            + [60.25, 60.5, 60.75, 61.0, 61.25, 61.5, 61.75, 62.0]
            + [62.0] * 10
        )
        ev = self._decode(midis)
        assert len(ev) == 2
        assert ev[0][2] == 60.0
        assert ev[1][2] == 62.0

    def test_single_frame_dropout_bridges(self):
        midis = [60] * 10 + [60] * 9
        voiced = [True] * 10 + [False] + [True] * 9
        ev = self._decode(midis, voiced=voiced)
        assert len(ev) == 1

    def test_unvoiced_gap_splits_phrases(self):
        # A real breath (>1 unvoiced frame) is a hard boundary — never
        # bridged even when both sides share a pitch.
        midis = [60] * 10 + [60] * 10
        voiced = [True] * 10 + [False, False, False] + [True] * 10
        ev = self._decode(midis, voiced=voiced)
        assert len(ev) == 2

    def test_onset_split_still_applies(self):
        # The shared onset-split pass runs after decoding — same-pitch
        # re-articulation with a prob dip still produces two notes.
        f0, t, v, p = self._frames([60] * 40)
        p[20] = 0.3
        ev = frames_to_note_events(
            f0, t, v, p, decoder="lead", onset_sec=[0.2]
        )
        assert len(ev) == 2

    def test_short_segments_dropped(self):
        ev = self._decode([60] * 3)
        assert ev == []

    def test_empty_and_unvoiced(self):
        f0, t, v, p = self._frames([], voiced=[])
        assert frames_to_note_events(f0, t, v, p, decoder="lead") == []
        f0, t, v, p = self._frames([60] * 10, voiced=[False] * 10)
        assert frames_to_note_events(f0, t, v, p, decoder="lead") == []

    def test_unknown_decoder_rejected(self):
        f0, t, v, p = self._frames([60] * 10)
        with pytest.raises(ValueError):
            frames_to_note_events(f0, t, v, p, decoder="bogus")


def _ev(i: int, pitch: float, onset: float, offset: float) -> RawNoteEvent:
    return RawNoteEvent(
        id=RawNoteEventId(f"rne-{i:06d}"),
        transcription_revision=TranscriptionRevisionId("tr-000001"),
        pitch_midi=float(pitch),
        onset_sec=onset,
        offset_sec=offset,
        confidence=0.5,
        velocity=64,
        source="test",
    )


class TestAdmitRescueEvents:
    """#165: the sensitive second pass may only fill spans the
    production pass left empty — at any pitch."""

    def test_empty_span_candidate_admitted(self):
        base = (_ev(1, 72.0, 0.0, 0.5), _ev(2, 74.0, 1.5, 2.0))
        extra = (_ev(3, 79.0, 0.7, 1.2),)
        assert admit_rescue_events(base, extra) == extra

    def test_overlapping_candidate_rejected(self):
        base = (_ev(1, 72.0, 0.0, 0.5),)
        # Same span, different pitch — the louder evidence already
        # arbitrated this span; the ghost must not re-open it.
        extra = (_ev(2, 79.0, 0.1, 0.45),)
        assert admit_rescue_events(base, extra) == ()

    def test_edge_touch_within_tolerance_admitted(self):
        base = (_ev(1, 72.0, 0.0, 0.5),)
        # <=30 ms overlap is a boundary kiss, not coverage — a
        # candidate starting at the base event's release survives.
        extra = (_ev(2, 79.0, 0.48, 1.0),)
        assert admit_rescue_events(base, extra) == extra

    def test_no_base_means_everything_admitted(self):
        extra = (_ev(1, 79.0, 0.0, 0.4), _ev(2, 76.0, 0.6, 1.0))
        assert admit_rescue_events((), extra) == extra


class TestLeadTrackAgreement:
    """#165: time-weighted same-line agreement for the backend gate."""

    def test_identical_tracks_agree_fully(self):
        line = (_ev(1, 72.0, 0.0, 1.0), _ev(2, 74.0, 1.0, 2.0))
        tracker = (_ev(3, 72.0, 0.0, 1.0), _ev(4, 74.0, 1.0, 2.0))
        assert lead_track_agreement(line, tracker) == 1.0

    def test_different_line_scores_zero(self):
        # Tracker followed the bass — no same-pitch overlap at all.
        line = (_ev(1, 76.0, 0.0, 1.0), _ev(2, 79.0, 1.0, 2.0))
        tracker = (_ev(3, 40.0, 0.0, 1.0), _ev(4, 43.0, 1.0, 2.0))
        assert lead_track_agreement(line, tracker) == 0.0

    def test_octave_off_does_not_count(self):
        # A tracker an octave low followed a DIFFERENT line (the bass
        # shares pitch classes with the lead it accompanies) — octave
        # agreement must not pass the gate.
        line = (_ev(1, 76.0, 0.0, 1.0), _ev(2, 79.0, 1.0, 2.0))
        tracker = (_ev(3, 64.0, 0.0, 1.0), _ev(4, 79.0, 1.0, 2.0))
        assert lead_track_agreement(line, tracker) == 0.5

    def test_partial_overlap_weights_time(self):
        line = (_ev(1, 76.0, 0.0, 1.0),)
        # Tracker agrees on 0.5s of its 2s span -> 0.25.
        tracker = (_ev(2, 76.0, 0.5, 1.0), _ev(3, 40.0, 1.0, 2.5))
        assert lead_track_agreement(line, tracker) == pytest.approx(0.25)

    def test_empty_tracker_scores_zero(self):
        line = (_ev(1, 76.0, 0.0, 1.0),)
        assert lead_track_agreement(line, ()) == 0.0

    def test_vibrato_semitone_drift_still_agrees(self):
        line = (_ev(1, 76.0, 0.0, 1.0),)
        tracker = (_ev(2, 77.0, 0.0, 1.0),)
        assert lead_track_agreement(line, tracker) == 1.0
