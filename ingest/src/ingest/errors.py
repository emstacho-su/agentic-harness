"""Typed errors. Nothing in this package swallows an exception silently."""

from __future__ import annotations


class IngestError(Exception):
    """Base class for every failure this package raises deliberately."""


class ConfigError(IngestError):
    """Missing or malformed configuration (env vars, CLI arguments)."""


class SourceError(IngestError):
    """A loader could not read or interpret its input."""


class DocumentError(IngestError):
    """A single document failed. The run continues; the failure is counted."""

    def __init__(self, external_id: str, message: str) -> None:
        super().__init__(f"{external_id}: {message}")
        self.external_id = external_id
        self.message = message


class EmbeddingError(IngestError):
    """The embedding backend failed or returned an unexpected shape."""


class StoreError(IngestError):
    """The database rejected a read or write."""
