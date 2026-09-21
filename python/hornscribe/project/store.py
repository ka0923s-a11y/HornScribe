"""Project file IO: atomic writes, recovery snapshot, source relink (FND-001).

Write protocol
--------------
1. Serialize to ``<name>.tmp`` in the same directory.
2. fsync, then ``os.replace`` onto the target (atomic on Windows + POSIX).
3. Keep the previous good file as ``<name>.recovery`` before replacing —
   exactly one recovery snapshot, per plan.
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any

from hornscribe.project.errors import (
    ProjectValidationError,
    SourceAudioHashMismatchError,
    SourceAudioMissingError,
)
from hornscribe.project.model import HornScribeProject, hash_file_sha256

RECOVERY_SUFFIX = ".recovery"
TMP_SUFFIX = ".tmp"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + TMP_SUFFIX)
    blob = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(blob)
        handle.flush()
        os.fsync(handle.fileno())
    if path.exists():
        recovery = path.with_name(path.name + RECOVERY_SUFFIX)
        os.replace(path, recovery)
    os.replace(tmp, path)


class ProjectStore:
    """Load/save HornScribe project files with corruption-safe semantics."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def save(self, project: HornScribeProject, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(path, project.to_dict())

    def load(self, path: Path) -> HornScribeProject:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            recovery = path.with_name(path.name + RECOVERY_SUFFIX)
            if recovery.exists():
                data = json.loads(recovery.read_text(encoding="utf-8"))
            else:
                raise ProjectValidationError(f"unreadable project file {path}: {exc}") from exc
        return HornScribeProject.from_dict(data)

    def relink_source_audio(self, project: HornScribeProject, path: Path) -> HornScribeProject:
        """Return a project whose sourceAudio.originalPath points at *path*.

        The candidate file must hash to the recorded content hash; audio
        identity is content, not location.
        """
        if project.source_audio is None:
            raise SourceAudioMissingError("project has no sourceAudio to relink")
        if not path.is_file():
            raise SourceAudioMissingError(f"relink candidate not found: {path}")
        actual = hash_file_sha256(path)
        if actual != project.source_audio.content_hash:
            raise SourceAudioHashMismatchError(
                f"{path} hashes to {actual}, expected {project.source_audio.content_hash}"
            )
        return replace(
            project, source_audio=replace(project.source_audio, original_path=str(path))
        )

    def verify_source_audio(self, project: HornScribeProject) -> Path:
        """Resolve the recorded source path and verify content identity."""
        if project.source_audio is None:
            raise SourceAudioMissingError("project has no sourceAudio")
        path = Path(project.source_audio.original_path)
        if not path.is_file():
            raise SourceAudioMissingError(f"source audio missing: {path}")
        if hash_file_sha256(path) != project.source_audio.content_hash:
            raise SourceAudioHashMismatchError(f"source audio changed on disk: {path}")
        return path
