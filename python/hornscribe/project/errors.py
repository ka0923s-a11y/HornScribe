"""Project persistence errors."""

from __future__ import annotations


class ProjectError(Exception):
    """Base class for project persistence failures."""


class SchemaVersionError(ProjectError):
    """Missing, corrupt, or unsupported ``schemaVersion``."""


class ProjectValidationError(ProjectError):
    """Project document failed schema/contract validation."""


class SourceAudioMissingError(ProjectError):
    """Source audio path is missing and could not be relinked."""


class SourceAudioHashMismatchError(ProjectError):
    """A candidate relink path does not match the recorded content hash."""
