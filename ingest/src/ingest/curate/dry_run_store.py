"""A dry run's store: every read reaches the real store, every write stays in memory.

``uv run ingest curate ledger --dry-run`` wraps the real :class:`CurateStore` in
:class:`DryRunStore` so the whole ledger run (clustering, events, replay) can
show what it would change without changing anything: no write method of the
real store is ever called. Issues it "creates" take the next seq after the ones
already stored, so the ids it prints are the ids a real run would allocate,
barring a counter gap left by a rolled-back allocation.
"""

from __future__ import annotations

from datetime import datetime

from ..errors import StoreError
from .store_models import CurateStore, EventKey, Issue, IssueEvent, IssueMember, new_issue


class DryRunStore:
    """Reads from ``base``; keeps writes in memory and never calls a write method of ``base``."""

    def __init__(self, base: CurateStore) -> None:
        self._base = base
        self._issues: list[Issue] = []
        self._members: dict[tuple[str, str, str, int], IssueMember] = {}
        self._events: list[IssueEvent] = []
        self._confirmations: dict[tuple[str, str, str], bool] = {}
        self._base_members: dict[str, set[tuple[str, str, str, int]]] = {}
        self._base_event_keys: dict[str, set[EventKey]] = {}
        self._owner: dict[str, str] = {}  # issue id -> collection, learned from list_issues

    def get_extraction(self, note_id, content_hash, extractor_version):
        return self._base.get_extraction(note_id, content_hash, extractor_version)

    def get_extractions(self, keys):
        return self._base.get_extractions(keys)

    def put_extraction(self, extraction) -> None:
        raise AssertionError("the ledger never writes extractions")

    def list_issues(self, collection: str) -> tuple[Issue, ...]:
        base = self._base.list_issues(collection)
        self._owner.update({issue.issue_id: collection for issue in base})
        return (*base, *(i for i in self._issues if i.collection == collection))

    def create_issue(self, collection, kind, summary, files, first_seen_at) -> Issue:
        seq = max((i.seq for i in self.list_issues(collection)), default=0) + 1
        issue = new_issue(collection, seq, kind, summary, files, first_seen_at)
        self._issues.append(issue)
        self._owner[issue.issue_id] = collection
        return issue

    def add_member(self, member: IssueMember) -> bool:
        collection = self._collection_of(member.issue_id)
        if collection not in self._base_members:
            self._base_members[collection] = {m.item_key for m in self._base.members(collection)}
        if member.item_key in self._members or member.item_key in self._base_members[collection]:
            return False
        self._members[member.item_key] = member
        return True

    def members(self, collection: str) -> tuple[IssueMember, ...]:
        mine = [m for m in self._members.values() if self._collection_of(m.issue_id) == collection]
        return (*self._base.members(collection), *mine)

    def add_event(self, event: IssueEvent) -> bool:
        collection = self._collection_of(event.issue_id)
        if collection not in self._base_event_keys:
            self._base_event_keys[collection] = {e.unique_key for e in self._base.events(collection)}
        if event.unique_key in self._base_event_keys[collection] or \
                any(e.unique_key == event.unique_key for e in self._events):
            return False
        self._events.append(event)
        return True

    def events(self, collection: str) -> tuple[IssueEvent, ...]:
        mine = [e for e in self._events if self._collection_of(e.issue_id) == collection]
        merged = (*self._base.events(collection), *mine)
        return tuple(sorted(merged, key=lambda e: datetime.fromisoformat(e.effective_at)))

    def get_confirmation(self, item_key, issue_id, extractor_version):
        held = self._confirmations.get((item_key, issue_id, extractor_version))
        return held if held is not None else self._base.get_confirmation(item_key, issue_id, extractor_version)

    def put_confirmation(self, item_key, issue_id, extractor_version, same, model) -> None:
        self._confirmations.setdefault((item_key, issue_id, extractor_version), bool(same))

    def close(self) -> None:
        return None

    def _collection_of(self, issue_id: str) -> str:
        collection = self._owner.get(issue_id)
        if collection is None:
            raise StoreError(f"{issue_id} is not an issue (foreign key)")
        return collection
