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

    def fake_demucs(path, start, end):
        calls.append("demucs")
        return np.zeros(22050, dtype=np.float32)

    def fake_center(path, start, end):
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
        vocal_mod, "isolate_demucs_vocals", lambda *a: None
    )
    monkeypatch.setattr(
        vocal_mod,
        "isolate_center_vocals",
        lambda *a: np.zeros(22050, dtype=np.float32),
    )

    path, reason, managed, method, _ver = vocal_wav("a.wav", "h", 0.0, None, 22050)
    assert method == "center_extraction"
    assert reason == "applied"
    # The fallback result is keyed as center_extraction — a later run
    # where demucs works recomputes instead of reusing the weaker stem.
    assert vocal_mod._cache_key("a.wav", "h", 0.0, None, "demucs") != (
        vocal_mod._cache_key("a.wav", "h", 0.0, None, "center_extraction")
    )


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
