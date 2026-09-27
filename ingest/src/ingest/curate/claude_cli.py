"""The first Judge backend: headless Claude Code (``claude -p``) on Stack's login.

The command, flag by flag (docs checked 2026-09-27 against
https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference,
https://code.claude.com/docs/en/hooks#disable-or-remove-hooks,
https://code.claude.com/docs/en/sessions and
https://code.claude.com/docs/en/agent-sdk/structured-outputs):

``-p JUDGE_INSTRUCTION``
    Print mode. The note text goes on **stdin** (``cat file | claude -p "query"`` is the
    documented pattern; piped stdin is capped at 10 MB), so the Windows ~32K command line
    never carries it. The fixed instruction sits right after ``-p`` because ``--tools``
    and ``--disallowedTools`` take variadic lists that would swallow a later positional.
``--output-format json --json-schema <schema>``
    One JSON result object; the validated answer is in ``structured_output``. The flag
    takes inline JSON only (no file form is documented). The schema goes compact and is
    refused above ``MAX_SCHEMA_ARGV_CHARS`` so argv stays well under the limit.
``--model <model>``
    ``DEFAULT_MODEL`` unless the caller injects another.
``--tools ""`` and ``--disallowedTools "mcp__*"``
    ``""`` disables every built-in tool; the docs say it "doesn't affect MCP tools", so
    those are denied separately.
``--strict-mcp-config`` (with no ``--mcp-config``)
    "Only use MCP servers from --mcp-config, ignoring all other MCP configurations": none load.
``--no-session-persistence``
    "sessions are not saved to disk": no transcript lands in ``~/.claude/projects``, so the
    nightly transcript sweep never files a judge call as a session.
``--safe-mode``
    Turns off CLAUDE.md (including the user-level one, which the empty cwd cannot avoid),
    skills, plugins, hooks, MCP servers, output styles and auto memory, while
    "Authentication, model selection, built-in tools, and permissions work normally".
``--settings '{"disableAllHooks": true}'``
    The hooks page's documented way "to turn hooks off for one run"; it outranks user,
    project and local settings. Kept alongside ``--safe-mode`` so user hooks (the harness's
    SessionStart/SessionEnd capture) stay off even if safe mode's scope changes.
``--disable-slash-commands``
    A note that starts with ``/something`` is never expanded as a command.

Rejected: ``--bare`` ("never reads OAuth credentials or the system keychain", so it would
need an API key and Stack logs in with a subscription). ``--setting-sources`` would drop
user settings, hooks included; credentials live outside settings files, but the docs do not
define an empty list, and ``disableAllHooks`` is the documented route, so it is not used.

The process runs in a fresh, empty temp directory, so no project ``CLAUDE.md``,
``.claude/settings.json`` or ``.mcp.json`` is found and the session is not routed to a repo.
Error messages never include the prompt or the model's output; they give the exit code, a
known result subtype and at most ``STDERR_EXCERPT_CHARS`` of stderr.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol

from .judge import JudgeError, JudgeResult, JudgeUsage, check_request, validate_output

log = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_TIMEOUT_S = 300.0
EXECUTABLE_NAME = "claude"
STDERR_EXCERPT_CHARS = 200
MAX_SCHEMA_ARGV_CHARS = 16_000  # Windows caps the whole command line near 32K chars
WORKDIR_PREFIX = "curate-judge-"
JUDGE_INSTRUCTION = (
    "The piped input is the whole task. Answer it only with JSON matching the given schema."
)
HOOKS_OFF_SETTINGS = json.dumps({"disableAllHooks": True})
# Stripped from the child's environment so `claude` uses Stack's subscription login rather
# than an API key that ingest's .env loading may have put in os.environ.
API_KEY_ENV_VARS = frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"})
SUCCESS_SUBTYPE = "success"
_SAFE_SUBTYPE = re.compile(r"[a-z_]{1,64}")
INPUT_CACHE_FIELDS = ("cache_creation_input_tokens", "cache_read_input_tokens")


class RunOutcome(Protocol):
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[list[str], str, Path, float], RunOutcome]
Which = Callable[[str], str | None]


def subprocess_runner(argv: list[str], stdin: str, cwd: Path, timeout: float) -> RunOutcome:
    """Run ``argv`` with list arguments (never a shell), UTF-8 both ways."""
    env = {key: value for key, value in os.environ.items() if key not in API_KEY_ENV_VARS}
    return subprocess.run(
        argv,
        input=stdin,
        cwd=cwd,
        timeout=timeout,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        check=False,
    )


def build_argv(executable: str, schema: dict, model: str) -> list[str]:
    """The exact command, documented flag by flag in the module docstring."""
    schema_json = json.dumps(schema, separators=(",", ":"), sort_keys=True)
    if len(schema_json) > MAX_SCHEMA_ARGV_CHARS:
        raise JudgeError(
            f"judge schema is {len(schema_json)} chars as JSON; the argv limit is "
            f"{MAX_SCHEMA_ARGV_CHARS}"
        )
    return [
        executable,
        "-p", JUDGE_INSTRUCTION,
        "--output-format", "json",
        "--json-schema", schema_json,
        "--model", model,
        "--tools", "",
        "--disallowedTools", "mcp__*",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--safe-mode",
        "--settings", HOOKS_OFF_SETTINGS,
        "--disable-slash-commands",
    ]  # fmt: skip


class ClaudeCliJudge:
    """:class:`~ingest.curate.judge.Judge` backed by ``claude -p``."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        *,
        runner: Runner = subprocess_runner,
        which: Which = shutil.which,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ) -> None:
        if not model.strip():
            raise JudgeError("judge model must not be blank")
        if timeout_s <= 0:
            raise JudgeError("judge timeout must be positive")
        self.model = model
        self._runner = runner
        self._which = which
        self._timeout_s = timeout_s

    def judge(self, prompt: str, schema: dict) -> JudgeResult:
        check_request(prompt, schema)
        argv = build_argv(self._executable(), schema, self.model)
        with _empty_workdir() as workdir:
            outcome = self._run(argv, prompt, workdir)
        try:
            payload = _parse_result(outcome)
            output = validate_output(payload.get("structured_output"), schema)
            usage = _usage(payload)
        except JudgeError as exc:
            exc.usage = _reported_usage(outcome.stdout)
            raise
        return JudgeResult(output=output, usage=usage, model=self.model)

    def _executable(self) -> str:
        found = self._which(EXECUTABLE_NAME)
        if not found:
            raise JudgeError(
                f"`{EXECUTABLE_NAME}` is not on PATH; install Claude Code or add it to PATH "
                "for the account that runs the curator"
            )
        return found

    def _run(self, argv: list[str], prompt: str, workdir: Path) -> RunOutcome:
        try:
            return self._runner(argv, prompt, workdir, self._timeout_s)
        except subprocess.TimeoutExpired:
            raise JudgeError(f"claude timed out after {self._timeout_s:g} s") from None
        except OSError as exc:
            raise JudgeError(f"could not start claude: {type(exc).__name__}") from None


@contextmanager
def _empty_workdir() -> Iterator[Path]:
    """A fresh empty directory, removed afterwards; a failed removal is logged."""
    path = Path(tempfile.mkdtemp(prefix=WORKDIR_PREFIX))
    try:
        yield path
    finally:
        try:
            shutil.rmtree(path)
        except OSError as exc:
            log.warning("could not remove judge workdir %s: %s", path, exc)


def _parse_result(outcome: RunOutcome) -> dict:
    """The result object from stdout, or a JudgeError that quotes none of it."""
    payload = _json_object(outcome.stdout)
    if outcome.returncode != 0:
        subtype = _safe_subtype(payload) if payload is not None else "none"
        raise JudgeError(
            f"claude failed with exit code {outcome.returncode} (subtype={subtype}); "
            f"stderr: {_stderr_excerpt(outcome.stderr)!r}"
        )
    if payload is None:
        raise JudgeError("claude stdout is not a JSON object")
    subtype = payload.get("subtype")
    if payload.get("is_error") is True or (subtype is not None and subtype != SUCCESS_SUBTYPE):
        raise JudgeError(f"claude reported an error (subtype={_safe_subtype(payload)})")
    if payload.get("structured_output") is None:
        raise JudgeError(
            "claude result has no structured_output; the model did not answer through the schema"
        )
    return payload


def _json_object(stdout: str) -> dict | None:
    try:
        parsed = json.loads(stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _safe_subtype(payload: dict) -> str:
    """The result subtype when it looks like one of the CLI's own enum values."""
    subtype = payload.get("subtype")
    if isinstance(subtype, str) and _SAFE_SUBTYPE.fullmatch(subtype):
        return subtype
    return "unrecognised"


def _stderr_excerpt(stderr: str | None) -> str:
    text = " ".join((stderr or "").split())
    return text[:STDERR_EXCERPT_CHARS]


def _usage(payload: dict) -> JudgeUsage:
    """Token counts for the run budget.

    Cache writes and reads are summed into ``input_tokens``: they are input the call
    consumed, and the budget counts context size. The exact spend is ``total_cost_usd``,
    which already prices each kind at its own rate.
    """
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        raise JudgeError("claude result has no usage block; the run budget cannot count this call")
    cached = sum(_token_count(usage, field, required=False) for field in INPUT_CACHE_FIELDS)
    return JudgeUsage(
        input_tokens=_token_count(usage, "input_tokens", required=True) + cached,
        output_tokens=_token_count(usage, "output_tokens", required=True),
        cost_usd=_cost(payload.get("total_cost_usd")),
    )


def _reported_usage(stdout: str) -> JudgeUsage | None:
    """What a failed call reported it consumed, or None when it reported nothing usable."""
    payload = _json_object(stdout)
    if payload is None:
        return None
    try:
        return _usage(payload)
    except JudgeError:
        return None


def _token_count(usage: dict, field: str, *, required: bool) -> int:
    if field not in usage and not required:
        return 0
    value = usage.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise JudgeError(f"claude usage field {field} is missing or not a non-negative integer")
    return value


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value)
