# Documentation

Read in this order if you are new to the project.

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | How the pieces fit together, the `rag` schema, and why Supabase / a shared schema / direct Postgres instead of PostgREST / an agent-neutral design / a single `rag.search()` |
| [harness-reset.md](./harness-reset.md) | The Claude Code harness before and after the reset — 71→12 skills, 58→0 agents, 60→0 commands, 22→0 hooks, 220→0 permission rules — and what it cost |
| [ingestion.md](./ingestion.md) | The ingestion pipeline: parse → chunk → embed → upsert, and how `content_hash` skips unchanged documents |
| [embeddings.md](./embeddings.md) | Text → tokenizer → `bge-small-en-v1.5` → 384-dim vector → HNSW, why 384 dimensions and cosine distance, and what changing the model would cost |
| [retrieval.md](./retrieval.md) | Hybrid vector + full-text search fused with Reciprocal Rank Fusion, why RRF beats weighted score mixing, and what `k = 60` does |

Database specifics — project ref, migration mirror, access model — are in
[../db/README.md](../db/README.md).

Diagrams are mermaid in fenced blocks and render natively on GitHub.

## Status

Phases 4, 5, 7 and 8 are **not built**. Documents describing them say so at the
top. Nothing here should be read as a description of running code unless it is
marked as applied and verified.
