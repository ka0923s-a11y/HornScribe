#!/usr/bin/env python3
"""MusicXML -> MuseScore -> MusicXML round-trip verification (#15).

Imports every ``fixtures/musicxml`` golden through a real MuseScore 4
binary, re-exports it, and compares measure counts, pitched-note
counts and (pitch, duration) sets against the originals.  A golden
that MuseScore cannot import, or that comes back altered, fails the
run — the release gate then catches the regression instead of a user.

    python scripts/musescore_roundtrip.py <MuseScore4.exe> [fixtures_dir]

MuseScore runs headless via ``-o`` conversion mode; each file takes a
few seconds.  Exit 0 on success, 1 on any import/parse/diff failure.
"""

from __future__ import annotations

import subprocess
import sys
import warnings
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "python"))

CONVERT_TIMEOUT_S = 180.0


def _convert(musescore: str, out_path: Path, in_path: Path) -> tuple[int, str]:
    r = subprocess.run(
        [musescore, "-o", str(out_path), str(in_path)],
        capture_output=True,
        text=True,
        timeout=CONVERT_TIMEOUT_S,
        check=False,
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def _counts(path: Path) -> tuple[int, int, int, set]:
    import music21

    s = music21.converter.parse(str(path))
    notes = list(s.recurse().notes)
    pitched = [n for n in notes if not isinstance(n, music21.note.Rest)]
    measures = len(
        list(s.recurse().getElementsByClass(music21.stream.Measure))
    )
    pcs = {
        (n.pitch.ps, round(float(n.quarterLength), 4)) for n in pitched
    }
    return len(notes), len(pitched), measures, pcs


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: musescore_roundtrip.py <MuseScore4.exe> [fixtures_dir]",
            file=sys.stderr,
        )
        return 2
    musescore = sys.argv[1]
    if not Path(musescore).is_file():
        print(f"MuseScore binary not found: {musescore}", file=sys.stderr)
        return 1
    fixtures_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else (
        REPO / "fixtures" / "musicxml"
    )
    out_dir = REPO / ".work" / "musescore_roundtrip"
    out_dir.mkdir(parents=True, exist_ok=True)

    fixtures = sorted(fixtures_dir.glob("*.musicxml"))
    if not fixtures:
        print(f"no fixtures under {fixtures_dir}", file=sys.stderr)
        return 1
    print(f"{len(fixtures)} fixtures")

    warnings.filterwarnings("ignore")
    failures: list[tuple[str, str, str]] = []
    converted: list[tuple[Path, Path]] = []
    for fx in fixtures:
        mscz = out_dir / (fx.stem + ".mscz")
        rt = out_dir / (fx.stem + ".rt.musicxml")
        rc, log = _convert(musescore, mscz, fx)
        if rc != 0 or not mscz.is_file():
            failures.append((fx.name, "import", log[-800:]))
            continue
        rc, log = _convert(musescore, rt, mscz)
        if rc != 0 or not rt.is_file():
            failures.append((fx.name, "export", log[-800:]))
            continue
        converted.append((fx, rt))
        print(f"  {fx.name}: musescore ok")

    for fx, rt in converted:
        try:
            a_n, a_p, a_m, a_pcs = _counts(fx)
            b_n, b_p, b_m, b_pcs = _counts(rt)
        except Exception as exc:  # noqa: BLE001
            failures.append((fx.name, "parse", repr(exc)))
            continue
        msgs = []
        if a_m != b_m:
            msgs.append(f"measures {a_m}!={b_m}")
        if a_p != b_p:
            msgs.append(f"pitched {a_p}!={b_p}")
        if a_pcs != b_pcs:
            msgs.append(
                f"pitch+duration set differs ({len(a_pcs)} vs {len(b_pcs)})"
            )
        if msgs:
            failures.append((fx.name, "diff", "; ".join(msgs)))
            print(f"  {fx.name}: DIFF {'; '.join(msgs)}")
        else:
            print(f"  {fx.name}: OK (notes {a_n}, measures {a_m})")

    print(f"{len(fixtures) - len(failures)}/{len(fixtures)} clean")
    for name, tag, detail in failures:
        print(f"FAIL {name} [{tag}] {detail[:400]}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
