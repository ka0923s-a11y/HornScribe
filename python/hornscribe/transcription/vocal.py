"""Opt-in vocal-isolation preprocessing stage (#187).

JPOP mixes bury the lead vocal under accompaniment, so a monophonic
tracker or melody-preference cleaner keeps locking onto louder
instruments. Two backends are supported, tried in quality order:

* **demucs** (#302) — true neural two-stem separation, used when a
  runnable demucs is resolvable: the optional ``engine-vocal`` extra
  in a dev install, or — in packaged builds, where
  ``sys.executable`` is the worker itself and ``-m demucs`` would
  spawn a second worker — a bundled ``tools/demucs`` binary, a
  ``demucs`` console script on PATH, or another interpreter named by
  ``HORNSCRIBE_PYTHON`` (#10). It ships ~200 MB of torch + model
  weights, so it stays opt-in.
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
import functools
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


def _demucs_module_importable() -> bool:
    """find_spec probe — never imports, so torch stays unloaded."""
    try:
        import importlib.util

        return importlib.util.find_spec("demucs") is not None
    except Exception:
        return False


def _python_has_demucs(python_exe: str) -> bool:
    """find_spec probe inside a *different* interpreter — the honest
    check when the module isn't in this process. find_spec (not
    ``import demucs``) so the probe stays sub-second: a real import
    would pay torch's multi-second load on every cold handshake.
    A present-but-broken install still fails at job time and falls
    back to center extraction — same as a broken dev env."""
    try:
        kwargs: dict[str, Any] = {
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "timeout": 15,
            "check": False,
        }
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.run(  # noqa: S603
            [
                python_exe,
                "-c",
                "import importlib.util,sys;sys.exit(0 if "
                "importlib.util.find_spec('demucs') else 1)",
            ],
            **kwargs,
        )
        return proc.returncode == 0
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def _demucs_cmd() -> tuple[str, ...] | None:
    """Resolve a runnable demucs prefix — mirrors the shell's ffmpeg order.

    Order (#10): ``HORNSCRIBE_DEMUCS`` exe path (explicit override — a
    bad path resolves to None rather than falling through) -> this
    interpreter's ``-m demucs`` when the module is importable -> a
    ``demucs`` console script on PATH (the shell prepends the bundled
    tools/ dir to the child's PATH, so a packaged demucs.exe lands
    here too) -> ``HORNSCRIBE_PYTHON`` then PATH pythons that have
    demucs installed. A frozen engine never uses ``sys.executable -m``
    — the exe is the worker itself, so the spawn would start a second
    NDJSON worker on the protocol pipe, not demucs.
    """
    env_exe = os.environ.get("HORNSCRIBE_DEMUCS", "").strip()
    if env_exe:
        return (env_exe,) if os.path.isfile(env_exe) else None
    if (
        not getattr(sys, "frozen", False)
        and sys.executable
        and _demucs_module_importable()
    ):
        return (sys.executable, "-m", "demucs")
    cli = shutil.which("demucs")
    if cli:
        return (cli,)
    candidates: list[str] = []
    env_py = os.environ.get("HORNSCRIBE_PYTHON", "").strip()
    if env_py:
        candidates.append(env_py)
    exe_real = (
        os.path.realpath(sys.executable) if sys.executable else ""
    )
    for name in ("python", "python3"):
        found = shutil.which(name)
        if (
            found
            and found not in candidates
            and os.path.realpath(found) != exe_real
        ):
            candidates.append(found)
    for python_exe in candidates:
        if _python_has_demucs(python_exe):
            return (python_exe, "-m", "demucs")
    return None


def _demucs_available() -> bool:
    """#302: demucs is opt-in — resolved once per process via
    ``_demucs_cmd`` so the availability probe and the spawned command
    can never disagree."""
    return _demucs_cmd() is not None


def demucs_available() -> bool:
    """Handshake-visible availability — the same resolver the job path
    uses, so the capability flag never disagrees with what a job
    would actually run (#10)."""
    return _demucs_cmd() is not None


def _stage_span_wav(
    audio_path: str, start_sec: float, end_sec: float | None
) -> str | None:
    """#320: decode [start, end) in stereo and stage it as a temp WAV
    for demucs — None when the span cannot be decoded (the caller then
    falls back to center extraction, which decodes spans itself)."""
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415
    except Exception:
        return None
    try:
        stereo, sr = librosa.load(
            audio_path,
            sr=44100,
            mono=False,
            offset=max(0.0, start_sec),
            duration=(
                None if end_sec is None else max(0.0, end_sec - start_sec)
            ),
        )
    except Exception:
        return None
    if stereo.size == 0:
        return None
    channels = stereo if stereo.ndim == 2 else stereo.reshape(1, -1)
    interleaved = np.asarray(channels, dtype=np.float32).T.reshape(-1)
    pcm = array(
        "h",
        (
            max(-32768, min(32767, int(round(float(v) * 32768.0))))
            for v in interleaved
        ),
    )
    if pcm.itemsize != 2:
        return None
    try:
        fd, tmp = tempfile.mkstemp(
            prefix="hornscribe-span-", suffix=".wav"
        )
        with contextlib.suppress(OSError):
            os.close(fd)
        with wave.open(tmp, "wb") as wav:
            wav.setnchannels(int(channels.shape[0]))
            wav.setsampwidth(2)
            wav.setframerate(int(sr))
            wav.writeframes(pcm.tobytes())
        return tmp
    except (OSError, ValueError, TypeError):
        return None


def isolate_demucs_vocals(
    audio_path: str,
    start_sec: float = 0.0,
    end_sec: float | None = None,
) -> Any | None:
    """#302: neural two-stem separation via the demucs CLI -> mono float32 | None.

    Runs ``<demucs prefix> --two-stems=vocals`` in a subprocess so a
    torch crash can never take the engine down with it. The prefix
    comes from ``_demucs_cmd`` — module, console script, bundled
    binary, or another interpreter (#10).
    #320: a selection job must not pay the whole-file separation — the
    requested span is staged as a temp stereo WAV and demucs only ever
    sees that slice (the #229 partial-transcription contract). A
    full-range job still hands demucs the original file directly.
    None on any failure (missing binary, non-zero exit, decode error)
    so the caller falls back to center extraction.
    """
    cmd_prefix = _demucs_cmd()
    if cmd_prefix is None:
        return None
    try:
        require_module("librosa")
        import librosa  # noqa: PLC0415 - lazy optional dependency
        import numpy as np  # noqa: PLC0415
    except Exception:
        return None

    # #320: stage the span when the job is range-scoped — demucs gets a
    # file holding only the selection, so a 30 s pick out of a 10 min
    # source costs 30 s of separation, not ten minutes.
    input_path = audio_path
    span_staged = False
    if start_sec > 0.0 or end_sec is not None:
        staged_span = _stage_span_wav(audio_path, start_sec, end_sec)
        if staged_span is None:
            return None
        input_path = staged_span
        span_staged = True

    out_dir = tempfile.mkdtemp(prefix="hornscribe-demucs-")
    try:
        cmd = [
            *cmd_prefix,
            "--two-stems=vocals",
            "-o",
            out_dir,
            input_path,
        ]
        kwargs: dict[str, Any] = {
            "capture_output": True,
            # DEVNULL keeps the child off this worker's stdin — that
            # pipe carries NDJSON protocol frames, not subprocess input.
            "stdin": subprocess.DEVNULL,
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
        # A staged span is already selection-relative — only a direct
        # full-file run needs the requested span sliced out.
        lo = 0 if span_staged else int(max(0.0, start_sec) * 22050)
        hi = (
            len(samples)
            if span_staged or end_sec is None
            else int(end_sec * 22050)
        )
        sliced = np.asarray(samples[lo:hi], dtype=np.float32)
        if sliced.size == 0:
            return None
        return sliced
    except Exception:
        return None
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        if span_staged:
            with contextlib.suppress(OSError):
                os.unlink(input_path)


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


def _demucs_version() -> str | None:
    """Installed demucs package version — None when absent. Read via
    importlib.metadata so the engine never pays torch's import cost."""
    try:
        import importlib.metadata

        return importlib.metadata.version("demucs")
    except Exception:
        return None


# #319: the center-extraction algorithm carries its own version — bump
# it whenever the mask/STFT geometry changes so a behavior change mints
# a new transcription identity instead of silently rewriting one.
_CENTER_EXTRACTION_VERSION = "1"


def method_version(method: str | None) -> str | None:
    """Version string for the isolation method that produced the audio.

    #319: the transcription revision must name what actually ran —
    a demucs upgrade or a center-mask change is a different preprocess
    and has to mint a new tr-* identity.
    """
    if method == "demucs":
        return _demucs_version() or "unknown"
    if method == "center_extraction":
        return _CENTER_EXTRACTION_VERSION
    return None


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
) -> tuple[str | None, str, bool, str | None, str | None]:
    """Isolated-vocal WAV -> (path, reason, managed, method, method_version).

    ``reason`` maps to a review issue: "applied" on success,
    "mono_source" for mono input, "unavailable" for decode or
    isolation failures. ``managed`` marks the shared cache file — the
    caller must not delete it; an unmanaged path is a per-job temp.
    A cache hit skips the STFT entirely (contentHash + selection span
    keyed, per the issue's cache note).
    ``method`` names the backend that produced the audio — "demucs"
    (#302) or "center_extraction" — so the pipeline can report which
    estimate the tracker actually saw. ``method_version`` is the
    provenance version of that method (#319) — folded into the
    transcription revision so an engine/model upgrade mints a new
    tr-* identity.
    """
    _sweep_cache(time.time())
    preferred = _method()
    key = _cache_key(audio_path, content_hash, start_sec, end_sec, preferred)
    cached = os.path.join(_cache_dir(), f"{_CACHE_PREFIX}{key}.wav")
    if os.path.isfile(cached):
        return cached, "applied", True, preferred, method_version(preferred)

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

        return None, reason, False, None, None

    # Cache under the method that actually produced the audio — a
    # demucs failure cached as center must not pin future runs to the
    # weaker estimate once demucs works again.
    assert method is not None  # samples is not None implies a method
    version = method_version(method)
    if preferred != method:
        key = _cache_key(audio_path, content_hash, start_sec, end_sec, method)
        cached = os.path.join(_cache_dir(), f"{_CACHE_PREFIX}{key}.wav")
        if os.path.isfile(cached):
            return cached, "applied", True, method, version
    if _write_mono_wav(cached, samples, sample_rate):
        return cached, "applied", True, method, version
    # Cache write failed (read-only temp) — stage a plain temp file so
    # this job still gets the isolated input.
    fd, tmp = tempfile.mkstemp(prefix="hornscribe-vocal-", suffix=".wav")
    with contextlib.suppress(OSError):
        os.close(fd)
    if _write_mono_wav(tmp, samples, sample_rate):
        return tmp, "applied", False, method, version
    with contextlib.suppress(OSError):
        os.unlink(tmp)
    return None, "unavailable", False, None, None
