"""#187: center-extraction vocal isolation — unit + cache contract."""

from __future__ import annotations

import wave
from array import array

import numpy as np
import pytest

from hornscribe.transcription.options import TranscriptionParams

# librosa is an engine extra — absent in the dev/CI install, so the
# audio tests importorskip individually while the options contract
# still runs. vocal.py itself imports librosa lazily, so the module
# import below is safe everywhere.
from hornscribe.transcription.vocal import (
    isolate_center_vocals,
    vocal_wav,
)


def _write_stereo_wav(path, left, right, rate: int = 22050) -> str:
    """Interleaved PCM16 stereo WAV at the given path."""
    inter = np.empty(left.size + right.size, dtype=np.float32)
    inter[0::2] = left
    inter[1::2] = right
    pcm = array(
        "h",
        (int(round(float(v) * 32767.0)) for v in inter),
    )
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm.tobytes())
    return str(path)


def _tone(freq: float, seconds: float, rate: int = 22050, amp=0.5):
    t = np.arange(int(seconds * rate), dtype=np.float32) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def test_center_signal_survives_side_is_suppressed(tmp_path):
    pytest.importorskip("librosa")
    # A center-panned vocal keeps its energy; a hard-panned
    # accompaniment line is attenuated by the mask.
    rate = 22050
    vocal = _tone(440.0, 2.0, rate)
    accomp = _tone(220.0, 2.0, rate)
    left = vocal + accomp
    right = vocal - accomp
    src = _write_stereo_wav(tmp_path / "mix.wav", left, right, rate)

    out = isolate_center_vocals(src)
    assert out is not None
    out = np.asarray(out)
    # Spectral check: the 440 Hz center tone dominates, the 220 Hz
    # side tone is largely cancelled.
    spec = np.abs(np.fft.rfft(out))
    freqs = np.fft.rfftfreq(out.size, 1 / rate)
    e_vocal = spec[np.argmin(np.abs(freqs - 440))]
    e_accomp = spec[np.argmin(np.abs(freqs - 220))]
    assert e_vocal > 5 * e_accomp


def test_mono_source_returns_none(tmp_path):
    pytest.importorskip("librosa")
    mono = _tone(330.0, 1.0)
    src = _write_stereo_wav(tmp_path / "mono.wav", mono, mono)
    # Identical channels decode as stereo with zero side — the mask
    # is a no-op there, so isolation still applies.
    out = isolate_center_vocals(src)
    assert out is not None

    # A true mono file (1 channel) has nothing to cancel.
    pcm = array(
        "h",
        (int(round(float(v) * 32767.0)) for v in mono),
    )
    mono_path = tmp_path / "true-mono.wav"
    with wave.open(str(mono_path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(pcm.tobytes())
    assert isolate_center_vocals(str(mono_path)) is None


def test_vocal_wav_cache_and_reason(tmp_path, monkeypatch):
    pytest.importorskip("librosa")
    # vocal_wav memoizes per (source, span) and reports the
    # mono/unavailable reasons distinctly.
    vocal = _tone(440.0, 1.5)
    accomp = _tone(220.0, 1.5)
    src = _write_stereo_wav(tmp_path / "mix.wav", vocal + accomp, vocal - accomp)

    # Redirect the cache dir into tmp_path so the test is hermetic.
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))

    path, reason, managed, method, _ver = vocal_wav(src, "hash1", 0.0, None, 22050)
    assert reason == "applied"
    assert managed is True
    assert method == "center_extraction"
    assert path is not None and path.endswith(".wav")
    # Second call hits the cache — same path, no recompute.
    path2, reason2, _, _, _ = vocal_wav(src, "hash1", 0.0, None, 22050)
    assert reason2 == "applied"
    assert path2 == path


def test_vocal_wav_prefers_demucs_when_available(tmp_path, monkeypatch):
    """#302: an installed demucs wins over center extraction.

    No torch in CI — the availability probe and both isolators are
    stubbed so only the dispatch order is under test.
    """
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
    monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)
    calls: list[str] = []

    def fake_demucs(path, start, end, **_kw):
        calls.append("demucs")
        return np.zeros(22050, dtype=np.float32)

    def fake_center(path, start, end, **_kw):
        calls.append("center")
        return np.zeros(22050, dtype=np.float32)

    monkeypatch.setattr(vocal_mod, "isolate_demucs_vocals", fake_demucs)
    monkeypatch.setattr(vocal_mod, "isolate_center_vocals", fake_center)

    path, reason, managed, method, _ver = vocal_wav("a.wav", "h", 0.0, None, 22050)
    assert calls == ["demucs"]  # center never ran
    assert method == "demucs"
    assert reason == "applied" and managed is True


def test_vocal_wav_falls_back_to_center_on_demucs_failure(
    tmp_path, monkeypatch
):
    """#302: a demucs failure degrades to center extraction — and the
    cache records the method that actually produced the audio."""
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
    monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)
    monkeypatch.setattr(
        vocal_mod, "isolate_demucs_vocals", lambda *a, **k: None
    )
    monkeypatch.setattr(
        vocal_mod,
        "isolate_center_vocals",
        lambda *a, **k: np.zeros(22050, dtype=np.float32),
    )

    path, reason, managed, method, _ver = vocal_wav("a.wav", "h", 0.0, None, 22050)
    assert method == "center_extraction"
    assert reason == "applied"
    # The fallback result is keyed as center_extraction — a later run
    # where demucs works recomputes instead of reusing the weaker stem.
    assert vocal_mod._cache_key("a.wav", "h", 0.0, None, "demucs") != (
        vocal_mod._cache_key("a.wav", "h", 0.0, None, "center_extraction")
    )


def test_vocal_wav_rejects_silent_demucs_stem(tmp_path, monkeypatch):
    """#169: a near-silent demucs stem (model found no voice) falls
    back to center extraction — and the verdict is memoized so a
    repeat job skips demucs entirely."""
    pytest.importorskip("librosa")
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
    monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)

    lead = _tone(440.0, 1.5)
    accomp = _tone(220.0, 1.5)
    src = _write_stereo_wav(tmp_path / "mix.wav", lead + accomp, lead - accomp)

    calls: list[str] = []
    monkeypatch.setattr(
        vocal_mod,
        "isolate_demucs_vocals",
        lambda *a, **k: calls.append("demucs")
        or np.zeros(22050, dtype=np.float32),
    )
    monkeypatch.setattr(
        vocal_mod,
        "isolate_center_vocals",
        lambda *a, **k: calls.append("center") or _tone(440.0, 1.0),
    )

    _p, reason, _m, method, _v = vocal_wav(src, "h", 0.0, None, 22050)
    assert calls == ["demucs", "center"]
    assert method == "center_extraction"
    assert reason == "applied"

    # The rejection marker + center cache make a repeat call free —
    # no demucs re-run, no STFT.
    calls.clear()
    _p2, _r2, _m2, method2, _v2 = vocal_wav(src, "h", 0.0, None, 22050)
    assert calls == []
    assert method2 == "center_extraction"


def test_vocal_wav_rejects_cached_silent_demucs_stem(
    tmp_path, monkeypatch
):
    """#169: a silent stem already in the cache is re-verified
    against the source instead of being served for the TTL."""
    pytest.importorskip("librosa")
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
    monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)

    src = _write_stereo_wav(
        tmp_path / "mix.wav", _tone(440.0, 1.5), _tone(330.0, 1.5)
    )
    # Pre-seed the demucs cache slot with a silent stem — the shape a
    # pre-fix run would have left behind.
    key = vocal_mod._cache_key(src, "h", 0.0, None, "demucs")
    silent = cache_dir / f"{vocal_mod._CACHE_PREFIX}{key}.wav"
    assert vocal_mod._write_mono_wav(
        str(silent), np.zeros(22050, dtype=np.float32), 22050
    )

    calls: list[str] = []
    monkeypatch.setattr(
        vocal_mod,
        "isolate_demucs_vocals",
        lambda *a, **k: calls.append("demucs") or _tone(440.0, 1.0),
    )
    monkeypatch.setattr(
        vocal_mod,
        "isolate_center_vocals",
        lambda *a, **k: calls.append("center") or _tone(440.0, 1.0),
    )

    _p, reason, _m, method, _v = vocal_wav(src, "h", 0.0, None, 22050)
    # The cached stem was judged silent — demucs never re-ran, and
    # center extraction took over.
    assert calls == ["center"]
    assert method == "center_extraction"
    assert reason == "applied"

    calls.clear()
    _p2, _r2, _m2, method2, _v2 = vocal_wav(src, "h", 0.0, None, 22050)
    assert calls == []
    assert method2 == "center_extraction"


def test_vocal_wav_keeps_audible_demucs_stem(tmp_path, monkeypatch):
    """#169: an audible demucs stem is kept — the gate rejects only
    near-silence, never a real (if odd) separation."""
    import hornscribe.transcription.vocal as vocal_mod

    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
    monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)

    calls: list[str] = []
    monkeypatch.setattr(
        vocal_mod,
        "isolate_demucs_vocals",
        lambda *a, **k: calls.append("demucs") or _tone(440.0, 1.0),
    )
    monkeypatch.setattr(
        vocal_mod,
        "isolate_center_vocals",
        lambda *a, **k: calls.append("center") or _tone(220.0, 1.0),
    )

    _p, reason, _m, method, _v = vocal_wav("a.wav", "h", 0.0, None, 22050)
    assert calls == ["demucs"]  # center never ran
    assert method == "demucs"
    assert reason == "applied"


class TestSilentStemGate:
    """#169: _demucs_stem_silent boundary behaviour."""

    def test_silent_stem_under_audible_source_rejected(self, tmp_path):
        pytest.importorskip("librosa")
        from hornscribe.transcription.vocal import _demucs_stem_silent

        src = _write_stereo_wav(
            tmp_path / "s.wav", _tone(440.0, 1.0), _tone(330.0, 1.0)
        )
        assert _demucs_stem_silent(0.0005, src, 0.0, None) is True

    def test_audible_stem_never_decodes_source(self):
        from hornscribe.transcription.vocal import _demucs_stem_silent

        # Above the absolute floor — returns before touching the
        # (nonexistent) source.
        assert _demucs_stem_silent(0.05, "missing.wav", 0.0, None) is False

    def test_undecodable_source_keeps_stem(self):
        pytest.importorskip("librosa")
        from hornscribe.transcription.vocal import _demucs_stem_silent

        # Cannot judge without the source — conservative keep.
        assert (
            _demucs_stem_silent(0.0001, "missing.wav", 0.0, None) is False
        )

    def test_quiet_source_keeps_comparable_stem(self, tmp_path):
        pytest.importorskip("librosa")
        from hornscribe.transcription.vocal import _demucs_stem_silent

        quiet = _tone(440.0, 1.0, amp=0.01)
        src = _write_stereo_wav(tmp_path / "q.wav", quiet, quiet * 0.5)
        # Stem ~35% of a quiet source's RMS — residue it is not.
        assert _demucs_stem_silent(0.0025, src, 0.0, None) is False


def test_vocal_isolation_option_parses_and_echoes():
    params = TranscriptionParams.from_payload(
        {"audioPath": "a.wav", "vocalIsolation": True},
    )
    assert params.vocal_isolation is True
    assert params.settings_dict()["vocalIsolation"] is True
    # Default off — the option is opt-in.
    default = TranscriptionParams.from_payload({"audioPath": "a.wav"})
    assert default.vocal_isolation is False
    assert default.settings_dict()["vocalIsolation"] is False


def test_vocal_isolation_quality_parses_and_echoes():
    """#181: the demucs tier is a whitelisted option — "standard" is
    the engine default and an unknown value is rejected like every
    other whitelisted param."""
    params = TranscriptionParams.from_payload(
        {
            "audioPath": "a.wav",
            "vocalIsolation": True,
            "vocalIsolationQuality": "precision",
        },
    )
    assert params.vocal_isolation_quality == "precision"
    assert params.settings_dict()["vocalIsolationQuality"] == "precision"

    # Absent -> standard; an unrecognized tier degrades to standard.
    default = TranscriptionParams.from_payload({"audioPath": "a.wav"})
    assert default.vocal_isolation_quality == "standard"
    assert default.settings_dict()["vocalIsolationQuality"] == "standard"
    with pytest.raises(ValueError, match="vocalIsolationQuality"):
        TranscriptionParams.from_payload(
            {"audioPath": "a.wav", "vocalIsolationQuality": "ultra"}
        )


class TestSeparationQuality:
    """#181: the demucs tier pins model+shifts per call, keys its own
    cache slot, and tags the provenance — a quality change never
    reuses another model's stem or identity."""

    def _stub_isolation(self, monkeypatch, tmp_path):
        import hornscribe.transcription.vocal as vocal_mod

        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        monkeypatch.setattr(vocal_mod, "_cache_dir", lambda: str(cache_dir))
        monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)
        return vocal_mod

    def test_tier_pins_model_and_shifts(self, tmp_path, monkeypatch):
        vocal_mod = self._stub_isolation(monkeypatch, tmp_path)
        calls: list[dict] = []

        def fake_demucs(path, start, end, model, shifts):
            calls.append({"model": model, "shifts": shifts})
            return _tone(440.0, 1.0)

        monkeypatch.setattr(
            vocal_mod, "isolate_demucs_vocals", fake_demucs
        )

        vocal_wav("a.wav", "h-std", 0.0, None, 22050)
        vocal_wav("b.wav", "h-std2", 0.0, None, 22050)  # distinct hash
        vocal_wav(
            "a.wav", "h-pre", 0.0, None, 22050, quality="precision"
        )

        assert calls == [
            {"model": "htdemucs", "shifts": 1},
            {"model": "htdemucs", "shifts": 1},
            {"model": "htdemucs_ft", "shifts": 2},
        ]

    def test_unknown_tier_degrades_to_standard_pins(
        self, tmp_path, monkeypatch
    ):
        """A caller-side quality the table doesn't know still runs —
        the engine's strict whitelist lives in options.py; vocal_wav
        degrades gracefully on direct calls."""
        vocal_mod = self._stub_isolation(monkeypatch, tmp_path)
        calls: list[dict] = []
        monkeypatch.setattr(
            vocal_mod,
            "isolate_demucs_vocals",
            lambda path, start, end, model, shifts: (
                calls.append({"model": model, "shifts": shifts})
                or _tone(440.0, 1.0)
            ),
        )

        vocal_wav("a.wav", "h-unk", 0.0, None, 22050, quality="ultra")
        assert calls == [{"model": "htdemucs", "shifts": 1}]

    def test_tiers_never_share_a_cache_slot(self, tmp_path, monkeypatch):
        """A cached standard stem must not satisfy a precision request
        — the variant is part of the key."""
        vocal_mod = self._stub_isolation(monkeypatch, tmp_path)
        calls: list[str] = []
        monkeypatch.setattr(
            vocal_mod,
            "isolate_demucs_vocals",
            lambda *a, **k: calls.append("demucs") or _tone(440.0, 1.0),
        )

        vocal_wav("a.wav", "h", 0.0, None, 22050)
        vocal_wav("a.wav", "h", 0.0, None, 22050)  # cache hit
        vocal_wav("a.wav", "h", 0.0, None, 22050, quality="precision")
        assert calls == ["demucs", "demucs"]  # precision re-ran

        # The key contract: same source/span, different tier -> a
        # different slot; center extraction has no tier identity.
        std = vocal_mod._cache_key("a.wav", "h", 0.0, None, "demucs", "")
        pre = vocal_mod._cache_key(
            "a.wav", "h", 0.0, None, "demucs", "htdemucs_ft-s2"
        )
        center = vocal_mod._cache_key(
            "a.wav", "h", 0.0, None, "center_extraction", ""
        )
        assert std != pre != center

    def test_variant_tags_the_provenance(self, monkeypatch):
        import hornscribe.transcription.vocal as vocal_mod

        monkeypatch.setattr(
            vocal_mod, "_demucs_version", lambda: "4.0.1"
        )
        # Standard keeps the bare version — existing provenance is
        # unchanged for the unchanged tier.
        assert vocal_mod.method_version("demucs") == "4.0.1"
        assert vocal_mod.method_version("demucs", "") == "4.0.1"
        assert (
            vocal_mod.method_version("demucs", "htdemucs_ft-s2")
            == "4.0.1:htdemucs_ft-s2"
        )
        # Center extraction never wears a demucs variant.
        assert (
            vocal_mod.method_version("center_extraction", "htdemucs_ft-s2")
            == "1"
        )

    def test_center_tier_is_quality_independent(
        self, tmp_path, monkeypatch
    ):
        """Without demucs the tier must not split the cache — a
        center stem is identical audio under any quality value."""
        vocal_mod = self._stub_isolation(monkeypatch, tmp_path)
        monkeypatch.setattr(
            vocal_mod, "_demucs_available", lambda: False
        )
        monkeypatch.setattr(
            vocal_mod,
            "isolate_center_vocals",
            lambda *a, **k: np.zeros(22050, dtype=np.float32),
        )

        _p, _r, _m, method, ver = vocal_wav("a.wav", "h", 0.0, None, 22050)
        assert method == "center_extraction"
        assert ver == "1"  # untagged — no demucs ran
        p2, _r2, _m2, _mth2, _v2 = vocal_wav(
            "a.wav", "h", 0.0, None, 22050, quality="precision"
        )
        assert p2 == _p  # precision hits the standard center slot


class TestDemucsQualityCli:
    """#181: the tier reaches the demucs CLI as explicit -n/--shifts —
    the model is pinned on every invocation so a demucs default change
    never shifts output under an unchanged tier."""

    def _run(self, monkeypatch, quality):
        import importlib.machinery
        import sys
        import types

        import hornscribe.transcription.vocal as vocal_mod

        monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)
        monkeypatch.setattr(vocal_mod, "_demucs_cmd", lambda: ("demucs",))
        stub = types.ModuleType("librosa")
        stub.__spec__ = importlib.machinery.ModuleSpec("librosa", None)
        monkeypatch.setitem(sys.modules, "librosa", stub)
        monkeypatch.setattr(vocal_mod, "require_module", lambda _n: None)
        seen_cmd: list[list[str]] = []

        class _Proc:
            returncode = 1  # fail fast — the dispatch is under test

        def fake_run(cmd, **kw):
            seen_cmd.append(cmd)
            return _Proc()

        monkeypatch.setattr(vocal_mod.subprocess, "run", fake_run)
        model, shifts = vocal_mod._SEPARATION_QUALITIES[quality]
        vocal_mod.isolate_demucs_vocals(
            "src.wav", 0.0, None, model=model, shifts=shifts
        )
        return seen_cmd

    def test_standard_pins_htdemucs_without_shifts(self, monkeypatch):
        (cmd,) = self._run(monkeypatch, "standard")
        assert cmd[:3] == ["demucs", "-n", "htdemucs"]
        assert "--shifts" not in cmd  # default invocation unchanged

    def test_precision_pins_ft_and_shift_averaging(self, monkeypatch):
        (cmd,) = self._run(monkeypatch, "precision")
        assert cmd[:3] == ["demucs", "-n", "htdemucs_ft"]
        assert cmd[cmd.index("--shifts") + 1] == "2"


class TestDemucsSpanStaging:
    """#320: a selection job hands demucs only the chosen span — the
    whole-file separation the #229 performance budget forbids is gone."""

    def _run(self, monkeypatch, start, end):
        import hornscribe.transcription.vocal as vocal_mod

        monkeypatch.setattr(vocal_mod, "_demucs_available", lambda: True)
        monkeypatch.setattr(
            vocal_mod, "_demucs_cmd", lambda: ("demucs",)
        )
        # librosa is an engine extra — absent in dev/CI — but the
        # dispatch under test never reaches it (staging + run are
        # stubbed, run fails before the decode). A bare module stub
        # satisfies require_module/find_spec.
        import importlib.machinery
        import sys
        import types

        stub = types.ModuleType("librosa")
        stub.__spec__ = importlib.machinery.ModuleSpec("librosa", None)
        monkeypatch.setitem(sys.modules, "librosa", stub)
        monkeypatch.setattr(vocal_mod, "require_module", lambda _n: None)
        staged: list[tuple[str, float, float | None]] = []
        seen_cmd: list[list[str]] = []

        def fake_stage(path, s, e):
            staged.append((path, s, e))
            return "STAGED.wav"

        class _Proc:
            returncode = 1  # fail fast — the dispatch is under test

        def fake_run(cmd, **kw):
            seen_cmd.append(cmd)
            return _Proc()

        monkeypatch.setattr(vocal_mod, "_stage_span_wav", fake_stage)
        monkeypatch.setattr(vocal_mod.subprocess, "run", fake_run)
        return staged, seen_cmd, vocal_mod.isolate_demucs_vocals(
            "src.wav", start, end
        )

    def test_selection_stages_the_span(self, monkeypatch):
        staged, seen_cmd, out = self._run(monkeypatch, 60.0, 90.0)
        # The span was decoded+staged and demucs read the staged slice,
        # never the source file.
        assert staged == [("src.wav", 60.0, 90.0)]
        assert seen_cmd and seen_cmd[0][-1] == "STAGED.wav"
        assert out is None  # stubbed failure — dispatch is what matters

    def test_full_range_passes_the_source_through(self, monkeypatch):
        staged, seen_cmd, _ = self._run(monkeypatch, 0.0, None)
        assert staged == []  # no staging for a whole-file job
        assert seen_cmd and seen_cmd[0][-1] == "src.wav"


class TestIsolationProvenance:
    """#319: the transcription revision must name the preprocess that
    actually ran — method AND version — so the same settings on two
    installs never share a tr-* identity over different input audio."""

    def test_method_version_tracks_the_method(self, monkeypatch):
        import hornscribe.transcription.vocal as vocal_mod

        monkeypatch.setattr(
            vocal_mod, "_demucs_version", lambda: "4.0.1"
        )
        assert vocal_mod.method_version("demucs") == "4.0.1"
        assert vocal_mod.method_version("center_extraction") == "1"
        assert vocal_mod.method_version(None) is None
        # A missing demucs version still names the method honestly.
        monkeypatch.setattr(vocal_mod, "_demucs_version", lambda: None)
        assert vocal_mod.method_version("demucs") == "unknown"

    def test_revision_distinguishes_methods_and_fallback(self):
        from hornscribe.transcription.backend import (
            new_transcription_revision,
        )

        base = dict(
            audio_hash="h",
            settings={"vocalIsolation": True},
            backend_id="pyin",
            backend_version="1.0",
        )
        demucs = new_transcription_revision(
            **base,
            preprocess={
                "vocalIsolation": True,
                "method": "demucs",
                "methodVersion": "4.0.1",
            },
        )
        center = new_transcription_revision(
            **base,
            preprocess={
                "vocalIsolation": True,
                "method": "center_extraction",
                "methodVersion": "1",
            },
        )
        fallback = new_transcription_revision(
            **base,
            preprocess={
                "vocalIsolation": True,
                "method": "none",
                "methodVersion": None,
                "fallbackReason": "unavailable",
            },
        )
        # demucs != center != raw-fallback — each is a different
        # effective input and must mint its own tr-*.
        assert len({demucs, center, fallback}) == 3
        # A demucs upgrade is a new identity too.
        demucs_new = new_transcription_revision(
            **base,
            preprocess={
                "vocalIsolation": True,
                "method": "demucs",
                "methodVersion": "5.0.0",
            },
        )
        assert demucs_new != demucs
        # No preprocess requested -> identical to the pre-#319 form.
        plain = new_transcription_revision(**base)
        assert plain != demucs


class TestDemucsResolution:
    """#10: demucs must stay reachable in packaged builds — a bundled
    tools/ binary or console script on PATH, or another interpreter,
    never ``sys.executable -m`` when the exe IS the worker itself."""

    @pytest.fixture(autouse=True)
    def _resolver(self, monkeypatch):
        import sys as _sys

        import hornscribe.transcription.vocal as vocal_mod

        monkeypatch.delenv("HORNSCRIBE_DEMUCS", raising=False)
        monkeypatch.delenv("HORNSCRIBE_PYTHON", raising=False)
        monkeypatch.delattr(_sys, "frozen", raising=False)
        monkeypatch.setattr(
            vocal_mod, "_demucs_module_importable", lambda: False
        )
        monkeypatch.setattr(vocal_mod.shutil, "which", lambda _n: None)
        vocal_mod._demucs_cmd.cache_clear()
        yield vocal_mod
        vocal_mod._demucs_cmd.cache_clear()

    def test_env_exe_wins(self, _resolver, tmp_path, monkeypatch):
        exe = tmp_path / "demucs.exe"
        exe.write_bytes(b"x")
        monkeypatch.setenv("HORNSCRIBE_DEMUCS", str(exe))
        # Explicit override beats even an importable module.
        monkeypatch.setattr(
            _resolver, "_demucs_module_importable", lambda: True
        )
        assert _resolver._demucs_cmd() == (str(exe),)

    def test_env_exe_missing_file_never_falls_through(
        self, _resolver, monkeypatch
    ):
        """Same contract as resolve_ffmpeg — a typo'd override must
        report missing, not silently grab another demucs."""
        monkeypatch.setenv("HORNSCRIBE_DEMUCS", r"C:\no\demucs.exe")
        monkeypatch.setattr(
            _resolver, "_demucs_module_importable", lambda: True
        )
        monkeypatch.setattr(
            _resolver.shutil,
            "which",
            lambda n: "C:\\tools\\demucs.exe" if n == "demucs" else None,
        )
        assert _resolver._demucs_cmd() is None

    def test_dev_uses_this_interpreter(self, _resolver, monkeypatch):
        import sys

        monkeypatch.setattr(
            _resolver, "_demucs_module_importable", lambda: True
        )
        assert _resolver._demucs_cmd() == (
            sys.executable,
            "-m",
            "demucs",
        )

    def test_path_console_script(self, _resolver, monkeypatch):
        monkeypatch.setattr(
            _resolver.shutil,
            "which",
            lambda n: "C:\\tools\\demucs.exe" if n == "demucs" else None,
        )
        assert _resolver._demucs_cmd() == ("C:\\tools\\demucs.exe",)

    def test_frozen_never_uses_sys_executable(
        self, _resolver, monkeypatch
    ):
        """The packaged engine's sys.executable is the worker — even
        with the module bundled, `-m demucs` must not run: the spawn
        would start a second worker on the NDJSON pipe."""
        import sys

        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(
            _resolver, "_demucs_module_importable", lambda: True
        )
        assert _resolver._demucs_cmd() is None
        assert _resolver._demucs_available() is False

    def test_frozen_finds_other_python(self, _resolver, monkeypatch):
        """A pip-installed demucs on the user's own python stays
        reachable in packaged builds — free operation, zero config."""
        import sys

        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(
            _resolver.shutil,
            "which",
            lambda n: (
                "C:\\Python312\\python.exe" if n == "python" else None
            ),
        )
        monkeypatch.setattr(
            _resolver, "_python_has_demucs", lambda _p: True
        )
        assert _resolver._demucs_cmd() == (
            "C:\\Python312\\python.exe",
            "-m",
            "demucs",
        )

    def test_nothing_resolves_to_none(self, _resolver):
        assert _resolver._demucs_cmd() is None
        assert _resolver.demucs_available() is False
