#!/usr/bin/env python3
"""Smoke-test a frozen HornScribe engine binary (#244).

Speaks the worker NDJSON protocol directly: handshake, then one real
offline transcription job over a generated sine-wave fixture.  The
release workflow runs this against hornscribe-engine.exe so a broken
bundle (missing ONNX model, missing librosa, protocol drift) fails CI
instead of shipping.

    python scripts/smoke_engine.py path/to/hornscribe-engine.exe

Exit 0 on success; prints the failing phase and exits 1 otherwise.
"""

from __future__ import annotations

import json
import math
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

HANDSHAKE_TIMEOUT_S = 120.0
JOB_TIMEOUT_S = 300.0


def _write_fixture(path: Path) -> None:
    """A440 sine with harmonics — enough pitched content for the
    backend to report notes."""
    sr = 22050
    frames = int(sr * 4.0)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sr)
        buf = bytearray()
        for i in range(frames):
            t = i / sr
            v = (
                0.6 * math.sin(2 * math.pi * 440.0 * t)
                + 0.2 * math.sin(2 * math.pi * 880.0 * t)
                + 0.1 * math.sin(2 * math.pi * 1320.0 * t)
            )
            buf += struct.pack("<h", int(v * 32000))
        fh.writeframes(bytes(buf))


def _request(proc: subprocess.Popen, method: str, payload: dict) -> None:
    line = json.dumps(
        {"v": 1, "kind": "request", "id": method, "method": method,
         "payload": payload},
    )
    assert proc.stdin is not None
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def _read_frame(proc: subprocess.Popen, timeout_s: float) -> dict:
    """Read one stdout frame with a deadline."""
    q: queue.Queue = queue.Queue()

    def pump() -> None:
        assert proc.stdout is not None
        line = proc.stdout.readline()
        q.put(line)

    threading.Thread(target=pump, daemon=True).start()
    try:
        line = q.get(timeout=timeout_s)
    except queue.Empty:
        raise TimeoutError(f"no frame within {timeout_s:.0f}s") from None
    if not line:
        raise RuntimeError("engine closed stdout")
    return json.loads(line)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: smoke_engine.py <path-to-hornscribe-engine>",
              file=sys.stderr)
        return 2
    engine = Path(sys.argv[1])
    if not engine.is_file():
        print(f"engine binary not found: {engine}", file=sys.stderr)
        return 1

    proc = subprocess.Popen(
        [str(engine)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        _request(proc, "engine.handshake", {"protocolVersion": 1})
        frame = _read_frame(proc, HANDSHAKE_TIMEOUT_S)
        if frame.get("error"):
            print(f"handshake error: {frame['error']}", file=sys.stderr)
            return 1
        payload = frame.get("payload") or {}
        caps = payload.get("capabilities") or {}
        info = payload.get("engineInfo") or {}
        print(f"handshake ok: {info}")
        if not caps.get("basicPitchAvailable"):
            print("basic_pitch not importable inside the frozen engine",
                  file=sys.stderr)
            return 1

        with tempfile.TemporaryDirectory() as td:
            fixture = Path(td) / "fixture.wav"
            _write_fixture(fixture)
            _request(
                proc,
                "job.start",
                {
                    "jobKind": "transcription",
                    "params": {
                        "audioPath": str(fixture),
                        "tempoBpm": 120.0,
                        "meter": "4/4",
                        "texture": "mono",
                        "backend": "basicPitch",
                    },
                },
            )
            deadline = time.monotonic() + JOB_TIMEOUT_S
            while time.monotonic() < deadline:
                frame = _read_frame(
                    proc, max(1.0, deadline - time.monotonic())
                )
                if frame.get("kind") == "response":
                    if frame.get("error"):
                        print(f"job.start error: {frame['error']}",
                              file=sys.stderr)
                        return 1
                    continue
                evt = frame.get("payload") or {}
                phase = evt.get("phase")
                if phase in ("started", "progress"):
                    continue
                if phase == "completed":
                    result = evt.get("result") or {}
                    doc = result.get("scoreDocument") or {}
                    parts = (doc.get("content") or {}).get("parts")
                    notes = sum(
                        len(p.get("notes") or []) for p in (parts or [])
                    )
                    if not notes:
                        print("job completed with zero notes",
                              file=sys.stderr)
                        return 1
                    print(f"transcription ok: {notes} notes")
                    _request(proc, "engine.shutdown", {})
                    return 0
                print(f"job failed: {evt.get('error')}", file=sys.stderr)
                return 1
            print("transcription job timed out", file=sys.stderr)
            return 1
    finally:
        proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
