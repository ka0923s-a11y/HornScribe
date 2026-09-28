"""UI-006: validate the canonical ja-JP copy deck and Japanese UI fixtures.

Locks in the Japanese-only UI contract (MASTER_PLAN §8,
docs/JAPANESE_UI_COPY.md, docs/UI_COPY_CONTRACT.md) before the desktop app
exists:

- exactly one copy deck, ``protocol/copy/ja-JP.json``
- required copy groups and canonical terminology are present
- no untranslated English copy (proper-noun whitelist only)
- no banned terminology variants (エクスポート, レビュー, 譜面, …)
- no language/locale switcher keys anywhere in the deck
- review reasons cover the MASTER_PLAN §10 contract reasons and the
  HSQ-v1 reasons from JAPANESE_UI_COPY §14
- fixtures in ``fixtures/ui/`` only use copy that resolves from the deck
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
COPY_DIR = ROOT / "protocol" / "copy"
DECK_PATH = COPY_DIR / "ja-JP.json"
FIXTURE_DIR = ROOT / "fixtures" / "ui"

DECK: dict[str, Any] = json.loads(DECK_PATH.read_text(encoding="utf-8"))

REQUIRED_GROUPS = {
    "meta",
    "app",
    "common",
    "menus",
    "commandBar",
    "segments",
    "tooltips",
    "transport",
    "waveform",
    "score",
    "transcription",
    "review",
    "properties",
    "exportSheet",
    "settings",
    "diagnostics",
    "dialogs",
    "errors",
    "emptyStates",
    "loading",
    "firstRun",
    "dependencies",
    "notifications",
    "a11y",
}

# MASTER_PLAN §10 ReviewIssue.reason contract values.
MASTER_PLAN_REVIEW_REASONS = {
    "low_model_confidence",
    "very_short_detection",
    "overlapping_candidates",
    "quantization_ambiguous",
    "pitch_spelling_ambiguous",
    "outside_preferred_horn_range",
    "structural_measure_conflict",
}

# JAPANESE_UI_COPY §14 HSQ-v1 internal reasons that must have UI wording.
HSQ_REVIEW_REASONS = {
    "quantization_ambiguous",
    "beat_alignment_uncertain",
    "beat_map_uncertain",
    "possible_triplet",
    "possible_grace_note",
    "offset_ambiguous",
    "pickup_ambiguous",
    "meter_conflict",
    "overlapping_candidates",
    # #352: emitted by the engine — deck coverage is required.
    "key_uncertain",
}

# JAPANESE_UI_COPY §5 internal stage names.
TRANSCRIPTION_STAGES = {
    "preparing_audio",
    "transcribing",
    "cleaning",
    "analyzing_rhythm",
    "quantizing",
    "building_score",
    "rendering",
}

# Latin-alphabet tokens allowed inside Japanese copy (proper nouns, standards,
# formats, key names). Anything else ASCII-alphabetic is untranslated English.
ALLOWED_LATIN_TOKENS = {
    "HornScribe",
    "MusicXML",
    "MIDI",
    "FFmpeg",
    "MuseScore",
    "Basic",
    "Pitch",
    "Verovio",
    "pYIN",
    "Windows",
    "pip",
    "install",
    "engine",
    "hornscribe",
    "wavesurfer",
    "Python",
    "WAV",
    "MP3",
    "FLAC",
    "M4A",
    "OGG",
    "PDF",
    "BPM",
    "PC",
    "Ctrl",
    "Shift",
    "Alt",
    "Space",
    "Esc",
    "Home",
    "End",
    "Tab",
    "Enter",
    "Backspace",
    "Delete",
}

# Variants banned by JAPANESE_UI_COPY §12 plus generic English UI words.
BANNED_TERMS = (
    "エクスポート",
    "トランスクリプション",
    "セッティング",
    "レビュー",
    "譜面",
    "OK",
)

# Key-path segments that would imply a language switcher exists.
FORBIDDEN_KEY_SEGMENTS = {
    "language",
    "languages",
    "lang",
    "language_switcher",
    "language_selector",
    "locale_switcher",
    "locale_selector",
    "en_us",
    "english",
}

LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*")
PLACEHOLDER = re.compile(r"\{[a-z_][a-z0-9_]*\}")
ANY_BRACE = re.compile(r"[{}]")

FIXTURE_STATES = {
    "EMPTY",
    "AUDIO_READY",
    "TRANSCRIBING",
    "SCORE_READY",
    "REVIEWING",
    "EXPORTING",
    "ERROR",
    "LOADING",
    "FIRST_RUN",
    "SETTINGS",
}


def _iter_strings(node: Any, path: tuple[str, ...] = ()) -> Iterator[tuple[str, str]]:
    """Yield ``(dot.path, value)`` for every string leaf below ``node``."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _iter_strings(value, (*path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _iter_strings(value, (*path, str(index)))
    elif isinstance(node, str):
        yield ".".join(path), node


def _assert_only_string_leaves(node: Any, path: tuple[str, ...] = ()) -> None:
    """Copy groups may only contain dicts/lists/strings — no stray values."""
    if isinstance(node, dict):
        for key, value in node.items():
            _assert_only_string_leaves(value, (*path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _assert_only_string_leaves(value, (*path, str(index)))
    else:
        assert isinstance(node, str), f"non-string leaf at {'.'.join(path)}: {node!r}"


def _iter_key_paths(node: Any, path: tuple[str, ...] = ()) -> Iterator[str]:
    """Yield every key-path segment in the deck (keys, not leaf values)."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from _iter_key_paths(value, (*path, key))
    elif isinstance(node, list):
        for value in node:
            yield from _iter_key_paths(value, path)


def _copy_strings() -> list[tuple[str, str]]:
    """User-visible strings only: everything except the ``meta`` group."""
    out: list[tuple[str, str]] = []
    for group, node in DECK.items():
        if group == "meta":
            continue
        out.extend(_iter_strings(node, (group,)))
    return out


def _lookup(path: str) -> Any:
    node: Any = DECK
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            raise KeyError(f"copy deck is missing key: {path}")
        node = node[part]
    return node


def _fixture_paths() -> list[Path]:
    return sorted(FIXTURE_DIR.glob("*.json"))


def test_deck_is_the_only_copy_file() -> None:
    files = sorted(p.name for p in COPY_DIR.glob("*"))
    assert files == ["ja-JP.json"]


def test_meta_declares_ja_jp_only() -> None:
    assert DECK["meta"]["locale"] == "ja-JP"
    assert "en" not in DECK["meta"]["locale"]


def test_required_groups_present() -> None:
    missing = REQUIRED_GROUPS - set(DECK)
    assert not missing, f"missing copy groups: {sorted(missing)}"


def test_canonical_terminology() -> None:
    """Spot-check the glossary terms that anchors the whole UI."""
    canonical = {
        "segments.scoreView.concertPitch": "コンサートピッチ",
        "segments.scoreView.hornInF": "F管ホルン",
        "commandBar.transcribe.label": "採譜",
        "commandBar.retranscribe.label": "採譜し直す",
        "review.title": "要確認",
        "exportSheet.title": "書き出し",
        "exportSheet.submit": "書き出す",
        "settings.title": "設定",
        "properties.title": "プロパティ",
        "transport.followFull": "再生位置を追従",
        "transport.resumeFollow": "追従を再開",
        "diagnostics.title": "診断情報",
        "properties.fields.confidence": "モデル確信度",
        "transcription.running": "採譜中",
        "transcription.cancel": "キャンセル",
        "common.retry": "再試行",
        "common.undo": "元に戻す",
        "common.redo": "やり直す",
        "transcription.options.simplicity": "楽譜の簡潔さ",
        "exportSheet.revealInExplorer": "エクスプローラーで表示",
        "exportSheet.openInMusescore": "MuseScoreで開く",
        "settings.advanced.label": "詳細設定",
        "score.empty": "まだ楽譜はありません",
        "emptyStates.launch.headline": "ここに音声ファイルをドロップ",
    }
    for path, expected in canonical.items():
        assert _lookup(path) == expected, f"{path} must be 「{expected}」"


def test_no_untranslated_english() -> None:
    offenders = []
    for path, value in _copy_strings():
        stripped = PLACEHOLDER.sub(" ", value)
        for token in LATIN_WORD.findall(stripped):
            if token in ALLOWED_LATIN_TOKENS:
                continue
            if len(token) == 1 and token.isupper():
                continue  # key names such as J / K / L / F
            offenders.append(f"{path}: {value!r} (token {token!r})")
    assert not offenders, "untranslated English in copy deck:\n" + "\n".join(offenders)


def test_no_banned_terms() -> None:
    offenders = [
        f"{path}: {value!r}"
        for path, value in _copy_strings()
        for term in BANNED_TERMS
        if term in value
    ]
    assert not offenders, "banned terminology in copy deck:\n" + "\n".join(offenders)


def test_no_language_switcher_keys() -> None:
    offenders = [
        key for key in _iter_key_paths(DECK) if key.lower() in FORBIDDEN_KEY_SEGMENTS
    ]
    assert not offenders, f"language-switcher keys found: {sorted(set(offenders))}"


def test_no_other_locale_values() -> None:
    offenders = [
        f"{path}: {value!r}"
        for path, value in _iter_strings(DECK)
        if re.search(r"en[-_]US|en[-_]GB|\ben\b", value)
    ]
    assert not offenders, "non-ja locale references found:\n" + "\n".join(offenders)


def test_review_reasons_cover_contract() -> None:
    reasons = DECK["review"]["reasons"]
    required = MASTER_PLAN_REVIEW_REASONS | HSQ_REVIEW_REASONS
    missing = required - set(reasons)
    assert not missing, f"missing review reasons: {sorted(missing)}"
    for key, entry in reasons.items():
        assert set(entry) == {"title", "detail"}, f"review.reasons.{key} must have title+detail"
        assert entry["title"].strip(), f"review.reasons.{key}.title is empty"


def test_stage_labels_cover_internal_names() -> None:
    stages = DECK["transcription"]["stages"]
    missing = TRANSCRIPTION_STAGES - set(stages)
    assert not missing, f"missing stage labels: {sorted(missing)}"
    for key, entry in stages.items():
        assert set(entry) == {"pending", "active", "done"}, (
            f"transcription.stages.{key} must have pending/active/done"
        )


def test_error_surfaces_cover_dependency_failures() -> None:
    errors = DECK["errors"]
    for key in ("ffmpegMissing", "musescoreMissing", "workerCrashed"):
        assert key in errors, f"errors.{key} is required"
    for key, entry in errors.items():
        assert {"title", "body", "actions"} <= set(entry), (
            f"errors.{key} must have title/body/actions"
        )
        assert entry["title"].strip() and entry["body"].strip()
        assert entry["actions"], f"errors.{key}.actions must not be empty"


def test_copy_groups_contain_only_strings() -> None:
    for group, node in DECK.items():
        if group == "meta":
            continue
        _assert_only_string_leaves(node, (group,))


def test_all_copy_values_non_empty() -> None:
    empty = [path for path, value in _copy_strings() if not value.strip()]
    assert not empty, f"empty copy values: {empty}"


def test_placeholders_are_well_formed() -> None:
    offenders = []
    for path, value in _copy_strings():
        remainder = PLACEHOLDER.sub("", value)
        if ANY_BRACE.search(remainder):
            offenders.append(f"{path}: {value!r}")
    assert not offenders, "malformed placeholders:\n" + "\n".join(offenders)


def test_fixtures_exist() -> None:
    files = _fixture_paths()
    assert len(files) >= 12, f"expected >= 12 UI fixtures, found {len(files)}"


@pytest.mark.parametrize("path", _fixture_paths(), ids=[p.name for p in _fixture_paths()])
def test_fixture_copy_resolves_from_deck(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["screenState"] in FIXTURE_STATES, f"{path.name}: unknown screenState"
    assert data["elements"], f"{path.name}: fixture has no elements"
    seen_ids: set[str] = set()
    for element in data["elements"]:
        element_id = element["id"]
        assert element_id not in seen_ids, f"{path.name}: duplicate element id {element_id}"
        seen_ids.add(element_id)
        node = _lookup(element["copyKey"])
        assert isinstance(node, str), (
            f"{path.name}: {element['copyKey']} must resolve to a string"
        )
        rendered = node.format(**element.get("params", {}))
        assert element["text"] == rendered, (
            f"{path.name}: element {element_id} text {element['text']!r} "
            f"!= deck render {rendered!r}"
        )
