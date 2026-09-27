"""R-C3: the issue ledger's state machine — a pure reducer, no I/O.

An issue's state is never stored; it is replayed from the issue's events every
run, so an event that arrives late (an earlier note extracted after a later one)
lands in its right place and the answer is the same as if it had come in order.

**Order.** Events are sorted by ``(effective_at, kind order, cause_ref)``. The
kind order puts a sighting before any fix on the same instant, so one note that
says "found X and fixed it" is not read as a regression.

**Rules** (``to_state`` is the event's claim, ``state`` the issue's current one):

* ``found``: none -> open, opening an interval; open -> open and regressed ->
  regressed (another sighting); claimed-fixed or verified -> regressed, a
  recurrence after a fix, opening a new interval when the last one was closed.
* ``claimed-fixed``: open or regressed -> claimed-fixed; none -> claimed-fixed,
  opening an interval (the issue's first word is that it was fixed);
  claimed-fixed or verified -> no change.
* ``verified``: any state but verified -> verified, closing the interval
  (``valid_to`` = the event's instant); none -> verified with an interval that
  opens and closes at once; verified -> no change.
* an annotation (``to_state`` None: a workaround or wontfix claim) never moves
  the state.

Nothing is ever removed: a fixed issue keeps its interval with an end date.
Every event becomes one :class:`Transition`, including the ones that change
nothing (``from_state == to_state``), so the ledger can cite every cause.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from .store_models import IssueEvent

STATE_OPEN = "open"
STATE_CLAIMED_FIXED = "claimed-fixed"
STATE_VERIFIED = "verified"
STATE_REGRESSED = "regressed"

# Ties on the same instant: a sighting first, then annotations, then fixes, then proof.
KIND_ORDER = {
    "found": 0,
    "recurrence": 1,
    "claim-workaround": 2,
    "claim-wontfix": 3,
    "claim-fixed": 4,
    "fix-commit": 5,
    "merged-pr": 6,
}

# A stored event claiming "regressed" (the curator stores none; the reducer derives
# regressions) is read as a sighting, so no valid row can break a replay.
SIGHTING_STATES = (STATE_OPEN, STATE_REGRESSED)

Interval = tuple[str, "str | None"]  # (valid_from, valid_to); None while still open


@dataclass(frozen=True)
class Transition:
    """One event as applied: the state before and after, and what caused it."""

    at: str
    from_state: str | None
    to_state: str | None
    event_kind: str
    cause_type: str
    cause_ref: str
    evidence: str | None


@dataclass(frozen=True)
class IssueState:
    issue_id: str
    state: str | None
    intervals: tuple[Interval, ...]
    transitions: tuple[Transition, ...]
    sightings: int


def event_order(event: IssueEvent) -> tuple[datetime, int, str]:
    return (datetime.fromisoformat(event.effective_at), KIND_ORDER.get(event.event_kind, len(KIND_ORDER)),
            event.cause_ref)


def reduce_issue(issue_id: str, events: Iterable[IssueEvent]) -> IssueState:
    """Replay ``events`` (any order) into the issue's state, intervals and transitions."""
    ordered = sorted(events, key=event_order)
    for event in ordered:
        if event.issue_id != issue_id:
            raise ValueError(f"event of {event.issue_id} given to the reducer for {issue_id}")

    state: str | None = None
    intervals: list[Interval] = []
    transitions: list[Transition] = []
    sightings = 0
    for event in ordered:
        after, intervals = _apply(state, event.to_state, event.effective_at, intervals)
        if event.to_state in SIGHTING_STATES:
            sightings += 1
        transitions.append(Transition(
            at=event.effective_at, from_state=state, to_state=after, event_kind=event.event_kind,
            cause_type=event.cause_type, cause_ref=event.cause_ref, evidence=event.evidence,
        ))
        state = after
    return IssueState(issue_id, state, tuple(intervals), tuple(transitions), sightings)


def _apply(state: str | None, claim: str | None, at: str,
           intervals: list[Interval]) -> tuple[str | None, list[Interval]]:
    """(the state after, the intervals after) for one event. Returns new lists."""
    if claim is None:
        return state, intervals
    if claim in SIGHTING_STATES:
        return _sighting(state, at, intervals)
    if claim == STATE_CLAIMED_FIXED:
        if state in (STATE_OPEN, STATE_REGRESSED):
            return STATE_CLAIMED_FIXED, intervals
        if state is None:
            return STATE_CLAIMED_FIXED, [*intervals, (at, None)]
        return state, intervals
    if claim == STATE_VERIFIED:
        if state == STATE_VERIFIED:
            return state, intervals
        opened = intervals if _is_open(intervals) else [*intervals, (at, None)]
        return STATE_VERIFIED, [*opened[:-1], (opened[-1][0], at)]
    raise ValueError(f"no rule for an event moving to {claim!r}")


def _sighting(state: str | None, at: str, intervals: list[Interval]) -> tuple[str, list[Interval]]:
    if state is None:
        return STATE_OPEN, [*intervals, (at, None)]
    if state in (STATE_OPEN, STATE_REGRESSED):
        return state, intervals
    reopened = intervals if _is_open(intervals) else [*intervals, (at, None)]
    return STATE_REGRESSED, reopened


def _is_open(intervals: list[Interval]) -> bool:
    return bool(intervals) and intervals[-1][1] is None
