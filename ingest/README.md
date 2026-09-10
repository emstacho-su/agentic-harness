# `ingest` — RAG ingestion pipeline

Turns an Obsidian vault and the migrated claude-mem history into rows in
`rag.documents` and `rag.chunks` on the `harness-memory` Supabase Postgres
(project ref `hqkytnyiiuxovnnyixye` — **not** `bb2dash`, which holds a different corpus
embedded with a different model).

Two loaders, one pipeline:

```
loader ──▶ SourceDocument ──▶ sha256 hash ──▶ unchanged? ──yes──▶ skip (no embed, no write)
                                                  │no
                                                  ▼
                                    markdown chunker (token-aware)
                                                  ▼
                                    fastembed / bge-small-en-v1.5
                                                  ▼
                        one transaction: upsert document, delete chunks, insert chunks
```

---

## Setup

Prerequisites: `uv` (0.9.26+). No system Python needed — uv manages it.

```bash
uv python install 3.12          # once, if you have no uv-managed Python
cd C:/Users/estac/agentic-harness/ingest
uv sync                         # creates .venv and installs everything
uv run pytest                   # verify
```

The first real (non-dry) run downloads the ONNX weights for
`BAAI/bge-small-en-v1.5` (~130 MB) into fastembed's cache. Every run after that
is fully offline — no API key, no network, no cost.

> **Windows paths.** Always pass `C:/Users/...`. An MSYS-style `/c/Users/...`
> path silently resolves to `C:\c\Users\...` for anything that is not the bash
> shell itself, and fails with a misleading ENOENT.

---

## Environment

Credentials come from the environment. Nothing is ever hardcoded, committed or
printed. The CLI walks up from the package looking for a `.env` (so the repo
root `.env` is found automatically); **an exported variable always wins over the
file**.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | for writes | Direct Postgres URI. The only write path. |
| `DATABASE_CA_CERT` | for writes | Absolute path to Supabase's root CA (`certs/prod-ca.crt`). Connections are `sslmode=verify-full` and never downgrade; `PGSSLROOTCERT` is accepted as an alias. |
| `DATABASE_SSL` | no | `disable` turns TLS off for a local Postgres only. No `prefer`, no `no-verify`. |
| `SUPABASE_URL` | no | Reported by `--check-env`; used by the MCP server. |
| `SUPABASE_SERVICE_ROLE` | no | Same. `SUPABASE_SERVICE_KEY` is accepted as a legacy alias. |

```bash
uv run ingest --check-env       # presence report; never prints a value
```

**There is no PostgREST path, by design.** The `rag` schema is not exposed on
the project's REST surface (`PGRST106`) and will not be — a REST surface is
anon-facing by nature and exposing the store there buys nothing. Direct Postgres is also far faster for
bulk chunk inserts than thousands of HTTP round-trips.

`--dry-run` works with no credentials at all. Without `DATABASE_URL` it cannot
tell new from changed, so it reports everything as new and says so.

---

## Usage

```bash
# Obsidian vault
uv run ingest --source obsidian --path "C:/Users/estac/OneDrive - Syracuse University/vault"

# claude-mem export directory
uv run ingest --source claude-mem --path C:/Users/estac/.claude-archive/2026-09-09/claude-mem-export

# Plan without touching anything
uv run ingest --source obsidian --path C:/Users/estac/vault --dry-run

# bb2dash class materials -> vault notes (ingest: false; read-only against bb2dash)
uv run export-materials --env-file C:/Users/estac/projects/bb2dash/.env \
    --vault "C:/Users/estac/OneDrive - Syracuse University/vault" [--dry-run] [--course IST.323]
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report new/changed/unchanged and the chunk count. No embedding, no writes. |
| `--force` | Re-chunk and re-embed even when the hash is unchanged. Use after a model or chunk-config change. |
| `--limit N` | Process at most N documents. Useful for a first smoke test. |
| `--no-summaries` | claude-mem only: skip `session_summaries.json`. |
| `--no-prompts` | claude-mem only: skip `user_prompts.json`. |
| `--prune` | **Destructive.** Orphan sweep — see below. Off by default. |
| `--env-file PATH` | Use a specific `.env` instead of the walk-up search. |
| `--check-env` | Print which connection variables are set, then exit. |
| `-v` | Debug logging. |

Exit codes: `0` success, `1` at least one document failed (or a fatal config
error), `2` bad arguments.

---

## What each loader produces

### `obsidian`

| Column | Value |
| --- | --- |
| `source` | `obsidian` |
| `external_id` | frontmatter `id:` when present, else vault-relative POSIX path |
| `agent` | `claude-code` |
| `title` | frontmatter `title`, else first H1, else filename stem |
| `body` | the note with frontmatter stripped |
| `metadata` | the frontmatter verbatim, plus `_ingest` |

**Prefer an `id:` in notes you expect to move.** With a path-based key a rename
is indistinguishable from delete-plus-create: the old row is stranded and a
duplicate appears. A stable `id:` (a UUID) survives the rename.

* A missing or blank `id:` falls back to the path — adding an id later is a
  legitimate migration, and refusing the note would lose content over a
  formatting detail.
* A structurally wrong `id:` (a list, a mapping, a multi-line block, anything
  over 512 characters) skips the note and says why.
* Two notes claiming the same `id:` would silently overwrite each other through
  the upsert key, so the second is refused and the conflict is named.
* `_ingest.id_source` records whether the identity came from `frontmatter` or
  `path`.

Ingest-added keys are nested under `_ingest` (`path`, `id_source`, `filename`,
`folder`, `modified_at`, `bytes`, `loader`) so they can never collide with a
user's own frontmatter key named `path` or `source`.

`.obsidian/`, `.trash/`, `.git/`, `node_modules/`, `.venv/` and `__pycache__/`
are skipped at any depth; the vault-root `templates/` folder (Obsidian's own)
is skipped too, but a deeper `templates/` is ordinary content. A note whose
YAML is malformed is skipped and counted — one bad note never aborts a vault
ingest.

**`ingest: false`** in frontmatter opts a note out of embedding. It is reported
as a skip (`frontmatter ingest: false`), never hidden. `no`, `off`, `'false'`
and `0` are accepted; a list, mapping or empty string is refused as a typo.
Opting out a note that was *already* embedded leaves its rows in place — run
`--prune` to remove them. Class materials exported from bb2dash carry this flag
— see `export-materials` below.

### `export-materials` (bb2dash → vault, not a loader)

Reads `bb_files` + `bb_file_text` from the **bb2dash** Supabase project over
PostgREST and writes one note per file to
`classes/<course>/materials/<slug>-<id>.md` with `id: bb2dash-file-<id>`,
`type: material`, `source: bb2dash` and `ingest: false`. `--env-file` is
required and is read directly (never merged into the process environment); the
URL must be the bb2dash project or the run refuses with exit code `2`, as does
a malformed `--course`. Superseded, unextracted, empty and unmappable files are
reported as skips; a `--course` that matches nothing is an error. Idempotent:
unchanged notes are not rewritten. It never writes to bb2dash. Full rationale
in [docs/ingestion.md](../docs/ingestion.md).

### `claude-mem`

Three of the four export files become documents, all under
`source='claude-mem'`, with distinct `external_id` prefixes so they cannot
collide inside one source:

| File | Rows | Ingested | `external_id` | Body | Title |
| --- | --- | --- | --- | --- | --- |
| `observations.json` | 461 | **443** | `<id>` | `narrative` (legacy `text` fallback) | `title` |
| `session_summaries.json` | 141 | **137** | `summary:<id>` | six prose columns as `## ` sections | from `request` |
| `user_prompts.json` | 725 | **725** | `prompt:<id>` | `prompt_text` | none |
| `sdk_sessions.json` | 103 | — | not ingested | — | — |

`sdk_sessions.json` is pure session metadata (timestamps, status, worker port)
with nothing to embed. It is read only to enrich the other three, joined on
whichever session id that record carries:

* observations and summaries join on `memory_session_id`
* prompts join on `content_session_id` — prompts have no `memory_session_id`

The joined fields land under `metadata._session`, namespaced so they cannot
shadow a real column. `worker_port` is deliberately dropped: an ephemeral local
detail with no retrieval value. Prompts additionally inherit `project` from
their session, since they carry no project column of their own. On the
2026-09-09 export every one of the 1305 ingested documents resolves to a
session.

`facts`, `concepts`, `files_read` and `files_modified` are JSON **inside a TEXT
column**, not arrays. They are decoded into real lists in `metadata`. Malformed
JSON skips that one row rather than being swallowed.

Deliberate skips, all counted and printed:

* **18 observations** (ids 68–164, all within `2026-05-07 06:09–08:27`) with no
  narrative, no text and no title — failed writes from that day's
  data-directory migration. 461 exported, **443 ingested**.
* **4 session summaries** whose six prose columns are all blank. 141 exported,
  **137 ingested**. (Not in CONTEXT.md; found while probing the export.)

Total: **1305 documents, 2278 chunks** from the export; vault notes captured since add to that
(1,319 / 2,312 as of 2026-09-10).

The exporter's own 16-character `content_hash` is kept as
`metadata.source_content_hash` for provenance. It is *not* what goes into
`rag.documents.content_hash` — that is our own sha256.

---

## Orphan sweep (`--prune`)

After a *complete* pass over one source, any `external_id` still in
`rag.documents` that the loader did not produce is an orphan: a deleted note, or
a note renamed while it had no stable frontmatter `id:`.

This is the only destructive operation in the package, so it is **off by
default** and refuses to run unless the sweep can be trusted:

* `--limit` was used — the seen set is not a full pass, so a sweep would delete
  most of the corpus;
* any document failed — the seen set is incomplete;
* the loader produced nothing — a mistyped path or an unmounted OneDrive folder
  would otherwise wipe the source.

Each guard prints why it declined. `--prune --dry-run` lists exactly what would
be deleted without touching anything. `rag.chunks` cascades from
`rag.documents`, so one delete removes both.

---

## Chunking

All budgets live in `ChunkConfig` in `src/ingest/config.py`.

| Parameter | Value | Why |
| --- | --- | --- |
| `target_tokens` | 384 | bge-small accepts 512. ~25% headroom lets a chunk carry a heading breadcrumb and an overlap block without the tokenizer silently truncating it. |
| `overlap_tokens` | 64 | One sixth of a chunk. Enough that a sentence split across a boundary is retrievable from either side; storage and embedding cost rise only ~17%. |
| `min_tokens` | 32 | Shorter fragments (a lone heading, one list item) embed to near-noise and pollute the top-k, so a runt trailing chunk is folded into its predecessor. |
| `hard_max_tokens` | 480 | Absolute ceiling after breadcrumb and overlap. Still under 512, so nothing is ever truncated by the model. |

**Structure is respected.** The chunker packs *blocks* (heading, fenced code,
table, list run, paragraph), never raw lines:

* A code fence that fits is never split. One that does not is split on **line**
  boundaries and the fence is re-opened and re-closed on every part, so no chunk
  ever contains an unbalanced fence.
* A table that does not fit is split on **row** boundaries with the header and
  separator repeated on each part, so every piece is still a valid table.
* An oversized paragraph splits at sentence boundaries, then line, then word.
  Only a single token-dense blob with no whitespace (a base64 string, a minified
  line) is ever cut mid-token.
* Code and table blocks are **not** duplicated into the next chunk's overlap.
  Repeating them doubles the most token-expensive content in the corpus for
  little retrieval gain, and a half-repeated fence reads as broken markdown.

**Heading breadcrumb.** Each chunk is prefixed with `Title > H1 > H2` so it stays
interpretable once torn out of its file. Toggle with
`ChunkConfig.include_heading_breadcrumb`.

**Token counting.** A real run uses the model's own WordPiece tokenizer, dug out
of fastembed, so `rag.chunks.token_count` is exactly what the model saw. If that
tokenizer cannot be reached the pipeline logs a warning and falls back to a
heuristic counter — it never fails silently. `--dry-run` and the test suite
always use the heuristic, so neither downloads a model.

---

## Embeddings

`BAAI/bge-small-en-v1.5`, **384 dimensions**, local via `fastembed` (ONNX, CPU).

The model name and dimension live in one place: `EMBEDDING` in
`src/ingest/config.py`. Swapping models is one edit there plus
`uv run ingest --force`, not a refactor.

Weights are cached in `~/.cache/fastembed` (override with `FASTEMBED_CACHE_DIR`).
fastembed's own default is the system temp directory, which Windows is free to
clean out — that would silently re-download 130 MB on some future run. The cache
must stay **out of OneDrive**: binary indexes plus OneDrive sync have already
caused file-lock failures in this project.

Every returned vector is checked
against the configured dimension before it reaches the database, because
`rag.chunks.embedding` is fixed at `extensions.vector(384)` — a mismatch there
would otherwise surface as an opaque Postgres error mid-run.

Vectors are sent as pgvector text literals cast to `extensions.vector` in SQL,
so there is no runtime dependency on the `pgvector` Python package.

---

## Change detection and re-runs

`rag.documents.content_hash` is the sha256 of the **normalised** body:
Unicode NFC, CRLF/CR → LF, trailing whitespace stripped per line, blank-line
runs collapsed. That means a OneDrive round-trip or an editor adding a trailing
newline does not trigger a needless re-embed. The stored `body` is the original
text; only the hash input is normalised.

On re-ingest:

* **hash unchanged** → skipped entirely. No chunking, no embedding, no SQL write.
* **hash changed** → in one transaction: upsert the document on
  `(source, external_id)`, delete its chunks, insert the new ones. If any step
  fails, the document keeps its previous chunks — never a half-rewritten
  document, never duplicate chunks.

A failed document is logged and counted; the run continues and exits `1`.

---

## Tests

```bash
uv run pytest
uv run pytest --cov=ingest --cov-report=term-missing
```

The database is mocked (`FakeStore`, and a fake psycopg connection that asserts
the exact SQL and transaction sequence) and the embedder is mocked
(`FakeEmbedder`), so the suite needs no credentials, no network and no model
download. Coverage includes chunker boundaries (code fences, tables, oversized
paragraphs, overlap, the hard ceiling), hash-based skip logic, the 18-empty-row
skip and the 461 → 443 arithmetic, frontmatter parsing, and the JSON-in-TEXT
column decoding.

---

## Layout

```
ingest/
  pyproject.toml
  src/ingest/
    config.py           model name, dimensions, chunk budgets, env names
    errors.py           typed errors; nothing is swallowed
    models.py           SourceDocument, Chunk, DocumentState
    hashing.py          normalise + sha256
    markdown_blocks.py  markdown -> structural blocks
    chunking.py         blocks -> chunks, with overlap
    tokenizer.py        real tokenizer, heuristic fallback
    embedding.py        fastembed wrapper + pgvector literal
    store.py            the only SQL in the package
    pipeline.py         hash -> skip -> chunk -> embed -> write
    prune.py            guarded orphan sweep
    envfile.py          minimal .env reader
    cli.py              argument parsing and reporting
    loaders/
      obsidian.py
      claude_mem.py
      claude_mem_sessions.py
  tests/
```
