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
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
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

ISSUE_ID_PREFIX = "ISSUE"
ISSUE_SEQ_WIDTH = 3

ExtractionKey = tuple[str, str, str]  # (note_id, content_hash, extractor_version)

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
    def unique_key(self) -> tuple[str, str, str, str]:
        """What makes a rerun insert nothing: the same cause for the same issue and kind."""
        return (self.issue_id, self.event_kind, self.cause_type, self.cause_ref)


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
        """False when (issue_id, event_kind, cause_type, cause_ref) is already recorded."""
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
        self._event_keys: set[tuple[str, str, str, str]] = set()
        self._confirmations: dict[tuple[str, str, str], bool] = {}

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

    def close(self) -> None:
        return None
