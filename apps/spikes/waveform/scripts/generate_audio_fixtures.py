"""Generate deterministic synthetic WAV fixtures for the UI-004 waveform spike.

Stdlib-only (wave/struct/math/hashlib), no numpy. The synthesis formula is
mirrored by src/audio/synth.ts so the same signal can be produced in-browser
on demand (the 3 min / 10 min fixtures are intentionally not committed).

Signal design (44.1 kHz mono PCM16):
  - a new "note" every 2 s cycling through a scale, 5 Hz vibrato + harmonic
  - per-note attack/decay envelope; every 8th note is a rest (visible gaps)
  - a 1 kHz / 60 ms marker tick every 10 s (visual anchor for loop/jitter)
  - deterministic LCG noise floor

Usage (from this directory):
    python scripts/generate_audio_fixtures.py            # all durations
    python scripts/generate_audio_fixtures.py 30 180     # custom durations

Outputs: public/fixtures/sweep_<label>.wav + manifest.json (hashes, sizes).
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import wave
from array import array
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "public" / "fixtures"

SAMPLE_RATE = 44100
NOTE_SECONDS = 2.0
SCALE_HZ = (220.0, 246.94, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25)
ATTACK_S = 0.03
DECAY = 5.0
TICK_PERIOD_S = 10.0
TICK_LEN_S = 0.06
TICK_HZ = 1000.0
NOISE_AMP = 0.015
MASTER_AMP = 0.5


def _lcg(seed: int) -> int:
    return (1103515245 * seed + 12345) % (1 << 32)


def synth_samples(seconds: float):
    """Yield int16 samples for `seconds` of the fixture signal."""
    total = int(seconds * SAMPLE_RATE)
    seed = 0x1234ABCD
    for i in range(total):
        t = i / SAMPLE_RATE
        note_idx = int(t // NOTE_SECONDS)
        u = (t - note_idx * NOTE_SECONDS) / NOTE_SECONDS  # 0..1 within note

        sample = 0.0
        if note_idx % 8 != 7:  # every 8th note is a rest
            octave = 1.0 if (note_idx // 8) % 2 == 0 else 0.5
            freq = SCALE_HZ[note_idx % len(SCALE_HZ)] * octave
            phase = 2.0 * math.pi * freq * t + 0.3 * math.sin(2.0 * math.pi * 5.0 * t)
            env_attack = min(1.0, (u * NOTE_SECONDS) / ATTACK_S)
            env = env_attack * math.exp(-DECAY * u)
            sample += (math.sin(phase) + 0.3 * math.sin(2.0 * phase)) * env

        # marker tick every 10 s
        tick_pos = t % TICK_PERIOD_S
        if tick_pos < TICK_LEN_S:
            tick_env = math.sin(math.pi * tick_pos / TICK_LEN_S)
            sample += 0.6 * math.sin(2.0 * math.pi * TICK_HZ * t) * tick_env

        seed = _lcg(seed)
        noise = (seed / (1 << 31) - 1.0) * NOISE_AMP
        sample = (sample + noise) * MASTER_AMP
        yield max(-1.0, min(1.0, sample))


def write_wav(path: Path, seconds: float) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = array("h", (int(s * 32767) for s in synth_samples(seconds)))
    data = frames.tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(data)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "file": path.name,
        "seconds": seconds,
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "bitDepth": 16,
        "bytes": path.stat().st_size,
        "sha256": digest,
    }


def main() -> None:
    durations = [float(a) for a in sys.argv[1:]] or [30.0, 180.0, 600.0]
    manifest = []
    for d in durations:
        if d < 60:
            label = f"{int(d)}s"
        else:
            label = f"{int(d / 60)}min"
        path = FIXTURES_DIR / f"sweep_{label}.wav"
        print(f"synthesizing {path.name} ({d}s) ...", flush=True)
        manifest.append(write_wav(path, d))
        print(f"  -> {path.stat().st_size / 1e6:.2f} MB", flush=True)
    manifest_path = FIXTURES_DIR / "manifest.json"
    # Merge into any existing manifest so partial regenerations stay accurate.
    existing: dict[str, dict] = {}
    if manifest_path.exists():
        try:
            for entry in json.loads(manifest_path.read_text(encoding="utf-8")):
                existing[entry["file"]] = entry
        except Exception:
            pass
    for entry in manifest:
        existing[entry["file"]] = entry
    merged = sorted(existing.values(), key=lambda e: e["seconds"])
    manifest_path.write_text(
        json.dumps(merged, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"wrote {manifest_path}")


if __name__ == "__main__":
    main()
