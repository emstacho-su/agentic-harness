"""Split markdown into structural blocks.

The chunker never looks at raw lines — it packs *blocks*, which is how it avoids
cutting through a fenced code block or a table. A block is the smallest unit the
chunker is allowed to treat as atomic:

    heading | code fence | table | list run | paragraph

Each block also carries the heading trail that was active where it appeared, so
a chunk can be prefixed with a breadcrumb once it is torn out of its file.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum

log = logging.getLogger(__name__)

_FENCE_OPEN = re.compile(r"^(\s{0,3})(`{3,}|~{3,})(.*)$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d{1,9}[.)])\s+")
_TABLE_DIVIDER = re.compile(r"^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$")


class BlockKind(str, Enum):
    HEADING = "heading"
    CODE = "code"
    TABLE = "table"
    LIST = "list"
    PARAGRAPH = "paragraph"


@dataclass(frozen=True)
class Block:
    kind: BlockKind
    text: str
    heading_trail: tuple[str, ...] = ()
    start_line: int = 0


def parse_blocks(body: str) -> list[Block]:
    """Parse a markdown body into blocks.

    Line endings are normalised first; the caller's original text is untouched.
    An unterminated code fence is kept as a single code block and logged — it is
    malformed input, but dropping the tail would silently lose content.
    """
    if not isinstance(body, str):
        raise TypeError(f"body must be str, got {type(body).__name__}")

    lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[Block] = []
    trail: list[tuple[int, str]] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        fence = _FENCE_OPEN.match(line)
        if fence:
            block, i = _consume_fence(lines, i, fence, _trail_titles(trail))
            blocks.append(block)
            continue

        heading = _HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            # The breadcrumb for a heading is its *parents*, so capture the
            # trail before this heading joins it.
            blocks.append(
                Block(BlockKind.HEADING, line.strip(), _trail_titles(trail), i)
            )
            while trail and trail[-1][0] >= level:
                trail.pop()
            trail.append((level, heading.group(2).strip()))
            i += 1
            continue

        if _starts_table(lines, i):
            block, i = _consume_table(lines, i, _trail_titles(trail))
            blocks.append(block)
            continue

        kind = BlockKind.LIST if _LIST_ITEM.match(line) else BlockKind.PARAGRAPH
        block, i = _consume_plain(lines, i, kind, _trail_titles(trail))
        blocks.append(block)

    return blocks


def _trail_titles(trail: list[tuple[int, str]]) -> tuple[str, ...]:
    return tuple(title for _, title in trail if title)


def _consume_fence(
    lines: list[str], start: int, fence: re.Match[str], trail: tuple[str, ...]
) -> tuple[Block, int]:
    marker = fence.group(2)
    char = marker[0]
    closing = re.compile(rf"^\s{{0,3}}{re.escape(char)}{{{len(marker)},}}\s*$")

    i = start + 1
    while i < len(lines) and not closing.match(lines[i]):
        i += 1

    if i >= len(lines):
        log.warning("Unterminated code fence opened at line %d", start + 1)
        end = len(lines)
    else:
        end = i + 1

    text = "\n".join(lines[start:end]).rstrip()
    return Block(BlockKind.CODE, text, trail, start), end


def _starts_table(lines: list[str], i: int) -> bool:
    if "|" not in lines[i]:
        return False
    if i + 1 >= len(lines):
        return False
    nxt = lines[i + 1]
    return "|" in nxt and bool(_TABLE_DIVIDER.match(nxt))


def _consume_table(
    lines: list[str], start: int, trail: tuple[str, ...]
) -> tuple[Block, int]:
    i = start
    while i < len(lines) and lines[i].strip() and "|" in lines[i]:
        i += 1
    text = "\n".join(lines[start:i]).rstrip()
    return Block(BlockKind.TABLE, text, trail, start), i


def _consume_plain(
    lines: list[str], start: int, kind: BlockKind, trail: tuple[str, ...]
) -> tuple[Block, int]:
    i = start
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            break
        if i > start and (_FENCE_OPEN.match(line) or _HEADING.match(line)):
            break
        if i > start and _starts_table(lines, i):
            break
        i += 1
    text = "\n".join(lines[start:i]).rstrip()
    return Block(kind, text, trail, start), i
