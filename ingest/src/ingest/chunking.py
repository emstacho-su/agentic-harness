"""Token-aware markdown chunker.

Packs :mod:`markdown_blocks` blocks into chunks that fit the embedding model's
window, with overlap so a thought split across a boundary stays retrievable from
either side. Code fences and tables are never cut mid-structure: an oversized
fence is split on line boundaries with the fence re-opened on each part, and an
oversized table is split on row boundaries with the header repeated.

See :class:`ingest.config.ChunkConfig` for the token budgets and why.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .config import CHUNKING, ChunkConfig
from .markdown_blocks import Block, BlockKind, parse_blocks
from .models import Chunk
from .tokenizer import HeuristicTokenCounter, TokenCounter

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_FENCE_LINE = re.compile(r"^\s{0,3}(?:`{3,}|~{3,})")

# Blocks we refuse to duplicate into the next chunk's overlap: repeating code or
# a table doubles the most token-expensive content in the vault for little
# retrieval gain, and a half-repeated fence reads as broken markdown.
_NO_OVERLAP_KINDS = (BlockKind.CODE, BlockKind.TABLE)


@dataclass(frozen=True)
class Unit:
    """A block, or a piece of an oversized block, small enough to fit a chunk."""

    kind: BlockKind
    text: str
    tokens: int
    heading_trail: tuple[str, ...]
    # True when this unit continues the block that produced the previous unit,
    # so the two are rejoined with a single newline instead of a blank line.
    continuation: bool = False


class MarkdownChunker:
    """Chunk markdown bodies into embeddable pieces."""

    def __init__(
        self,
        count_tokens: TokenCounter | None = None,
        config: ChunkConfig = CHUNKING,
    ) -> None:
        if config.overlap_tokens >= config.target_tokens:
            raise ValueError("overlap_tokens must be smaller than target_tokens")
        self.count_tokens: TokenCounter = count_tokens or HeuristicTokenCounter()
        self.config = config
        # A unit is capped below the chunk target so that overlap + unit still
        # fits: overlap(<=64) + unit(<=320) == target(384).
        self.max_unit_tokens = max(
            config.min_tokens, config.target_tokens - config.overlap_tokens
        )

    # -- public API --------------------------------------------------------

    def chunk(self, body: str, *, title: str | None = None) -> list[Chunk]:
        if not isinstance(body, str):
            raise TypeError(f"body must be str, got {type(body).__name__}")
        if not body.strip():
            return []

        units = self._to_units(parse_blocks(body))
        if not units:
            return []

        groups = self._pack(units)
        contents = [self._render(group, title) for group in groups]
        contents = self._merge_runt(contents)
        return [
            Chunk(chunk_index=i, content=text, token_count=self.count_tokens(text))
            for i, text in enumerate(contents)
        ]

    # -- unit construction -------------------------------------------------

    def _to_units(self, blocks: list[Block]) -> list[Unit]:
        units: list[Unit] = []
        for block in blocks:
            tokens = self.count_tokens(block.text)
            if tokens <= self.max_unit_tokens:
                units.append(Unit(block.kind, block.text, tokens, block.heading_trail))
                continue
            units.extend(self._split_oversized(block))
        return units

    def _split_oversized(self, block: Block) -> list[Unit]:
        if block.kind is BlockKind.CODE:
            pieces = self._split_code(block.text)
        elif block.kind is BlockKind.TABLE:
            pieces = self._split_table(block.text)
        else:
            pieces = self._split_prose(block.text)

        return [
            Unit(
                kind=block.kind,
                text=piece,
                tokens=self.count_tokens(piece),
                heading_trail=block.heading_trail,
                continuation=index > 0,
            )
            for index, piece in enumerate(pieces)
        ]

    def _split_code(self, text: str) -> list[str]:
        """Split a fence on line boundaries, re-opening the fence on each part."""
        lines = text.split("\n")
        opener = lines[0] if _FENCE_LINE.match(lines[0]) else None
        closer_present = len(lines) > 1 and bool(_FENCE_LINE.match(lines[-1]))
        inner = lines[1:-1] if (opener and closer_present) else lines[1:] if opener else lines
        closer = lines[-1] if closer_present else (opener.strip() if opener else "")

        overhead = self.count_tokens(f"{opener}\n{closer}") if opener else 0
        budget = max(self.config.min_tokens, self.max_unit_tokens - overhead)

        groups = self._group_lines(inner, budget)
        if opener is None:
            return ["\n".join(group) for group in groups]
        return ["\n".join([opener, *group, closer]) for group in groups]

    def _split_table(self, text: str) -> list[str]:
        """Split a table on row boundaries, repeating the header on each part."""
        lines = text.split("\n")
        header = lines[:2]
        rows = lines[2:]
        if not rows:
            return [text]

        overhead = self.count_tokens("\n".join(header))
        budget = max(self.config.min_tokens, self.max_unit_tokens - overhead)
        groups = self._group_lines(rows, budget)
        return ["\n".join([*header, *group]) for group in groups]

    def _split_prose(self, text: str) -> list[str]:
        """Split a paragraph or list on sentence, then line, then word bounds."""
        pieces = _SENTENCE_END.split(text)
        if len(pieces) == 1:
            pieces = text.split("\n")
        out: list[str] = []
        for piece in pieces:
            if self.count_tokens(piece) <= self.max_unit_tokens:
                out.append(piece)
            else:
                out.extend(self._split_words(piece))
        return self._merge_small(out, self.max_unit_tokens)

    def _split_words(self, text: str) -> list[str]:
        """Last resort: never split inside a word unless the word alone is huge."""
        out: list[str] = []
        current: list[str] = []
        current_tokens = 0
        for word in text.split(" "):
            word_tokens = self.count_tokens(word)
            if word_tokens > self.max_unit_tokens:
                if current:
                    out.append(" ".join(current))
                    current, current_tokens = [], 0
                out.extend(self._split_chars(word))
                continue
            if current and current_tokens + word_tokens > self.max_unit_tokens:
                out.append(" ".join(current))
                current, current_tokens = [], 0
            current.append(word)
            current_tokens += word_tokens
        if current:
            out.append(" ".join(current))
        return out

    def _split_chars(self, word: str) -> list[str]:
        """A single token-dense blob (base64, a minified line) gets hard-cut.

        The first guess assumes ~3 characters per token. That holds for prose and
        for base64, but not for every tokenizer, so the guess is verified against
        the real counter and halved until every piece genuinely fits.
        """
        span = max(1, self.max_unit_tokens * 3)
        while span > 1:
            pieces = [word[i : i + span] for i in range(0, len(word), span)]
            if all(self.count_tokens(p) <= self.max_unit_tokens for p in pieces):
                return pieces
            span //= 2
        return list(word)

    def _group_lines(self, lines: list[str], budget: int) -> list[list[str]]:
        groups: list[list[str]] = []
        current: list[str] = []
        current_tokens = 0
        for line in lines:
            line_tokens = self.count_tokens(line)
            if line_tokens > budget:
                if current:
                    groups.append(current)
                    current, current_tokens = [], 0
                groups.extend([piece] for piece in self._split_words(line))
                continue
            if current and current_tokens + line_tokens > budget:
                groups.append(current)
                current, current_tokens = [], 0
            current.append(line)
            current_tokens += line_tokens
        if current:
            groups.append(current)
        return groups or [[]]

    def _merge_small(self, pieces: list[str], budget: int) -> list[str]:
        merged: list[str] = []
        for piece in pieces:
            if not merged:
                merged.append(piece)
                continue
            joined = f"{merged[-1]} {piece}"
            if self.count_tokens(joined) <= budget:
                merged[-1] = joined
            else:
                merged.append(piece)
        return merged

    # -- packing -----------------------------------------------------------

    def _pack(self, units: list[Unit]) -> list[list[Unit]]:
        groups: list[list[Unit]] = []
        current: list[Unit] = []
        current_tokens = 0
        new_content = 0

        for unit in units:
            budget = self._budget_for(current, unit)
            if new_content and current_tokens + unit.tokens > budget:
                groups.append(current)
                current = self._overlap_from(current)
                current_tokens = sum(u.tokens for u in current)
                new_content = 0
            current.append(unit)
            current_tokens += unit.tokens
            new_content += 1

        if new_content:
            groups.append(current)
        return groups

    def _budget_for(self, current: list[Unit], nxt: Unit) -> int:
        """Chunk budget, less the breadcrumb this chunk will carry."""
        if not self.config.include_heading_breadcrumb:
            return self.config.target_tokens
        trail = (current[0] if current else nxt).heading_trail
        reserve = self.count_tokens(_breadcrumb(trail)) if trail else 0
        return max(self.config.min_tokens, self.config.target_tokens - reserve)

    def _overlap_from(self, group: list[Unit]) -> list[Unit]:
        carried: list[Unit] = []
        total = 0
        for unit in reversed(group):
            if unit.kind in _NO_OVERLAP_KINDS:
                break
            if total + unit.tokens > self.config.overlap_tokens:
                break
            carried.append(unit)
            total += unit.tokens
        carried.reverse()
        # Never carry the whole chunk forward — that would not advance.
        if len(carried) >= len(group):
            carried = carried[1:]
        return carried

    # -- rendering ---------------------------------------------------------

    def _render(self, group: list[Unit], title: str | None) -> str:
        parts: list[str] = []
        for index, unit in enumerate(group):
            if index and unit.continuation:
                parts[-1] = f"{parts[-1]}\n{unit.text}"
            else:
                parts.append(unit.text)
        body = "\n\n".join(parts).strip()

        if not self.config.include_heading_breadcrumb:
            return body
        trail = group[0].heading_trail if group else ()
        crumbs = ([title.strip()] if title and title.strip() else []) + list(trail)
        if not crumbs:
            return body
        return f"{_breadcrumb(tuple(crumbs))}\n\n{body}"

    def _merge_runt(self, contents: list[str]) -> list[str]:
        """Fold a too-small trailing chunk back into its predecessor."""
        if len(contents) < 2:
            return contents
        last = contents[-1]
        if self.count_tokens(last) >= self.config.min_tokens:
            return contents
        joined = f"{contents[-2]}\n\n{last}"
        if self.count_tokens(joined) > self.config.hard_max_tokens:
            return contents
        return [*contents[:-2], joined]


def _breadcrumb(trail: tuple[str, ...]) -> str:
    return " > ".join(trail)


def chunk_markdown(
    body: str, *, title: str | None = None, count_tokens: TokenCounter | None = None
) -> list[Chunk]:
    """Convenience wrapper around :class:`MarkdownChunker` with the defaults."""
    return MarkdownChunker(count_tokens=count_tokens).chunk(body, title=title)
