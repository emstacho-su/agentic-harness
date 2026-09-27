"""Text and JSON reports for ``uv run ingest curate extract`` (R-C2).

Paths, counts, reasons and token numbers only: no note body, quote or prompt text
is ever printed, and no value from an env file.
"""

from __future__ import annotations

from typing import Any

from .extract import ExtractReport
from .extract_plan import OUTPUT_ALLOWANCE_TOKENS, Budget, CollectionPlan, ExtractPlan


def plan_text(plan: ExtractPlan, budget: Budget) -> str:
    """The ``--dry-run`` report: per collection, then the planned batches and the budget check."""
    lines = [f"extract dry run (version {plan.version})"]
    for collection in plan.collections:
        lines.append(_collection_line(collection))
        lines.extend(
            f"  batch {index}: {len(batch.notes)} notes, ~{batch.input_tokens} input tokens"
            for index, batch in enumerate(collection.batches, start=1)
        )
        lines.extend(_skipped_lines(collection))
    verdict = "fits" if plan.fits(budget) else "does not fit"
    lines.append(
        f"dry run: {plan.calls} calls, ~{plan.estimated_tokens} estimated tokens "
        f"(input plus {OUTPUT_ALLOWANCE_TOKENS} output allowance per call); "
        f"budget {budget.max_calls} calls / {budget.max_tokens} tokens: {verdict}"
    )
    return "\n".join(lines)


def run_text(report: ExtractReport) -> str:
    """The report of a run that called the judge."""
    plan = report.plan
    lines = [f"extract (version {plan.version})"]
    for collection in plan.collections:
        lines.append(_collection_line(collection))
        lines.extend(_skipped_lines(collection))
    lines.append(
        f"extract: {len(plan.collections)} collection(s), notes {sum(c.notes for c in plan.collections)}, "
        f"cache hits {sum(c.hits for c in plan.collections)}, extracted {report.extracted} "
        f"of {plan.pending_notes} pending, failed {len(report.failed)}"
    )
    lines.append("items accepted: " + _counts(report.accepted))
    lines.append("items rejected: " + _counts(report.rejected))
    lines.extend(f"failed: {problem.path}: {problem.reason}" for problem in report.failed)
    lines.extend(f"ignored: {ref}" for ref in report.ignored_refs)
    cost = "n/a" if report.cost_usd is None else f"{report.cost_usd:.4f}"
    lines.append(
        f"calls {report.calls}, tokens in {report.input_tokens} / out {report.output_tokens}, cost_usd {cost}"
    )
    if report.stop_message:
        lines.append(report.stop_message)
    return "\n".join(lines)


def _collection_line(collection: CollectionPlan) -> str:
    return (
        f"{collection.folder} ({collection.kind}): notes {collection.notes}, cache hits {collection.hits}, "
        f"pending {collection.pending}, skipped too large {len(collection.too_large)}"
    )


def _skipped_lines(collection: CollectionPlan) -> list[str]:
    return [
        *(f"    too large: {item.path} ({item.reason})" for item in collection.too_large),
        *(f"    duplicate: {item.path} ({item.reason})" for item in collection.duplicates),
    ]


def _counts(counts: dict[str, int]) -> str:
    return ", ".join(f"{name} {count}" for name, count in counts.items()) or "none"


def plan_json(plan: ExtractPlan, budget: Budget) -> dict[str, Any]:
    return {
        "version": plan.version,
        "collections": [_collection_json(collection) for collection in plan.collections],
        "pending_notes": plan.pending_notes,
        "planned_calls": plan.calls,
        "estimated_tokens": plan.estimated_tokens,
        "output_allowance_per_call": OUTPUT_ALLOWANCE_TOKENS,
        "budget": {"max_calls": budget.max_calls, "max_tokens": budget.max_tokens},
        "fits_budget": plan.fits(budget),
    }


def run_json(report: ExtractReport) -> dict[str, Any]:
    return {
        **plan_json(report.plan, report.budget),
        "extracted": report.extracted,
        "accepted": dict(report.accepted),
        "rejected": dict(report.rejected),
        "failed": [{"path": p.path, "reason": p.reason} for p in report.failed],
        "ignored_refs": list(report.ignored_refs),
        "calls": report.calls,
        "input_tokens": report.input_tokens,
        "output_tokens": report.output_tokens,
        "cost_usd": report.cost_usd,
        "stopped": report.stopped,
        "stop_message": report.stop_message,
        "exit_code": report.exit_code,
    }


def _collection_json(collection: CollectionPlan) -> dict[str, Any]:
    return {
        "folder": collection.folder,
        "realm": collection.realm,
        "collection": collection.collection,
        "kind": collection.kind,
        "notes": collection.notes,
        "hits": collection.hits,
        "pending": collection.pending,
        "batches": [
            {"notes": [record.path for record in batch.notes], "input_tokens": batch.input_tokens}
            for batch in collection.batches
        ],
        "too_large": [{"path": item.path, "reason": item.reason} for item in collection.too_large],
        "duplicates": [{"path": item.path, "reason": item.reason} for item in collection.duplicates],
    }
