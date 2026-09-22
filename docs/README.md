# Documentation

Read in this order if you are new to the project.

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | How the pieces fit together, the `rag` schema, and why Supabase / its own project / direct Postgres instead of PostgREST / an agent-neutral design / a single `rag.search()` |
| [harness-reset.md](./harness-reset.md) | The Claude Code harness before and after the reset — 71→12 skills, 58→0 agents, 60→0 commands, 22→1 hooks, 220→0 permission rules — and what it cost |
| [ingestion.md](./ingestion.md) | The ingestion pipeline: parse → chunk → embed → upsert, how `content_hash` skips unchanged documents, the vault layout, and the SessionEnd capture hook that feeds it |
| [embeddings.md](./embeddings.md) | Text → tokenizer → `bge-small-en-v1.5` → 384-dim vector → HNSW, why 384 dimensions and cosine distance, the Node/Python parity check, and what changing the model would cost |
| [retrieval.md](./retrieval.md) | Hybrid vector + full-text search fused with Reciprocal Rank Fusion, the 0.70 relevance floor, the per-document cap, and the full `rag.search()` contract |
| [portable.md](./portable.md) | The harness on more than one machine: realms, the machine file, a local store, git sync — and the runbooks for a second machine and for migrating the home vault |
| [vault-migration-requirements.md](./vault-migration-requirements.md) | The migration contract: requirements with tests and definitions of done for moving the home vault into realms, bringing up the VM, and keeping the store correct — with the research each one rests on |
| [tags.md](./tags.md) | The controlled tag vocabulary for session notes: what raises each term, the five-tag cap, and the weekly `unclassified` review |

Database specifics — project ref, connection gotchas, migration mirror, access
model — are in [../db/README.md](../db/README.md). Component-level READMEs live
in [../hooks/](../hooks/README.md), [../ingest/](../ingest/README.md) and
[../mcp-server/](../mcp-server/README.md).

Diagrams are mermaid in fenced blocks and render natively on GitHub.

## Status

Phases 0–6 are built, live and verified against `harness-memory` as of
2026-09-09. Phase 7 (a second agent on the same store) and Phase 8 (the
self-evolution loop) are designed only, and every document says so where it
touches them. If anything here describes present-tense behaviour you cannot
verify against the database or the filesystem, that is a documentation bug.
