"""QNT-007: reproducible quantizer benchmark — B0–B4 + weight ablations.

Run from the repo root inside the venv:

    .venv/Scripts/python scripts/bench_quantizer.py
    .venv/Scripts/python scripts/bench_quantizer.py --out benchmarks/quantizer_benchmark.json

Writes the committed artifact (default ``benchmarks/quantizer_benchmark.json``)
plus a human-readable ``.md`` table next to it. The report records the git
commit, ``QUANTIZER_VERSION``, ``weights_version``, a deterministic fixture
corpus hash, per-fixture/per-arm metrics, and per-arm runtimes — everything
needed to reproduce or audit the weights-v1 freeze.

Private horn recordings belong under gitignored ``benchmarks/local/`` as JSON
event files::

    {"name": "take01", "bpm": 118.0,
     "events": [{"onset_sec": 0.0, "offset_sec": 0.44, "pitch_midi": 65.0}, ...],
     "expected_onsets_ql": ["0", "1/2", ...]}

``--local`` benchmarks that corpus into ``benchmarks/local/results_local.json``
(never committed); without ``--local`` the directory is untouched.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import time
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python"))
sys.path.insert(0, str(REPO_ROOT / "tests" / "python"))

import rhythm_fixtures as fx  # noqa: E402
from hornscribe.domain.events import RawNoteEvent  # noqa: E402
from hornscribe.domain.ids import RawNoteEventId, TranscriptionRevisionId  # noqa: E402
from hornscribe.rhythm import benchmark_methods  # noqa: E402
from hornscribe.rhythm.contracts import (  # noqa: E402
    QUANTIZER_ID,
    QUANTIZER_VERSION,
)
from hornscribe.rhythm.meter import MeterMap, MeterSegment  # noqa: E402
from hornscribe.rhythm.profile import QuantizationProfile  # noqa: E402
from hornscribe.rhythm.timewarp import TimeWarp  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "benchmarks" / "quantizer_benchmark.json"
LOCAL_DIR = REPO_ROOT / "benchmarks" / "local"
_REVISION = TranscriptionRevisionId("bench")


def _frac(value: Fraction | int) -> str:
    f = value if isinstance(value, Fraction) else Fraction(value)
    return f"{f.numerator}/{f.denominator}"


def _fixture_fingerprint(fixture: fx.RhythmFixture) -> dict[str, Any]:
    """Canonical serialization of everything that determines the run."""
    meter = None
    if fixture.meter_map is not None:
        meter = [
            {
                "start_ql": _frac(seg.start_ql),
                "numerator": seg.numerator,
                "denominator": seg.denominator,
                "measure_phase_ql": _frac(seg.measure_phase_ql),
            }
            for seg in fixture.meter_map.segments
        ]
    return {
        "name": fixture.name,
        "layer": fixture.layer,
        "bpm": fixture.bpm,
        "events": [
            [repr(e.onset_sec), repr(e.offset_sec), repr(e.pitch_midi)]
            for e in fixture.events
        ],
        "expected_onsets_ql": [_frac(q) for q in fixture.expected_onsets_ql],
        "expected_durations_ql": (
            [_frac(q) for q in fixture.expected_durations_ql]
            if fixture.expected_durations_ql is not None
            else None
        ),
        "expected_rest_spans_ql": (
            [[_frac(a), _frac(b)] for a, b in fixture.expected_rest_spans_ql]
            if fixture.expected_rest_spans_ql is not None
            else None
        ),
        "expected_tuplet_groups": fixture.expected_tuplet_groups,
        "meter_map": meter,
    }


def corpus_hash(fixtures: list[fx.RhythmFixture]) -> str:
    """sha256 over the canonical fixture corpus — pins reproducibility."""
    payload = json.dumps(
        [_fixture_fingerprint(f) for f in fixtures], sort_keys=True
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _git_commit() -> dict[str, Any]:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    return {
        "commit": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(git("status", "--porcelain")),
    }


def _metrics_dict(run: Any) -> dict[str, Any]:
    """Serialize one MethodRun: metrics + measured runtime."""
    return {"runtime_sec": run.runtime_sec, "metrics": asdict(run.metrics)}


def run_fixture(
    fixture: fx.RhythmFixture, arms: tuple[str, ...] | None = None
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if arms is not None:
        kwargs["arms"] = arms
    runs = benchmark_methods(
        fixture.events,
        fixture.warp,
        fixture.expected_onsets_ql,
        expected_durations_ql=fixture.expected_durations_ql,
        expected_rest_spans_ql=fixture.expected_rest_spans_ql,
        expected_tuplet_groups=fixture.expected_tuplet_groups,
        meter_map=fixture.meter_map,
        **kwargs,
    )
    return {name: _metrics_dict(run) for name, run in runs.items()}


def runtime_probe(beats: int = 360, bpm: float = 120.0) -> dict[str, Any]:
    """Time B0/B4 on a ~3-minute monophonic horn-like stream (issue metric).

    At 120 BPM ``beats=360`` is 180 s of audio — inside the issue's
    "typical 3-5 minute" band. The pattern is deterministic: an 8-beat
    phrase of seven tongued quarters + one breath beat, repeated.
    """
    onsets_ql: list[Fraction] = []
    durations_ql: list[Fraction] = []
    phrase = 0
    while phrase * 8 < beats:
        base = phrase * 8
        for i in range(7):
            onsets_ql.append(Fraction(base + i))
            durations_ql.append(Fraction(4, 5))  # breath gap before next
        phrase += 1
    events = fx.make_events(
        [float(q) * 60.0 / bpm for q in onsets_ql],
        durations_sec=[float(d) * 60.0 / bpm for d in durations_ql],
    )
    warp = TimeWarp.fixed_bpm(bpm)
    meter = MeterMap((MeterSegment(Fraction(0), 4, 4),))
    expected = tuple(onsets_ql)
    out: dict[str, Any] = {
        "audio_sec": beats * 60.0 / bpm,
        "beats": beats,
        "note_count": len(events),
        "arms": {},
    }
    for arm in ("B0", "B4"):
        runs = benchmark_methods(
            events, warp, expected, meter_map=meter, arms=(arm,)
        )
        out["arms"][arm] = _metrics_dict(runs[arm])
    return out


def load_local_corpus(local_dir: Path) -> list[fx.RhythmFixture]:
    """Load gitignored ``benchmarks/local/*.json`` horn recordings."""
    fixtures: list[fx.RhythmFixture] = []
    for path in sorted(local_dir.glob("*.json")):
        if path.name == "results_local.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        bpm = float(data["bpm"])
        events = tuple(
            RawNoteEvent(
                id=RawNoteEventId(f"rne-{i + 1:06d}"),
                transcription_revision=_REVISION,
                pitch_midi=float(e.get("pitch_midi", 60.0)),
                onset_sec=float(e["onset_sec"]),
                offset_sec=float(e["offset_sec"]),
            )
            for i, e in enumerate(data["events"])
        )
        fixtures.append(
            fx.RhythmFixture(
                name=data.get("name", path.stem),
                events=events,
                warp=TimeWarp.fixed_bpm(bpm),
                expected_onsets_ql=tuple(
                    Fraction(q) for q in data["expected_onsets_ql"]
                ),
                meter_map=MeterMap((MeterSegment(Fraction(0), 4, 4),)),
                bpm=bpm,
                layer="local",
            )
        )
    return fixtures


def summarize(results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Aggregate headline numbers per arm across the corpus."""
    arms: dict[str, dict[str, Any]] = {}
    for methods in results.values():
        for arm, run in methods.items():
            agg = arms.setdefault(
                arm,
                {
                    "fixtures": 0,
                    "exact_onsets": 0,
                    "expected_onsets": 0,
                    "mean_exact_onset_rate": 0.0,
                    "mean_onset_error_ql": 0.0,
                    "exact_durations": 0.0,
                    "duration_fixtures": 0,
                    "rest_exact": 0,
                    "rest_expected": 0,
                    "rest_extra": 0,
                    "rest_fixtures": 0,
                    "triplet_fp": 0,
                    "triplet_missed": 0,
                    "tiny_rests": 0,
                    "review_issues": 0,
                    "runtime_sec": 0.0,
                },
            )
            m = run["metrics"]
            agg["fixtures"] += 1
            agg["exact_onsets"] += m["matched_count"]
            agg["expected_onsets"] += m["expected_count"]
            agg["mean_exact_onset_rate"] += m["exact_onset_rate"]
            agg["mean_onset_error_ql"] += m["mean_abs_onset_error_ql"]
            if m["exact_duration_rate"] is not None:
                agg["exact_durations"] += m["exact_duration_rate"]
                agg["duration_fixtures"] += 1
            if m["rest_exact_count"] is not None:
                agg["rest_exact"] += m["rest_exact_count"]
                agg["rest_expected"] += m["expected_rest_count"] or 0
                agg["rest_extra"] += m["rest_extra_count"] or 0
                agg["rest_fixtures"] += 1
            agg["triplet_fp"] += m["triplet_false_positive_groups"] or 0
            agg["triplet_missed"] += m["triplet_missed_groups"] or 0
            agg["tiny_rests"] += m["tiny_rest_count"] or 0
            agg["review_issues"] += m["review_issue_count"] or 0
            agg["runtime_sec"] += run["runtime_sec"]
    for agg in arms.values():
        if agg["fixtures"]:
            agg["mean_exact_onset_rate"] /= agg["fixtures"]
            agg["mean_onset_error_ql"] /= agg["fixtures"]
        if agg["duration_fixtures"]:
            agg["exact_durations"] /= agg["duration_fixtures"]
        else:
            agg["exact_durations"] = None
    return arms


def _fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_markdown(report: dict[str, Any]) -> str:
    """Human-readable headline table next to the JSON artifact."""
    lines = [
        "# QNT-007 quantizer benchmark",
        "",
        f"- commit: `{report['git']['commit']}`"
        + (" (dirty)" if report["git"]["dirty"] else ""),
        f"- quantizer: {report['quantizer']['id']} "
        f"v{report['quantizer']['version']}, "
        f"weights_version={report['quantizer']['weights_version']}",
        f"- fixture corpus: {report['corpus']['fixture_count']} fixtures, "
        f"sha256 `{report['corpus']['sha256'][:16]}…`",
        "",
        "| arm | exact onset | mean onset err (ql) | exact dur | "
        "rest exact/extra | triplet fp/miss | tiny rests | runtime (s) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for arm, agg in report["summary"].items():
        rest = "-"
        if agg["rest_fixtures"]:
            rest = f"{agg['rest_exact']}/{agg['rest_expected']} (+{agg['rest_extra']})"
        lines.append(
            f"| {arm} | {_fmt(agg['mean_exact_onset_rate'])} | "
            f"{_fmt(agg.get('mean_onset_error_ql', 0.0))} | "
            f"{_fmt(agg['exact_durations'])} | {rest} | "
            f"{agg['triplet_fp']}/{agg['triplet_missed']} | "
            f"{agg['tiny_rests']} | {_fmt(agg['runtime_sec'])} |"
        )
    probe = report["runtime_probe"]
    lines += [
        "",
        "## Runtime probe (3-minute monophonic stream)",
        "",
        f"- {probe['note_count']} notes / {probe['audio_sec']:.0f} s audio:",
    ]
    for arm, run in probe["arms"].items():
        lines.append(f"  - {arm}: {run['runtime_sec']:.3f} s")
    lines.append("")
    return "\n".join(lines)


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    fixtures = [make() for make in fx.ALL_FIXTURES]
    arms = tuple(args.arms.split(",")) if args.arms else None
    started = time.perf_counter()
    results = {f.name: run_fixture(f, arms) for f in fixtures}
    probe = runtime_probe(beats=args.runtime_probe_beats)
    total_runtime = time.perf_counter() - started
    music21_version = None
    with contextlib.suppress(importlib.metadata.PackageNotFoundError):
        music21_version = importlib.metadata.version("music21")
    report: dict[str, Any] = {
        "issue": "QNT-007 (#21): quantizer benchmark + weights v1 freeze",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git": _git_commit(),
        "quantizer": {
            "id": QUANTIZER_ID,
            "version": QUANTIZER_VERSION,
            "weights_version": QuantizationProfile.standard().weights.weights_version,
        },
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "music21": music21_version,
        },
        "corpus": {
            "fixture_count": len(fixtures),
            "sha256": corpus_hash(fixtures),
            "names": [f.name for f in fixtures],
        },
        "results": results,
        "runtime_probe": probe,
        "summary": summarize(results),
        "benchmark_wall_time_sec": total_runtime,
    }
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="committed artifact path (default: %(default)s)",
    )
    parser.add_argument(
        "--arms",
        default=None,
        help="comma-separated arm subset (default: all B0-B4 + ablations)",
    )
    parser.add_argument(
        "--runtime-probe-beats",
        type=int,
        default=360,
        help="length of the runtime probe stream in beats (default: %(default)s)",
    )
    parser.add_argument(
        "--local",
        action="store_true",
        help="also benchmark benchmarks/local/*.json into "
        "benchmarks/local/results_local.json (gitignored, never committed)",
    )
    args = parser.parse_args(argv)

    report = build_report(args)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    args.out.with_suffix(".md").write_text(
        render_markdown(report), encoding="utf-8"
    )
    print(f"wrote {args.out}")
    print(f"wrote {args.out.with_suffix('.md')}")

    if args.local:
        fixtures = load_local_corpus(LOCAL_DIR)
        if not fixtures:
            print(f"no local corpus in {LOCAL_DIR} (skipped)")
        else:
            results = {f.name: run_fixture(f) for f in fixtures}
            out = LOCAL_DIR / "results_local.json"
            out.write_text(
                json.dumps(
                    {
                        "note": "private corpus — gitignored, do not commit",
                        "git": _git_commit(),
                        "corpus": {"fixture_count": len(fixtures)},
                        "results": results,
                        "summary": summarize(results),
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            print(f"wrote {out} (gitignored)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
