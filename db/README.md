# Database

The RAG store lives in a Supabase Postgres project, in a schema called `rag`.

| Property | Value |
| --- | --- |
| Project ref | `goultdzqcavefcgnifdy` (`bb2dash`) |
| Region | `us-east-1` |
| Postgres | 17.6 |
| pgvector | 0.8.2 |
| Schema owned by this repo | `rag` |
| Schemas this repo must never touch | `public` (the bb2dash application) |

## Why this project and not a dedicated one

The Supabase free tier allows two active projects, and both slots were already
taken. Rather than pay for a third project or pause a working one, the RAG store
was given its own schema inside an existing project. Postgres schemas are a real
isolation boundary: separate namespace, separate grants, separate migrations.
The cost is a shared connection pool and a shared storage quota with `bb2dash`.

If the store ever outgrows that, moving it is a `pg_dump --schema=rag` and a
restore — not a rewrite.

## Migrations

`migrations/` mirrors what has actually been applied to the remote project. It
is a mirror, not the mechanism: migrations are applied through the Supabase MCP
`apply_migration` tool, which authenticates without needing a local secret. The
files here exist so the schema is reviewable in the repo and reproducible if the
project is ever rebuilt.

File names use the remote `version` timestamp so the directory sorts in apply
order and each file maps one-to-one to a row in
`supabase_migrations.schema_migrations`.

| File | Remote version | What it does |
| --- | --- | --- |
| `20260909170410_create_rag_schema.sql` | `create_rag_schema` | Creates schema `rag`, tables `documents` and `chunks`, all indexes including the HNSW vector index, the `updated_at` trigger, and enables RLS |
| `20260909170451_create_rag_hybrid_search.sql` | `create_rag_hybrid_search` | Creates `rag.search()`, the hybrid vector + full-text retrieval function fused with Reciprocal Rank Fusion |

Migrations `001_schema` through `010_search_layer` also exist on this project.
Those belong to the `bb2dash` application and are deliberately **not** mirrored
here — they are another project's schema.

## Access model

RLS is enabled on both tables with **no policies defined**. In Postgres that
means nothing gets through except the service role, which bypasses RLS.

This is intentional. There is no browser client and no per-user access to model,
so the simplest correct answer is "deny everyone, let the two trusted server-side
processes in". If a multi-user client is ever added, policies get written then —
the tables are already RLS-enabled, so nothing leaks in the meantime.

### Connect over direct Postgres, not PostgREST

The `rag` schema is **not exposed to the REST API**, and will not be:

```
POST /rest/v1/rpc/search   (Content-Profile: rag)
  -> HTTP 406  PGRST106
     "Only the following schemas are exposed: public, graphql_public"
```

Both the ingestion pipeline and the MCP server connect with `DATABASE_URL`. Two
reasons: `bb2dash` has a public anon-facing REST surface and there is no benefit
to widening it, and bulk chunk insertion over HTTP would be thousands of
round-trips where a direct connection batches. Full reasoning in
[../docs/architecture.md](../docs/architecture.md#why-direct-postgres-and-not-postgrest).

Environment variables — use these exact names:

```
DATABASE_URL           # direct Postgres connection
SUPABASE_SERVICE_ROLE  # service role secret (not SUPABASE_SERVICE_KEY)
SUPABASE_URL           # project endpoint; serves `public`, not `rag`
```

## Verifying the mirror

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;
```

Anything in that list starting with `create_rag_` should have a matching file in
`migrations/`.
