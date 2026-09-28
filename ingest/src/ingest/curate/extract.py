"""R-C2: extraction, cached and checked — the run.

``extract_plan`` decides which notes need the judge and how they are batched;
this module spends the calls. Per batch: check the budget, build the prompt with
fresh labels (N1..Nk) and a fresh nonce, call the judge with the kind's schema,
route each answer back to its note by label, apply the substring guard, and write
that batch's cache rows at once, so a budget stop or a crash keeps the progress.

**Version.** The cache key is ``(note_id, content_hash, extractor_version)``
with ``extractor_version() == f"{EXTRACTOR_VERSION}+{fingerprint}"``. The
fingerprint is the first 8 hex of a sha256 over both kinds' schemas and every
fixed prompt text (sorted-key JSON), so editing a rubric, the instructions or the
schema is a new version and a cache miss without anyone remembering to bump.
Bump :data:`EXTRACTOR_VERSION` by hand for a change neither covers, such as the
guard's rules or the stored item order that ``IssueMember.item_index`` relies on.

**Answer routing.** A label missing from the answer leaves its note uncached
("no answer", retried next run). An unknown label, or a second answer for the
same label, is ignored and reported (a label that is not N1-shaped without its
value); the first answer for a label wins. A batch
whose call fails (:class:`JudgeError`, including a schema failure) leaves all its
notes uncached and reported, and the run goes on; after
:data:`MAX_CONSECUTIVE_FAILED_BATCHES` in a row it stops, because a broken
backend should not burn the budget.

**Budget.** Before each call: if one more call would pass ``max_calls``, or the
tokens used so far plus the batch's estimate (input plus the output allowance)
would pass ``max_tokens``, the run stops and says how far it got. After each
call the real usage is added. A failed call counts as a call and is charged
what the backend reports it used (a schema mismatch or an error result still
bills), or the batch's input estimate when it reports nothing, so failures that
alternate with successes cannot run past ``max_tokens`` uncounted.

**Stored usage.** A call's input and output tokens are divided across its notes
in proportion to their estimated size (:func:`~.extract_plan.apportion`), so the
rows of a fully answered batch sum to the call's usage. A note with no answer
stores nothing, so its share appears only in the run totals.

Exit codes: 0 every pending note done; 1 a note failed or had no answer, or the
run stopped after consecutive failures; 3 stopped by budget with no failure.
(2, could not run, belongs to the CLI.) A failure outranks a budget stop.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from . import prompts
from .extract_plan import (
    Batch,
    Budget,
    CollectionPlan,
    ExtractPlan,
    apportion,
    plan_extraction,
    prompt_note,
)
from .extract_schema import ISSUE_KINDS, ITEM_TYPES, REJECT_REASONS, build_schema, check_note_answer, is_ref
from .judge import Judge, JudgeError, JudgeUsage
from .store_models import CurateStore, Extraction

__all__ = [
    "EXTRACTOR_VERSION", "Budget", "ExtractPlan", "ExtractReport", "NoteProblem",
    "extractor_version", "plan_extraction", "run_extraction",
]

EXTRACTOR_VERSION = "c2-v1"
FINGERPRINT_CHARS = 8

DEFAULT_MAX_CALLS = 40
DEFAULT_MAX_TOKENS = 600_000
MAX_CONSECUTIVE_FAILED_BATCHES = 2

EXIT_DONE = 0
EXIT_FAILED = 1
EXIT_UNAVAILABLE = 2
EXIT_BUDGET = 3

STOP_BUDGET = "budget"
STOP_FAILURES = "failures"
NO_ANSWER = "no answer"
NOT_A_LABEL = "unknown ref (not a label; value withheld)"


def extractor_version() -> str:
    """``EXTRACTOR_VERSION`` plus the fingerprint of the schemas and prompt texts."""
    material = {
        "schemas": {kind: build_schema(kind) for kind in sorted(ISSUE_KINDS)},
        "prompts": prompts.prompt_texts(),
    }
    digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode("utf-8")).hexdigest()
    return f"{EXTRACTOR_VERSION}+{digest[:FINGERPRINT_CHARS]}"


@dataclass(frozen=True)
class NoteProblem:
    path: str
    reason: str


@dataclass(frozen=True)
class ExtractReport:
    plan: ExtractPlan
    budget: Budget
    extracted: int
    accepted: dict[str, int]  # item type -> count, only types seen, in stored order
    rejected: dict[str, int]  # reason -> count
    failed: tuple[NoteProblem, ...]
    ignored_refs: tuple[str, ...]
    calls: int
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    stopped: str | None = None

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def exit_code(self) -> int:
        if self.stopped == STOP_FAILURES or self.failed:
            return EXIT_FAILED
        return EXIT_BUDGET if self.stopped == STOP_BUDGET else EXIT_DONE

    @property
    def stop_message(self) -> str | None:
        progress = (f"extracted {self.extracted} of {self.plan.pending_notes} pending notes "
                    f"in {self.calls} calls, {self.tokens} tokens")
        if self.stopped == STOP_BUDGET:
            return f"stopped by budget: {progress}; rerun to continue"
        if self.stopped == STOP_FAILURES:
            return (f"stopped after {MAX_CONSECUTIVE_FAILED_BATCHES} consecutive failed batches "
                    f"(the judge backend looks broken): {progress}")
        return None


@dataclass
class _Tally:
    """The run's running totals; private, and frozen into an ExtractReport at the end."""

    extracted: int = 0
    accepted: Counter = field(default_factory=Counter)
    rejected: Counter = field(default_factory=Counter)
    failed: list[NoteProblem] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None
    consecutive_failures: int = 0


def run_extraction(
    plan: ExtractPlan,
    judge: Judge,
    store: CurateStore,
    budget: Budget,
    *,
    version: str,
    nonce: Callable[[Iterable[str]], str] = prompts.new_nonce,
) -> ExtractReport:
    """Spend the plan's calls within ``budget``; every answered note is written as it lands."""
    tally = _Tally()
    stopped = None
    for collection in plan.collections:
        for batch in collection.batches:
            if tally.calls + 1 > budget.max_calls or \
                    tally.input_tokens + tally.output_tokens + batch.estimated_cost > budget.max_tokens:
                stopped = STOP_BUDGET
                break
            _run_batch(collection, batch, judge, store, version, nonce, tally)
            if tally.consecutive_failures >= MAX_CONSECUTIVE_FAILED_BATCHES:
                stopped = STOP_FAILURES
                break
        if stopped:
            break
    return ExtractReport(
        plan=plan, budget=budget, extracted=tally.extracted,
        accepted={t: tally.accepted[t] for t in ITEM_TYPES if tally.accepted[t]},
        rejected={r: tally.rejected[r] for r in REJECT_REASONS if tally.rejected[r]},
        failed=tuple(tally.failed), ignored_refs=tuple(tally.ignored), calls=tally.calls,
        input_tokens=tally.input_tokens, output_tokens=tally.output_tokens,
        cost_usd=tally.cost_usd, stopped=stopped,
    )


def _run_batch(collection: CollectionPlan, batch: Batch, judge: Judge, store: CurateStore,
               version: str, nonce: Callable[[Iterable[str]], str], tally: _Tally) -> None:
    refs = tuple(f"N{index}" for index in range(1, len(batch.notes) + 1))
    notes = tuple(prompt_note(record, ref) for record, ref in zip(batch.notes, refs))
    fence = nonce(text for note in notes for text in (note.body, note.title))
    prompt = prompts.build_prompt(batch.kind, notes, fence)

    tally.calls += 1
    try:
        result = judge.judge(prompt, build_schema(batch.kind))
    except JudgeError as exc:
        tally.consecutive_failures += 1
        tally.failed.extend(NoteProblem(record.path, f"batch failed: {exc}") for record in batch.notes)
        _charge(tally, exc.usage or JudgeUsage(batch.input_tokens, 0, None))
        return
    tally.consecutive_failures = 0
    _charge(tally, result.usage)

    answers = _route(result.output["notes"], refs, tally)
    shares_in = apportion(result.usage.input_tokens, batch.note_tokens)
    shares_out = apportion(result.usage.output_tokens, batch.note_tokens)
    for ref, record, tokens_in, tokens_out in zip(refs, batch.notes, shares_in, shares_out):
        answer = answers.get(ref)
        if answer is None:
            tally.failed.append(NoteProblem(record.path, NO_ANSWER))
            continue
        checked = check_note_answer(answer, record.body)
        store.put_extraction(Extraction(
            note_id=record.note_id, content_hash=record.content_hash, extractor_version=version,
            collection=collection.collection, note_path=record.path, realm=record.realm,
            result=checked.accepted, rejected=checked.rejected, model=result.model,
            input_tokens=tokens_in, output_tokens=tokens_out,
        ))
        tally.extracted += 1
        tally.accepted.update(item["type"] for item in checked.accepted)
        tally.rejected.update(item["reason"] for item in checked.rejected)


def _charge(tally: _Tally, usage: JudgeUsage) -> None:
    tally.input_tokens += usage.input_tokens
    tally.output_tokens += usage.output_tokens
    if usage.cost_usd is not None:
        tally.cost_usd = (tally.cost_usd or 0.0) + usage.cost_usd


def _route(note_answers: list[dict], refs: tuple[str, ...], tally: _Tally) -> dict[str, dict]:
    """Label -> answer. Unknown labels and repeats are ignored and recorded; the first answer wins.

    The schema does not constrain the label, so one that is not label-shaped
    (N1, N2, ...) is reported without its value: it is model output and may echo
    note text.
    """
    known = set(refs)
    routed: dict[str, dict] = {}
    for answer in note_answers:
        ref = answer["ref"]
        if not is_ref(ref):
            tally.ignored.append(NOT_A_LABEL)
        elif ref not in known:
            tally.ignored.append(f"unknown ref {ref}")
        elif ref in routed:
            tally.ignored.append(f"duplicate ref {ref}")
        else:
            routed[ref] = answer
    return routed
