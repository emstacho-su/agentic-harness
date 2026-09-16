"""Last-success bookkeeping for the nightly reconcile.

A scheduled job that never fires emits no error. Nothing fails, no log line is
written, and the store quietly goes stale — so health is measured as
**staleness**, not as failure: the nightly full run writes a timestamp when it
finishes cleanly, and ``ingest --health`` asserts that timestamp is recent.

Only a *complete* run counts. A ``--limit`` pass, a ``--only`` single-note run
from the session hook, a dry run, or a run with failures all leave the previous
timestamp alone, because none of them reconciled the whole vault.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .errors import IngestError

# Overridable so tests, and a second machine, never write to the real file.
ENV_STATE_FILE = "HARNESS_INGEST_STATE_FILE"

# Lives beside the hook logs, which is where every other artifact of the
# capture -> ingest loop already is.
DEFAULT_STATE_RELATIVE = (".claude", "hooks", "ingest-state.json")

# The nightly job runs every 24 h. 36 h is one missed run plus a margin for a
# laptop that was asleep at 03:00, and is the threshold the DoD names.
DEFAULT_MAX_AGE_HOURS = 36

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class RunRecord:
    """One completed full reconcile."""

    completed_at: datetime
    source: str
    path: str
    documents: int
    chunks_written: int

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "last_success": self.completed_at.astimezone(timezone.utc).isoformat(),
            "source": self.source,
            "path": self.path,
            "documents": self.documents,
            "chunks_written": self.chunks_written,
        }


@dataclass(frozen=True)
class HealthReport:
    """Answer to "is the nightly reconcile still running?"."""

    ok: bool
    reason: str
    record: RunRecord | None = None
    age_hours: float | None = None


def state_file(env: Mapping[str, str] | None = None) -> Path:
    """Where the timestamp lives. ``HARNESS_INGEST_STATE_FILE`` overrides it."""
    source = os.environ if env is None else env
    override = (source.get(ENV_STATE_FILE) or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home().joinpath(*DEFAULT_STATE_RELATIVE)


def record_success(
    *,
    source: str,
    path: str,
    documents: int,
    chunks_written: int,
    now: datetime | None = None,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Write the last-success record. Returns the file it wrote."""
    record = RunRecord(
        completed_at=now or datetime.now(timezone.utc),
        source=source,
        path=path,
        documents=documents,
        chunks_written=chunks_written,
    )
    target = state_file(env)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a crash mid-write must not leave a truncated file
        # that reads as "never succeeded".
        temporary = target.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(record.to_json(), indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, target)
    except OSError as exc:
        raise IngestError(f"Could not write the run-state file {target}: {exc}") from exc
    return target


def read_last_success(env: Mapping[str, str] | None = None) -> RunRecord | None:
    """The last recorded full run, or None if there has never been one."""
    target = state_file(env)
    if not target.exists():
        return None

    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IngestError(f"Run-state file {target} is unreadable: {exc}") from exc

    if not isinstance(payload, dict):
        raise IngestError(f"Run-state file {target} does not contain a JSON object")

    raw = payload.get("last_success")
    if not isinstance(raw, str) or not raw.strip():
        raise IngestError(f"Run-state file {target} has no 'last_success' timestamp")

    return RunRecord(
        completed_at=_parse_timestamp(raw, target),
        source=str(payload.get("source") or "unknown"),
        path=str(payload.get("path") or "unknown"),
        documents=_as_int(payload.get("documents")),
        chunks_written=_as_int(payload.get("chunks_written")),
    )


def health(
    *,
    now: datetime | None = None,
    max_age_hours: int = DEFAULT_MAX_AGE_HOURS,
    env: Mapping[str, str] | None = None,
) -> HealthReport:
    """Is the last full reconcile recent enough?"""
    if max_age_hours < 1:
        raise ValueError("max_age_hours must be >= 1")

    moment = now or datetime.now(timezone.utc)
    try:
        record = read_last_success(env)
    except IngestError as exc:
        return HealthReport(ok=False, reason=str(exc))

    if record is None:
        return HealthReport(
            ok=False,
            reason=(
                f"No full ingest has ever been recorded in {state_file(env)}. "
                "Run the nightly command once, or register the scheduled task."
            ),
        )

    age = moment - record.completed_at
    age_hours = age / timedelta(hours=1)
    if age > timedelta(hours=max_age_hours):
        return HealthReport(
            ok=False,
            reason=(
                f"Last full ingest was {age_hours:.1f} h ago, over the {max_age_hours} h "
                "threshold. The scheduled task is not running."
            ),
            record=record,
            age_hours=age_hours,
        )

    return HealthReport(
        ok=True,
        reason=f"Last full ingest was {age_hours:.1f} h ago, within the {max_age_hours} h threshold.",
        record=record,
        age_hours=age_hours,
    )


def _parse_timestamp(raw: str, target: Path) -> datetime:
    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise IngestError(
            f"Run-state file {target} has an unparseable 'last_success': {raw!r}"
        ) from exc
    # A naive timestamp would compare against an aware "now" and raise; treat it
    # as UTC, which is what every writer of this file emits.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _as_int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


__all__ = [
    "DEFAULT_MAX_AGE_HOURS",
    "ENV_STATE_FILE",
    "HealthReport",
    "RunRecord",
    "health",
    "read_last_success",
    "record_success",
    "state_file",
]
