# Database

The RAG store lives in its own Supabase Postgres project, in a schema called `rag`.

| Property | Value |
| --- | --- |
| Project | `harness-memory` |
| Project ref | `hqkytnyiiuxovnnyixye` |
| Region | `us-east-1` |
| Postgres | 17 |
| pgvector | 0.8.2 |
| Schema owned by this repo | `rag` |
| Live contents | 1,324 documents, 2,360 chunks, 27 collections |

## Two stores exist. Never cross them.

|  | **harness-memory** (this repo) | **bb2dash** |
| --- | --- | --- |
| Project ref | `hqkytnyiiuxovnnyixye` | `goultdzqcavefcgnifdy` |
| Purpose | Session histories, tagged by project or class | Class materials + the bb2dash app |
| Schema | `rag` | `public` |
| Embedding model | `bge-small-en-v1.5`, local fastembed | `gte-small`, Supabase Edge Runtime |
| Dimensions | 384 | 384 |

Both are 384-dimensional, so a query vector from one model runs against the other's rows
**without any error** and returns confidently-ranked nonsense. The MCP server refuses a
`DATABASE_URL` containing the bb2dash ref; nothing else stands between you and that mistake, so
keep the two projects' credentials in separate `.env` files (bb2dash's live in its own repo).

## Why its own project

The store started life on 2026-09-09 as a `rag` schema inside `bb2dash`, because the Supabase
free tier allows two active projects and both slots were taken. That same day
`quant-edge-tracker-v2` — which held 0 bets and 0 bankroll rows — was paused to free a slot, the
harness got `harness-memory`, and the empty `rag` schema was dropped from `bb2dash`.

What that bought: no shared connection pool with a live application, no shared storage quota,
and no way for a destructive statement typed against the wrong schema to reach the bb2dash
tables. Schema-level isolation was a reasonable stopgap; project-level isolation is simply better
and cost nothing once the slot existed.

## Migrations

`migrations/` mirrors what has actually been applied to `harness-memory`. It is a mirror, not the
mechanism: migrations are applied through the Supabase MCP `apply_migration` tool, which
authenticates without needing a local secret. The files here exist so the schema is reviewable
in the repo and reproducible if the project is ever rebuilt.

File names use the remote `version` timestamp so the directory sorts in apply order and each
file maps one-to-one to a row in `supabase_migrations.schema_migrations`. The bodies are copied
verbatim from that table.

| File | What it does |
| --- | --- |
| `20260909175037_create_rag_schema.sql` | Schema `rag`, tables `documents` (with `collection`) and `chunks`, HNSW + GIN + btree indexes, the `updated_at` trigger, RLS enabled |
| `20260909175058_create_rag_hybrid_search.sql` | `rag.search()`: hybrid vector + full-text retrieval fused with RRF, `filter_source`, `filter_collection`, `max_per_document`; raises when both query arguments are null |
| `20260909190458_rag_search_relevance_floor.sql` | Adds `min_similarity` (default 0.70) gating the vector arm, and the `vector_similarity` output column. Measured on this corpus: relevant 0.79–0.83, nonsense 0.48–0.66 |
| `20260915144257_rag_search_filter_metadata.sql` | Adds `filter_metadata jsonb` (a `@>` contains-match on frontmatter, pushed into both arms) and `include_superseded boolean default true`; re-asserts the `documents_metadata_idx` GIN index the filter needs, and pins the function's `search_path` |
| `20260921223446_rag_search_question_tolerant_text.sql` | The text arm also admits a chunk matching at least half the query's lexemes (minimum two) whose cosine is within 0.08 of `min_similarity`, so a natural-language question gets keyword support instead of an all-terms-or-nothing match. Signature unchanged |
| `20260921223612_rag_search_strict_matches_first.sql` | Inside the text arm, chunks matching every term rank ahead of partial matches. Fixes two golden cases the previous migration pushed out of the top 3 |

## Access model

RLS is enabled on both tables with **no policies defined**. In Postgres that means nothing gets
through except the service role, which bypasses RLS.

This is intentional. There is no browser client and no per-user access to model, so the simplest
correct answer is "deny everyone, let the two trusted server-side processes in". If a multi-user
client is ever added, policies get written then — the tables are already RLS-enabled, so nothing
leaks in the meantime.

### Connect over direct Postgres, not PostgREST

The `rag` schema is **not exposed to the REST API**, and will not be. Probed on the original
host project and equally true here:

```
POST /rest/v1/rpc/search   (Content-Profile: rag)
  -> HTTP 406  PGRST106
     "Only the following schemas are exposed: public, graphql_public"
```

Both the ingestion pipeline and the MCP server connect with `DATABASE_URL`. Exposing the schema
would buy nothing (no browser needs it) and bulk chunk insertion over HTTP would be thousands of
round-trips where a direct connection batches. Full reasoning in
[../docs/architecture.md](../docs/architecture.md#why-direct-postgres-and-not-postgrest).

### Connection specifics — each of these cost an hour

- Use the **session pooler**: `aws-0-us-east-1.pooler.supabase.com:5432`. The direct host
  `db.<ref>.supabase.co` is AAAA-only, and a machine without routable IPv6 gets a misleading
  `ENOTFOUND`.
- The username is `postgres.<project-ref>`, not plain `postgres`. The pooler strips the suffix
  after routing, so an auth failure reports user `postgres` regardless.
- Port 6543 is the *transaction* pooler and does not support prepared statements. Use 5432.
- TLS needs Supabase's own root CA: `certs/prod-ca.crt` in this repo (public, not a secret, valid
  to 2031). Point `DATABASE_CA_CERT` / `PGSSLROOTCERT` at it with a `C:/...` path.
- A connection held open across a long embedding run gets reaped by the pooler. The ingestion
  store reconnects and retries, with TCP keepalives.

The only variable that matters:

```
DATABASE_URL   # postgresql://postgres.hqkytnyiiuxovnnyixye:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

## Verifying the mirror

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;
```

Every row should have a matching `<version>_<name>.sql` in `migrations/`, and the six files
above are the complete list as of 2026-09-15.

"Mirror" means byte-identical, and that is checkable. `apply_migration` stores the query it was
given verbatim — one array element, comments and all — so the file and the row must hash the
same:

```sql
select version, name, md5(statements[1]) as applied, octet_length(statements[1]) as bytes
from supabase_migrations.schema_migrations order by version;
```

```bash
python -c "import hashlib,pathlib;print(hashlib.md5(pathlib.Path('db/migrations/<file>.sql').read_bytes()).hexdigest())"
```

Checked for `20260915144257`: both `0d221c15b32bc28c25ab7ddf4a42749c`, 7,771 bytes. Files are
stored with LF endings (`.gitattributes`), which is what the hash is taken over — a CRLF working
copy would not match.

### Verifying a filter is index-served, not scanned

`filter_metadata` is only worth having if Postgres reaches it through
`documents_metadata_idx` rather than reading all 1,324 documents. `EXPLAIN` on either arm of
`rag.search` should show a bitmap index scan:

```
->  Bitmap Heap Scan on documents d (actual rows=2)
      Recheck Cond: (metadata @> '{"repo": "emstacho-su/bb2dash", "phase": "phase-9"}'::jsonb)
      Filter: (COALESCE((metadata ->> 'status'), '') <> 'superseded')
      ->  Bitmap Index Scan on documents_metadata_idx (actual rows=2)
            Index Cond: (metadata @> '{"repo": "emstacho-su/bb2dash", "phase": "phase-9"}'::jsonb)
```

The bitmap scan must be the **driving** node, with the chunk scan nested inside
it. If `documents` appears below the chunk scan instead, the filter has become a
post-ANN filter: results are still returned, fewer than `match_count` of them,
and nothing looks broken.
