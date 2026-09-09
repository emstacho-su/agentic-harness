# Hybrid retrieval with Reciprocal Rank Fusion

All retrieval goes through one database function, `rag.search()`. It runs two
independent searches over the same chunks, merges their results into a single
ordering, caps how many chunks one document may contribute, and refuses to
surface semantic neighbours that are not actually close.

> **Status.** Live on `harness-memory` over 1,306 documents and 2,289 chunks.
> The similarity numbers below were measured on that corpus, not invented.

---

## Why two searches

Dense vector search and keyword search fail in opposite directions.

| | Vector search | Full-text search |
| --- | --- | --- |
| Finds | Meaning, paraphrase, related concepts | Exact terms |
| "database connection pooling" also matches | "pgbouncer setup", "too many clients" | only literal occurrences |
| `ENOENT` | Poorly — rare tokens are weakly represented | Exactly |
| A UUID or a filename | Badly | Exactly |
| Wrong-but-plausible results | Common | Rare |
| Misses when wording differs | Rare | Common |

An agent's corpus contains both kinds of query. "What did I decide about
retrieval ranking?" is semantic. "Where did that `chunks_embedding_idx` error
come from?" is lexical. A store that only does one of them is frustrating in a
predictable way roughly half the time.

Running both and fusing costs one extra index scan and removes the whole failure
class.

---

## The retrieval flow

```mermaid
flowchart TD
    Q["rag.search(query_embedding, query_text, match_count,<br/>filter_source, filter_collection, rrf_k,<br/>max_per_document, min_similarity)"]

    Q --> G{"both query args null?"}
    G -->|"yes"| X["RAISE — a silent empty result<br/>would be indistinguishable from no match"]
    G -->|"no"| A1
    G -->|"no"| A2

    A1["Vector arm<br/>runs only if query_embedding is not null"]
    A2["Full-text arm<br/>runs only if query_text is not null"]

    A1 --> V0["WHERE 1 - (embedding &lt;=&gt; query) &gt;= min_similarity<br/>the relevance floor, vector arm ONLY"]
    V0 --> V1["ORDER BY embedding &lt;=&gt; query_embedding<br/>HNSW index, cosine distance"]
    A2 --> T1["WHERE tsv @@ websearch_to_tsquery english<br/>ORDER BY ts_rank_cd DESC<br/>GIN index"]

    V1 --> V2["LIMIT greatest(match_count * 10, 100)"]
    T1 --> T2["LIMIT greatest(match_count * 10, 100)"]

    V2 --> VR["Ranked list A<br/>row_number = 1, 2, 3, ..."]
    T2 --> TR["Ranked list B<br/>row_number = 1, 2, 3, ..."]

    VR --> F["Reciprocal Rank Fusion<br/>weight = 1.0 / (rrf_k + rank)<br/>sum weights per chunk id"]
    TR --> F

    F --> C["Per-document cap<br/>row_number over (partition by document_id)<br/>keep &lt;= max_per_document"]
    C --> O["ORDER BY fused_score DESC<br/>LIMIT match_count"]
    O --> R["chunk_id, doc_id, doc_source, doc_collection, doc_external,<br/>doc_title, chunk_content, doc_metadata,<br/>fused_score, vector_similarity"]

    FS["filter_source<br/>filter_collection"] -.->|"applied inside both arms"| A1
    FS -.->|"applied inside both arms"| A2
```

Points worth noticing in that diagram:

- **Both arms are optional, but not both absent.** Each has a `where query_… is
  not null` guard, so passing only an embedding gives pure vector search and
  only text gives pure full-text search. Passing neither **raises** rather than
  returning zero rows, because an empty result from a silent no-op is
  indistinguishable from "nothing matched". `match_count < 1` and
  `max_per_document < 1` raise too.
- **Filters are pushed into each arm**, not applied after fusion. Filtering
  afterwards would let irrelevant sources consume candidate slots and return
  fewer than `match_count` rows. `filter_collection` matches with `=` — exact,
  case-sensitive.
- **Each arm over-fetches.** `greatest(match_count * 10, 100)` retrieves ten
  times the requested rows, floor 100. Fusion needs a pool deep enough to find
  agreement, and the per-document cap needs room to bite: if each arm returned
  only 10 rows from the same long document, the cap would leave nothing.
- **`websearch_to_tsquery`** rather than `to_tsquery`. It accepts everyday query
  syntax (quoted phrases, `or`, leading `-` to exclude) and never raises a syntax
  error on arbitrary input. `to_tsquery` throws on a stray operator, which would
  turn a user's punctuation into a failed search.
- **`ts_rank_cd`** — cover-density ranking, which accounts for how close the
  matched terms are to each other. For multi-word queries that is a better signal
  than raw term frequency.

---

## The RRF formula

For each chunk `c`, over each ranked list `L` that contains it:

```
score(c) = Σ  1 / (k + rank_L(c))
          L
```

with `k = rrf_k`, default **60**. In SQL:

```sql
select vec.cid, 1.0 / (rrf_k + vec.rnk) as w from vec
union all
select txt.cid, 1.0 / (rrf_k + txt.rnk) as w from txt
-- then: group by cid, sum(w)
```

Only the **ordinal position** of a result enters the formula. Cosine distance and
`ts_rank_cd` values are used to sort each arm and are then thrown away — which is
exactly why a separate `vector_similarity` column exists (below).

---

## Why RRF instead of mixing scores

The obvious alternative is a weighted blend: `0.7 × vector_score + 0.3 ×
text_score`. It does not work, for a specific reason.

The two scores are not on the same scale, and they are not on any fixed scale:

- **Cosine distance** is bounded in `[0, 2]`, and **lower is better**. In
  practice, embeddings of related English text cluster in a narrow band — a good
  match and a mediocre one might be 0.18 and 0.31.
- **`ts_rank_cd`** is an unbounded positive number where **higher is better**.
  Its magnitude depends on term frequency, document length, the number of query
  terms and their proximity. A rank of 0.09 can be excellent for one query and
  poor for another.

To blend them you must first normalise, and every normalisation strategy
introduces a new failure:

| Strategy | Failure |
| --- | --- |
| Min-max over the candidate set | Scores depend on which other rows happened to be retrieved. The best result in a set of bad results normalises to 1.0 — a pile of garbage produces a confident-looking top hit. |
| Fixed divisor per metric | Requires knowing each metric's real range in advance. `ts_rank_cd` has no upper bound to divide by. |
| Z-score | Assumes a distribution the scores do not have, and still breaks when one arm returns two rows. |

All of these make fusion depend on the shape of the candidate set rather than on
what the query actually matched. Worse, the failure is invisible: results still
come back ordered, so nothing looks broken.

RRF sidesteps the entire problem. Rank 1 is rank 1 whether cosine distance was
0.02 or 0.4. There is nothing to normalise because no score crosses between the
arms. Adding a third retrieval arm later — a reranker, a graph walk — needs no
recalibration of the existing two, which is not true of any weighted scheme.

RRF comes from Cormack, Clarke and Buettcher (2009), where it beat considerably
more complicated learned fusion methods across TREC collections. `k = 60` is
their value and has held up as a default.

---

## What `k = 60` actually does

`k` flattens the curve. Without it, rank 1 scores 1.0 and rank 2 scores 0.5 —
the top of one list would dominate everything. With `k = 60`:

| Rank | `1 / (60 + rank)` |
| ---: | ---: |
| 1 | 0.01639 |
| 2 | 0.01613 |
| 5 | 0.01538 |
| 10 | 0.01429 |
| 50 | 0.00909 |

Adjacent ranks are nearly equal, so **appearing in both lists matters more than
topping one of them**:

| Chunk | Vector rank | Text rank | Fused score |
| --- | ---: | ---: | ---: |
| A | 5 | 5 | 0.01538 + 0.01538 = **0.03077** |
| B | 1 | — | 0.01639 + 0 = 0.01639 |
| C | — | 1 | 0 + 0.01639 = 0.01639 |
| D | 12 | 8 | 0.01389 + 0.01471 = **0.02860** |

Chunk A wins despite being nobody's favourite, because both methods independently
agree it is relevant. Chunk D, mediocre in both, still outranks B and C, each of
which one method loved and the other never surfaced. That is the intended
behaviour: agreement between two methods that fail differently is strong
evidence, and a lone enthusiastic vote is weak evidence.

The ceiling of `fused_score` is therefore `2 / (k + 1)` ≈ **0.0328** at the
default `k`. A top hit scoring `0.03` is an excellent match, not a 3% one. The
score orders results within one query and means nothing across queries; the MCP
server labels it "ordering only" for exactly this reason.

Lowering `k` sharpens the curve and lets top-ranked singletons win. Raising it
flattens further and weights consensus even more heavily. It is exposed as a
parameter, so it can be tuned per query without a migration.

---

## The relevance floor

RRF has a blind spot that only shows up in production: it fuses **ranks**, so it
has no concept of "nothing is close enough". A query about banana bread, run
against a corpus of engineering history, still has a nearest neighbour, and that
neighbour is rank 1. Before the floor existed, off-topic queries returned their
nearest irrelevant chunks at the RRF ceiling and the consuming model treated
them as answers.

`min_similarity` (default **0.70**) fixes this on the vector arm: a chunk must
have cosine similarity `1 - (embedding <=> query)` of at least the floor to enter
ranked list A at all. Measured on this corpus, best-hit cosine over five relevant
and five nonsense queries:

| Query class | Best-hit similarity |
| --- | --- |
| Relevant | 0.79 – 0.83 |
| Nonsense | 0.48 – 0.66 |
| Gap | +0.126 |

0.70 sits in that gap, biased toward false positives, because missing a real
memory is worse than showing a weak one. Pass `null` to remove the floor.

Three rules follow from how it is wired:

- **Zero rows means nothing relevant exists. That is a correct answer, not an
  error.** The MCP server says so in plain words and keeps `isError` false.
- **The floor gates the vector arm only.** A chunk can still appear with
  similarity below 0.70 if it matched the full-text arm — a literal keyword hit
  is independent evidence and is shown, labelled, never filtered out client-side.
- **Judge relevance by `vector_similarity`, order by `fused_score`.**
  `vector_similarity` is real cosine, computed for every returned row whichever
  arm surfaced it, and is interpretable in absolute terms. `fused_score` is not.

---

## The per-document cap

Long documents produce many chunks, and many of them match the same query.
Without a cap, a single session note could fill all ten result slots and crowd
out every other source. `max_per_document` (default **3**, `null` disables)
keeps the top three fused chunks of each document and drops the rest before the
final `limit`. Asking for four results from a collection with one matching
document therefore returns three — the cap, working as intended.

---

## What RRF gives up

- **Magnitude is discarded** by the fusion itself. `vector_similarity` is the
  compensating signal, carried alongside rather than folded in.
- **No arm weighting by default.** Every list counts equally. If the vector arm
  were consistently better on this corpus, RRF would not know. A per-arm
  multiplier could be added, at the cost of reintroducing a tuned constant.
- **Ordering only.** `fused_score` is a fusion artifact, not a relevance
  probability. It is not comparable across queries and should never be shown to a
  user as a confidence value or thresholded.

For this use case those are acceptable. The consumer is an agent that reads a
handful of chunks and decides for itself which ones matter — the job of retrieval
is to get the right material into that set, not to rank it perfectly.

---

## The contract

As applied by `db/migrations/20260909190458_rag_search_relevance_floor.sql`:

```sql
rag.search(
  query_embedding   extensions.vector(384) default null,
  query_text        text                   default null,
  match_count       int                    default 10,
  filter_source     text                   default null,
  filter_collection text                   default null,   -- project or class
  rrf_k             int                    default 60,
  max_per_document  int                    default 3,      -- null disables
  min_similarity    double precision       default 0.70    -- null disables
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
  fused_score       double precision,   -- RRF sum, ordering only
  vector_similarity double precision    -- real cosine; null when no embedding was passed
)
```

**Bind arguments by name.** This signature has changed three times — gaining
`filter_collection`, `max_per_document`, then `min_similarity` and
`vector_similarity`. When `filter_collection` was inserted at position five, the
MCP server's positional call put an `int` where a `text` was expected, no
overload matched, and Postgres reported **42883 "function does not exist"** —
which reads like a missing migration and sends you debugging the wrong thing.
Named binding (`query_embedding => $1, …`) survives insertions and reorderings.

**Every client goes through this function.** Hand-rolled SQL in the MCP server
or in a future Hermes client would give each agent its own private definition of
relevance, and the two would drift apart in ways that are extremely hard to
notice — both would return results, both would look fine, and they would disagree
about what the knowledge base says. A point lookup by `(source, external_id)`
may read `rag.documents` directly; that is a key lookup, not ranking.
