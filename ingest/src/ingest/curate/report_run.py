"""The ``report`` stage's work for one realm folder (R-C6 second half, R-C7).

1. **Read the ticks.** Every ``<realm>/curation/<YYYY-MM-DD>.md`` whose
   frontmatter says ``captured_by: curator`` and ``type: curation-report`` is
   read; anything else in that folder (a hand-written note, a file not named by
   a date) is counted as ignored and never touched. A checkbox line counts only
   when its (report day, note id, action) is a stored proposal, and only its
   first line per proposal does.

   A ticked box records an acceptance. An unticked box records a rejection when
   the report is older than today's run (Stack had the week to tick it) or when
   it undoes an earlier recorded tick; an unticked box on today's report is not
   decided yet. The store appends a decision only when it differs from the
   latest one, so reading the same file again records nothing.
2. **Score and propose** each selected collection: status for the open items,
   ``scores.score_collection``, the ledger's members, then ``proposals.propose``;
   each candidate is stored as today's proposal (an existing one is kept).
3. **Tally** every stored proposal of the realm against the latest decisions.
4. **Render** today's report from today's stored proposals (so a same-day rerun
   keeps what an earlier run proposed, and recorded ticks stay ticked) and write
   it through ``writer.write_curation_report`` unless this is a dry run. Links
   and paths come from every collection of the realm, not only the scored ones,
   and a collection ``--collection`` left unscored shows today's stored scores
   (or nothing when it has none), so a narrowed rerun keeps the rest of the page.

A dry run gets a ``DryRunStore``: decisions, scores and proposals it "records"
stay in memory, and no file is written.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from ..errors import ConfigError, IngestError, StoreError
from ..loaders.obsidian import split_frontmatter
from .inventory import Inventory
from .ledger import EmbedderSource, JudgeSource, Spend
from .note_records import CURATOR
from .plan import load_plan_sources
from .proposals import Candidate, propose
from .report_render import ScoreSummary, report_body, report_frontmatter, summarise_scores
from .retrieval_counts import Counts, RetrievalCounts
from .score_features import scored_records
from .scores import CollectionScores, score_collection
from .status import build_status, note_index, open_items
from .store_models import CurateStore, Decision, Extraction, Proposal
from .tally import Mode, Round, parse_report_checkboxes, promotion_state, rounds
from .writer import REPORT_FOLDER, REPORT_TYPE, WriteResult, write_curation_report

# A write outcome: the writer's result, a refusal message, or None for a dry run.
Write = WriteResult | str | None


@dataclass(frozen=True)
class ReadTicks:
    reports_read: int
    reports_ignored: int  # files in curation/ that are not the curator's dated reports
    recorded: int  # decisions appended
    ignored: int  # checkbox lines naming no stored proposal, or naming one twice


@dataclass(frozen=True)
class CollectionReport:
    folder: str
    collection: str
    scores: CollectionScores
    candidates: tuple[Candidate, ...]
    new_proposals: int


@dataclass(frozen=True)
class RealmReport:
    realm_folder: str
    day: str
    ticks: ReadTicks
    collections: tuple[CollectionReport, ...]
    rounds: tuple[Round, ...]
    modes: dict[str, Mode]
    write: Write

    @property
    def path(self) -> str:
        return f"{self.realm_folder}/{REPORT_FOLDER}/{self.day}.md"


@dataclass(frozen=True)
class RunContext:
    """What every realm of one run shares."""

    day: str
    generated_at: str
    dry_run: bool
    spend: Spend
    judge_source: JudgeSource | None
    embedder_source: EmbedderSource
    counts: RetrievalCounts
    scorer_version: str
    extractor_version: str


class FallbackRetrievalCounts:
    """Retrieval counts from ``build()`` on first use. When building or reading fails with a
    ConfigError or StoreError, one warning goes to stderr and every later read is empty."""

    def __init__(self, build: Callable[[], RetrievalCounts], *, owned: bool) -> None:
        self._build = build
        self._owned = owned
        self._held: RetrievalCounts | None = None
        self.available = True

    def counts(self, external_ids: Sequence[str]) -> dict[str, Counts]:
        if not self.available:
            return {}
        try:
            if self._held is None:
                self._held = self._build()
            return self._held.counts(external_ids)
        except (ConfigError, StoreError) as exc:
            print(f"warning: retrieval counts unavailable ({exc}); scoring without them", file=sys.stderr)
            self.available = False
            return {}

    def close(self) -> None:
        close = getattr(self._held, "close", None)
        if self._owned and close is not None:
            close()


# -- 1. the ticks ---------------------------------------------------------------------------------


def record_ticks(root: Path, realm_folder: str, store: CurateStore, today: str) -> ReadTicks:
    folder = root / realm_folder / REPORT_FOLDER
    if not folder.is_dir():
        return ReadTicks(0, 0, 0, 0)
    stored = {p.key for p in store.proposals(realm_folder)}
    read = ignored_files = recorded = ignored_ticks = 0
    for path in sorted(folder.iterdir()):
        if path.suffix.lower() != ".md":
            continue
        day = report_day(path)
        body = curator_report_body(path) if day is not None else None
        if body is None:
            ignored_files += 1
            continue
        read += 1
        latest = store.latest_decisions(realm_folder, day)
        seen: set[tuple[str, str]] = set()
        for tick in parse_report_checkboxes(body):
            pair = (tick.note_id, tick.action)
            if (realm_folder, day, *pair) not in stored or pair in seen:
                ignored_ticks += 1
                continue
            seen.add(pair)
            if not tick.checked and day >= today and pair not in latest:
                continue  # today's report, not ticked yet: undecided
            if store.record_decision(Decision(realm_folder, day, tick.note_id, tick.action, tick.checked)):
                recorded += 1
    return ReadTicks(read, ignored_files, recorded, ignored_ticks)


def report_day(path: Path) -> str | None:
    """The report's day when the file is named ``YYYY-MM-DD.md`` with a real date."""
    stem = path.stem
    if len(stem) != 10:
        return None
    try:
        return date.fromisoformat(stem).isoformat() if stem[4] == "-" == stem[7] else None
    except ValueError:
        return None


def curator_report_body(path: Path) -> str | None:
    """The body of a curation report the curator wrote, else None. A symlink is never followed."""
    if path.is_symlink() or not path.is_file():
        return None
    try:
        fields, body = split_frontmatter(path.read_text(encoding="utf-8"), path.name)
    except (OSError, UnicodeDecodeError, IngestError):
        return None
    if fields.get("captured_by") != CURATOR or fields.get("type") != REPORT_TYPE:
        return None
    return body


# -- 2. to 4. one realm ---------------------------------------------------------------------------


def report_realm(root: str, realm_folder: str, inventories: Sequence[Inventory], store: CurateStore,
                 context: RunContext, *, realm_inventories: Sequence[Inventory] | None = None) -> RealmReport:
    """Score and propose ``inventories``; ``realm_inventories`` (every collection of the realm,
    default ``inventories``) give the page its links, paths and the unscored collections' rows."""
    ticks = record_ticks(Path(root), realm_folder, store, context.day)
    collections = tuple(_collection(inventory, realm_folder, store, context) for inventory in inventories)
    proposals = store.proposals(realm_folder)
    decided = {day: store.latest_decisions(realm_folder, day) for day in sorted({p.report_day for p in proposals})}
    tallied = rounds(proposals, decided)
    modes = promotion_state(tallied)
    write = None
    if not context.dry_run:
        whole = realm_inventories if realm_inventories is not None else inventories
        summaries = _summaries(collections, whole, store, context)
        body = _body(context.day, proposals, decided, tallied, modes, summaries, whole)
        fields = report_frontmatter(realm_folder, context.day, context.generated_at, context.scorer_version)
        write = _write(root, realm_folder, context.day, fields, body)
    return RealmReport(realm_folder=realm_folder, day=context.day, ticks=ticks, collections=collections,
                       rounds=tallied, modes=modes, write=write)


def _collection(inventory: Inventory, realm_folder: str, store: CurateStore, context: RunContext) -> CollectionReport:
    collection = inventory.profile.collection
    version = context.extractor_version
    status = build_status(inventory, store.get_extractions, load_plan_sources(inventory.profile), inventory.git,
                          version=version)
    scores = score_collection(inventory, store, open_items(status), context.counts, context.embedder_source,
                              context.judge_source, context.spend, run_day=context.day,
                              version=context.scorer_version, extractor_version=version, git=inventory.git)
    members = {member.item_key: member.issue_id for member in store.members(collection)}
    candidates = propose(inventory, _extractions(store, inventory, version), members, scores)
    new = 0
    for candidate in candidates:
        if store.put_proposal(Proposal(
                realm_folder=realm_folder, report_day=context.day, note_id=candidate.note_id,
                action=candidate.action, collection=collection, reasons=candidate.reasons,
                no_loss=candidate.no_loss)):
            new += 1
    return CollectionReport(folder=inventory.folder, collection=collection, scores=scores, candidates=candidates,
                            new_proposals=new)


def _extractions(store: CurateStore, inventory: Inventory, version: str) -> dict[str, Extraction]:
    keys = [(r.note_id, r.content_hash, version) for r in scored_records(inventory)]
    cached = store.get_extractions(keys) if keys else {}
    return {key[0]: cached[key] for key in keys if key in cached}


def _summaries(collections: Sequence[CollectionReport], whole: Sequence[Inventory], store: CurateStore,
               context: RunContext) -> list[ScoreSummary]:
    """The scored collections' summaries, then each unscored one's from today's stored rows, if any."""
    summaries = [summarise_scores(c.collection, c.scores.notes) for c in collections]
    scored = {c.collection for c in collections}
    for inventory in whole:
        collection = inventory.profile.collection
        if collection in scored:
            continue
        scored.add(collection)
        stored = {s.note_id: s for s in store.note_scores(collection, context.day)
                  if s.scorer_version == context.scorer_version}
        if stored:
            summaries.append(summarise_scores(collection, stored))
    return summaries


def _body(day: str, proposals: Sequence[Proposal], decided: Mapping[str, Mapping[tuple[str, str], bool]],
          tallied: Sequence[Round], modes: Mapping[str, Mode], summaries: Sequence[ScoreSummary],
          inventories: Sequence[Inventory]) -> str:
    index: dict[str, tuple[str, str]] = {}
    paths: dict[str, str] = {}
    for inventory in inventories:
        for note_id, found in note_index(inventory).items():
            index.setdefault(note_id, found)
        for record in scored_records(inventory):
            paths.setdefault(record.note_id, record.path)
    today = [Candidate(note_id=p.note_id, action=p.action, collection=p.collection, reasons=p.reasons,
                       no_loss=p.no_loss, path=paths.get(p.note_id, ""))
             for p in proposals if p.report_day == day]
    accepted = {pair for pair, ok in decided.get(day, {}).items() if ok}
    return report_body(day, today, modes, tallied, summaries, index, accepted=accepted)


def _write(root: str, realm_folder: str, day: str, fields: dict[str, Any], body: str) -> WriteResult | str:
    where = f"{realm_folder}/{REPORT_FOLDER}/{day}.md"
    try:
        return write_curation_report(root, realm_folder, day, fields, body)
    except IngestError as exc:
        return f"{where}: {exc}"
    except OSError as exc:  # a locked file (Obsidian, OneDrive) must not sink the other realms
        return f"{where}: could not write ({exc.strerror or type(exc).__name__})"
