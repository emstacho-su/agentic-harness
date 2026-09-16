"""bb2dash class materials -> Obsidian vault markdown.

Reads the extracted text that bb2dash already holds (``bb_files`` +
``bb_file_text``) over PostgREST and writes one note per file under
``classes/<collection>/materials/`` in the vault.

Every exported note carries ``ingest: false``. The vault is where the material
is *read*; retrieval over it stays in the bb2dash store (gte-small, its own MCP
server). Embedding it into harness-memory (bge-small) would silently mix two
vector spaces — see CONTEXT.md, "TWO SEPARATE RAG STORES".

This package only ever reads from bb2dash. It never writes to that project.
"""
