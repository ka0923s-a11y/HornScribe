"""Schema migration entry point (FND-001).

Migrations are pure functions ``dict -> dict`` registered per source version.
v1 -> v1 is the identity migration and exists so the interface is exercised
from day one. Unknown versions fail safely in ``HornScribeProject.from_dict``
before migration is even attempted... except ``migrate_project_dict`` gives
callers one explicit funnel to route raw documents through.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from hornscribe.project.errors import SchemaVersionError
from hornscribe.project.model import SCHEMA_VERSION

Migration = Callable[[dict[str, Any]], dict[str, Any]]


def _identity(data: dict[str, Any]) -> dict[str, Any]:
    return data


MIGRATIONS: dict[int, Migration] = {
    1: _identity,
}


def migrate_project_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Migrate a raw project document to the current schema version."""
    version = data.get("schemaVersion")
    if not isinstance(version, int):
        raise SchemaVersionError(f"cannot migrate document with schemaVersion {version!r}")
    if version > SCHEMA_VERSION:
        raise SchemaVersionError(
            f"document schemaVersion {version} is newer than supported {SCHEMA_VERSION}"
        )
    current = data
    while version < SCHEMA_VERSION:
        migration = MIGRATIONS.get(version)
        if migration is None:
            raise SchemaVersionError(f"no migration path from schemaVersion {version}")
        current = migration(current)
        version += 1
    return current
