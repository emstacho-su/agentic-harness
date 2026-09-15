"""Source loaders. Both produce ``SourceDocument`` for the same pipeline."""

from .base import LoadedSource, SkippedRecord
from .claude_mem import load_claude_mem
from .obsidian import load_vault, load_vault_note

__all__ = [
    "LoadedSource",
    "SkippedRecord",
    "load_claude_mem",
    "load_vault",
    "load_vault_note",
]
