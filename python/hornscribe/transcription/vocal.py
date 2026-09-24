"""Opt-in vocal-isolation preprocessing stage (#187).

JPOP mixes bury the lead vocal under accompaniment, so a monophonic
tracker or melody-preference cleaner keeps locking onto louder
instruments. Two backends are supported, tried in quality order:

* **demucs** (#302) — true neural two-stem separation, used when the
  optional ``engine-vocal`` extra is installed. It ships ~200 MB of
  torch + model weights, so it stays opt-in.
* **center-channel extraction** — the free, librosa-only middle
  ground: pop production pans the lead vocal dead center while
  stereo-wide instrumentation spreads across the side channel, so a
  soft spectral mask (mid - side) / (mid + side) keeps bins whose
  energy is center-dominant and attenuates the rest.

Contract:

* Each isolate_* returns mono float32 samples at the pipeline's
  fixed 22050 Hz, or None when it cannot run — the caller then
  falls back to the next backend or the ordinary path and reports
  the reason.
* vocal_wav memoizes the result per (source, selection, method) so
  a re-transcription with the same options never re-runs the split.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
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
# #299: cache files older than this are swept — the cache is an
# optimization, never data, so a fixed TTL beats an unbounded pile.
_CACHE_TTL_SEC = 7 * 24 * 3600


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
        # Decode only the requested span — a selection job must not
        # pay the whole-file decode the #230 budget forbids.
        stereo, sr = librosa.load(
            audio_path,
            sr=22050,
            mono=False,
            offset=max(0.0, start_sec),
            duration=(
                None if end_sec is None else max(0.0, end_sec - start_sec)
            ),
        )
    except Exception:
        return None
    # librosa returns (n,) mono or (channels, n); a mono file has
    # nothing to cancel — the caller treats that as not applicable.
    if stereo.ndim != 2 or stereo.shape[0] < 2:
        return None
    left = np.asarray(stereo[0], dtype=np.float32)
    right = np.asarray(stereo[1], dtype=np.float32)
    n = left.shape[0]
    # The decode was already span-scoped — the buffer IS the span.
    if n < _N_FFT:
        return None
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


def _cache_dir() -> str:
    root = os.path.join(tempfile.gettempdir(), "hornscribe-vocal-cache")
    os.makedirs(root, exist_ok=True)
    return root


def _demucs_available() -> bool:
    """#302: demucs is an optional heavier engine — probe, never import.

    find_spec avoids paying torch's multi-second import cost on every
    job when demucs is absent (the common case).
    """
    try:
        import importlib.util

        return importlib.util.find_spec("demucs") is not None
    except Exception:
        return False


def isolate_demucs_vocals(
    audio_path: str,
    start_sec: float = 0.0,
    end_sec: float | None = None,
) -> Any | None:
    """#302: neural two-stem separation via the demucs CLI -> mono float32 | None.

    Runs ``python -m demucs --two-stems=vocals`` in a subprocess so a
    torch crash can never take the engine down with it. demucs
    separates the whole file — the returned samples are sliced to the
    requested span afterwards. None on any failure (missing binary,
    non-zero exit, decode error) so the caller falls back to center
    extraction.
    """
    if not _demucs_available():
        return None
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415
    except Exception:
        return None

    out_dir = tempfile.mkdtemp(prefix="hornscribe-demucs-")
    try:
        cmd = [
            sys.executable,
            "-m",
            "demucs",
            "--two-stems=vocals",
            "-o",
            out_dir,
            audio_path,
        ]
        kwargs: dict[str, Any] = {
            "capture_output": True,
            "timeout": 3600,
        }
        if sys.platform == "win32":
            # No console flash when the engine runs under the GUI.
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.run(cmd, **kwargs)  # noqa: S603
        if proc.returncode != 0:
            return None
        vocals_path: str | None = None
        for root, _dirs, files in os.walk(out_dir):
            if "vocals.wav" in files:
                vocals_path = os.path.join(root, "vocals.wav")
                break
        if vocals_path is None:
            return None
        samples, _sr = librosa.load(vocals_path, sr=22050, mono=True)
        lo = int(max(0.0, start_sec) * 22050)
        hi = len(samples) if end_sec is None else int(end_sec * 22050)
        sliced = np.asarray(samples[lo:hi], dtype=np.float32)
        if sliced.size == 0:
            return None
        return sliced
    except Exception:
        return None
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def _sweep_cache(now: float) -> None:
    """#299: drop expired cache files — best-effort, never fatal."""
    try:
        for entry in os.scandir(_cache_dir()):
            if not entry.name.startswith(_CACHE_PREFIX):
                continue
            try:
                if now - entry.stat().st_mtime > _CACHE_TTL_SEC:
                    os.unlink(entry.path)
            except OSError:
                continue
    except OSError:
        return


def _cache_key(
    audio_path: str,
    content_hash: str | None,
    start_sec: float,
    end_sec: float | None,
    method: str,
) -> str:
    basis = content_hash or f"path:{os.path.abspath(audio_path)}"
    span = f"{start_sec:.3f}-{end_sec if end_sec is not None else 'end'}"
    # #302: the method tags the key — a demucs stem and a center
    # extraction of the same span are different audio and must never
    # share a cache slot.
    digest = hashlib.sha256(f"{basis}|{span}|{method}".encode()).hexdigest()
    return digest[:32]


def _method() -> str:
    """Preferred isolation backend for this install — drives lookup."""
    return "demucs" if _demucs_available() else "center_extraction"


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
) -> tuple[str | None, str, bool, str | None]:
    """Isolated-vocal WAV -> (path, reason, managed, method).

    ``reason`` maps to a review issue: "applied" on success,
    "mono_source" for mono input, "unavailable" for decode or
    isolation failures. ``managed`` marks the shared cache file — the
    caller must not delete it; an unmanaged path is a per-job temp.
    A cache hit skips the STFT entirely (contentHash + selection span
    keyed, per the issue's cache note).
    ``method`` names the backend that produced the audio — "demucs"
    (#302) or "center_extraction" — so the pipeline can report which
    estimate the tracker actually saw.
    """
    _sweep_cache(time.time())
    preferred = _method()
    key = _cache_key(audio_path, content_hash, start_sec, end_sec, preferred)
    cached = os.path.join(_cache_dir(), f"{_CACHE_PREFIX}{key}.wav")
    if os.path.isfile(cached):
        return cached, "applied", True, preferred

    samples: Any | None = None
    method: str | None = None
    if preferred == "demucs":
        samples = isolate_demucs_vocals(audio_path, start_sec, end_sec)
        if samples is not None:
            method = "demucs"
    if samples is None:
        # demucs absent or failed — the free center mask still beats
        # the raw mix for a monophonic tracker.
        samples = isolate_center_vocals(audio_path, start_sec, end_sec)
        if samples is not None:
            method = "center_extraction"
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

        return None, reason, False, None

    # Cache under the method that actually produced the audio — a
    # demucs failure cached as center must not pin future runs to the
    # weaker estimate once demucs works again.
    assert method is not None  # samples is not None implies a method
    if preferred != method:
        key = _cache_key(audio_path, content_hash, start_sec, end_sec, method)
        cached = os.path.join(_cache_dir(), f"{_CACHE_PREFIX}{key}.wav")
        if os.path.isfile(cached):
            return cached, "applied", True, method
    if _write_mono_wav(cached, samples, sample_rate):
        return cached, "applied", True, method
    # Cache write failed (read-only temp) — stage a plain temp file so
    # this job still gets the isolated input.
    fd, tmp = tempfile.mkstemp(prefix="hornscribe-vocal-", suffix=".wav")
    with contextlib.suppress(OSError):
        os.close(fd)
    if _write_mono_wav(tmp, samples, sample_rate):
        return tmp, "applied", False, method
    with contextlib.suppress(OSError):
        os.unlink(tmp)
    return None, "unavailable", False, None
