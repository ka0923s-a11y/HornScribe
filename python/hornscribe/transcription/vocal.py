"""Opt-in vocal-isolation preprocessing stage (#187).

JPOP mixes bury the lead vocal under accompaniment, so a monophonic
tracker or melody-preference cleaner keeps locking onto louder
instruments. Full neural separation (demucs) is the eventual target,
but it ships ~200 MB of torch + model weights — too heavy for the
default engine install. This module implements the free, librosa-only
middle ground the issue names: **center-channel extraction**.

The idea: pop production pans the lead vocal dead center while
stereo-wide instrumentation spreads across the side channel. A soft
spectral mask (mid - side) / (mid + side) keeps bins whose energy is
center-dominant and attenuates the rest — not a true vocal stem, but
a large signal-to-interference win for a monophonic tracker.

Contract:

* isolate_center_vocals returns mono float32 samples at the
  pipeline's fixed 22050 Hz, or None when the source is not
  stereo / cannot be decoded — the caller then falls back to the
  ordinary path and reports the reason.
* vocal_wav memoizes the result per (source, selection) so a
  re-transcription with the same options never re-runs the STFT.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import tempfile
import wave
from array import array
from typing import Any

from .backend import require_module

# STFT geometry: 2048/512 at 22050 Hz — ~93 ms window, ~23 ms hop; the
# standard speech/music separation trade-off point.
_N_FFT = 2048
_HOP = 512
# Power-law exponent for the soft mask; 1.0 is the classic
# ratio-mask. Lower values keep more bleed (safer), higher values
# isolate harder (more artifacts).
_MASK_POWER = 1.0
# Filesystem cache root — system temp dir, one file per (hash, span).
_CACHE_PREFIX = "hornscribe-vocal-"
_CACHE_PREFIX = "hornscribe-vocal-"


def isolate_center_vocals(
    audio_path: str,
    start_sec: float = 0.0,
    end_sec: float | None = None,
) -> Any | None:
    """Center-extract the [start, end) span -> mono float32 | None.

    None means isolation did not apply (mono source, decode failure,
    empty span) — never an exception, so the pipeline can degrade to
    the un-isolated path honestly.
    """
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415
    except Exception:
        return None

    try:
        stereo, sr = librosa.load(audio_path, sr=22050, mono=False)
    except Exception:
        return None
    # librosa returns (n,) mono or (channels, n); a mono file has
    # nothing to cancel — the caller treats that as not applicable.
    if stereo.ndim != 2 or stereo.shape[0] < 2:
        return None
    left = np.asarray(stereo[0], dtype=np.float32)
    right = np.asarray(stereo[1], dtype=np.float32)
    n = left.shape[0]
    i0 = max(0, min(int(start_sec * sr), n))
    i1 = n if end_sec is None else max(i0, min(int(end_sec * sr), n))
    if i1 - i0 < _N_FFT:
        return None
    left = left[i0:i1]
    right = right[i0:i1]

    mid = (left + right) * 0.5
    side = (left - right) * 0.5
    mid_stft = librosa.stft(mid, n_fft=_N_FFT, hop_length=_HOP)
    side_stft = librosa.stft(side, n_fft=_N_FFT, hop_length=_HOP)
    mid_mag = np.abs(mid_stft)
    side_mag = np.abs(side_stft)
    # Soft ratio mask: 1 where energy is fully center, 0 where fully
    # side. Clamp keeps the division stable on silent bins.
    denom = np.maximum(mid_mag + side_mag, 1e-8)
    mask = np.clip((mid_mag - side_mag) / denom, 0.0, 1.0) ** _MASK_POWER
    vocal_stft = mid_stft * mask
    vocal = librosa.istft(vocal_stft, hop_length=_HOP, length=len(mid))
    return np.asarray(vocal, dtype=np.float32)
    return np.asarray(vocal, dtype=np.float32)


def _cache_dir() -> str:
    root = os.path.join(tempfile.gettempdir(), "hornscribe-vocal-cache")
    os.makedirs(root, exist_ok=True)
    return root


def _cache_key(
    audio_path: str,
    content_hash: str | None,
    start_sec: float,
    end_sec: float | None,
) -> str:
    basis = content_hash or f"path:{os.path.abspath(audio_path)}"
    span = f"{start_sec:.3f}-{end_sec if end_sec is not None else 'end'}"
    digest = hashlib.sha256(f"{basis}|{span}".encode()).hexdigest()
    return digest[:32]


def _write_mono_wav(path: str, samples: Any, sample_rate: int) -> bool:
    """PCM16 write mirroring _stage_selection_wav contract."""
    try:
        pcm = array(
            "h",
            (
                max(-32768, min(32767, int(round(float(v) * 32768.0))))
                for v in samples
            ),
        )
        if pcm.itemsize != 2:
            return False
        # tmp+rename so a crashed worker never leaves a torn cache hit.
        tmp = f"{path}.tmp"
        with wave.open(tmp, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm.tobytes())
        os.replace(tmp, path)
        return True
    except (OSError, ValueError, TypeError):
        return False


def vocal_wav(
    audio_path: str,
    content_hash: str | None,
    start_sec: float,
    end_sec: float | None,
    sample_rate: int,
) -> tuple[str | None, str, bool]:
    """Isolated-vocal WAV for the backend -> (path, reason, managed).

    ``reason`` maps to a review issue: "applied" on success,
    "mono_source" for mono input, "unavailable" for decode or
    isolation failures. ``managed`` marks the shared cache file — the
    caller must not delete it; an unmanaged path is a per-job temp.
    A cache hit skips the STFT entirely (contentHash + selection span
    keyed, per the issue's cache note).
    """
    key = _cache_key(audio_path, content_hash, start_sec, end_sec)
    cached = os.path.join(_cache_dir(), f"{_CACHE_PREFIX}{key}.wav")
    if os.path.isfile(cached):
        return cached, "applied", True

    samples = isolate_center_vocals(audio_path, start_sec, end_sec)
    if samples is None:
        # Distinguish nothing-to-isolate from isolation-failed — the
        # review copy reads differently for each.
        try:
            require_module("librosa")
            import librosa  # noqa: PLC0415

            probe, _ = librosa.load(
                audio_path, sr=22050, mono=False, duration=0.1
            )
            mono = probe.ndim != 2 or probe.shape[0] < 2
            reason = "mono_source" if mono else "unavailable"
        except Exception:
            reason = "unavailable"
        return None, reason, False

    if _write_mono_wav(cached, samples, sample_rate):
        return cached, "applied", True
    # Cache write failed (read-only temp) — stage a plain temp file so
    # this job still gets the isolated input.
    fd, tmp = tempfile.mkstemp(prefix="hornscribe-vocal-", suffix=".wav")
    with contextlib.suppress(OSError):
        os.close(fd)
    if _write_mono_wav(tmp, samples, sample_rate):
        return tmp, "applied", False
    with contextlib.suppress(OSError):
        os.unlink(tmp)
    return None, "unavailable", False
