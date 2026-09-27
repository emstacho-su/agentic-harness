"""A dry run's store: every read reaches the real store, every write stays in memory.

``uv run ingest curate ledger --dry-run`` wraps the real :class:`CurateStore` in
:class:`DryRunStore` so the whole ledger run (clustering, events, replay) can
show what it would change without changing anything: no write method of the
real store is ever called. Issues it "creates" take the next seq after the ones
already stored, so the ids it prints are the ids a real run would allocate,
barring a counter gap left by a rolled-back allocation.

The C-b stages (status, history, report) get the same treatment for the history
cache, scores, importance judgements, proposals and decisions.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime

from ..errors import StoreError
from .store_models import (
    CurateStore,
    Decision,
    EventKey,
    HistoryWeek,
    HistoryWeekKey,
    ImportanceJudgement,
    ImportanceKey,
    Issue,
    IssueEvent,
    IssueMember,
    NoteScore,
    NoteScoreKey,
    Proposal,
    ProposalKey,
    latest_by_key,
    new_issue,
    report_decisions,
    sort_proposals,
    sort_scores,
    to_iso_day,
)


class DryRunStore:
    """Reads from ``base``; keeps writes in memory and never calls a write method of ``base``.

    Every write it holds is visible to later reads through the same instance, so
    a dry-run stage sees what a real run would have stored a moment earlier.
    """

    def __init__(self, base: CurateStore) -> None:
        self._base = base
        self._issues: list[Issue] = []
        self._members: dict[tuple[str, str, str, int], IssueMember] = {}
        self._events: list[IssueEvent] = []
        self._confirmations: dict[tuple[str, str, str], bool] = {}
        self._base_members: dict[str, set[tuple[str, str, str, int]]] = {}
        self._base_event_keys: dict[str, set[EventKey]] = {}
        self._owner: dict[str, str] = {}  # issue id -> collection, learned from list_issues
        self._weeks: dict[HistoryWeekKey, HistoryWeek] = {}
        self._scores: dict[NoteScoreKey, NoteScore] = {}
        self._importance: dict[ImportanceKey, ImportanceJudgement] = {}
        self._proposals: dict[ProposalKey, Proposal] = {}
        self._decisions: list[Decision] = []

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

    def get_history_week(self, collection: str, week_start: str | date, input_hash: str,
                         version: str) -> HistoryWeek | None:
        held = self._weeks.get((collection, to_iso_day(week_start), input_hash, version))
        if held is not None:
            return replace(held)
        return self._base.get_history_week(collection, week_start, input_hash, version)

    def put_history_week(self, week: HistoryWeek) -> None:
        if week.key not in self._weeks and self._base.get_history_week(*week.key) is None:
            self._weeks[week.key] = week

    def put_note_score(self, score: NoteScore) -> bool:
        # The base has no lookup by key; its scores of that collection and day stand in,
        # which is exact while a note belongs to one collection on a given run day.
        stored = {s.key for s in self._base.note_scores(score.collection, score.run_day)}
        if score.key in self._scores or score.key in stored:
            return False
        self._scores[score.key] = score
        return True

    def note_scores(self, collection: str, run_day: str | date) -> tuple[NoteScore, ...]:
        day = to_iso_day(run_day)
        mine = (replace(s) for s in self._scores.values() if s.collection == collection and s.run_day == day)
        return sort_scores((*self._base.note_scores(collection, day), *mine))

    def get_importance(self, note_id: str, content_hash: str, version: str) -> ImportanceJudgement | None:
        stored = self._base.get_importance(note_id, content_hash, version)
        return stored if stored is not None else self._importance.get((note_id, content_hash, version))

    def put_importance(self, judgement: ImportanceJudgement) -> None:
        if self.get_importance(*judgement.key) is None:
            self._importance[judgement.key] = judgement

    def put_proposal(self, proposal: Proposal) -> bool:
        if proposal.key in self._proposals or \
                any(p.key == proposal.key for p in self._base.proposals(proposal.realm_folder)):
            return False
        self._proposals[proposal.key] = proposal
        return True

    def proposals(self, realm_folder: str) -> tuple[Proposal, ...]:
        mine = (p for p in self._proposals.values() if p.realm_folder == realm_folder)
        return sort_proposals((*self._base.proposals(realm_folder), *mine))

    def record_decision(self, decision: Decision) -> bool:
        if latest_by_key(self.decisions(decision.realm_folder)).get(decision.key) == decision.accepted:
            return False
        self._decisions.append(replace(decision, id=None))
        return True

    def decisions(self, realm_folder: str) -> tuple[Decision, ...]:
        stored = self._base.decisions(realm_folder)
        # Held decisions are numbered on read, after the highest stored id of the realm,
        # so they sort after the stored ones and "latest" stays the latest.
        highest = max((d.id or 0 for d in stored), default=0)
        mine = [d for d in self._decisions if d.realm_folder == realm_folder]
        return (*stored, *(replace(d, id=highest + n) for n, d in enumerate(mine, start=1)))

    def latest_decisions(self, realm_folder: str, report_day: str | date) -> dict[tuple[str, str], bool]:
        return report_decisions(self.decisions(realm_folder), report_day)

    def close(self) -> None:
        return None

    def _collection_of(self, issue_id: str) -> str:
        collection = self._owner.get(issue_id)
        if collection is None:
            raise StoreError(f"{issue_id} is not an issue (foreign key)")
        return collection
