-- Metadata filtering and superseded exclusion for session archival (R-27.5).
--
-- Session notes carry their whole frontmatter in rag.documents.metadata: repo,
-- branch, phase, tags, status, parent_session and the rest. Until now search
-- could narrow only by source and collection, so "Phase 7 sessions on
-- emstacho-su/bb2dash" had no expression at all.
--
-- filter_metadata is a jsonb CONTAINS match (metadata @> filter_metadata), one
-- predicate covering every shape the caller needs:
--     {"repo": "emstacho-su/bb2dash"}   scalar equality
--     {"phase": "phase-7"}
--     {"tags": ["review"]}              array containment: the note's tags must
--                                       include every tag listed
-- Array containment is why this is @> rather than a set of typed scalar
-- parameters. A key the corpus does not have matches nothing rather than
-- raising, which is precisely why the MCP tool exposes named inputs instead of
-- free-form jsonb: a hallucinated key would otherwise read as "no results".
-- A filter_metadata that is not a JSON object is a caller bug and raises.
--
-- The filter is pushed into BOTH arms, beside filter_source and
-- filter_collection. Filtering after the fusion would let excluded rows consume
-- candidate slots and return fewer than match_count, which is the classic
-- post-filter-after-ANN failure and reads as "nothing matched".
--
-- include_superseded = false drops documents whose metadata->>'status' is
-- 'superseded'. R-27.2 keeps a resumed session's earlier note ingested and
-- searchable, only out of the default result set; nothing is ever deleted. The
-- SQL default stays true so every existing caller behaves exactly as before.
-- The rag MCP server defaults it to false, which is where that policy belongs.
--
-- The GIN index this needs already exists (20260909175037) and is re-asserted
-- here because this function is the reason it has to. jsonb_path_ops indexes
-- only the @> operator and is 2-3x smaller than the default jsonb_ops; @> is
-- the only jsonb operator this function uses, so jsonb_ops would cost index
-- size and write amplification for operators nothing calls.
--
-- search_path is pinned, which also clears the Supabase linter's
-- 0011_function_search_path_mutable warning. extensions has to stay on the path
-- because the <=> cosine distance operator lives there.

create index if not exists documents_metadata_idx
  on rag.documents using gin (metadata jsonb_path_ops);

drop function if exists rag.search(extensions.vector, text, integer, text, text, integer, integer, double precision);

create function rag.search(
  query_embedding    extensions.vector(384) default null,
  query_text         text    default null,
  match_count        int     default 10,
  filter_source      text    default null,
  filter_collection  text    default null,
  rrf_k              int     default 60,
  max_per_document   int     default 3,
  min_similarity     double precision default 0.70,
  filter_metadata    jsonb   default null,
  include_superseded boolean default true
)
returns table (
  chunk_id          bigint,
  doc_id            bigint,
  doc_source        text,
  doc_collection    text,
  doc_external      text,
  doc_title         text,
  chunk_content     text,
  doc_metadata      jsonb,
  fused_score       double precision,
  vector_similarity double precision
)
language plpgsql
stable
set search_path = pg_catalog, extensions, rag
as $$
declare
  keep_superseded boolean := coalesce(include_superseded, true);
begin
  if query_embedding is null and query_text is null then
    raise exception
      'rag.search requires at least one of query_embedding or query_text'
      using hint = 'Pass an embedding for semantic search, text for lexical, or both for hybrid RRF.';
  end if;
  if match_count is null or match_count < 1 then
    raise exception 'rag.search: match_count must be >= 1, got %', match_count;
  end if;
  if max_per_document is not null and max_per_document < 1 then
    raise exception 'rag.search: max_per_document must be >= 1 or null, got %', max_per_document;
  end if;
  if filter_metadata is not null and jsonb_typeof(filter_metadata) <> 'object' then
    raise exception 'rag.search: filter_metadata must be a JSON object, got %', jsonb_typeof(filter_metadata)
      using hint = 'Contains-match against frontmatter, e.g. {"repo": "owner/name"} or {"tags": ["review"]}.';
  end if;

  return query
  with vec as (
    select c.id as cid,
           row_number() over (order by c.embedding <=> query_embedding) as rnk
    from rag.chunks c
    join rag.documents d on d.id = c.document_id
    where query_embedding is not null
      and c.embedding is not null
      and (filter_source     is null or d.source     = filter_source)
      and (filter_collection is null or d.collection = filter_collection)
      and (filter_metadata   is null or d.metadata  @> filter_metadata)
      and (keep_superseded or coalesce(d.metadata ->> 'status', '') <> 'superseded')
      and (min_similarity    is null or (1 - (c.embedding <=> query_embedding)) >= min_similarity)
    order by c.embedding <=> query_embedding
    limit greatest(match_count * 10, 100)
  ),
  txt as (
    select c.id as cid,
           row_number() over (order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc) as rnk
    from rag.chunks c
    join rag.documents d on d.id = c.document_id
    where query_text is not null
      and c.tsv @@ websearch_to_tsquery('english', query_text)
      and (filter_source     is null or d.source     = filter_source)
      and (filter_collection is null or d.collection = filter_collection)
      and (filter_metadata   is null or d.metadata  @> filter_metadata)
      and (keep_superseded or coalesce(d.metadata ->> 'status', '') <> 'superseded')
    order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
    limit greatest(match_count * 10, 100)
  ),
  fused as (
    select z.cid, sum(z.w)::double precision as score
    from (
      select vec.cid, 1.0::double precision / (rrf_k + vec.rnk)::double precision as w from vec
      union all
      select txt.cid, 1.0::double precision / (rrf_k + txt.rnk)::double precision as w from txt
    ) z
    group by z.cid
  ),
  ranked as (
    select f.cid, f.score,
           row_number() over (partition by c.document_id order by f.score desc, c.id) as per_doc_rank
    from fused f
    join rag.chunks c on c.id = f.cid
  )
  select c.id, d.id, d.source, d.collection, d.external_id, d.title, c.content, d.metadata,
         r.score,
         case when query_embedding is null then null
              else (1 - (c.embedding <=> query_embedding))::double precision end
  from ranked r
  join rag.chunks c    on c.id = r.cid
  join rag.documents d on d.id = c.document_id
  where max_per_document is null or r.per_doc_rank <= max_per_document
  order by r.score desc
  limit match_count;
end;
$$;

comment on function rag.search(extensions.vector, text, integer, text, text, integer, integer, double precision, jsonb, boolean) is
  'Hybrid vector + full-text retrieval fused with RRF, with a cosine relevance floor (min_similarity, default 0.70 — measured: relevant hits 0.79-0.83, nonsense 0.48-0.66). filter_collection narrows to a project or class; filter_metadata is a jsonb contains-match on frontmatter ({"repo": ...}, {"phase": ...}, {"tags": [...]}) served by the documents_metadata_idx GIN index; include_superseded = false drops metadata->>status = superseded. All four filters are applied inside both arms, never after fusion. Capped at max_per_document chunks per document. Raises if both query args are null. fused_score is an RRF rank score, NOT comparable across queries; use vector_similarity for absolute closeness.';
