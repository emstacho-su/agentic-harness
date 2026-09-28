"""The curator store's contract, free of SQL: the rows of the ``curate`` schema
as frozen dataclasses, the issue id format, the :class:`CurateStore` protocol,
and :class:`InMemoryCurateStore`, its dict-backed twin for tests.
``store.py`` holds the Postgres implementation and re-exports all of this.

Every value is validated and normalised when the object is built, so both
stores (Postgres and in-memory) hold exactly the same shapes:

* timestamps are text, always UTC ISO-8601 with an explicit ``+00:00``
  (:func:`to_utc_iso`). A bare date means midnight UTC. Postgres hands back
  ``datetime`` objects; they are normalised the same way, so a value read back
  compares equal to the one written.
* ``Extraction.result`` and ``Extraction.rejected`` are tuples of JSON objects
  (dicts), each a fresh JSON round-trip of what was passed in. ``result`` holds
  the items the substring guard and validation accepted, ``rejected`` the ones
  they did not, each with its reason. ``IssueMember.item_index`` is a 0-based
  index into ``result``. What keys an item carries is the extract stage's
  contract, not this module's.
* days (``run_day``, ``report_day``, ``week_start``) are ``YYYY-MM-DD`` text
  (:func:`to_iso_day`); Postgres hands back ``date`` objects, normalised the same.
* JSON columns of the C-b tables (``HistoryWeek.narrative`` and ``titles``,
  ``NoteScore.features``) are validated for shape and held as fresh JSON
  copies, so a caller mutating what it read never changes what is stored.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from typing import Any, Protocol

from ..errors import StoreError
from ..jsonutil import dumps

ISSUE_STATES = ("open", "claimed-fixed", "verified", "regressed")
EVENT_KINDS = (
    "found", "claim-fixed", "claim-workaround", "claim-wontfix",
    "fix-commit", "merged-pr", "recurrence",
)
CAUSE_TYPES = ("note", "commit", "pr")
CURATE_ACTIONS = ("condense", "prune")
IMPORTANCE_RANGE = (1, 10)

ISSUE_ID_PREFIX = "ISSUE"
ISSUE_SEQ_WIDTH = 3

ExtractionKey = tuple[str, str, str]  # (note_id, content_hash, extractor_version)
EventKey = tuple[str, str, str, str, "str | None"]  # (issue_id, event_kind, cause_type, cause_ref, to_state)
HistoryWeekKey = tuple[str, str, str, str]  # (collection, week_start, input_hash, history_version)
NoteScoreKey = tuple[str, str, str]  # (note_id, scorer_version, run_day)
ImportanceKey = tuple[str, str, str]  # (note_id, content_hash, scorer_version)
ProposalKey = tuple[str, str, str, str]  # (realm_folder, report_day, note_id, action); decisions too

_WHITESPACE = re.compile(r"\s+")


def format_issue_id(collection: str, seq: int) -> str:
    """``ISSUE-<collection>-NNN``: seq zero-padded to three digits, wider past 999.

    Whitespace in the collection becomes ``-`` in the id only; the ``collection``
    column keeps the name verbatim. Two collections that differ only there
    ('wta dog finder', 'wta-dog-finder') would map to the same ids, and the
    ``issue_id`` primary key refuses the second one rather than merging them.
    """
    slug = _WHITESPACE.sub("-", collection.strip())
    if not slug:
        raise ValueError("an issue id needs a non-empty collection")
    if seq < 1:
        raise ValueError(f"issue seq must be 1 or more, got {seq}")
    return f"{ISSUE_ID_PREFIX}-{slug}-{seq:0{ISSUE_SEQ_WIDTH}d}"


def to_utc_iso(value: str | datetime | date) -> str:
    """Any ISO date or timestamp as ``YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00``.

    A value with no offset is taken as UTC. Anything unparseable is a ValueError.
    """
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, date):
        moment = datetime(value.year, value.month, value.day)
    elif isinstance(value, str):
        try:
            moment = datetime.fromisoformat(value.strip())
        except ValueError as exc:
            raise ValueError(f"not an ISO date or timestamp: {value!r}") from exc
    else:
        raise ValueError(f"not a date or timestamp: {type(value).__name__}")
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat()


def _optional_instant(value: str | datetime | None) -> str | None:
    return None if value is None else to_utc_iso(value)


def to_iso_day(value: str | date) -> str:
    """A calendar day as ``YYYY-MM-DD``. A timestamp is refused rather than truncated."""
    if isinstance(value, datetime):
        raise ValueError(f"a day, not a timestamp, is wanted: {value!r}")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()).isoformat()
        except ValueError as exc:
            raise ValueError(f"not an ISO day: {value!r}") from exc
    raise ValueError(f"not a day: {type(value).__name__}")


def _json_items(items: Sequence[Mapping[str, Any]], what: str) -> tuple[dict[str, Any], ...]:
    """A tuple of fresh JSON-object copies; anything that is not an object is refused."""
    if isinstance(items, (str, bytes, Mapping)):
        raise ValueError(f"{what} must be a sequence of JSON objects")
    copies = []
    for item in items:
        if not isinstance(item, Mapping):
            raise ValueError(f"{what} items must be JSON objects, got {type(item).__name__}")
        copies.append(json.loads(dumps(item)))
    return tuple(copies)


def _require_text(value: str, what: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{what} must be non-empty text")


def _require_count(value: int | None, what: str) -> None:
    if value is not None and (not isinstance(value, int) or value < 0):
        raise ValueError(f"{what} must be a non-negative integer or None")


def _require_bool(value: bool, what: str) -> None:
    if not isinstance(value, bool):
        raise ValueError(f"{what} must be true or false, got {value!r}")


def _require_action(value: str) -> None:
    if value not in CURATE_ACTIONS:
        raise ValueError(f"action must be one of {CURATE_ACTIONS}, got {value!r}")


def _require_importance(value: int | None, *, optional: bool) -> None:
    if value is None and optional:
        return
    low, high = IMPORTANCE_RANGE
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"importance must be an integer from {low} to {high}, got {value!r}")


def _finite_number(value: float, what: str) -> float:
    """``value`` as a float; a bool, a string, NaN or an infinity is refused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{what} must be a finite number, got {value!r}")
    return float(value)


def _texts(values: Sequence[str], what: str) -> tuple[str, ...]:
    """A tuple of non-empty strings; a bare string is refused, not split into characters."""
    if isinstance(values, (str, bytes, Mapping)):
        raise ValueError(f"{what} must be a sequence of text")
    items = tuple(values)
    for item in items:
        _require_text(item, f"each of {what}")
    return items


def _json_copy(value: Any) -> Any:
    return json.loads(dumps(value))


def _narrative(paragraphs: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], ...]:
    """History paragraphs: each ``{"text": str, "note_ids": [str, ...]}``, the ids it cites."""
    copies = _json_items(paragraphs, "narrative")
    for paragraph in copies:
        _require_text(paragraph.get("text"), "narrative text")
        note_ids = paragraph.get("note_ids")
        if not isinstance(note_ids, list):
            raise ValueError("narrative note_ids must be a list of note ids")
        _texts(note_ids, "narrative note_ids")
    return copies


def _titles(titles: Mapping[str, str]) -> dict[str, str]:
    """note id -> the history's better title for it (R-N3)."""
    if not isinstance(titles, Mapping):
        raise ValueError("titles must be a JSON object of note id to title")
    for note_id, title in titles.items():
        _require_text(note_id, "a titles key")
        _require_text(title, f"the title of {note_id}")
    return _json_copy(dict(titles))


def _features(features: Mapping[str, float]) -> dict[str, int | float]:
    """Score features: a JSON object of finite numbers. Ints stay ints."""
    if not isinstance(features, Mapping):
        raise ValueError("features must be a JSON object of numbers")
    for name, value in features.items():
        _require_text(name, "a feature name")
        _finite_number(value, f"feature {name}")
    return _json_copy(dict(features))


@dataclass(frozen=True)
class Extraction:
    """One ``curate.extractions`` row: the judge's cached output for one note version."""

    note_id: str
    content_hash: str
    extractor_version: str
    collection: str
    note_path: str
    result: tuple[dict[str, Any], ...]
    rejected: tuple[dict[str, Any], ...] = ()
    realm: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    created_at: str | None = None  # set by the store on insert when None

    def __post_init__(self) -> None:
        for name in ("note_id", "content_hash", "extractor_version", "collection", "note_path"):
            _require_text(getattr(self, name), name)
        _require_count(self.input_tokens, "input_tokens")
        _require_count(self.output_tokens, "output_tokens")
        # Normalising a frozen instance at construction is the one allowed write.
        object.__setattr__(self, "result", _json_items(self.result, "result"))
        object.__setattr__(self, "rejected", _json_items(self.rejected, "rejected"))
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))

    @property
    def key(self) -> ExtractionKey:
        return (self.note_id, self.content_hash, self.extractor_version)


@dataclass(frozen=True)
class Issue:
    """One ``curate.issues`` row. Only a store builds these: it allocates the seq."""

    issue_id: str
    collection: str
    seq: int
    kind: str | None
    summary: str
    files: tuple[str, ...]
    first_seen_at: str
    created_at: str | None = None

    def __post_init__(self) -> None:
        if self.issue_id != format_issue_id(self.collection, self.seq):
            raise ValueError(f"{self.issue_id} does not match its collection and seq")
        _require_text(self.summary, "summary")
        object.__setattr__(self, "files", tuple(str(f) for f in self.files))
        object.__setattr__(self, "first_seen_at", to_utc_iso(self.first_seen_at))
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))


@dataclass(frozen=True)
class IssueMember:
    """One extracted item (``result[item_index]`` of one extraction) in one issue."""

    issue_id: str
    note_id: str
    content_hash: str
    extractor_version: str
    item_index: int

    def __post_init__(self) -> None:
        for name in ("issue_id", "note_id", "content_hash", "extractor_version"):
            _require_text(getattr(self, name), name)
        if not isinstance(self.item_index, int) or self.item_index < 0:
            raise ValueError(f"item_index must be a non-negative integer, got {self.item_index!r}")

    @property
    def item_key(self) -> tuple[str, str, str, int]:
        """The primary key: an item belongs to at most one issue."""
        return (self.note_id, self.content_hash, self.extractor_version, self.item_index)


@dataclass(frozen=True)
class IssueEvent:
    """One ``curate.issue_events`` row. Append-only and bi-temporal.

    ``effective_at`` is when it happened (note, commit or merge date);
    ``recorded_at`` is when the curator learned it, set by the store when None.
    ``to_state`` is None for an annotation that moves no state. ``id`` is None
    until the store assigns it.
    """

    issue_id: str
    to_state: str | None
    event_kind: str
    effective_at: str
    cause_type: str
    cause_ref: str
    evidence: str | None = None
    recorded_at: str | None = None
    id: int | None = None

    def __post_init__(self) -> None:
        _require_text(self.issue_id, "issue_id")
        _require_text(self.cause_ref, "cause_ref")
        if self.to_state is not None and self.to_state not in ISSUE_STATES:
            raise ValueError(f"to_state must be one of {ISSUE_STATES} or None, got {self.to_state!r}")
        if self.event_kind not in EVENT_KINDS:
            raise ValueError(f"event_kind must be one of {EVENT_KINDS}, got {self.event_kind!r}")
        if self.cause_type not in CAUSE_TYPES:
            raise ValueError(f"cause_type must be one of {CAUSE_TYPES}, got {self.cause_type!r}")
        object.__setattr__(self, "effective_at", to_utc_iso(self.effective_at))
        object.__setattr__(self, "recorded_at", _optional_instant(self.recorded_at))

    @property
    def unique_key(self) -> EventKey:
        """What makes a rerun insert nothing: the same cause claiming the same state for the
        same issue and kind. Two None states are equal (``nulls not distinct``)."""
        return (self.issue_id, self.event_kind, self.cause_type, self.cause_ref, self.to_state)


@dataclass(frozen=True)
class HistoryWeek:
    """One ``curate.history_weeks`` row: the judge's narrative for one week of one
    collection (R-C5), cached by the hash of its input and the history version."""

    collection: str
    week_start: str
    input_hash: str
    history_version: str
    narrative: tuple[dict[str, Any], ...]
    titles: dict[str, str]
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    created_at: str | None = None  # set by the store on insert when None

    def __post_init__(self) -> None:
        for name in ("collection", "input_hash", "history_version"):
            _require_text(getattr(self, name), name)
        _require_count(self.input_tokens, "input_tokens")
        _require_count(self.output_tokens, "output_tokens")
        object.__setattr__(self, "week_start", to_iso_day(self.week_start))
        object.__setattr__(self, "narrative", _narrative(self.narrative))
        object.__setattr__(self, "titles", _titles(self.titles))
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))

    @property
    def key(self) -> HistoryWeekKey:
        return (self.collection, self.week_start, self.input_hash, self.history_version)


@dataclass(frozen=True)
class NoteScore:
    """One ``curate.note_scores`` row: a note's impact and relevance on one weekly run (R-C6).

    ``importance`` is the judge's 1-10, present only where the features disagreed
    and the judge was asked.
    """

    note_id: str
    scorer_version: str
    run_day: str
    content_hash: str
    collection: str
    impact: float
    relevance: float
    features: dict[str, int | float]
    realm: str | None = None
    importance: int | None = None
    created_at: str | None = None

    def __post_init__(self) -> None:
        for name in ("note_id", "scorer_version", "content_hash", "collection"):
            _require_text(getattr(self, name), name)
        _require_importance(self.importance, optional=True)
        object.__setattr__(self, "run_day", to_iso_day(self.run_day))
        object.__setattr__(self, "impact", _finite_number(self.impact, "impact"))
        object.__setattr__(self, "relevance", _finite_number(self.relevance, "relevance"))
        object.__setattr__(self, "features", _features(self.features))
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))

    @property
    def key(self) -> NoteScoreKey:
        return (self.note_id, self.scorer_version, self.run_day)


@dataclass(frozen=True)
class ImportanceJudgement:
    """One ``curate.importance_judgements`` row: the judge's cached 1-10 for one note version."""

    note_id: str
    content_hash: str
    scorer_version: str
    importance: int
    model: str | None = None
    created_at: str | None = None

    def __post_init__(self) -> None:
        for name in ("note_id", "content_hash", "scorer_version"):
            _require_text(getattr(self, name), name)
        _require_importance(self.importance, optional=False)
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))

    @property
    def key(self) -> ImportanceKey:
        return (self.note_id, self.content_hash, self.scorer_version)


@dataclass(frozen=True)
class Proposal:
    """One ``curate.proposals`` row: a condense or prune candidate as a report listed it.

    ``no_loss`` is the R-C7 verifier's verdict: every issue, decision and
    requirement reference in the text the action would remove survives elsewhere.
    """

    realm_folder: str
    report_day: str
    note_id: str
    action: str
    collection: str
    reasons: tuple[str, ...]
    no_loss: bool
    created_at: str | None = None

    def __post_init__(self) -> None:
        for name in ("realm_folder", "note_id", "collection"):
            _require_text(getattr(self, name), name)
        _require_action(self.action)
        _require_bool(self.no_loss, "no_loss")
        object.__setattr__(self, "report_day", to_iso_day(self.report_day))
        object.__setattr__(self, "reasons", _texts(self.reasons, "reasons"))
        object.__setattr__(self, "created_at", _optional_instant(self.created_at))

    @property
    def key(self) -> ProposalKey:
        return (self.realm_folder, self.report_day, self.note_id, self.action)


@dataclass(frozen=True)
class Decision:
    """One ``curate.decisions`` row: Stack's tick (accepted) or untick of one proposal.

    Append-only: a change of mind is a new row, and the latest row per proposal
    key is the decision. ``id`` is None until the store assigns it;
    ``recorded_at`` is set by the store when None.
    """

    realm_folder: str
    report_day: str
    note_id: str
    action: str
    accepted: bool
    recorded_at: str | None = None
    id: int | None = None

    def __post_init__(self) -> None:
        for name in ("realm_folder", "note_id"):
            _require_text(getattr(self, name), name)
        _require_action(self.action)
        _require_bool(self.accepted, "accepted")
        object.__setattr__(self, "report_day", to_iso_day(self.report_day))
        object.__setattr__(self, "recorded_at", _optional_instant(self.recorded_at))

    @property
    def key(self) -> ProposalKey:
        """The proposal this decides."""
        return (self.realm_folder, self.report_day, self.note_id, self.action)


class CurateStore(Protocol):
    """What the curator stages need from persistence. Nothing here deletes."""

    def get_extraction(self, note_id: str, content_hash: str, extractor_version: str) -> Extraction | None: ...

    def get_extractions(self, keys: Sequence[ExtractionKey]) -> dict[ExtractionKey, Extraction]:
        """Batch lookup; only the keys that are cached appear in the result."""
        ...

    def put_extraction(self, extraction: Extraction) -> None:
        """Insert; an existing (note_id, content_hash, extractor_version) is left as it is."""
        ...

    def list_issues(self, collection: str) -> tuple[Issue, ...]:
        """The collection's issues in seq order."""
        ...

    def create_issue(
        self, collection: str, kind: str | None, summary: str, files: Sequence[str], first_seen_at: str
    ) -> Issue:
        """Allocate the collection's next seq and insert the issue, atomically."""
        ...

    def add_member(self, member: IssueMember) -> bool:
        """False when that item already belongs to an issue (this one or another)."""
        ...

    def members(self, collection: str) -> tuple[IssueMember, ...]: ...

    def add_event(self, event: IssueEvent) -> bool:
        """False when (issue_id, event_kind, cause_type, cause_ref, to_state) is already recorded."""
        ...

    def events(self, collection: str) -> tuple[IssueEvent, ...]:
        """Every event of the collection's issues, by effective_at then id."""
        ...

    def get_confirmation(self, item_key: str, issue_id: str, extractor_version: str) -> bool | None: ...

    def put_confirmation(
        self, item_key: str, issue_id: str, extractor_version: str, same: bool, model: str | None
    ) -> None:
        """Cache a verdict. The first verdict for a key wins; a second is ignored."""
        ...

    def get_history_week(self, collection: str, week_start: str | date, input_hash: str,
                         version: str) -> HistoryWeek | None: ...

    def put_history_week(self, week: HistoryWeek) -> None:
        """Insert; an existing (collection, week_start, input_hash, history_version) is left alone."""
        ...

    def put_note_score(self, score: NoteScore) -> bool:
        """False when (note_id, scorer_version, run_day) is already stored."""
        ...

    def note_scores(self, collection: str, run_day: str | date) -> tuple[NoteScore, ...]:
        """The collection's scores of one run day, by note_id then scorer_version."""
        ...

    def get_importance(self, note_id: str, content_hash: str, version: str) -> ImportanceJudgement | None: ...

    def put_importance(self, judgement: ImportanceJudgement) -> None:
        """Cache a judgement. The first for a key wins; a second is ignored."""
        ...

    def put_proposal(self, proposal: Proposal) -> bool:
        """False when (realm_folder, report_day, note_id, action) is already stored."""
        ...

    def proposals(self, realm_folder: str) -> tuple[Proposal, ...]:
        """The realm's proposals by report_day, action, note_id."""
        ...

    def record_decision(self, decision: Decision) -> bool:
        """Append only when ``accepted`` differs from the latest recorded for the same
        proposal key (no record yet counts as differing); False otherwise."""
        ...

    def decisions(self, realm_folder: str) -> tuple[Decision, ...]:
        """Every decision of the realm, by id."""
        ...

    def latest_decisions(self, realm_folder: str, report_day: str | date) -> dict[tuple[str, str], bool]:
        """(note_id, action) -> accepted, from the latest record per key of that report."""
        ...

    def close(self) -> None: ...


def new_issue(collection: str, seq: int, kind: str | None, summary: str,
              files: Sequence[str], first_seen_at: str, created_at: Any = None) -> Issue:
    """An :class:`Issue` with its id derived from ``collection`` and ``seq``; validates."""
    return Issue(format_issue_id(collection, seq), collection, seq, kind, summary,
                 tuple(files), first_seen_at, created_at)


class InMemoryCurateStore:
    """A dict-backed :class:`CurateStore` with the Postgres store's semantics."""

    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._extractions: dict[ExtractionKey, Extraction] = {}
        self._counters: dict[str, int] = {}
        self._issues: dict[str, Issue] = {}
        self._members: dict[tuple[str, str, str, int], IssueMember] = {}
        self._events: list[IssueEvent] = []
        self._event_keys: set[EventKey] = set()
        self._confirmations: dict[tuple[str, str, str], bool] = {}
        self._weeks: dict[HistoryWeekKey, HistoryWeek] = {}
        self._scores: dict[NoteScoreKey, NoteScore] = {}
        self._importance: dict[ImportanceKey, ImportanceJudgement] = {}
        self._proposals: dict[ProposalKey, Proposal] = {}
        self._decisions: list[Decision] = []

    def _now(self) -> str:
        return to_utc_iso(self._clock())

    def _require_issue(self, issue_id: str) -> Issue:
        issue = self._issues.get(issue_id)
        if issue is None:
            raise StoreError(f"{issue_id} is not an issue (foreign key)")
        return issue

    def get_extraction(self, note_id: str, content_hash: str, extractor_version: str) -> Extraction | None:
        found = self._extractions.get((note_id, content_hash, extractor_version))
        # replace() rebuilds the object, and with it fresh copies of the item dicts.
        return None if found is None else replace(found)

    def get_extractions(self, keys: Sequence[ExtractionKey]) -> dict[ExtractionKey, Extraction]:
        return {tuple(key): replace(self._extractions[tuple(key)])
                for key in keys if tuple(key) in self._extractions}

    def put_extraction(self, extraction: Extraction) -> None:
        if extraction.key not in self._extractions:
            self._extractions[extraction.key] = replace(
                extraction, created_at=extraction.created_at or self._now())

    def list_issues(self, collection: str) -> tuple[Issue, ...]:
        return tuple(sorted((i for i in self._issues.values() if i.collection == collection),
                            key=lambda i: i.seq))

    def create_issue(self, collection: str, kind: str | None, summary: str,
                     files: Sequence[str], first_seen_at: str) -> Issue:
        seq = self._counters.get(collection, 0) + 1
        issue = new_issue(collection, seq, kind, summary, files, first_seen_at, self._now())
        if issue.issue_id in self._issues:
            raise StoreError(f"{issue.issue_id} already exists for another collection (primary key)")
        self._counters[collection] = seq
        self._issues[issue.issue_id] = issue
        return issue

    def add_member(self, member: IssueMember) -> bool:
        self._require_issue(member.issue_id)
        if member.item_key in self._members:
            return False
        self._members[member.item_key] = member
        return True

    def members(self, collection: str) -> tuple[IssueMember, ...]:
        chosen = [m for m in self._members.values() if self._issues[m.issue_id].collection == collection]
        return tuple(sorted(chosen, key=lambda m: (self._issues[m.issue_id].seq, *m.item_key)))

    def add_event(self, event: IssueEvent) -> bool:
        self._require_issue(event.issue_id)
        if event.unique_key in self._event_keys:
            return False
        self._event_keys.add(event.unique_key)
        self._events.append(replace(event, id=len(self._events) + 1,
                                    recorded_at=event.recorded_at or self._now()))
        return True

    def events(self, collection: str) -> tuple[IssueEvent, ...]:
        chosen = [e for e in self._events if self._issues[e.issue_id].collection == collection]
        return tuple(sorted(chosen, key=lambda e: (datetime.fromisoformat(e.effective_at), e.id)))

    def get_confirmation(self, item_key: str, issue_id: str, extractor_version: str) -> bool | None:
        return self._confirmations.get((item_key, issue_id, extractor_version))

    def put_confirmation(self, item_key: str, issue_id: str, extractor_version: str,
                         same: bool, model: str | None) -> None:
        self._confirmations.setdefault((item_key, issue_id, extractor_version), bool(same))

    # replace() rebuilds each row read back, and with it fresh copies of its JSON fields.

    def get_history_week(self, collection: str, week_start: str | date, input_hash: str,
                         version: str) -> HistoryWeek | None:
        found = self._weeks.get((collection, to_iso_day(week_start), input_hash, version))
        return None if found is None else replace(found)

    def put_history_week(self, week: HistoryWeek) -> None:
        if week.key not in self._weeks:
            self._weeks[week.key] = replace(week, created_at=week.created_at or self._now())

    def put_note_score(self, score: NoteScore) -> bool:
        if score.key in self._scores:
            return False
        self._scores[score.key] = replace(score, created_at=score.created_at or self._now())
        return True

    def note_scores(self, collection: str, run_day: str | date) -> tuple[NoteScore, ...]:
        day = to_iso_day(run_day)
        return sort_scores(replace(s) for s in self._scores.values()
                           if s.collection == collection and s.run_day == day)

    def get_importance(self, note_id: str, content_hash: str, version: str) -> ImportanceJudgement | None:
        return self._importance.get((note_id, content_hash, version))

    def put_importance(self, judgement: ImportanceJudgement) -> None:
        if judgement.key not in self._importance:
            self._importance[judgement.key] = replace(
                judgement, created_at=judgement.created_at or self._now())

    def put_proposal(self, proposal: Proposal) -> bool:
        if proposal.key in self._proposals:
            return False
        self._proposals[proposal.key] = replace(proposal, created_at=proposal.created_at or self._now())
        return True

    def proposals(self, realm_folder: str) -> tuple[Proposal, ...]:
        return sort_proposals(p for p in self._proposals.values() if p.realm_folder == realm_folder)

    def record_decision(self, decision: Decision) -> bool:
        if latest_by_key(self._decisions).get(decision.key) == decision.accepted:
            return False
        self._decisions.append(replace(decision, id=len(self._decisions) + 1,
                                       recorded_at=decision.recorded_at or self._now()))
        return True

    def decisions(self, realm_folder: str) -> tuple[Decision, ...]:
        return tuple(d for d in self._decisions if d.realm_folder == realm_folder)

    def latest_decisions(self, realm_folder: str, report_day: str | date) -> dict[tuple[str, str], bool]:
        return report_decisions(self.decisions(realm_folder), report_day)

    def close(self) -> None:
        return None


# Orderings and folds every store shares, so the three cannot drift apart.


def sort_scores(scores: Iterable[NoteScore]) -> tuple[NoteScore, ...]:
    """The order every store lists scores in: note_id, then scorer_version."""
    return tuple(sorted(scores, key=lambda s: (s.note_id, s.scorer_version)))


def sort_proposals(proposals: Iterable[Proposal]) -> tuple[Proposal, ...]:
    """The order every store lists proposals in: report_day, action, note_id."""
    return tuple(sorted(proposals, key=lambda p: (p.report_day, p.action, p.note_id)))


def latest_by_key(decisions: Iterable[Decision]) -> dict[ProposalKey, bool]:
    """Proposal key -> ``accepted`` of its latest decision. ``decisions`` come in id order."""
    return {decision.key: decision.accepted for decision in decisions}


def report_decisions(decisions: Iterable[Decision], report_day: str | date) -> dict[tuple[str, str], bool]:
    """(note_id, action) -> the latest ``accepted`` among one realm's decisions of ``report_day``."""
    day = to_iso_day(report_day)
    return {(key[2], key[3]): accepted
            for key, accepted in latest_by_key(decisions).items() if key[1] == day}
