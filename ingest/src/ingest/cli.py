"""Command line entry point.

    uv run ingest --source obsidian   --path C:/Users/you/vault
    uv run ingest --source claude-mem --path C:/Users/you/.claude-archive/.../claude-mem-export
    uv run ingest --source obsidian   --path C:/Users/you/vault --dry-run
    uv run ingest --source obsidian   --path C:/Users/you/vault --only projects/x/sessions/y.md
    uv run ingest --source obsidian   --path C:/Users/you/vault --only a.md --only b.md
    uv run ingest sweep-concluded     --path C:/Users/you/vault [--apply]
    uv run ingest eval                [--json] [--min-hit-rate 0.8]
    uv run ingest --health

Windows note: always pass ``C:/Users/...``. An MSYS-style ``/c/Users/...`` path
resolves to ``C:\\c\\Users\\...`` for anything that is not the bash shell itself.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .chunking import MarkdownChunker
from .config import CHUNKING, EMBEDDING, SOURCE_CLAUDE_MEM, SOURCE_OBSIDIAN, load_db_settings
from .embedding import FastEmbedEmbedder
from .envfile import load_env_file
from .errors import IngestError
from .eval_cli import SUBCOMMAND as EVAL_SUBCOMMAND, run_eval_command
from .loaders import LoadedSource, load_claude_mem, load_vault, load_vault_notes
from .pipeline import Action, IngestPipeline, IngestStats
from .prune import PruneResult, prune_orphans
from .runstate import DEFAULT_MAX_AGE_HOURS, health, state_file
from .store import ChunkStore, NullStore, PostgresStore
from .sweep_cli import SUBCOMMAND as SWEEP_SUBCOMMAND, run_sweep
from .tokenizer import HeuristicTokenCounter, model_token_counter, tokenizer_from_embedder

log = logging.getLogger("ingest")

SOURCES = (SOURCE_OBSIDIAN, SOURCE_CLAUDE_MEM)

# Subcommands are dispatched before argparse sees anything, so the flag-only
# parser above keeps working exactly as it did.
SUBCOMMANDS = {SWEEP_SUBCOMMAND: run_sweep, EVAL_SUBCOMMAND: run_eval_command}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ingest",
        description="Ingest markdown or claude-mem history into rag.documents/rag.chunks.",
    )
    parser.add_argument("--source", choices=SOURCES, help="which loader to run")
    parser.add_argument(
        "--path",
        help="vault directory (obsidian) or export directory (claude-mem). "
        "On Windows use C:/Users/... , not /c/Users/... ",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would change; no embedding, no writes",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-chunk and re-embed even when the content hash is unchanged",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="process at most N documents"
    )
    parser.add_argument(
        "--only",
        action="append",
        default=None,
        metavar="NOTE",
        help="obsidian only: ingest exactly these notes instead of walking the "
        "vault. Absolute or vault-relative; each must be inside --path and must "
        "be a note a full run would also visit. Repeat the flag for more than "
        "one note; they are ingested by one process, so the embedding model is "
        "loaded once. This is what the SessionEnd hook runs.",
    )
    parser.add_argument(
        "--no-summaries",
        action="store_true",
        help="claude-mem only: skip session_summaries.json",
    )
    parser.add_argument(
        "--no-prompts",
        action="store_true",
        help="claude-mem only: skip user_prompts.json",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="DESTRUCTIVE: after a full pass, delete documents of this source "
        "whose external_id was not produced by the loader. Off by default; "
        "refused after --limit or any failure.",
    )
    parser.add_argument(
        "--check-env",
        action="store_true",
        help="report which connection variables are set, then exit",
    )
    parser.add_argument(
        "--health",
        action="store_true",
        help=f"report how long ago the last full reconcile finished and exit "
        f"non-zero if it is older than {DEFAULT_MAX_AGE_HOURS} h",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="path to a .env file (default: nearest .env walking up from the "
        "package, i.e. the repo root). Exported variables always win.",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] in SUBCOMMANDS:
        return SUBCOMMANDS[arguments[0]](arguments[1:])

    args = build_parser().parse_args(arguments)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        load_env_file(Path(args.env_file) if args.env_file else None)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.check_env:
        _report_env()
        return 0

    if args.health:
        return _report_health()

    if not args.source or not args.path:
        build_parser().print_usage(sys.stderr)
        print("error: --source and --path are both required", file=sys.stderr)
        return 2

    refusal = _refuse_bad_combination(args)
    if refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 2

    try:
        return _run(args)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("interrupted", file=sys.stderr)
        return 130


# --------------------------------------------------------------------------


def _refuse_bad_combination(args: argparse.Namespace) -> str | None:
    """Flag combinations that cannot mean anything sensible. Checked at the boundary."""
    if not args.only:
        return None
    if args.source != SOURCE_OBSIDIAN:
        return f"--only applies to --source {SOURCE_OBSIDIAN} only"
    if args.prune:
        # The orphan sweep deletes every document the run did not produce. After
        # a one-note run that is the entire vault.
        return (
            "--only and --prune contradict each other: naming the notes to "
            "ingest is not a full pass"
        )
    return None


def _run(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser()
    loaded = _load(args, path)
    _report_load(loaded)

    documents = loaded.documents
    if args.limit is not None:
        if args.limit < 1:
            print("error: --limit must be >= 1", file=sys.stderr)
            return 2
        documents = documents[: args.limit]

    if not documents:
        print("Nothing to ingest.")
        return 0

    store, embedder, chunker = _build_components(args)
    prune_result = None
    try:
        pipeline = IngestPipeline(
            store, embedder, chunker, dry_run=args.dry_run, force=args.force
        )
        stats = pipeline.run(documents)

        if args.prune:
            prune_result = prune_orphans(
                store,
                args.source,
                (doc.external_id for doc in documents),
                dry_run=args.dry_run,
                document_count=len(documents),
                failure_count=len(stats.failures),
                limited=args.limit is not None,
            )
    finally:
        store.close()

    _report_stats(stats, dry_run=args.dry_run)
    if prune_result is not None:
        _report_prune(prune_result, dry_run=args.dry_run)
    if _reconciled_everything(args, stats):
        _record_success(args, stats, len(documents))
    return 1 if stats.failures else 0


def _load(args: argparse.Namespace, path: Path) -> LoadedSource:
    if args.source == SOURCE_OBSIDIAN:
        if args.only:
            return load_vault_notes(path, args.only)
        return load_vault(path)
    return load_claude_mem(
        path,
        include_summaries=not args.no_summaries,
        include_prompts=not args.no_prompts,
    )


def _build_components(
    args: argparse.Namespace,
) -> tuple[ChunkStore, FastEmbedEmbedder | None, MarkdownChunker]:
    settings = load_db_settings()

    if args.dry_run:
        # Dry runs use approximate token counts so they never download the model.
        chunker = MarkdownChunker(count_tokens=HeuristicTokenCounter())
        if settings.can_connect:
            return PostgresStore.from_settings(settings), None, chunker
        log.warning(
            "DATABASE_URL is not set: every document will be reported as new."
        )
        return NullStore(), None, chunker

    embedder = FastEmbedEmbedder()
    chunker = MarkdownChunker(
        count_tokens=model_token_counter(tokenizer_from_embedder(embedder.model))
    )
    return PostgresStore.from_settings(settings), embedder, chunker


# --------------------------------------------------------------------------


def _reconciled_everything(args: argparse.Namespace, stats: IngestStats) -> bool:
    """Did this run actually reconcile the whole vault?

    Only such a run may refresh the health timestamp. A dry run wrote nothing, a
    ``--limit`` run saw part of the corpus, a ``--only`` run saw one note, and a
    run with failures left documents behind — none of them is evidence that the
    nightly reconcile is working. claude-mem is a retired one-time import, so it
    never counts either.
    """
    return (
        args.source == SOURCE_OBSIDIAN
        and not args.dry_run
        and not args.only
        and args.limit is None
        and not stats.failures
    )


def _record_success(args: argparse.Namespace, stats: IngestStats, documents: int) -> None:
    """Record the run, but never fail the run over the recording."""
    from .runstate import record_success

    try:
        target = record_success(
            source=args.source,
            path=str(Path(args.path).expanduser()),
            documents=documents,
            chunks_written=stats.chunks_written,
        )
    except IngestError as exc:
        log.warning("Could not record the run state: %s", exc)
        return
    print(f"  last-success recorded in {target}")


def _report_health() -> int:
    report = health()
    print(f"Nightly reconcile health: {'OK' if report.ok else 'STALE'}")
    print(f"  state file: {state_file()}")
    print(f"  {report.reason}")
    if report.record is not None:
        record = report.record
        print(f"  last success: {record.completed_at.isoformat()}")
        print(f"  source: {record.source}")
        print(f"  path: {record.path}")
        print(f"  documents: {record.documents}, chunks written: {record.chunks_written}")
    return 0 if report.ok else 1


def _report_env() -> None:
    settings = load_db_settings()
    print("Connection variables (values never printed):")
    for name, state in settings.redacted().items():
        print(f"  {name:22} {state}")
    print(
        "\nWrites go over DATABASE_URL (direct Postgres). The rag schema is not "
        "exposed to PostgREST, so there is no REST fallback. TLS is verify-full "
        "against DATABASE_CA_CERT; it never downgrades."
    )
    print(f"\nEmbedding model: {EMBEDDING.model_name} ({EMBEDDING.dimensions} dims)")
    print(
        f"Chunking: target {CHUNKING.target_tokens} tokens, "
        f"overlap {CHUNKING.overlap_tokens}, min {CHUNKING.min_tokens}"
    )


def _report_load(loaded: LoadedSource) -> None:
    for note in loaded.notes:
        print(note)
    print(f"Loaded {len(loaded.documents)} documents.")
    if loaded.skipped:
        print(f"Skipped {len(loaded.skipped)} records:")
        for reason, count in sorted(loaded.skip_reasons().items(), key=lambda kv: -kv[1]):
            print(f"  {count:5}  {reason}")


def _report_stats(stats: IngestStats, *, dry_run: bool) -> None:
    print("\n--- dry run, nothing written ---" if dry_run else "\n--- ingest complete ---")
    for action, count in stats.summary().items():
        if count:
            print(f"  {count:5}  {action}")
    if dry_run:
        print(f"  chunks that would be written: {stats.chunks_planned}")
    else:
        print(f"  chunks written: {stats.chunks_written}")

    # Say what "metadata-updated" means where it is counted, rather than leaving
    # an unexplained action name in the nightly log.
    refreshed = stats.count(
        Action.PLANNED_METADATA if dry_run else Action.METADATA_UPDATED
    )
    if refreshed:
        verb = "would refresh" if dry_run else "refreshed"
        print(
            f"  {verb} title/metadata on {refreshed} document(s) whose body was "
            "unchanged: no re-chunking, no embedding"
        )

    _report_failures(stats)


def _report_prune(result: PruneResult, *, dry_run: bool) -> None:
    if result.declined:
        print(f"\nOrphan sweep skipped: {result.declined_reason}")
        return
    if not result.orphans:
        print(f"\nOrphan sweep: nothing stale in source '{result.source}'.")
        return

    verb = "would delete" if dry_run else "deleted"
    print(f"\nOrphan sweep {verb} {len(result.orphans)} document(s) from '{result.source}':")
    for external_id in result.orphans[:20]:
        print(f"  {external_id}")
    if len(result.orphans) > 20:
        print(f"  ... and {len(result.orphans) - 20} more")
    if not dry_run:
        print(f"  rows removed: {result.deleted}")


def _report_failures(stats: IngestStats) -> None:
    failures = stats.failures
    if failures:
        print(f"\n{len(failures)} document(s) failed:", file=sys.stderr)
        for outcome in failures[:20]:
            print(f"  {outcome.external_id}: {outcome.detail}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more", file=sys.stderr)


__all__ = ["main", "build_parser", "Action"]
