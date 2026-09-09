-- Hybrid retrieval: vector kNN + full-text, fused with Reciprocal Rank Fusion.
-- RRF fuses ranks, not scores, so cosine distance never needs normalising against ts_rank.
-- One shared definition of "search" so Claude Code and Hermes cannot drift apart.

create function rag.search(
  query_embedding   extensions.vector(384) default null,
  query_text        text default null,
  match_count       int  default 10,
  filter_source     text default null,
  filter_collection text default null,
  rrf_k             int  default 60,
  max_per_document  int  default 3
)
returns table (
  chunk_id       bigint,
  doc_id         bigint,
  doc_source     text,
  doc_collection text,
  doc_external   text,
  doc_title      text,
  chunk_content  text,
  doc_metadata   jsonb,
  fused_score    double precision
)
language plpgsql
stable
as $$
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
  select c.id, d.id, d.source, d.collection, d.external_id, d.title, c.content, d.metadata, r.score
  from ranked r
  join rag.chunks c    on c.id = r.cid
  join rag.documents d on d.id = c.document_id
  where max_per_document is null or r.per_doc_rank <= max_per_document
  order by r.score desc
  limit match_count;
end;
$$;

comment on function rag.search(extensions.vector, text, integer, text, text, integer, integer) is
  'Hybrid vector + full-text retrieval fused with RRF. filter_collection narrows to one project or class; filter_source to one producer. Capped at max_per_document chunks per document (default 3; null disables). Raises if both query_embedding and query_text are null. fused_score is a raw RRF sum of 1/(k+rank), ceiling 2/(k+1) ~= 0.0328 at k=60 — a ranking score only, NOT comparable across queries.';
