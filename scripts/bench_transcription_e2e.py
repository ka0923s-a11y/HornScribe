#!/usr/bin/env python3
"""End-to-end transcription accuracy benchmark (labeled audio).

Synthesizes short fixtures with *known* note ground truth, runs the real
transcription job through the worker protocol, and scores the produced
score against the truth:

- pitch sequence accuracy (order-aligned, per fixture)
- octave-flip rate (detected pitch == expected +/- 12 at matched slots)
- onset F1 at 150 ms (beat axis -> seconds via the result's own
  tempo/meter, so a tempo estimate is exercised too)
- note-count ratio

The point is a repeatable yardstick: changes to backend tuning,
cleaning, or the quantizer can be measured against labeled audio instead
of vibes. Sine fixtures are easy-mode for Basic Pitch, so this is a
floor check — a regression here means something broke badly.

Usage:
    python scripts/bench_transcription_e2e.py [--engine hornscribe-engine.exe]
                                            [--python .venv/Scripts/python.exe]
                                            [--out benchmarks/transcription_e2e]

Defaults to the repo dev engine (.venv-bp312) with PYTHONPATH=python.
"""

from __future__ import annotations

import argparse
import json
import math
import queue
import struct
import subprocess
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

HANDSHAKE_TIMEOUT_S = 120.0
JOB_TIMEOUT_S = 420.0
ONSET_TOL_S = 0.150


# ---------------------------------------------------------------- fixtures


@dataclass(frozen=True)
class Note:
    onset: float
    offset: float
    midi: int
    amp: float = 0.8


@dataclass(frozen=True)
class Fixture:
    name: str
    meter: str  # hinted meter to keep the scoring deterministic
    tempo_bpm: float  # hinted primary-beat BPM
    notes: tuple[Note, ...]
    note: str = ""  # shown in the report for hard-case trackers


def _synth(path: Path, notes: tuple[Note, ...], sr: int = 22050) -> None:
    """Sine render with a soft attack/decay and a light 2nd harmonic —
    enough for Basic Pitch to lock on without a realistic-timbre gap."""
    total = int((max(n.offset for n in notes) + 0.3) * sr)
    buf = [0.0] * total
    for n in notes:
        f = 440.0 * 2 ** ((n.midi - 69) / 12)
        s0, s1 = int(n.onset * sr), int(n.offset * sr)
        for s in range(s0, min(s1, total)):
            t = (s - s0) / sr
            env = min(1.0, t / 0.01) * min(1.0, (s1 - s) / sr / 0.02)
            buf[s] += n.amp * env * (
                math.sin(2 * math.pi * f * t)
                + 0.25 * math.sin(2 * math.pi * f * 2 * t)
            )
    peak = max(abs(x) for x in buf) or 1.0
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(struct.pack("<h", int(x / peak * 30000)) for x in buf)
        )


def _waltz() -> Fixture:
    # 3/4 at 120bpm: C-major scale pattern, accent on every downbeat.
    beat = 0.5
    pitches = [60, 62, 64, 65, 67, 69, 71, 72] * 3
    notes = tuple(
        Note(i * beat, (i + 1) * beat - 0.03, p, 0.9 if i % 3 == 0 else 0.35)
        for i, p in enumerate(pitches)
    )
    return Fixture("waltz-3-4", "3/4", 120.0, notes)


def _six_eight() -> Fixture:
    # 6/8: eighth-note pulses at ~286 eighths/min, downbeat + secondary
    # dotted-quarter accent so the auto meter has real evidence.
    # tempoBpm is *primary-beat* BPM — for 6/8 that is the dotted
    # quarter, so one eighth spans 60/bpm/3 seconds.
    pulse = 60.0 / 143.0 / 3.0
    pitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65] * 3
    notes = tuple(
        Note(
            i * pulse,
            (i + 1) * pulse - 0.02,
            p,
            0.9 if i % 6 == 0 else (0.55 if i % 3 == 0 else 0.3),
        )
        for i, p in enumerate(pitches)
    )
    return Fixture("eighths-6-8", "6/8", 143.0, notes)


def _sustained_scale() -> Fixture:
    # 4/4 half-note scale — longer sustains exercise offset detection
    # and the merge/ghost rules, not just onsets.
    beat = 0.5
    pitches = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67]
    notes = tuple(
        Note(i * 2 * beat, (i + 1) * 2 * beat - 0.08, p, 0.8)
        for i, p in enumerate(pitches)
    )
    return Fixture("sustained-scale-4-4", "4/4", 120.0, notes)


def _legato_scale() -> Fixture:
    # Same ascending scale but with 20 ms gaps — a true legato line.
    # Known-weak tracker: onset detection collapses pitch transitions
    # without silence, so the expected score here is low until the
    # pipeline learns pitch-change segmentation.
    beat = 0.5
    pitches = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67]
    notes = tuple(
        Note(i * 2 * beat, (i + 1) * 2 * beat - 0.02, p, 0.8)
        for i, p in enumerate(pitches)
    )
    return Fixture(
        "legato-scale-4-4",
        "4/4",
        120.0,
        notes,
        note="hard case: legato transitions without silence gaps",
    )


FIXTURES = (_waltz, _six_eight, _sustained_scale, _legato_scale)


# ------------------------------------------------------- protocol driver


def _request(proc: subprocess.Popen, method: str, payload: dict) -> None:
    line = json.dumps(
        {
            "v": 1,
            "kind": "request",
            "id": method + "-" + str(time.time_ns() % 1_000_000),
            "method": method,
            "payload": payload,
        }
    )
    assert proc.stdin is not None
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def _read_frame(proc: subprocess.Popen, timeout_s: float) -> dict:
    q: queue.Queue = queue.Queue()

    def pump() -> None:
        assert proc.stdout is not None
        q.put(proc.stdout.readline())

    threading.Thread(target=pump, daemon=True).start()
    line = q.get(timeout=timeout_s)
    if not line:
        raise RuntimeError("engine closed stdout")
    return json.loads(line)


def _spawn(args: argparse.Namespace) -> subprocess.Popen:
    if args.engine:
        cmd = [str(args.engine)]
        env = None
    else:
        cmd = [str(args.python), "-m", "hornscribe.worker"]
        import os

        env = dict(os.environ)
        env["PYTHONPATH"] = str(REPO / "python") + (
            ";" + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
        )
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def _run_job(proc: subprocess.Popen, audio: Path, fx: Fixture) -> dict:
    _request(
        proc,
        "job.start",
        {
            "jobKind": "transcription",
            "params": {
                "audioPath": str(audio),
                "tempoBpm": fx.tempo_bpm,
                "meter": fx.meter,
                "texture": "mono",
                "backend": "basicPitch",
            },
        },
    )
    deadline = time.monotonic() + JOB_TIMEOUT_S
    while time.monotonic() < deadline:
        frame = _read_frame(proc, max(1.0, deadline - time.monotonic()))
        if frame.get("kind") == "response":
            if frame.get("error"):
                raise RuntimeError(f"job.start error: {frame['error']}")
            continue
        evt = frame.get("payload") or {}
        phase = evt.get("phase")
        if phase == "completed":
            return evt.get("result") or {}
        if phase == "failed":
            raise RuntimeError(f"job failed: {evt.get('error')}")
    raise TimeoutError(f"job exceeded {JOB_TIMEOUT_S:.0f}s")


# ------------------------------------------------------------- scoring


def _frac(value) -> float:
    if isinstance(value, str) and "/" in value:
        n, d = value.split("/", 1)
        return float(n) / float(d)
    return float(value)


def _detected_notes(result: dict) -> list[tuple[float, int]]:
    """(onset_sec, midi) rows — beats converted via the result's own
    tempo map so a wrong tempo pick shows up as onset error."""
    doc = result.get("scoreDocument") or {}
    parts = ((doc.get("content") or {}).get("parts")) or []
    meta = result.get("meta") or {}
    bpm = float(meta.get("tempoBpm") or 120.0)
    meter = str(meta.get("meter") or "4/4")
    if "/" in meter:
        num_s, den_s = meter.split("/", 1)
        num, den = int(num_s), int(den_s)
    else:
        num, den = 4, 4
    # scoreDocument startBeat counts *denominator* units (scorebuild.py:
    # onset_ql / (4/den)) — for 6/8 one "beat" is an eighth. tempoBpm
    # counts *primary* beats (compound: dotted quarter = 3/2 ql).
    measure_ql = num * 4.0 / den
    beat_count = num // 3 if (num % 3 == 0 and num > 3) else num
    primary_ql = measure_ql / beat_count
    sec_per_ql = 60.0 / bpm / primary_ql
    doc_beat_ql = 4.0 / den
    sec_per_beat = doc_beat_ql * sec_per_ql
    out: list[tuple[float, int]] = []
    for part in parts:
        for n in part.get("notes") or []:
            if n.get("deleted"):
                continue
            out.append((_frac(n["startBeat"]) * sec_per_beat, int(n["pitchMidi"])))
    out.sort()
    return out


def _align_pitches(expected: list[int], got: list[int]) -> dict:
    """Order-preserving alignment (Needleman-Wunsch, gap=-1, sub=-2).
    Reports exact / octave-off / other mismatches."""
    n, m = len(expected), len(got)
    # classic DP
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] - 1
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] - 1
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sub = 0 if expected[i - 1] == got[j - 1] else -2
            dp[i][j] = max(
                dp[i - 1][j - 1] + sub, dp[i - 1][j] - 1, dp[i][j - 1] - 1
            )
    # traceback
    i, j = n, m
    pairs = []
    ins = dele = 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + (
            0 if expected[i - 1] == got[j - 1] else -2
        ):
            pairs.append((expected[i - 1], got[j - 1]))
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] - 1:
            dele += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    exact = sum(1 for a, b in pairs if a == b)
    octave = sum(1 for a, b in pairs if abs(a - b) == 12)
    mismatched = len(pairs) - exact - octave
    return {
        "expected": n,
        "detected": m,
        "matched": len(pairs),
        "exact": exact,
        "octaveOff": octave,
        "mismatch": mismatched,
        "missing": dele,
        "extra": ins,
        "pitchAccuracy": round(exact / n, 4) if n else 0.0,
        "noteRatio": round(m / n, 4) if n else 0.0,
    }


def _onset_f1(expected: list[float], got: list[float]) -> dict:
    used = [False] * len(got)
    tp = 0
    errors: list[float] = []
    for e in expected:
        best = None
        best_d = ONSET_TOL_S
        for k, g in enumerate(got):
            if used[k]:
                continue
            d = abs(g - e)
            if d <= best_d:
                best, best_d = k, d
        if best is not None:
            used[best] = True
            tp += 1
            errors.append(best_d)
    fp = len(got) - tp
    fn = len(expected) - tp
    f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 1.0
    med = sorted(errors)[len(errors) // 2] if errors else None
    return {
        "onsetF1@150ms": round(f1, 4),
        "medianOnsetErrMs": round(med * 1000.0, 1) if med is not None else None,
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


# ----------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", type=Path, default=None,
                    help="frozen hornscribe-engine binary")
    ap.add_argument(
        "--python",
        type=Path,
        default=REPO / ".venv-bp312" / "Scripts" / "python.exe",
    )
    ap.add_argument("--out", type=Path, default=REPO / "benchmarks" / "transcription_e2e")
    args = ap.parse_args()

    rows = []
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for make in FIXTURES:
            fx = make()
            wav = tdp / (fx.name + ".wav")
            _synth(wav, fx.notes)
            proc = _spawn(args)
            t0 = time.monotonic()
            try:
                _request(proc, "engine.handshake", {"protocolVersion": 1})
                hs = _read_frame(proc, HANDSHAKE_TIMEOUT_S)
                if hs.get("error"):
                    raise RuntimeError(f"handshake: {hs['error']}")
                result = _run_job(proc, wav, fx)
            finally:
                proc.kill()
            elapsed = time.monotonic() - t0

            got = _detected_notes(result)
            exp_p = [n.midi for n in fx.notes]
            got_p = [m for _, m in got]
            seq = _align_pitches(exp_p, got_p)
            ons = _onset_f1([n.onset for n in fx.notes], [o for o, _ in got])
            meta = result.get("meta") or {}
            row = {
                "fixture": fx.name,
                "note": fx.note,
                "tempoBpmDetected": meta.get("tempoBpm"),
                "meterDetected": meta.get("meter"),
                "runtimeSec": round(elapsed, 1),
                **seq,
                **ons,
            }
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    stem = args.out
    stem.with_suffix(".json").write_text(
        json.dumps({"rows": rows}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    md = ["# E2E transcription accuracy benchmark", ""]
    md.append(
        "| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms"
        " | med err ms | tempo | meter | s | note |"
    )
    md.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        md.append(
            f"| {r['fixture']} | {r['pitchAccuracy']} | {r['octaveOff']} "
            f"| {r['missing']}/{r['extra']} | {r['onsetF1@150ms']} | {r['medianOnsetErrMs']} "
            f"| {r['tempoBpmDetected']} | {r['meterDetected']} | {r['runtimeSec']} | {r['note']} |"
        )
    stem.with_suffix(".md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"wrote {stem.with_suffix('.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
