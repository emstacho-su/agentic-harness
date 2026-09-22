-- Strict matches rank first inside the text arm.
--
-- 20260921223446 let the text arm admit chunks matching only some of the query's
-- terms and ordered the whole arm by ts_rank_cd over the OR query. That ordering
-- let a term-dense partial match outrank a chunk matching every term: on the
-- golden set two cases that had passed fell out of the top 3 (routines-billing
-- 1-3 -> 4, gradebook-phase -> 10) while two others were gained.
--
-- A chunk matching every term is better keyword evidence than one matching
-- half, whatever the density. Strict matches now take the arm's first ranks,
-- exactly the ranks they held before 20260921223446, and partial matches fill in
-- behind them. Nothing else changes.

create or replace function rag.search(
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
  -- How far under min_similarity a chunk may sit when its keywords vouch for it.
  keyword_floor_margin constant double precision := 0.08;
  keyword_floor double precision := min_similarity - keyword_floor_margin;
  strict_query  tsquery;
  loose_query   tsquery;
  lexemes       text[];
  lexemes_needed int;
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

  if query_text is not null then
    strict_query := websearch_to_tsquery('english', query_text);
    lexemes := tsvector_to_array(to_tsvector('english', query_text));
    if numnode(strict_query) > 0
       and cardinality(lexemes) > 1
       and position('!' in strict_query::text) = 0 then
      loose_query := replace(strict_query::text, ' & ', ' | ')::tsquery;
      lexemes_needed := greatest(2, ceil(cardinality(lexemes) / 2.0)::int);
    end if;
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
           row_number() over (order by (c.tsv @@ strict_query) desc, ts_rank_cd(c.tsv, coalesce(loose_query, strict_query)) desc) as rnk
    from rag.chunks c
    join rag.documents d on d.id = c.document_id
    where strict_query is not null
      and numnode(strict_query) > 0
      and (
        c.tsv @@ strict_query
        or (
          loose_query is not null
          and c.tsv @@ loose_query
          and (select count(*) from unnest(lexemes) as l(lexeme)
               where l.lexeme = any (tsvector_to_array(c.tsv))) >= lexemes_needed
          and (query_embedding is null
               or keyword_floor is null
               or (1 - (c.embedding <=> query_embedding)) >= keyword_floor)
        )
      )
      and (filter_source     is null or d.source     = filter_source)
      and (filter_collection is null or d.collection = filter_collection)
      and (filter_metadata   is null or d.metadata  @> filter_metadata)
      and (keep_superseded or coalesce(d.metadata ->> 'status', '') <> 'superseded')
    order by (c.tsv @@ strict_query) desc, ts_rank_cd(c.tsv, coalesce(loose_query, strict_query)) desc
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
  'Hybrid vector + full-text retrieval fused with RRF, with a cosine relevance floor (min_similarity, default 0.70). The text arm admits a chunk that matches every query term, or one that matches at least half of them (minimum two) and sits within 0.08 of the floor, so a natural-language question still gets keyword support. filter_collection narrows to a project or class; filter_metadata is a jsonb contains-match on frontmatter ({"repo": ...}, {"phase": ...}, {"tags": [...]}) served by the documents_metadata_idx GIN index; include_superseded = false drops metadata->>status = superseded. All four filters are applied inside both arms, never after fusion. Capped at max_per_document chunks per document. Raises if both query args are null. fused_score is an RRF rank score, NOT comparable across queries; use vector_similarity for absolute closeness.';
