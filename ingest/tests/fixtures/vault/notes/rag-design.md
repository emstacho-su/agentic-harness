---
title: RAG Store Design
tags:
  - rag
  - pgvector
status: active
created: 2026-09-01
priority: 2
---

# RAG Store Design

The store unifies an Obsidian vault with six months of migrated agent memory. Retrieval
is hybrid: a vector arm and a full-text arm, fused with reciprocal rank fusion so neither
score has to be normalised against the other.

## Schema

Two tables live in the `rag` schema. Documents hold the whole body and a content hash;
chunks hold the embeddable slices and the vector.

| Table | Key | Notes |
| --- | --- | --- |
| `rag.documents` | `(source, external_id)` | one row per note or observation |
| `rag.chunks` | `(document_id, chunk_index)` | cascade delete from documents |

## Upsert

Re-ingesting an unchanged document must cost nothing. The hash is compared before any
model work happens.

```python
digest = content_hash(document.body)
if state and state.content_hash == digest:
    return  # no embed, no write
```

That check is the whole of the change-detection story.
