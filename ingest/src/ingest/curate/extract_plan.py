"""R-C2 planning: which notes need the judge, and how they are packed into calls.

Nothing here calls a judge or writes; ``--dry-run`` prints exactly this plan.

* **Which notes.** Every note record the inventory yields for a collection, in
  timeline order (:func:`collection_notes`): each main session followed by its
  subagents, then orphan subagents, then ``notes/`` and ``decisions/`` notes by
  date. ``sdk-*`` review-worker notes are sessions and are included.
* **Cache.** A note is a hit when ``(note_id, content_hash, version)`` is already
  stored; hits cost nothing. The lookup is one batch call per collection.
* **Batching.** Misses are packed in order into one call until the estimated
  input would pass :data:`BATCH_TOKEN_TARGET` or the batch holds
  :data:`MAX_NOTES_PER_BATCH` notes. A batch always takes at least one note, so a
  note bigger than the target goes alone. A note whose own block is estimated
  above :data:`MAX_NOTE_TOKENS` is skipped as "too large" and reported.
* **Estimates** are ``estimate_tokens`` (chars/4) of the exact text the prompt
  will carry; a call's cost for the budget adds :data:`OUTPUT_ALLOWANCE_TOKENS`.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass

from .inventory import Inventory
from .judge import estimate_tokens
from .note_records import NoteRecord, SkippedNote
from .prompts import PromptNote, build_prompt, note_block
from .store_models import Extraction, ExtractionKey

BATCH_TOKEN_TARGET = 12_000
MAX_NOTES_PER_BATCH = 8
MAX_NOTE_TOKENS = 30_000
OUTPUT_ALLOWANCE_TOKENS = 4_000

# Stand-ins with the real lengths, so an estimate matches the prompt that is sent.
_ESTIMATE_REF = "N00"
_ESTIMATE_NONCE = "0" * 16

Lookup = Callable[[Sequence[ExtractionKey]], Mapping[ExtractionKey, Extraction]]


@dataclass(frozen=True)
class Budget:
    """The per-run ceiling: judge calls, and tokens counted as input plus output."""

    max_calls: int
    max_tokens: int

    def __post_init__(self) -> None:
        for name in ("max_calls", "max_tokens"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer, got {value!r}")


@dataclass(frozen=True)
class Batch:
    """One planned judge call: notes of one collection, with their estimated sizes."""

    kind: str
    notes: tuple[NoteRecord, ...]
    note_tokens: tuple[int, ...]
    overhead_tokens: int

    @property
    def input_tokens(self) -> int:
        return self.overhead_tokens + sum(self.note_tokens)

    @property
    def estimated_cost(self) -> int:
        """What the budget reserves before the call: input plus the output allowance."""
        return self.input_tokens + OUTPUT_ALLOWANCE_TOKENS


@dataclass(frozen=True)
class CollectionPlan:
    folder: str
    realm: str | None
    collection: str
    kind: str
    notes: int
    hits: int
    batches: tuple[Batch, ...]
    too_large: tuple[SkippedNote, ...]
    duplicates: tuple[SkippedNote, ...]  # same (note_id, content_hash) as an earlier note

    @property
    def pending(self) -> int:
        return sum(len(batch.notes) for batch in self.batches)


@dataclass(frozen=True)
class ExtractPlan:
    version: str
    collections: tuple[CollectionPlan, ...]

    @property
    def pending_notes(self) -> int:
        return sum(plan.pending for plan in self.collections)

    @property
    def calls(self) -> int:
        return sum(len(plan.batches) for plan in self.collections)

    @property
    def estimated_tokens(self) -> int:
        return sum(batch.estimated_cost for plan in self.collections for batch in plan.batches)

    def fits(self, budget: Budget) -> bool:
        return self.calls <= budget.max_calls and self.estimated_tokens <= budget.max_tokens


def collection_notes(inventory: Inventory) -> tuple[NoteRecord, ...]:
    """Every note of the collection, in the order described in the module docstring."""
    sessions = [record for group in inventory.sessions for record in (group.session, *group.subagents)]
    orphans = [record for group in inventory.orphans for record in group.subagents]
    others = sorted((*inventory.notes, *inventory.decisions), key=_timeline_key)
    return (*sessions, *orphans, *others)


def _timeline_key(record: NoteRecord) -> tuple[bool, str, str]:
    """Date order, undated last, ties by path (the inventory's own rule)."""
    return (record.date is None, record.date or "", record.path)


def prompt_note(record: NoteRecord, ref: str) -> PromptNote:
    return PromptNote(ref=ref, date=record.date, role=record.role, title=record.title, body=record.body)


def note_tokens(record: NoteRecord) -> int:
    return estimate_tokens(note_block(prompt_note(record, _ESTIMATE_REF), _ESTIMATE_NONCE))


def overhead_tokens(kind: str) -> int:
    return estimate_tokens(build_prompt(kind, (), _ESTIMATE_NONCE))


def plan_extraction(inventories: Iterable[Inventory], lookup: Lookup, version: str) -> ExtractPlan:
    """The plan for every collection given; ``lookup`` is ``store.get_extractions``."""
    return ExtractPlan(version, tuple(_plan_collection(inv, lookup, version) for inv in inventories))


def _plan_collection(inventory: Inventory, lookup: Lookup, version: str) -> CollectionPlan:
    kind = inventory.profile.kind
    records = collection_notes(inventory)
    cached = lookup([(r.note_id, r.content_hash, version) for r in records])

    first_path: dict[tuple[str, str], str] = {}
    misses: list[tuple[NoteRecord, int]] = []
    too_large: list[SkippedNote] = []
    duplicates: list[SkippedNote] = []
    hits = 0
    for record in records:
        if (record.note_id, record.content_hash, version) in cached:
            hits += 1
            continue
        identity = (record.note_id, record.content_hash)
        if identity in first_path:
            duplicates.append(SkippedNote(record.path, f"same note id and content as {first_path[identity]}"))
            continue
        first_path[identity] = record.path
        tokens = note_tokens(record)
        if tokens > MAX_NOTE_TOKENS:
            too_large.append(SkippedNote(record.path, f"too large (~{tokens} tokens, limit {MAX_NOTE_TOKENS})"))
        else:
            misses.append((record, tokens))

    return CollectionPlan(
        folder=inventory.folder, realm=inventory.profile.realm, collection=inventory.profile.collection,
        kind=kind, notes=len(records), hits=hits, batches=pack(kind, misses),
        too_large=tuple(too_large), duplicates=tuple(duplicates),
    )


def pack(kind: str, misses: Sequence[tuple[NoteRecord, int]]) -> tuple[Batch, ...]:
    """Greedy, order-preserving packing under the note-count and token targets."""
    overhead = overhead_tokens(kind)
    batches: list[Batch] = []
    current: list[tuple[NoteRecord, int]] = []
    for record, tokens in misses:
        used = overhead + sum(size for _, size in current)
        if current and (len(current) >= MAX_NOTES_PER_BATCH or used + tokens > BATCH_TOKEN_TARGET):
            batches.append(_batch(kind, current, overhead))
            current = []
        current = [*current, (record, tokens)]
    if current:
        batches.append(_batch(kind, current, overhead))
    return tuple(batches)


def _batch(kind: str, members: Sequence[tuple[NoteRecord, int]], overhead: int) -> Batch:
    return Batch(kind=kind, notes=tuple(r for r, _ in members),
                 note_tokens=tuple(size for _, size in members), overhead_tokens=overhead)


def apportion(total: int, weights: Sequence[int]) -> tuple[int, ...]:
    """Split ``total`` in proportion to ``weights`` (largest remainder), summing to ``total``.

    All-zero weights split evenly. Ties in the remainder go to the earlier share.
    """
    if not weights:
        return ()
    shares = list(weights) if sum(weights) > 0 else [1] * len(weights)
    whole = sum(shares)
    floors = [total * share // whole for share in shares]
    remainders = [total * share % whole for share in shares]
    leftover = total - sum(floors)
    order = sorted(range(len(shares)), key=lambda i: (-remainders[i], i))
    bonus = set(order[:leftover])
    return tuple(floor + (1 if i in bonus else 0) for i, floor in enumerate(floors))
