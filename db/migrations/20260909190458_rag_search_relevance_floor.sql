-- RRF fuses RANKS, not distances, so it has no concept of "nothing is close
-- enough": a query with no good match still returns the nearest neighbours, and
-- a consuming LLM treats that junk as relevant.
--
-- Measured against this corpus (5 relevant vs 5 nonsense queries, best-hit cosine):
--     relevant  0.7907 .. 0.8281
--     nonsense  0.4839 .. 0.6649
--     gap       +0.1259
-- Default floor 0.70 sits below every relevant hit and above every nonsense hit,
-- biased toward false positives over false negatives (missing a real memory is
-- worse than showing a weak one). Pass null to disable.
--
-- Also returns vector_similarity so callers can see actual closeness rather than
-- only the RRF score, whose ceiling is 2/(k+1) and which means nothing absolute.

drop function if exists rag.search(extensions.vector, text, integer, text, text, integer, integer);

create function rag.search(
  query_embedding   extensions.vector(384) default null,
  query_text        text   default null,
  match_count       int    default 10,
  filter_source     text   default null,
  filter_collection text   default null,
  rrf_k             int    default 60,
  max_per_document  int    default 3,
  min_similarity    double precision default 0.70
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

comment on function rag.search(extensions.vector, text, integer, text, text, integer, integer, double precision) is
  'Hybrid vector + full-text retrieval fused with RRF, with a cosine relevance floor (min_similarity, default 0.70 — measured: relevant hits 0.79-0.83, nonsense 0.48-0.66). filter_collection narrows to a project or class. Capped at max_per_document chunks per document. Raises if both query args are null. fused_score is an RRF rank score, NOT comparable across queries; use vector_similarity for absolute closeness.';
