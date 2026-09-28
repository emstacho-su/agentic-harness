"""``uv run ingest curate status`` — R-C4's stage: each requirement's state, written to status.md.

    uv run ingest curate status --path C:/Users/you/vault --collection agentic-harness --dry-run
    uv run ingest curate status --path C:/Users/you/vault --all --json

Per selected collection: the inventory (with git facts unless ``--no-git``),
the plan sources the hub names (``plan.load_plan_sources``), the cached
extractions at the current extractor version, then :func:`~.status.build_status`
and ``<realm>/<collection>/status.md`` through the curator's writer. No judge is
ever called, so there are no model or budget flags. The store is read even for a
dry run, as the ledger's is: without the cached extractions there is nothing to
report. ``--dry-run`` writes no file; the store is never written by this stage.

The report prints ids, paths and counts only: claim texts, titles and commit
subjects are note- or repo-derived and stay in status.md.

Exit codes: 0 done; 1 findings (a requirement is contradicted, or a plan source
is missing or unreadable); 2 could not run (bad arguments or vault, a hub that
cannot be read, the store unreachable even for a dry run, a status.md the
curator may not overwrite or cannot write). Never 3: there is no budget.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from ..envfile import load_env_file
from ..errors import IngestError
from .extract import extractor_version
from .inventory import GitCollector, VaultInventory, build_inventory
from .plan import load_plan_sources
from .profile import Runner
from .status import STATE_CONTRADICTED, STATES, CollectionStatus, build_status, note_index
from .status_render import status_body, status_frontmatter
from .store_models import CurateStore, to_utc_iso
from .writer import WriteResult, write_curator_note

STAGE = "status"

EXIT_DONE = 0
EXIT_FINDINGS = 1
EXIT_UNAVAILABLE = 2

# A write outcome: the writer's result, a refusal message, or None for a dry run.
Write = WriteResult | str | None


def add_parser(stages: argparse._SubParsersAction) -> None:
    from .cli import _common

    stage = stages.add_parser(
        STAGE, help="R-C4: each plan requirement's state from notes, checkboxes and git; write status.md"
    )
    stage.add_argument("--path", required=True, help="vault directory (C:/Users/... on Windows)")
    which = stage.add_mutually_exclusive_group(required=True)
    which.add_argument("--collection", default=None, help="only this collection (its folder name)")
    which.add_argument("--all", action="store_true", help="every collection")
    stage.add_argument("--realm", default=None, help="only this realm (name or top-level folder)")
    stage.add_argument("--no-git", action="store_true", help="skip git and gh: no commit or PR evidence")
    stage.add_argument("--dry-run", action="store_true", help="read the store only, write no file")
    stage.add_argument("--json", action="store_true", help="the report as JSON")
    _common(stage)


def run(args: argparse.Namespace, *, git_collector: GitCollector | None, runner: Runner,
        store: CurateStore | None, store_factory: Callable[[], CurateStore] | None,
        clock: Callable[[], datetime], **_: Any) -> int:
    from .cli import _close, real_git_collector, real_store

    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
        collector = None if args.no_git else (git_collector or real_git_collector())
        found = build_inventory(args.path, realm=args.realm, collection=args.collection,
                                git_collector=collector, runner=runner)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    for item in found.errors:
        print(f"error: {item.path}: {item.reason}", file=sys.stderr)

    owned = None
    try:
        if store is None:
            store = owned = (store_factory or real_store)()
        results, writes = _run(args, found, store, clock)
    except IngestError as exc:
        reason = " (a dry run reads the store, so the status has nothing to work from)" if args.dry_run else ""
        print(f"error: {exc}{reason}", file=sys.stderr)
        return EXIT_UNAVAILABLE
    finally:
        _close(owned)
    refused = [write for write in writes if isinstance(write, str)]
    for message in refused:
        print(f"error: {message}", file=sys.stderr)
    code = exit_code(results, refused=bool(found.errors or refused))
    if args.json:
        print(json.dumps(status_json(results, writes, args.dry_run, code), indent=2))
    else:
        print(status_text(results, writes, args.dry_run, code))
    return code


def _run(args: argparse.Namespace, found: VaultInventory, store: CurateStore,
         clock: Callable[[], datetime]) -> tuple[tuple[CollectionStatus, ...], tuple[Write, ...]]:
    version = extractor_version()
    results: list[CollectionStatus] = []
    writes: list[Write] = []
    generated_at = to_utc_iso(clock())
    for inventory in found.collections:
        status = build_status(inventory, store.get_extractions, load_plan_sources(inventory.profile),
                              inventory.git, version=version)
        results.append(status)
        writes.append(None if args.dry_run else _write(found.root, status, note_index(inventory),
                                                       generated_at, version))
    return tuple(results), tuple(writes)


def _write(root: str, status: CollectionStatus, notes: dict[str, tuple[str, str]], generated_at: str,
           version: str) -> WriteResult | str:
    fields = status_frontmatter(status.realm_folder, status.collection, generated_at, version)
    body = status_body(status, notes)
    try:
        return write_curator_note(root, status.realm_folder, status.collection, STAGE, fields, body)
    except IngestError as exc:
        return f"{status.folder}/status.md: {exc}"
    except OSError as exc:  # a locked file (Obsidian, OneDrive) must not sink the other collections
        return f"{status.folder}/status.md: could not write ({exc.strerror or type(exc).__name__})"


def exit_code(results: tuple[CollectionStatus, ...], *, refused: bool) -> int:
    if refused:
        return EXIT_UNAVAILABLE
    if any(result.problems or result.id_collisions or _contradicted(result) for result in results):
        return EXIT_FINDINGS
    return EXIT_DONE


def _contradicted(result: CollectionStatus) -> list[str]:
    return [r.id for r in result.requirements if r.state == STATE_CONTRADICTED]


def _outcome(write: Write) -> str:
    if write is None:
        return "not written (dry run)"
    if isinstance(write, WriteResult):
        return "written" if write.written else "unchanged"
    return "refused"


# -- reports ------------------------------------------------------------------------------------


def status_text(results, writes, dry_run: bool, code: int) -> str:
    lines = [STAGE + (" dry run" if dry_run else "") + f" (version {extractor_version()})"]
    for result, write in zip(results, writes):
        states = ", ".join(f"{state} {result.counts.get(state, 0)}" for state in STATES)
        lines.append(
            f"{result.folder}: requirements {len(result.requirements)} ({states}); "
            f"plan sources found {len(result.sources)}, missing {len(result.problems)}, "
            f"id collisions {len(result.id_collisions)}; notes {result.notes}, extracted {result.extracted}"
        )
        contradicted = _contradicted(result)
        if contradicted:
            lines.append("    contradicted: " + ", ".join(contradicted))
        lines.extend(f"    plan source problem: {p.given} ({p.reason})" for p in result.problems)
        lines.extend(
            f"    id collision: {c.id} kept from {c.kept_source} ({c.kept_title}); "
            f"also in {c.other_source} ({c.other_title})"
            for c in result.id_collisions
        )
        lines.append(f"    status: {result.folder}/status.md {_outcome(write)}")
    lines.append(f"{STAGE}: {len(results)} collection(s), exit {code}")
    return "\n".join(lines)


def status_json(results, writes, dry_run: bool, code: int) -> dict[str, Any]:
    return {
        "version": extractor_version(),
        "dry_run": dry_run,
        "collections": [_collection_json(result, write) for result, write in zip(results, writes)],
        "exit_code": code,
    }


def _collection_json(result: CollectionStatus, write: Write) -> dict[str, Any]:
    return {
        "folder": result.folder,
        "collection": result.collection,
        "notes": result.notes,
        "extracted": result.extracted,
        "requirements": len(result.requirements),
        "states": {state: result.counts.get(state, 0) for state in STATES},
        "contradicted": _contradicted(result),
        "plan_sources": {
            "found": len(result.sources),
            "missing": len(result.problems),
            "problems": [{"given": p.given, "reason": p.reason} for p in result.problems],
            "id_collisions": [
                {"id": c.id, "kept_source": c.kept_source, "kept_title": c.kept_title,
                 "other_source": c.other_source, "other_title": c.other_title}
                for c in result.id_collisions
            ],
        },
        "status": {"path": f"{result.folder}/status.md", "written": isinstance(write, WriteResult) and write.written,
                   "outcome": _outcome(write)},
    }
