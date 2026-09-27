"""R-C7: Stack's ticks tallied per report and action, and the promotion rule.

Pure: stored proposals and decisions in, rounds and modes out. Nothing here
reads a file or a store; ``report_run.py`` does, and passes what it read.

**A round** is one report day and one action with at least one proposal:
``proposed``, then ``accepted`` (latest decision True), ``rejected`` (latest
decision False) and ``undecided`` (no decision). ``acceptance`` is
``accepted / proposed``, so an undecided proposal counts against it.
``all_no_loss`` is True when the verifier passed every proposal of the round.

**The rule** (fixed by R-C7), per action and independently for condense and
prune, over the rounds in day order:

* a round *qualifies* when its acceptance is at least
  :data:`PROMOTION_ACCEPTANCE` and every proposal was ``no_loss``; each one
  adds 1 to the streak, and any other round resets the streak to 0;
* at :data:`PROMOTION_RUNS` the action becomes ``automatic``;
* while automatic, a round with a rejection demotes the action to
  ``proposals`` and resets the streak. A round that merely fails to qualify
  (undecided proposals, a possible loss) breaks the streak but does not demote.

The action's latest round, while it still has undecided proposals, is the
report nobody has reviewed yet: it is listed but neither extends nor breaks the
streak. Any earlier round is counted as it stands.

**Checkboxes.** :func:`parse_report_checkboxes` reads back only the exact
line ``report_render.py`` writes: ``- [ ] <action> `<note_id>` ...`` with
``[ ]``, ``[x]`` or ``[X]`` at the very start of the line. What it returns is
untrusted; the report stage keeps only ticks that name a stored proposal.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from .store_models import CURATE_ACTIONS, Proposal

PROMOTION_RUNS = 3
PROMOTION_ACCEPTANCE = 0.95
ACTIONS = CURATE_ACTIONS  # ("condense", "prune")

MODE_PROPOSALS = "proposals"
MODE_AUTOMATIC = "automatic"

_ACTION_ALTERNATIVES = "|".join(re.escape(action) for action in ACTIONS)
_CHECKBOX = re.compile(rf"^- \[([ xX])\] ({_ACTION_ALTERNATIVES}) `([^`\r\n]+)`(?: .*)?$")

DecisionsByDay = Mapping[str, Mapping[tuple[str, str], bool]]


@dataclass(frozen=True)
class Round:
    report_day: str
    action: str
    proposed: int
    accepted: int
    rejected: int
    undecided: int
    all_no_loss: bool

    @property
    def acceptance(self) -> float:
        return self.accepted / self.proposed if self.proposed else 0.0

    @property
    def qualifies(self) -> bool:
        return self.acceptance >= PROMOTION_ACCEPTANCE and self.all_no_loss


@dataclass(frozen=True)
class Mode:
    mode: str  # proposals | automatic
    streak: int


@dataclass(frozen=True)
class Tick:
    action: str
    note_id: str
    checked: bool


def rounds(proposals: Iterable[Proposal], latest_decisions_by_day: DecisionsByDay) -> tuple[Round, ...]:
    """One :class:`Round` per (report day, action) that has proposals, by day then action."""
    grouped: dict[tuple[str, str], list[Proposal]] = {}
    for item in proposals:
        grouped.setdefault((item.report_day, item.action), []).append(item)
    found = []
    for (day, action), items in sorted(grouped.items()):
        decided = latest_decisions_by_day.get(day, {})
        verdicts = [decided.get((item.note_id, action)) for item in items]
        accepted = sum(1 for verdict in verdicts if verdict is True)
        rejected = sum(1 for verdict in verdicts if verdict is False)
        found.append(Round(
            report_day=day, action=action, proposed=len(items), accepted=accepted, rejected=rejected,
            undecided=len(items) - accepted - rejected, all_no_loss=all(item.no_loss for item in items),
        ))
    return tuple(found)


def promotion_state(all_rounds: Sequence[Round]) -> dict[str, Mode]:
    """action -> its :class:`Mode` after replaying its rounds; see the module docstring."""
    return {action: _replay([r for r in sorted(all_rounds, key=lambda r: r.report_day) if r.action == action])
            for action in ACTIONS}


def _replay(action_rounds: Sequence[Round]) -> Mode:
    counted = list(action_rounds)
    if counted and counted[-1].undecided:
        counted.pop()  # the open report: nobody has reviewed it yet
    mode, streak = MODE_PROPOSALS, 0
    for item in counted:
        if mode == MODE_AUTOMATIC and item.rejected:
            mode, streak = MODE_PROPOSALS, 0
        elif item.qualifies:
            streak += 1
            if streak >= PROMOTION_RUNS:
                mode = MODE_AUTOMATIC
        else:
            streak = 0
    return Mode(mode, streak)


def open_round(action_rounds: Sequence[Round], candidate: Round) -> bool:
    """True when ``candidate`` is its action's latest round and still has undecided proposals."""
    same = [r for r in action_rounds if r.action == candidate.action]
    latest = max(same, key=lambda r: r.report_day, default=None)
    return latest == candidate and candidate.undecided > 0


def parse_report_checkboxes(text: str) -> tuple[Tick, ...]:
    """Every checkbox line in the report's own format, in file order; nothing else."""
    ticks = []
    for line in text.splitlines():
        match = _CHECKBOX.match(line.rstrip("\r"))
        if match is not None:
            ticks.append(Tick(action=match.group(2), note_id=match.group(3), checked=match.group(1) != " "))
    return tuple(ticks)
