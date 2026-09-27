"""R-C7's tally and promotion rule (curate/tally.py): rounds, streaks, demotion, and the
checkbox lines a curation report is read back through. Pure: no store, no file."""

from __future__ import annotations

import pytest

from ingest.curate.store_models import Proposal
from ingest.curate.tally import (
    ACTIONS,
    MODE_AUTOMATIC,
    MODE_PROPOSALS,
    PROMOTION_ACCEPTANCE,
    PROMOTION_RUNS,
    Mode,
    Round,
    Tick,
    parse_report_checkboxes,
    promotion_state,
    rounds,
)

REALM = "projects"


def proposal(day: str, note_id: str, action: str = "prune", no_loss: bool = True) -> Proposal:
    return Proposal(realm_folder=REALM, report_day=day, note_id=note_id, action=action, collection="demo",
                    reasons=("r",), no_loss=no_loss)


def closed(day: str, proposed: int, accepted: int, *, rejected: int | None = None, action: str = "prune",
           all_no_loss: bool = True) -> Round:
    """A reviewed round: every proposal decided unless ``rejected`` says fewer were."""
    rejected = proposed - accepted if rejected is None else rejected
    return Round(day, action, proposed, accepted, rejected, proposed - accepted - rejected, all_no_loss)


def test_constants_are_the_fixed_rule() -> None:
    assert (PROMOTION_RUNS, PROMOTION_ACCEPTANCE, ACTIONS) == (3, 0.95, ("condense", "prune"))


# -- rounds -------------------------------------------------------------------------------------


def test_rounds_count_each_report_and_action() -> None:
    proposals = [
        proposal("2026-09-20", "a"), proposal("2026-09-20", "b"), proposal("2026-09-20", "c", no_loss=False),
        proposal("2026-09-20", "d", action="condense"),
        proposal("2026-09-27", "e"),
    ]
    decisions = {
        "2026-09-20": {("a", "prune"): True, ("b", "prune"): False, ("d", "condense"): True},
        "2026-09-27": {},
    }
    assert rounds(proposals, decisions) == (
        Round("2026-09-20", "condense", 1, 1, 0, 0, True),
        Round("2026-09-20", "prune", 3, 1, 1, 1, False),
        Round("2026-09-27", "prune", 1, 0, 0, 1, True),
    )


def test_rounds_are_ascending_by_day_whatever_the_input_order() -> None:
    proposals = [proposal("2026-09-27", "a"), proposal("2026-09-13", "b"), proposal("2026-09-20", "c")]
    assert [r.report_day for r in rounds(proposals, {})] == ["2026-09-13", "2026-09-20", "2026-09-27"]


def test_a_decision_for_something_never_proposed_is_not_counted() -> None:
    (only,) = rounds([proposal("2026-09-20", "a")], {"2026-09-20": {("zzz", "prune"): True, ("a", "condense"): True}})
    assert (only.proposed, only.accepted, only.undecided) == (1, 0, 1)


def test_acceptance_is_accepted_over_proposed() -> None:
    assert closed("2026-09-20", 20, 19).acceptance == pytest.approx(0.95)
    assert closed("2026-09-20", 4, 1, rejected=0).acceptance == pytest.approx(0.25)


# -- promotion ----------------------------------------------------------------------------------


def test_nothing_proposed_is_proposals_mode() -> None:
    assert promotion_state(()) == {"condense": Mode(MODE_PROPOSALS, 0), "prune": Mode(MODE_PROPOSALS, 0)}


def test_two_qualifying_rounds_are_not_enough() -> None:
    state = promotion_state([closed("2026-09-06", 10, 10), closed("2026-09-13", 20, 19)])
    assert state["prune"] == Mode(MODE_PROPOSALS, 2)


def test_three_qualifying_rounds_promote() -> None:
    state = promotion_state([closed("2026-09-06", 10, 10), closed("2026-09-13", 20, 19), closed("2026-09-20", 5, 5)])
    assert state["prune"] == Mode(MODE_AUTOMATIC, 3)
    assert state["condense"] == Mode(MODE_PROPOSALS, 0)


def test_a_94_percent_round_breaks_the_streak() -> None:
    state = promotion_state([
        closed("2026-09-06", 10, 10), closed("2026-09-13", 10, 10),
        closed("2026-09-20", 50, 47),  # 94%
        closed("2026-09-27", 10, 10),
    ])
    assert state["prune"] == Mode(MODE_PROPOSALS, 1)


def test_a_round_with_a_possible_loss_breaks_the_streak() -> None:
    state = promotion_state([
        closed("2026-09-06", 10, 10), closed("2026-09-13", 10, 10),
        closed("2026-09-20", 10, 10, all_no_loss=False), closed("2026-09-27", 10, 10),
    ])
    assert state["prune"] == Mode(MODE_PROPOSALS, 1)


def test_a_rejection_while_automatic_demotes_and_resets() -> None:
    history = [closed(f"2026-08-{d:02d}", 40, 40) for d in (2, 9, 16)]
    assert promotion_state(history)["prune"] == Mode(MODE_AUTOMATIC, 3)
    history.append(closed("2026-08-23", 40, 39))  # 97.5%, but one rejection
    assert promotion_state(history)["prune"] == Mode(MODE_PROPOSALS, 0)
    history.append(closed("2026-08-30", 10, 10))
    assert promotion_state(history)["prune"] == Mode(MODE_PROPOSALS, 1)


def test_a_rejection_before_promotion_only_counts_through_acceptance() -> None:
    state = promotion_state([closed("2026-09-06", 40, 39), closed("2026-09-13", 40, 39), closed("2026-09-20", 40, 39)])
    assert state["prune"] == Mode(MODE_AUTOMATIC, 3)


def test_automatic_stays_automatic_through_a_short_round_without_rejection() -> None:
    history = [closed(f"2026-08-{d:02d}", 10, 10) for d in (2, 9, 16)]
    history.append(closed("2026-08-23", 10, 5, rejected=0))  # half undecided, a stale report
    history.append(closed("2026-08-30", 10, 10))
    assert promotion_state(history)["prune"] == Mode(MODE_AUTOMATIC, 1)


def test_the_latest_round_still_open_is_not_counted() -> None:
    history = [closed(f"2026-09-{d:02d}", 10, 10) for d in (6, 13, 20)]
    history.append(Round("2026-09-27", "prune", 4, 0, 0, 4, True))  # just written, nobody has ticked yet
    assert promotion_state(history)["prune"] == Mode(MODE_AUTOMATIC, 3)


def test_an_undecided_round_that_is_not_the_latest_counts_against() -> None:
    history = [closed("2026-09-06", 10, 10), Round("2026-09-13", "prune", 4, 0, 0, 4, True),
               closed("2026-09-20", 10, 10)]
    assert promotion_state(history)["prune"] == Mode(MODE_PROPOSALS, 1)


def test_condense_and_prune_are_promoted_separately() -> None:
    history = []
    for day in ("2026-09-06", "2026-09-13", "2026-09-20"):
        history.append(closed(day, 10, 10, action="condense"))
        history.append(closed(day, 10, 5, action="prune"))
    state = promotion_state(history)
    assert state == {"condense": Mode(MODE_AUTOMATIC, 3), "prune": Mode(MODE_PROPOSALS, 0)}


# -- report checkboxes ---------------------------------------------------------------------------


def test_parse_report_checkboxes_reads_the_exact_line_format() -> None:
    text = "\n".join([
        "# Curation report 2026-09-27",
        "- [ ] condense `session-a--1` [[projects/demo/sessions/a--1|2026-09-20]] — subagent of x (no-loss: yes)",
        "- [x] prune `note-b` [[projects/demo/notes/b|2026-09-21]] — body 12 chars (no-loss: yes)",
        "- [X] prune `note-c` note-c.md (undated) — scratchpad cwd (no-loss: no)\r",
    ])
    assert parse_report_checkboxes(text) == (
        Tick("condense", "session-a--1", False),
        Tick("prune", "note-b", True),
        Tick("prune", "note-c", True),
    )


@pytest.mark.parametrize("line", [
    "  - [x] prune `note-b` indented",
    "* [x] prune `note-b` another bullet",
    "- [x] delete `note-b` not an action",
    "- [x] prune note-b no code span",
    "- [y] prune `note-b` not a box",
    "- [x]prune `note-b` no space",
    "- [x] Prune `note-b` capitalised",
    "- [x] prune `` empty id",
    "text - [x] prune `note-b` mid-line",
    "| - [x] prune `note-b` | in a table |",
])
def test_parse_report_checkboxes_ignores_anything_else(line: str) -> None:
    assert parse_report_checkboxes(line) == ()


def test_a_forged_line_is_parsed_like_any_other() -> None:
    # The tally trusts nothing here: the report stage drops a tick whose id is no stored proposal.
    assert parse_report_checkboxes("- [x] prune `made-up-id` — anything") == (Tick("prune", "made-up-id", True),)
