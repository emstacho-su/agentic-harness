"""Phase tables in plan documents (R-C4), split from plan.py.

A markdown table whose first header cell is ``Phase`` (any case) gives one
:class:`PlanPhase` per body row, its cells keyed by the header text and kept raw.
Every other table is consumed and ignored, so nothing inside one is read as a
heading or a checkbox.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["PHASE_HEADER", "PlanPhase", "TableScanner"]

_TABLE_DIVIDER = re.compile(r"^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$")
_CELL_SPLIT = re.compile(r"(?<!\\)\|")
PHASE_HEADER = "phase"


@dataclass(frozen=True)
class PlanPhase:
    """One row of a table whose first header cell is ``Phase``; cells keyed by header, raw text."""

    name: str
    cells: dict[str, str]
    line: int


class TableScanner:
    """Collects the rows of every ``Phase`` table, fed one line at a time.

    A table starts at a ``|`` row directly followed by a divider row and runs
    until the first line that does not start with ``|``. Only a table whose first
    header cell is ``Phase`` (any case) yields rows; every table's lines are
    consumed, so nothing inside one is read as a heading or checkbox.
    """

    def __init__(self) -> None:
        self._header: list[str] | None = None
        self._wanted = False
        self._divider_next = False
        self._rows: list[PlanPhase] = []

    def feed(self, line: str, next_line: str | None, number: int) -> bool:
        """True when ``line`` belongs to a table."""
        if self._divider_next:
            self._divider_next = False
            return True
        is_row = line.lstrip().startswith("|")
        if self._header is not None:
            if is_row:
                self._row(line, number)
                return True
            self.close()
        if is_row and next_line is not None and "|" in next_line and _TABLE_DIVIDER.match(next_line):
            self._header = _cells(line)
            self._wanted = bool(self._header) and self._header[0].lower() == PHASE_HEADER
            self._divider_next = True
            return True
        return False

    def close(self) -> None:
        self._header = None
        self._wanted = False
        self._divider_next = False

    def phases(self) -> tuple[PlanPhase, ...]:
        return tuple(self._rows)

    def _row(self, line: str, number: int) -> None:
        if not self._wanted or self._header is None:
            return
        values = _cells(line)
        if not any(values):
            return
        padded = values[: len(self._header)] + [""] * (len(self._header) - len(values))
        self._rows.append(PlanPhase(padded[0], dict(zip(self._header, padded)), number))


def _cells(line: str) -> list[str]:
    """A table row's cells, stripped, with ``\\|`` unescaped."""
    inner = line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|") and not inner.endswith("\\|"):
        inner = inner[:-1]
    return [cell.strip().replace("\\|", "|") for cell in _CELL_SPLIT.split(inner)]
