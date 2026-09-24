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

    path, reason, managed, method = vocal_wav(src, "hash1", 0.0, None, 22050)
    assert reason == "applied"
    assert managed is True
    assert method == "center_extraction"
    assert path is not None and path.endswith(".wav")
    # Second call hits the cache — same path, no recompute.
    path2, reason2, _, _ = vocal_wav(src, "hash1", 0.0, None, 22050)
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

    path, reason, managed, method = vocal_wav("a.wav", "h", 0.0, None, 22050)
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

    path, reason, managed, method = vocal_wav("a.wav", "h", 0.0, None, 22050)
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
