"""RAG ingestion pipeline for the agentic harness.

Obsidian markdown and the migrated claude-mem history both flow through one
pipeline: hash -> skip-if-unchanged -> chunk -> embed -> upsert into
``rag.documents`` / ``rag.chunks``.
"""

from .config import CHUNKING, EMBEDDING
from .models import Chunk, DocumentState, SourceDocument
from .pipeline import Action, IngestPipeline, IngestStats

__version__ = "0.1.0"

__all__ = [
    "CHUNKING",
    "EMBEDDING",
    "Action",
    "Chunk",
    "DocumentState",
    "IngestPipeline",
    "IngestStats",
    "SourceDocument",
    "__version__",
]
