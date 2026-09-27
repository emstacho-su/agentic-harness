"""Retrieval eval: golden queries scored against ``rag.search``.

The numbers retrieval was tuned on — the 0.70 floor, ``rrf_k``, the chunk
budgets — were measured once and written down as prose. This makes them
reproducible: a fixed set of questions, what each should find, and three scores
that can be compared before and after any change to capture, chunking, the
model or the SQL.

    hit@k               share of positive cases with an expected result in the top k
    MRR                 mean of 1/rank of the first expected result (0 on a miss)
    negative pass rate  share of off-topic cases that correctly return nothing

A positive case names what it should find either by ``expect`` (document
external ids) or by ``expect_contains`` (text that must appear in a returned
chunk). The second form lets a case be written before the document that answers
it exists.

Every positive case is also labelled with the ``collection`` (and, for vault
notes, the ``realm``) its answer lives in. The labels give a per-collection
table, so a regression in one project or class is not averaged away, and a
label check: a case that passed on an ``expect`` id whose document sits in a
different collection or realm than the label says is reported, which is how a
note moving between realms or collections shows up. ``expect_contains`` matches
are not label-checked; that form accepts the answer from any note.

Scoring is pure; only :class:`PostgresSearcher` touches the database, and it
calls ``rag.search`` with the MCP server's defaults so the eval measures what a
client actually gets.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import yaml

from .config import REALM_NAME, DbSettings
from .embedding import Embedder, vector_literal
from .errors import ConfigError, StoreError
from .store import connect_kwargs

DEFAULT_K = 3
# Mirrors mcp-server/src/config.ts: DEFAULT_MATCH_COUNT and DEFAULT_INCLUDE_SUPERSEDED.
# max_per_document and min_similarity are left to the SQL defaults, as the server does.
DEFAULT_LIMIT = 10
INCLUDE_SUPERSEDED = False

_CASE_KEYS = frozenset(
    {"id", "query", "expect", "expect_contains", "negative", "note", "collection", "realm"}
)
# Table key for a case with no realm (claude-mem rows have none).
NO_REALM = "-"


@dataclass(frozen=True)
class GoldenCase:
    id: str
    query: str
    expect: tuple[str, ...] = ()
    expect_contains: tuple[str, ...] = ()
    negative: bool = False
    collection: str | None = None
    realm: str | None = None


@dataclass(frozen=True)
class Hit:
    source: str
    external_id: str
    title: str | None
    content: str
    similarity: float | None
    collection: str | None = None
    realm: str | None = None
    """The document's ``metadata._ingest.realm``; ``None`` for claude-mem rows."""


@dataclass(frozen=True)
class CaseResult:
    case: GoldenCase
    rank: int | None
    """1-based rank of the first expected hit; ``None`` on a miss or a negative case."""
    hits: tuple[Hit, ...]

    def passed(self, k: int) -> bool:
        if self.case.negative:
            return not self.hits
        return self.rank is not None and self.rank <= k

    @property
    def matched_hit(self) -> Hit | None:
        """The first hit that satisfied the case; ``None`` on a miss or a negative case."""
        return self.hits[self.rank - 1] if self.rank else None

    def mislabelled(self, k: int) -> bool:
        """The case passed at ``k`` on an expected document id, but that document
        sits in a different collection or realm than the case's label says.

        Not a failure: the answer was found. It means the label (or the note's
        home) moved, and a person should look. A case that failed is reported as a
        failure only, never here as well. An ``expect_contains`` match is not
        checked: that form accepts the answer from any note, so where the matching
        chunk lives says nothing about the label. A case with no realm matches a
        hit with no realm (claude-mem rows carry none)."""
        matched = self.matched_hit
        if matched is None or not self.passed(k) or matched.external_id not in self.case.expect:
            return False
        return (matched.collection, matched.realm) != (self.case.collection, self.case.realm)


@dataclass(frozen=True)
class CollectionScore:
    realm: str
    """The case's realm, or ``NO_REALM`` when it has none."""
    collection: str
    cases: int
    hit_rate: float
    mrr: float


@dataclass(frozen=True)
class EvalReport:
    results: tuple[CaseResult, ...]
    k: int

    @property
    def positives(self) -> tuple[CaseResult, ...]:
        return tuple(r for r in self.results if not r.case.negative)

    @property
    def negatives(self) -> tuple[CaseResult, ...]:
        return tuple(r for r in self.results if r.case.negative)

    @property
    def hit_rate(self) -> float:
        return _share(self.positives, self.k)

    @property
    def negative_pass_rate(self) -> float:
        return _share(self.negatives, self.k)

    @property
    def mrr(self) -> float:
        positives = self.positives
        if not positives:
            return 1.0
        return sum(1.0 / r.rank if r.rank else 0.0 for r in positives) / len(positives)

    @property
    def failures(self) -> tuple[CaseResult, ...]:
        return tuple(r for r in self.results if not r.passed(self.k))

    @property
    def mislabelled(self) -> tuple[CaseResult, ...]:
        return tuple(r for r in self.results if r.mislabelled(self.k))

    def by_collection(self) -> Mapping[tuple[str, str], CollectionScore]:
        """hit@k and MRR per ``(realm, collection)``, sorted by that key.

        Negative cases have no collection and are left out."""
        groups: dict[tuple[str, str], list[CaseResult]] = {}
        for result in self.positives:
            key = (result.case.realm or NO_REALM, result.case.collection or "")
            groups.setdefault(key, []).append(result)
        scores = {}
        for key in sorted(groups):
            group = EvalReport(results=tuple(groups[key]), k=self.k)
            scores[key] = CollectionScore(
                realm=key[0],
                collection=key[1],
                cases=len(group.results),
                hit_rate=group.hit_rate,
                mrr=group.mrr,
            )
        return scores


def _share(results: Sequence[CaseResult], k: int) -> float:
    """Pass rate; an empty group cannot fail, so it scores 1.0."""
    if not results:
        return 1.0
    return sum(1 for r in results if r.passed(k)) / len(results)


class Searcher(Protocol):
    def search(self, query: str, embedding: list[float], limit: int) -> list[Hit]: ...


# -- golden file -------------------------------------------------------------


def load_golden(path: str | Path) -> list[GoldenCase]:
    """Read and validate the golden file. Any defect is a ConfigError: a case
    that silently loads wrong would score as a retrieval failure."""
    file = Path(path)
    if not file.is_file():
        raise ConfigError(f"Golden file not found: {file}")
    try:
        raw = yaml.safe_load(file.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"{file} is not valid YAML: {exc}") from exc

    if not isinstance(raw, dict) or "cases" not in raw:
        raise ConfigError(f"{file} must be a mapping with a `cases` list")
    entries = raw["cases"]
    if not isinstance(entries, list) or not entries:
        raise ConfigError(f"{file} has no cases")

    cases = [_parse_case(entry, index) for index, entry in enumerate(entries, start=1)]
    seen: set[str] = set()
    for case in cases:
        if case.id in seen:
            raise ConfigError(f"duplicate case id: {case.id}")
        seen.add(case.id)
    return cases


def _parse_case(entry: Any, index: int) -> GoldenCase:
    if not isinstance(entry, dict):
        raise ConfigError(f"case {index} must be a mapping")
    unknown = set(entry) - _CASE_KEYS
    if unknown:
        raise ConfigError(f"case {index} has unknown keys: {', '.join(sorted(unknown))}")

    case_id = _required_text(entry, "id", index)
    query = _required_text(entry, "query", index)
    expect = _text_tuple(entry.get("expect"), "expect", case_id)
    expect_contains = _text_tuple(entry.get("expect_contains"), "expect_contains", case_id)
    negative = entry.get("negative", False)
    if not isinstance(negative, bool):
        raise ConfigError(f"case {case_id}: negative must be true or false")

    if negative and (expect or expect_contains):
        raise ConfigError(f"case {case_id}: a negative case expects nothing; drop expect/expect_contains")
    if not negative and not (expect or expect_contains):
        raise ConfigError(f"case {case_id}: needs expect, expect_contains, or negative: true")

    collection = _optional_text(entry, "collection", case_id)
    realm = _optional_text(entry, "realm", case_id)
    if negative and (collection or realm):
        raise ConfigError(f"case {case_id}: a negative case belongs to no collection; drop collection/realm")
    if not negative and not collection:
        raise ConfigError(f"case {case_id}: needs a `collection` (where the answer lives)")
    if realm is not None and not REALM_NAME.match(realm):
        raise ConfigError(f"case {case_id}: realm {realm!r} is not a valid realm name")
    return GoldenCase(
        id=case_id,
        query=query,
        expect=expect,
        expect_contains=expect_contains,
        negative=negative,
        collection=collection,
        realm=realm,
    )


def _required_text(entry: dict[str, Any], key: str, index: int) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"case {index} needs a non-empty `{key}`")
    return value.strip()


def _optional_text(entry: dict[str, Any], key: str, case_id: str) -> str | None:
    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"case {case_id}: `{key}` must be a non-empty string")
    return value.strip()


def _text_tuple(value: Any, key: str, case_id: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ConfigError(f"case {case_id}: {key} must be a list of non-empty strings")
    return tuple(v.strip() for v in value)


# -- scoring -----------------------------------------------------------------


def score_case(case: GoldenCase, hits: Sequence[Hit]) -> CaseResult:
    if case.negative:
        return CaseResult(case=case, rank=None, hits=tuple(hits))
    rank = next((i for i, h in enumerate(hits, start=1) if _matches(case, h)), None)
    return CaseResult(case=case, rank=rank, hits=tuple(hits))


def _matches(case: GoldenCase, hit: Hit) -> bool:
    if hit.external_id in case.expect:
        return True
    content = hit.content.lower()
    return any(needle.lower() in content for needle in case.expect_contains)


def run_eval(
    cases: Sequence[GoldenCase],
    searcher: Searcher,
    embedder: Embedder,
    *,
    k: int = DEFAULT_K,
    limit: int = DEFAULT_LIMIT,
) -> EvalReport:
    vectors = embedder.embed([case.query for case in cases])
    results = tuple(
        score_case(case, searcher.search(case.query, vector, limit))
        for case, vector in zip(cases, vectors, strict=True)
    )
    return EvalReport(results=results, k=k)


# -- the live searcher -------------------------------------------------------

# Bound by name, never positionally: the signature has changed before and a
# positional call silently shifts one parameter into another.
_SEARCH_SQL = """
SELECT doc_source, doc_external, doc_title, chunk_content, vector_similarity, doc_collection,
       doc_metadata -> '_ingest' ->> 'realm'
FROM rag.search(
    query_embedding    => %(embedding)s::extensions.vector,
    query_text         => %(query)s,
    match_count        => %(limit)s,
    include_superseded => %(include_superseded)s
)
"""


class PostgresSearcher:
    """``rag.search`` over a read-only connection."""

    def __init__(self, connection) -> None:
        self._conn = connection

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresSearcher":
        if not settings.database_url:
            raise ConfigError("DATABASE_URL is not set; the eval queries the live store.")
        import psycopg

        options = {**connect_kwargs(settings), "autocommit": True}
        try:
            return cls(psycopg.connect(settings.database_url, **options))
        except psycopg.Error as exc:
            raise StoreError(f"Could not connect to the database: {exc}") from exc

    def search(self, query: str, embedding: list[float], limit: int) -> list[Hit]:
        import psycopg

        params = {
            "embedding": vector_literal(embedding),
            "query": query,
            "limit": limit,
            "include_superseded": INCLUDE_SUPERSEDED,
        }
        try:
            with self._conn.cursor() as cursor:
                cursor.execute(_SEARCH_SQL, params)
                rows = cursor.fetchall()
        except psycopg.Error as exc:
            raise StoreError(f"rag.search failed for {query!r}: {exc}") from exc
        return [
            Hit(
                source=row[0],
                external_id=row[1],
                title=row[2],
                content=row[3],
                similarity=row[4],
                collection=row[5],
                realm=row[6],
            )
            for row in rows
        ]

    def close(self) -> None:
        self._conn.close()
