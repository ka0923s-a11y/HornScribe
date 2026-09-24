"""Validated ``job.start`` params for the ``transcription`` job kind.

Wire contract (camelCase, additive-optional; see PROTOCOL.md):

* ``audioPath`` (required) — absolute path to the audio file.
* ``tempoBpm`` — manual tempo in primary-beat BPM (4/4: quarter note,
  6/8: dotted quarter). ``None`` -> beat tracking.
 * ``meter`` — ``"auto"`` or ``"N/D"``; the supported set is
  ``4/4, 3/4, 2/4, 5/4, 6/8, 7/8, 9/8, 12/8`` (``meter.py``). ``"auto"``
  estimates from beat-aligned onset accents (``meter.py`` module),
  falling back to 4/4 with a ``meter_conflict`` review issue when
  the evidence is weak; the pick is reported in the result meta.
* ``minDuration`` — finest notated value as a denominator string
  (``"8"``/``"16"``/``"32"`` -> ``Fraction(1, 2)``/``1/4``/``1/8`` ql).
* ``triplets`` — ``"auto"`` | ``"allow"`` | ``"none"`` ->
  :class:`TripletPolicy` AUTO/ALWAYS/NEVER.
* ``simplicity`` — ``"standard"`` | ``"simple"`` | ``"detailed"`` ->
  :class:`QuantizationProfile` factory.
* ``range`` — ``"all"`` | ``"selection"`` with ``selectionStartSec`` /
  ``selectionEndSec`` clipping the accepted note window.
* ``deadlineMs`` — engine-side wall-clock cap, checked between stages
  (same contract as ``demoLongTask``).
* ``backend`` — ``"auto"`` | ``"basicPitch"`` | ``"pyin"``; the
  transcription backend selector from 設定 → 詳細設定 (#108).
  ``"auto"`` resolves to the engine that fits the declared texture —
  pYIN (#175, the monophonic librosa tracker) for a declared-mono
  source, Basic Pitch otherwise. ``"pyin"`` pins the monophonic
  tracker explicitly. The raw selector value is echoed in
  ``meta.settings`` while ``meta.backend`` reports the resolved
  engine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from hornscribe.rhythm.meter import MeterSegment, UnsupportedMeterError
from hornscribe.rhythm.profile import QuantizationProfile, TripletPolicy

_MIN_DURATION_DENOMINATORS = {"8": 2, "16": 4, "32": 8}
"""UI denominator -> min_note_value_ql (8th=1/2 ql, 16th=1/4, 32nd=1/8)."""

_TRIPLET_POLICIES = {
    "auto": TripletPolicy.AUTO,
    "allow": TripletPolicy.ALWAYS,
    "none": TripletPolicy.NEVER,
}

_PROFILES = {
    "standard": QuantizationProfile.standard,
    "simple": QuantizationProfile.simple,
    "detailed": QuantizationProfile.close_to_performance,
}

_SUPPORTED_METERS = {
    "4/4", "3/4", "2/4", "5/4", "6/8", "7/8", "9/8", "12/8",
}

_BACKENDS = {"auto", "basicPitch", "pyin"}

_TEXTURES = {"auto", "mono", "melody", "voices", "chords"}


@dataclass(frozen=True)
class TranscriptionParams:
    """Typed ``transcription`` job params (all fields optional but
    ``audio_path``)."""

    audio_path: str
    tempo_bpm: float | None = None
    """Primary-beat BPM when the user pinned the tempo, else None (auto)."""
    meter: str = "auto"
    min_duration_ql: Fraction = Fraction(1, 4)
    triplet_policy: TripletPolicy = TripletPolicy.AUTO
    profile_kind: str = "standard"
    range_kind: str = "all"
    selection_start_sec: float | None = None
    selection_end_sec: float | None = None
    deadline_ms: float | None = None
    backend: str = "auto"
    texture: str = "auto"
    """Source texture hint: ``mono`` keeps first-come clipping for
    single-instrument sources; ``melody`` keeps the highest voice on
    overlaps and widens the detection band (JPOP/mix melody extraction);
    ``voices`` keeps up to three detected lines as separate score parts;
    ``chords`` keeps the same lines but merges them into one part so
    same-rhythm simultaneities render as in-part chords (#155);
    ``auto`` cleans monophonically first and falls back to top-voice
    when the overlap evidence says the source is a mix."""
    # #187: opt-in vocal isolation — the backend runs on a
    # center-extracted vocal estimate instead of the raw mix.
    vocal_isolation: bool = False
    # #305: the user's file name for the score title. ``audio_path``
    # may point at a staged temp file (browser-dev kind:"file" drops),
    # so the display name travels separately and the title never
    # leaks the ``staged-<ts>-`` scratch name.
    display_name: str | None = None

    @classmethod
    def from_payload(cls, raw: Any) -> TranscriptionParams:
        if not isinstance(raw, dict):
            raise ValueError("params must be an object")
        audio_path = raw.get("audioPath")
        if not isinstance(audio_path, str) or not audio_path.strip():
            raise ValueError(
                "params.audioPath is required (absolute path to the audio file)"
            )
        tempo_bpm = cls._opt_float(raw, "tempoBpm", None, lo=20.0, hi=400.0)
        meter = cls._opt_choice(raw, "meter", "auto", _SUPPORTED_METERS | {"auto"})
        min_dur_raw = cls._opt_choice(
            raw, "minDuration", "16", set(_MIN_DURATION_DENOMINATORS)
        )
        triplets = cls._opt_choice(raw, "triplets", "auto", set(_TRIPLET_POLICIES))
        simplicity = cls._opt_choice(raw, "simplicity", "standard", set(_PROFILES))
        range_kind = cls._opt_choice(raw, "range", "all", {"all", "selection"})
        sel_start = cls._opt_float(
            raw, "selectionStartSec", None, lo=0.0, hi=86400.0
        )
        sel_end = cls._opt_float(raw, "selectionEndSec", None, lo=0.0, hi=86400.0)
        if range_kind == "selection" and (
            sel_start is None or sel_end is None or sel_end <= sel_start
        ):
            raise ValueError(
                "params.selectionStartSec/selectionEndSec are required "
                "(end > start) when range is 'selection'"
            )
        deadline_ms = cls._opt_float(raw, "deadlineMs", None, lo=1.0, hi=3_600_000.0)
        backend = cls._opt_choice(raw, "backend", "auto", _BACKENDS)
        texture = cls._opt_choice(raw, "texture", "auto", _TEXTURES)
        vocal_isolation = raw.get("vocalIsolation", False) is True
        display_name = cls._opt_str(raw, "displayName")
        return cls(
            audio_path=audio_path,
            tempo_bpm=tempo_bpm,
            meter=meter,
            min_duration_ql=Fraction(1, _MIN_DURATION_DENOMINATORS[min_dur_raw]),
            triplet_policy=_TRIPLET_POLICIES[triplets],
            profile_kind=simplicity,
            range_kind=range_kind,
            selection_start_sec=sel_start,
            selection_end_sec=sel_end,
            deadline_ms=deadline_ms,
            backend=backend,
            texture=texture,
            vocal_isolation=vocal_isolation,
            display_name=display_name,
        )

    def meter_segment(self) -> MeterSegment:
        """The single-segment meter map seed (auto -> 4/4 for HSQ-v1)."""
        label = "4/4" if self.meter == "auto" else self.meter
        num_s, den_s = label.split("/")
        try:
            return MeterSegment(
                start_ql=Fraction(0),
                numerator=int(num_s),
                denominator=int(den_s),
            )
        except UnsupportedMeterError as exc:  # pragma: no cover - guarded above
            raise ValueError(str(exc)) from exc

    def quantization_profile(self) -> QuantizationProfile:
        profile = _PROFILES[self.profile_kind]()
        return QuantizationProfile(
            min_note_value_ql=self.min_duration_ql,
            triplet_policy=self.triplet_policy,
            k_best=profile.k_best,
            candidate_window_ql=profile.candidate_window_ql,
            max_alignment_shift_sec=profile.max_alignment_shift_sec,
            triplet_gate_min_relevant_onsets=profile.triplet_gate_min_relevant_onsets,
            triplet_relevance_margin_ql=profile.triplet_relevance_margin_ql,
            sigma_onset_ql=profile.sigma_onset_ql,
            sigma_ioi_ql=profile.sigma_ioi_ql,
            sigma_offset_ql=profile.sigma_offset_ql,
            huber_k=profile.huber_k,
            weights=profile.weights,
        )

    def settings_dict(self) -> dict[str, Any]:
        """JSON-serializable echo of the effective settings (result meta)."""
        return {
            "tempoBpm": self.tempo_bpm,
            "meter": self.meter,
            "minDurationQl": str(self.min_duration_ql),
            "triplets": self.triplet_policy.value,
            "simplicity": self.profile_kind,
            "range": self.range_kind,
            "selectionStartSec": self.selection_start_sec,
            "selectionEndSec": self.selection_end_sec,
            "backend": self.backend,
            "texture": self.texture,
            "vocalIsolation": self.vocal_isolation,
        }

    @staticmethod
    def _opt_choice(
        raw: dict[str, Any], name: str, default: str, choices: set[str]
    ) -> str:
        value = raw.get(name, default)
        if not isinstance(value, str) or value not in choices:
            raise ValueError(
                f"params.{name} must be one of {sorted(choices)}, got {value!r}"
            )
        return value

    @staticmethod
    def _opt_float(
        raw: dict[str, Any], name: str, default: float | None, *, lo: float, hi: float
    ) -> float | None:
        value = raw.get(name, default)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"params.{name} must be a number")
        if not lo <= float(value) <= hi or not math.isfinite(float(value)):
            raise ValueError(f"params.{name} out of range [{lo}, {hi}]")
        return float(value)

    @staticmethod
    def _opt_str(raw: dict[str, Any], name: str) -> str | None:
        """Optional free-text field -> stripped str | None.

        Non-strings and empty/whitespace values collapse to None — a
        display name is a nicety, never a hard requirement. Capped so a
        pathological payload cannot stuff a megabyte into the title.
        """
        value = raw.get(name)
        if not isinstance(value, str):
            return None
        stripped = value.strip()[:255]
        return stripped or None
