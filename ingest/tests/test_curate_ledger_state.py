"""Tests for the ledger's pure reducer (curate/ledger_state.py, R-C3)."""

from __future__ import annotations

import pytest

from ingest.curate.ledger_state import IssueState, Transition, reduce_issue
from ingest.curate.store_models import IssueEvent

ISSUE = "ISSUE-demo-001"


def event(kind: str, to_state: str | None, day: int, ref: str = "n1", cause: str = "note",
          evidence: str | None = None) -> IssueEvent:
    return IssueEvent(issue_id=ISSUE, to_state=to_state, event_kind=kind,
                      effective_at=f"2026-09-{day:02d}", cause_type=cause, cause_ref=ref,
                      evidence=evidence)


def found(day: int, ref: str = "n1") -> IssueEvent:
    return event("found", "open", day, ref)


def claim_fixed(day: int, ref: str = "n2") -> IssueEvent:
    return event("claim-fixed", "claimed-fixed", day, ref)


def verified(day: int, ref: str = "abc1234def") -> IssueEvent:
    return event("fix-commit", "verified", day, ref, cause="commit")


def at(day: int) -> str:
    return f"2026-09-{day:02d}T00:00:00+00:00"


def test_no_events_is_no_state() -> None:
    state = reduce_issue(ISSUE, ())
    assert state == IssueState(ISSUE, None, (), (), 0)


def test_found_opens_an_interval() -> None:
    state = reduce_issue(ISSUE, (found(1),))
    assert state.state == "open"
    assert state.intervals == ((at(1), None),)
    assert state.sightings == 1
    assert state.transitions == (Transition(at(1), None, "open", "found", "note", "n1", None),)


def test_a_second_sighting_keeps_it_open_and_counts() -> None:
    state = reduce_issue(ISSUE, (found(1), found(2, "n3")))
    assert state.state == "open"
    assert state.intervals == ((at(1), None),)
    assert state.sightings == 2
    assert [t.to_state for t in state.transitions] == ["open", "open"]


@pytest.mark.parametrize("before", ["open", "regressed"])
def test_a_fix_claim_moves_open_or_regressed_to_claimed_fixed(before: str) -> None:
    events = [found(1), claim_fixed(2)]
    if before == "regressed":
        events = [found(1), claim_fixed(2, "n2"), found(3, "n3"), claim_fixed(4, "n4")]
    state = reduce_issue(ISSUE, events)
    assert state.state == "claimed-fixed"
    assert state.intervals == ((at(1), None),)  # a claim does not close the interval


def test_verified_closes_the_interval_with_an_end_date() -> None:
    state = reduce_issue(ISSUE, (found(1), claim_fixed(2), verified(3)))
    assert state.state == "verified"
    assert state.intervals == ((at(1), at(3)),)


def test_verified_straight_from_open() -> None:
    state = reduce_issue(ISSUE, (found(1), verified(2)))
    assert state.state == "verified" and state.intervals == ((at(1), at(2)),)


def test_a_sighting_after_a_claimed_fix_is_a_regression_in_the_same_interval() -> None:
    state = reduce_issue(ISSUE, (found(1), claim_fixed(2), found(3, "n3")))
    assert state.state == "regressed"
    assert state.intervals == ((at(1), None),)
    assert state.transitions[-1].from_state == "claimed-fixed"


def test_a_sighting_after_verification_regresses_and_opens_a_second_interval() -> None:
    state = reduce_issue(ISSUE, (found(1), verified(2), found(5, "n5")))
    assert state.state == "regressed"
    assert state.intervals == ((at(1), at(2)), (at(5), None))
    assert state.sightings == 2


def test_a_regression_can_be_fixed_and_verified_again() -> None:
    events = (found(1), verified(2), found(5, "n5"), claim_fixed(6, "n6"), verified(7, "fedcba9"))
    state = reduce_issue(ISSUE, events)
    assert state.state == "verified"
    assert state.intervals == ((at(1), at(2)), (at(5), at(7)))


def test_a_regressed_issue_stays_regressed_on_another_sighting() -> None:
    state = reduce_issue(ISSUE, (found(1), claim_fixed(2), found(3, "n3"), found(4, "n4")))
    assert state.state == "regressed" and state.sightings == 3


def test_a_fix_claim_after_verification_changes_nothing() -> None:
    state = reduce_issue(ISSUE, (found(1), verified(2), claim_fixed(3)))
    assert state.state == "verified"
    assert state.intervals == ((at(1), at(2)),)
    last = state.transitions[-1]
    assert (last.from_state, last.to_state) == ("verified", "verified")


def test_a_second_verification_changes_nothing() -> None:
    state = reduce_issue(ISSUE, (found(1), verified(2), verified(3, "1234567")))
    assert state.intervals == ((at(1), at(2)),)


@pytest.mark.parametrize("kind", ["claim-workaround", "claim-wontfix"])
def test_annotations_never_change_state(kind: str) -> None:
    state = reduce_issue(ISSUE, (found(1), event(kind, None, 2, "n2", evidence="worked around it")))
    assert state.state == "open"
    last = state.transitions[-1]
    assert (last.from_state, last.to_state, last.event_kind, last.evidence) == ("open", "open", kind,
                                                                                "worked around it")


def test_an_annotation_before_anything_else_leaves_no_state() -> None:
    state = reduce_issue(ISSUE, (event("claim-wontfix", None, 1),))
    assert state.state is None and state.intervals == ()


def test_a_fix_claim_as_the_first_event_opens_the_interval() -> None:
    state = reduce_issue(ISSUE, (claim_fixed(1),))
    assert state.state == "claimed-fixed"
    assert state.intervals == ((at(1), None),)


def test_verified_as_the_first_event_opens_and_closes_at_once() -> None:
    state = reduce_issue(ISSUE, (verified(1),))
    assert state.state == "verified" and state.intervals == ((at(1), at(1)),)


def test_late_arriving_earlier_events_are_replayed_in_date_order() -> None:
    """The fix claim is recorded first, the earlier sighting later: the answer is the same."""
    in_order = reduce_issue(ISSUE, (found(1), claim_fixed(3)))
    late = reduce_issue(ISSUE, (claim_fixed(3), found(1)))
    assert late == in_order
    assert late.state == "claimed-fixed"


def test_a_late_sighting_between_fix_and_verification_is_a_regression() -> None:
    state = reduce_issue(ISSUE, (verified(5), found(1), claim_fixed(2), found(3, "n3")))
    assert [t.to_state for t in state.transitions] == ["open", "claimed-fixed", "regressed", "verified"]
    assert state.intervals == ((at(1), at(5)),)


def test_on_the_same_instant_found_sorts_before_the_fix() -> None:
    """One note that says 'found X and fixed it' is not a regression."""
    state = reduce_issue(ISSUE, (claim_fixed(1, "n1"), found(1, "n1")))
    assert state.state == "claimed-fixed"
    assert [t.event_kind for t in state.transitions] == ["found", "claim-fixed"]


def test_ties_of_kind_and_instant_break_by_cause_ref() -> None:
    state = reduce_issue(ISSUE, (found(1, "zz"), found(1, "aa")))
    assert [t.cause_ref for t in state.transitions] == ["aa", "zz"]


def test_events_of_another_issue_are_refused() -> None:
    other = IssueEvent(issue_id="ISSUE-demo-002", to_state="open", event_kind="found",
                       effective_at="2026-09-01", cause_type="note", cause_ref="n1")
    with pytest.raises(ValueError):
        reduce_issue(ISSUE, (other,))


def test_the_state_is_frozen() -> None:
    state = reduce_issue(ISSUE, (found(1),))
    with pytest.raises(AttributeError):
        state.state = "verified"  # type: ignore[misc]


def test_a_stored_regressed_claim_reads_as_a_sighting() -> None:
    state = reduce_issue(ISSUE, (found(1), verified(2), event("recurrence", "regressed", 3, "n3")))
    assert state.state == "regressed" and state.intervals == ((at(1), at(2)), (at(3), None))
