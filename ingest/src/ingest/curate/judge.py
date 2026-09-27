"""The curator's Judge: the one place an LLM is consulted.

A judge is a pure function: prompt text and a JSON schema in, a JSON object out,
no tools and no side effects (Phase C *Shape* in docs/memory-sprint-requirements.md).
Every answer is validated against its schema before a stage sees it, whichever
backend produced it, so a stage only ever handles data of the shape it asked for.

Notes are untrusted input and may hold secrets that redaction missed, so no error
raised here carries the prompt or the model's raw answer. A schema failure names
the path and the schema keyword that failed, never the offending value, and a
path segment is shown only when the schema itself declares that name.

``FakeJudge`` lives here rather than in a conftest because every later curate
stage's tests import it; it validates exactly as the real backend does.
"""

from __future__ import annotations

import copy
import json
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Any, Protocol

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

from ..errors import IngestError

MAX_REPORTED_ERRORS = 10
MAX_SCHEMA_VALUE_CHARS = 80
UNDECLARED_SEGMENT = "?"
FAKE_MODEL = "fake-judge"
CHARS_PER_TOKEN_ESTIMATE = 4


class JudgeError(IngestError):
    """The judge could not produce an answer: process failed, timed out, not JSON."""


class JudgeOutputInvalid(JudgeError):
    """The judge answered, but the answer does not match the schema.

    Carries the validation messages only, never the raw answer.
    """

    def __init__(self, messages: tuple[str, ...]) -> None:
        super().__init__("judge output does not match the schema: " + "; ".join(messages))
        self.messages = messages


@dataclass(frozen=True)
class JudgeUsage:
    input_tokens: int
    output_tokens: int
    cost_usd: float | None


@dataclass(frozen=True)
class JudgeResult:
    output: dict  # validated against the schema the caller passed
    usage: JudgeUsage
    model: str


class Judge(Protocol):
    """What a curate stage needs from an LLM backend."""

    def judge(self, prompt: str, schema: dict) -> JudgeResult: ...


def check_request(prompt: object, schema: object) -> None:
    """Refuse a malformed request before any backend runs."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise JudgeError("judge prompt is empty or not a str")
    if not isinstance(schema, dict):
        raise JudgeError("judge schema must be a dict")


def validate_output(output: object, schema: dict) -> dict:
    """Validate ``output`` against ``schema`` (JSON Schema Draft 2020-12).

    Returns a deep copy of the output so the caller never shares structure with
    the backend's parsed JSON. Raises :class:`JudgeOutputInvalid` on a mismatch
    and :class:`JudgeError` if the schema itself is not a valid schema.
    """
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        # The schema is ours, not the model's, so its own message is safe to show.
        raise JudgeError(f"judge schema is not a valid Draft 2020-12 schema: {exc.message}") from exc

    validator = Draft202012Validator(schema)
    declared = frozenset(_declared_names(schema))
    messages = sorted(_describe(error, declared) for error in validator.iter_errors(output))
    if messages:
        raise JudgeOutputInvalid(_cap(messages))
    if not isinstance(output, dict):
        raise JudgeOutputInvalid(("$: the answer must be a JSON object",))
    return copy.deepcopy(output)


def _describe(error: ValidationError, declared: frozenset[str]) -> str:
    """One line per failure, built from the schema side only."""
    path = _render_path(error.absolute_path, declared)
    keyword = str(error.validator)
    if keyword == "required" and isinstance(error.instance, dict):
        missing = [name for name in error.validator_value if name not in error.instance]
        return f"{path}: missing required {missing}"
    if keyword in {"additionalProperties", "unevaluatedProperties"}:
        return f"{path}: fails '{keyword}' (a property the schema does not allow)"
    return f"{path}: fails '{keyword}' ({_short(error.validator_value)})"


def _render_path(segments: Iterable[Any], declared: frozenset[str]) -> str:
    rendered = ["$"]
    for segment in segments:
        if isinstance(segment, int):
            rendered.append(f"[{segment}]")
        else:
            rendered.append("." + (segment if segment in declared else UNDECLARED_SEGMENT))
    return "".join(rendered)


def _declared_names(schema: object) -> Iterator[str]:
    """Every property name the schema declares, at any depth."""
    if isinstance(schema, dict):
        properties = schema.get("properties")
        if isinstance(properties, dict):
            yield from (name for name in properties if isinstance(name, str))
        required = schema.get("required")
        if isinstance(required, list):
            yield from (name for name in required if isinstance(name, str))
        for value in schema.values():
            yield from _declared_names(value)
    elif isinstance(schema, list):
        for item in schema:
            yield from _declared_names(item)


def _short(value: object) -> str:
    text = json.dumps(value, sort_keys=True, default=str)
    if len(text) <= MAX_SCHEMA_VALUE_CHARS:
        return text
    return text[: MAX_SCHEMA_VALUE_CHARS - 3] + "..."


def _cap(messages: list[str]) -> tuple[str, ...]:
    if len(messages) <= MAX_REPORTED_ERRORS:
        return tuple(messages)
    hidden = len(messages) - MAX_REPORTED_ERRORS
    return (*messages[:MAX_REPORTED_ERRORS], f"and {hidden} more")


def estimate_tokens(text: str) -> int:
    """The rough chars/4 estimate the fake judge and ``--dry-run`` share."""
    return len(text) // CHARS_PER_TOKEN_ESTIMATE


# --- the fake ----------------------------------------------------------------


@dataclass(frozen=True)
class JudgeCall:
    prompt: str
    schema: dict


Responder = Callable[[str, dict], dict]
QueuedAnswer = dict | BaseException | type[BaseException]


class FakeJudge:
    """A :class:`Judge` for tests: no process, no model, no network.

    Built with either a responder ``(prompt, schema) -> dict`` or a sequence of
    answers taken in order, where an answer is a dict to return or an exception
    (instance or class) to raise. Every call is recorded before it is answered,
    and every dict answer passes through :func:`validate_output`.
    """

    def __init__(
        self,
        answers: Responder | Iterable[QueuedAnswer],
        model: str = FAKE_MODEL,
    ) -> None:
        self.model = model
        self._responder: Responder | None = answers if callable(answers) else None
        self._queue: deque[QueuedAnswer] = deque() if callable(answers) else deque(answers)
        self._calls: list[JudgeCall] = []

    @property
    def calls(self) -> tuple[JudgeCall, ...]:
        return tuple(self._calls)

    def judge(self, prompt: str, schema: dict) -> JudgeResult:
        check_request(prompt, schema)
        self._calls.append(JudgeCall(prompt=prompt, schema=copy.deepcopy(schema)))
        output = validate_output(self._next_answer(prompt, schema), schema)
        usage = JudgeUsage(
            input_tokens=estimate_tokens(prompt),
            output_tokens=estimate_tokens(json.dumps(output)),
            cost_usd=None,
        )
        return JudgeResult(output=output, usage=usage, model=self.model)

    def _next_answer(self, prompt: str, schema: dict) -> object:
        if self._responder is not None:
            return self._responder(prompt, schema)
        if not self._queue:
            raise JudgeError(f"FakeJudge queue is exhausted after {len(self._calls) - 1} answers")
        answer = self._queue.popleft()
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, type) and issubclass(answer, BaseException):
            raise answer()
        return answer
