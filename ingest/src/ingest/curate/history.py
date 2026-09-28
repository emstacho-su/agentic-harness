"""R-C5: a readable history — one judge-written narrative per ISO week, cached.

Per collection:

1. **Weeks.** Every dated record of the inventory, in units: a main session with
   its subagents nested beneath (a subagent follows its parent's week, and takes
   the parent's date when it has none), each orphan subagent, each ``notes/`` and
   ``decisions/`` note. A unit falls in the ISO week (Monday start) of its UTC
   date; units in a week are ordered by (date, path). An undated record is left
   out and reported. Commits fall in the week of their date, merged PRs in the
   week of ``merged_at``; a week with git facts but no record has no history.
2. **Items.** Each record carries the accepted items of its cached extraction at
   the current extractor version, when there is one.
3. **Cache.** ``input_hash`` is the sha256 of a sorted JSON of the week's
   (note_id, content_hash) pairs, commit shas, PR numbers and the extractor
   version. A stored ``HistoryWeek`` for (collection, week, hash, history
   version) is used as it is; anything that changes the week's input is a miss.
4. **Calls.** A miss costs one judge call (``history_prompt``): budget-checked
   through :class:`~.ledger.Spend` with the prompt's estimate plus
   :data:`OUTPUT_ALLOWANCE_TOKENS`; the answer is mapped back to note ids and
   stored. A failed call is charged as the ledger charges it and counts toward
   :data:`~.ledger.MAX_CONSECUTIVE_FAILURES`; a budget or failure stop leaves the
   remaining weeks pending for the next run. A dry run (no judge source) counts
   each miss as "would ask" with its estimated size and calls nothing.

**Version.** ``history_version() == "c5-v1+" + fingerprint``, the first 8 hex of
a sha256 over the prompt texts and the schema, so editing either is a new
version and a cache miss on its own.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from . import history_prompt, prompts
from .history_prompt import build_history_prompt, history_schema, resolve_answer, untrusted_texts
from .inventory import Inventory
from .judge import Judge, JudgeError, estimate_tokens
from .ledger import MAX_CONSECUTIVE_FAILURES, STOP_BUDGET, STOP_FAILURES, Spend
from .note_records import NoteRecord
from .store_models import CurateStore, Extraction, ExtractionKey, HistoryWeek, to_utc_iso

HISTORY_VERSION = "c5-v1"
FINGERPRINT_CHARS = 8
OUTPUT_ALLOWANCE_TOKENS = 2_000
DEFAULT_MAX_CALLS = 60
DEFAULT_MAX_TOKENS = 600_000
MERGED = "MERGED"

EXIT_DONE = 0
EXIT_FAILED = 1
EXIT_UNAVAILABLE = 2
EXIT_BUDGET = 3

_ESTIMATE_NONCE = "0" * 16

Lookup = Callable[[Sequence[ExtractionKey]], Mapping[ExtractionKey, Extraction]]
JudgeSource = Callable[[], Judge]


def history_version() -> str:
    """``HISTORY_VERSION`` plus the fingerprint of the prompt texts and the schema."""
    material = {"prompts": history_prompt.prompt_texts(), "schema": history_schema(["S1"])}
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()
    return f"{HISTORY_VERSION}+{digest[:FINGERPRINT_CHARS]}"


@dataclass(frozen=True)
class WeekRecord:
    record: NoteRecord
    effective_at: str  # UTC ISO; a dateless subagent's is its parent's
    items: tuple[dict[str, Any], ...]  # accepted extraction items at the current version, if cached


@dataclass(frozen=True)
class WeekInput:
    week_start: str  # YYYY-MM-DD, a Monday
    records: tuple[WeekRecord, ...]
    commits: tuple[Any, ...]  # gitfacts.Commit
    prs: tuple[Any, ...]  # gitfacts.PullRequest, merged
    input_hash: str


@dataclass(frozen=True)
class CollectionHistory:
    folder: str
    realm_folder: str
    collection: str
    weeks: tuple[WeekInput, ...]
    narratives: dict[str, HistoryWeek]  # week_start -> the cached or new narrative
    cached: int
    judge_calls: int
    would_ask: int
    estimated_tokens: int  # a dry run's estimate of the calls it would make
    dropped_citations: int
    dropped_paragraphs: int
    dropped_titles: int
    failed: tuple[tuple[str, str], ...]  # (week_start, reason)
    left: int  # weeks left by a budget or failure stop
    undated: tuple[str, ...]  # note paths
    note_index: dict[str, tuple[str, str]]  # note id -> (path, effective_at)

    @property
    def pending(self) -> int:
        return sum(1 for week in self.weeks if week.week_start not in self.narratives)


# -- weeks ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Timeline:
    weeks: tuple[WeekInput, ...]
    undated: tuple[str, ...]  # note paths, sorted


def week_inputs(inventory: Inventory, lookup: Lookup, git: Any, *, version: str) -> tuple[WeekInput, ...]:
    """Every week holding a dated record, ascending; ``lookup`` is ``store.get_extractions``."""
    return timeline(inventory, lookup, git, version=version).weeks


def timeline(inventory: Inventory, lookup: Lookup, git: Any, *, version: str) -> Timeline:
    """:func:`week_inputs` and the undated note paths, from one walk of the inventory."""
    units, undated = _units(inventory)
    records = [row for unit in units for row in unit]
    cached = lookup([(r.record.note_id, r.record.content_hash, version) for r in records])
    by_week: dict[str, list[WeekRecord]] = {}
    for unit in sorted(units, key=lambda u: (datetime.fromisoformat(u[0].effective_at), u[0].record.path)):
        week = week_of(unit[0].effective_at)
        for row in unit:
            found = cached.get((row.record.note_id, row.record.content_hash, version))
            items = tuple(found.result) if found is not None else ()
            by_week.setdefault(week, []).append(WeekRecord(row.record, row.effective_at, items))
    commits = _by_week(_field(git, "commits"), lambda c: c.date)
    prs = _by_week((p for p in _field(git, "prs") if p.state == MERGED and p.merged_at), lambda p: p.merged_at)
    weeks = tuple(
        _week(start, tuple(rows), tuple(commits.get(start, ())), tuple(prs.get(start, ())), version)
        for start, rows in sorted(by_week.items())
    )
    return Timeline(weeks=weeks, undated=tuple(undated))


def week_of(instant: str) -> str:
    """The Monday (ISO week start) of an ISO date or timestamp, in UTC."""
    day = datetime.fromisoformat(to_utc_iso(instant)).date()
    return (day - timedelta(days=day.isocalendar().weekday - 1)).isoformat()


def _units(inventory: Inventory) -> tuple[list[list[WeekRecord]], list[str]]:
    """Dated units (a session and its subagents, or one record) and the undated paths."""
    units: list[list[WeekRecord]] = []
    undated: list[str] = []
    for group in inventory.sessions:
        parent = _effective(group.session)
        if parent is None:
            undated.append(group.session.path)
            loose = [(s, _effective(s)) for s in group.subagents]
            units.extend([WeekRecord(s, when, ())] for s, when in loose if when is not None)
            undated.extend(s.path for s, when in loose if when is None)
            continue
        units.append([WeekRecord(group.session, parent, ()),
                      *(WeekRecord(s, _effective(s) or parent, ()) for s in group.subagents)])
    loose = [s for group in inventory.orphans for s in group.subagents] + [*inventory.notes, *inventory.decisions]
    for record in loose:
        when = _effective(record)
        if when is None:
            undated.append(record.path)
        else:
            units.append([WeekRecord(record, when, ())])
    return units, sorted(undated)


def _effective(record: NoteRecord) -> str | None:
    if not record.date:
        return None
    try:
        return to_utc_iso(record.date)
    except ValueError:
        return None


def _by_week(facts: Iterable[Any], when: Callable[[Any], str]) -> dict[str, list[Any]]:
    weeks: dict[str, list[Any]] = {}
    for fact in facts:
        try:
            weeks.setdefault(week_of(when(fact)), []).append(fact)
        except (TypeError, ValueError):
            continue  # a git fact without a usable date belongs to no week
    return weeks


def _field(git: Any, name: str) -> tuple[Any, ...]:
    """The GitFacts field, or nothing when git facts were not collected."""
    return tuple(getattr(git, name, None) or ())


def _week(start: str, rows: tuple[WeekRecord, ...], commits: tuple[Any, ...], prs: tuple[Any, ...],
          version: str) -> WeekInput:
    commits = tuple(sorted(commits, key=lambda c: (c.date, c.sha)))
    prs = tuple(sorted(prs, key=lambda p: (p.merged_at, p.number)))
    material = {
        "notes": sorted([r.record.note_id, r.record.content_hash] for r in rows),
        "commits": sorted(c.sha for c in commits),
        "prs": sorted(p.number for p in prs),
        "extractor_version": version,
    }
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()
    return WeekInput(start, rows, commits, prs, digest)


# -- the run --------------------------------------------------------------------------------------


@dataclass
class _Tally:
    narratives: dict[str, HistoryWeek] = field(default_factory=dict)
    cached: int = 0
    calls: int = 0
    would_ask: int = 0
    estimated: int = 0
    dropped_citations: int = 0
    dropped_paragraphs: int = 0
    dropped_titles: int = 0
    failed: list[tuple[str, str]] = field(default_factory=list)
    left: int = 0


def build_history(inventory: Inventory, store: CurateStore, judge: JudgeSource | None, spend: Spend, *,
                  version: str, extractor_version: str,
                  nonce: Callable[[Iterable[str]], str] = prompts.new_nonce) -> CollectionHistory:
    """Every week's narrative, from the cache or from one judge call; ``judge`` None is a dry run."""
    collection = inventory.profile.collection
    found_weeks = timeline(inventory, store.get_extractions, inventory.git, version=extractor_version)
    weeks = found_weeks.weeks
    tally = _Tally()
    for week in weeks:
        found = store.get_history_week(collection, week.week_start, week.input_hash, version)
        if found is not None:
            tally.narratives[week.week_start] = found
            tally.cached += 1
        elif spend.stopped:
            tally.left += 1
        elif judge is None:
            tally.would_ask += 1
            prompt = build_history_prompt(inventory.profile.kind, week, _labels(week), _ESTIMATE_NONCE)
            tally.estimated += estimate_tokens(prompt) + OUTPUT_ALLOWANCE_TOKENS
        else:
            _ask(inventory, store, judge, spend, week, version, nonce, tally)
    return CollectionHistory(
        folder=inventory.folder, realm_folder=inventory.folder.split("/", 1)[0], collection=collection,
        weeks=weeks, narratives=tally.narratives, cached=tally.cached, judge_calls=tally.calls,
        would_ask=tally.would_ask, estimated_tokens=tally.estimated, dropped_citations=tally.dropped_citations,
        dropped_paragraphs=tally.dropped_paragraphs, dropped_titles=tally.dropped_titles, failed=tuple(tally.failed),
        left=tally.left, undated=found_weeks.undated, note_index=_note_index(weeks),
    )


def _labels(week: WeekInput) -> list[str]:
    return [f"S{index}" for index in range(1, len(week.records) + 1)]


def _ask(inventory: Inventory, store: CurateStore, judge: JudgeSource, spend: Spend, week: WeekInput,
         version: str, nonce: Callable[[Iterable[str]], str], tally: _Tally) -> None:
    labels = _labels(week)
    prompt = build_history_prompt(inventory.profile.kind, week, labels, nonce(untrusted_texts(week)))
    if not spend.allows(estimate_tokens(prompt) + OUTPUT_ALLOWANCE_TOKENS):
        spend.stopped = STOP_BUDGET
        tally.left += 1
        return
    spend.calls += 1
    tally.calls += 1
    try:
        result = judge().judge(prompt, history_schema(labels))
    except JudgeError as exc:
        # a failed call may still have billed; charge what it reported, else the input estimate
        spent = exc.usage
        spend.tokens += (spent.input_tokens + spent.output_tokens) if spent else estimate_tokens(prompt)
        spend.consecutive_failures += 1
        if spend.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            spend.stopped = STOP_FAILURES
        tally.failed.append((week.week_start, f"judge failed: {exc}"))
        return
    spend.consecutive_failures = 0
    spend.tokens += result.usage.input_tokens + result.usage.output_tokens
    resolved = resolve_answer(result.output, dict(zip(labels, (r.record.note_id for r in week.records))))
    tally.dropped_citations += resolved.dropped_citations
    tally.dropped_paragraphs += resolved.dropped_paragraphs
    tally.dropped_titles += resolved.dropped_titles
    row = HistoryWeek(
        collection=inventory.profile.collection, week_start=week.week_start, input_hash=week.input_hash,
        history_version=version, narrative=resolved.narrative, titles=resolved.titles, model=result.model,
        input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens,
    )
    store.put_history_week(row)
    tally.narratives[week.week_start] = row


def _note_index(weeks: Sequence[WeekInput]) -> dict[str, tuple[str, str]]:
    index: dict[str, tuple[str, str]] = {}
    for week in weeks:
        for row in week.records:
            index.setdefault(row.record.note_id, (row.record.path, row.effective_at))
    return index


def exit_code(results: Sequence[CollectionHistory], spend: Spend, *, refused: bool = False) -> int:
    """2 when something could not run, 1 when a judge call failed, 3 for a budget stop, else 0.

    Dropped citations, paragraphs and titles are reported counts, not failures.
    """
    if refused:
        return EXIT_UNAVAILABLE
    if spend.stopped == STOP_FAILURES or any(result.failed for result in results):
        return EXIT_FAILED
    return EXIT_BUDGET if spend.stopped == STOP_BUDGET else EXIT_DONE

