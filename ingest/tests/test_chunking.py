"""Chunker boundaries: code fences, tables, oversized paragraphs, overlap."""

from __future__ import annotations

import pytest

from ingest.chunking import MarkdownChunker
from ingest.config import ChunkConfig
from ingest.markdown_blocks import BlockKind, parse_blocks
from ingest.tokenizer import HeuristicTokenCounter


def word_count(text: str) -> int:
    """Predictable counter so budgets in these tests are exact."""
    return len(text.split())


SMALL = ChunkConfig(
    target_tokens=60, overlap_tokens=12, min_tokens=8, hard_max_tokens=90
)


@pytest.fixture
def chunker() -> MarkdownChunker:
    return MarkdownChunker(count_tokens=word_count, config=SMALL)


def fence_count(text: str) -> int:
    return sum(1 for line in text.split("\n") if line.strip().startswith("```"))


# --------------------------------------------------------------------------
# basics
# --------------------------------------------------------------------------


def test_empty_body_produces_no_chunks(chunker):
    assert chunker.chunk("") == []
    assert chunker.chunk("   \n\n  ") == []


def test_short_document_is_one_chunk(chunker):
    chunks = chunker.chunk("# Title\n\nA short paragraph of prose.")
    assert len(chunks) == 1
    assert "A short paragraph" in chunks[0].content


def test_chunk_indexes_are_sequential(chunker):
    body = "\n\n".join(f"Paragraph {i} " + "word " * 25 for i in range(8))
    chunks = chunker.chunk(body)
    assert len(chunks) > 1
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_token_count_matches_the_counter(chunker):
    chunks = chunker.chunk("Some prose with a handful of words in it.")
    assert chunks[0].token_count == word_count(chunks[0].content)
    assert chunks[0].token_count > 0


def test_non_string_body_rejected(chunker):
    with pytest.raises(TypeError):
        chunker.chunk(None)  # type: ignore[arg-type]


# --------------------------------------------------------------------------
# code fences
# --------------------------------------------------------------------------


def test_small_code_fence_is_never_split(chunker):
    body = "Intro paragraph.\n\n```python\nx = 1\ny = 2\n```\n\nOutro paragraph."
    chunks = chunker.chunk(body)
    joined = "\n".join(c.content for c in chunks)
    assert "```python\nx = 1\ny = 2\n```" in joined


def test_oversized_code_fence_splits_on_line_boundaries_with_balanced_fences(chunker):
    lines = "\n".join(f"call_function_number_{i}(argument_{i}, other_{i})" for i in range(60))
    body = f"Intro.\n\n```python\n{lines}\n```\n"
    chunks = chunker.chunk(body)

    assert len(chunks) > 1
    for chunk in chunks:
        assert fence_count(chunk.content) % 2 == 0, "unbalanced fence in a chunk"

    joined = "\n".join(c.content for c in chunks)
    for i in range(60):
        assert f"call_function_number_{i}(" in joined, f"line {i} was lost"


def test_code_lines_are_never_cut_mid_line(chunker):
    lines = "\n".join(f"const value_{i} = compute(alpha_{i}, beta_{i});" for i in range(50))
    body = f"```js\n{lines}\n```"
    chunks = chunker.chunk(body)
    for chunk in chunks:
        for line in chunk.content.split("\n"):
            stripped = line.strip()
            if stripped.startswith("const value_"):
                assert stripped.endswith(");"), f"line cut mid-statement: {stripped!r}"


def test_tilde_fence_is_recognised():
    blocks = parse_blocks("~~~\nraw text\n~~~\n")
    assert [b.kind for b in blocks] == [BlockKind.CODE]


def test_unterminated_fence_keeps_its_content(chunker):
    body = "```python\nx = 1\ny = 2\n"
    chunks = chunker.chunk(body)
    joined = "\n".join(c.content for c in chunks)
    assert "x = 1" in joined and "y = 2" in joined


# --------------------------------------------------------------------------
# tables
# --------------------------------------------------------------------------


def test_small_table_stays_intact(chunker):
    body = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"
    chunks = chunker.chunk(body)
    assert len(chunks) == 1
    assert "| 1 | 2 |" in chunks[0].content
    assert "| 3 | 4 |" in chunks[0].content


def test_oversized_table_repeats_its_header_on_every_part(chunker):
    rows = "\n".join(f"| row_{i} | value_{i} | note_{i} | extra_{i} |" for i in range(60))
    body = f"| name | value | note | extra |\n| --- | --- | --- | --- |\n{rows}"
    chunks = chunker.chunk(body)

    assert len(chunks) > 1
    for chunk in chunks:
        assert "| name | value | note | extra |" in chunk.content
        assert "| --- | --- | --- | --- |" in chunk.content

    joined = "\n".join(c.content for c in chunks)
    for i in range(60):
        assert f"| row_{i} |" in joined, f"table row {i} was lost"


def test_table_rows_are_never_cut_mid_row(chunker):
    rows = "\n".join(f"| row_{i} | value_{i} | note_{i} | extra_{i} |" for i in range(60))
    body = f"| name | value | note | extra |\n| --- | --- | --- | --- |\n{rows}"
    for chunk in chunker.chunk(body):
        for line in chunk.content.split("\n"):
            if line.strip().startswith("| row_"):
                assert line.strip().endswith("|")


# --------------------------------------------------------------------------
# oversized prose + overlap
# --------------------------------------------------------------------------


def test_oversized_paragraph_splits_and_loses_nothing(chunker):
    sentences = " ".join(
        f"Sentence number {i} explains a distinct idea about ingestion." for i in range(40)
    )
    chunks = chunker.chunk(sentences)
    assert len(chunks) > 1
    joined = " ".join(c.content for c in chunks)
    for i in range(40):
        assert f"Sentence number {i} " in joined


def test_no_chunk_exceeds_the_hard_maximum(chunker):
    sentences = " ".join(
        f"Sentence number {i} explains a distinct idea about ingestion." for i in range(120)
    )
    for chunk in chunker.chunk(sentences):
        assert chunk.token_count <= SMALL.hard_max_tokens


def test_consecutive_prose_chunks_overlap(chunker):
    body = "\n\n".join(
        f"Paragraph {i} describes something specific and reasonably wordy." for i in range(30)
    )
    chunks = chunker.chunk(body)
    assert len(chunks) > 1
    overlaps = 0
    for previous, following in zip(chunks, chunks[1:]):
        tail = set(previous.content.split()[-25:])
        if tail & set(following.content.split()[:25]):
            overlaps += 1
    assert overlaps >= 1, "no overlap carried between any pair of chunks"


def test_code_is_not_duplicated_into_the_next_chunk(chunker):
    filler = "\n\n".join(f"Prose paragraph {i} with several words." for i in range(12))
    body = f"```python\nunique_marker_token = 1\n```\n\n{filler}"
    chunks = chunker.chunk(body)
    hits = sum(c.content.count("unique_marker_token") for c in chunks)
    assert hits == 1


def test_a_single_enormous_word_is_still_bounded(chunker):
    body = "x" * 5000
    chunks = chunker.chunk(body)
    assert len(chunks) >= 1
    assert "".join(c.content.replace("\n", "") for c in chunks).count("x") >= 5000


# --------------------------------------------------------------------------
# token-dense content: the word- and character-level fallbacks
# --------------------------------------------------------------------------


@pytest.fixture
def char_chunker() -> MarkdownChunker:
    """Counts characters, so a single long word really does bust the budget."""
    return MarkdownChunker(count_tokens=len, config=SMALL)


def test_long_wordy_paragraph_falls_back_to_word_splitting(char_chunker):
    body = " ".join(f"word{i}" for i in range(200))
    chunks = char_chunker.chunk(body)
    assert len(chunks) > 1
    joined = " ".join(c.content for c in chunks)
    for i in range(200):
        assert f"word{i}" in joined
    for chunk in chunks:
        assert chunk.token_count <= SMALL.hard_max_tokens


def test_a_single_unbreakable_blob_is_hard_cut_but_not_lost(char_chunker):
    blob = "Q" * 4000
    chunks = char_chunker.chunk(blob)
    assert len(chunks) > 1
    assert "".join(c.content.replace("\n", "").replace(" ", "") for c in chunks).count(
        "Q"
    ) >= 4000
    for chunk in chunks:
        assert chunk.token_count <= SMALL.hard_max_tokens


def test_a_single_enormous_code_line_is_split_without_losing_bytes(char_chunker):
    body = "```js\n" + "z" * 3000 + "\n```"
    chunks = char_chunker.chunk(body)
    assert len(chunks) > 1
    assert sum(c.content.count("z") for c in chunks) >= 3000


def test_runt_trailing_chunk_is_folded_into_its_predecessor(chunker):
    body = "\n\n".join(f"Paragraph {i} with about eight words in it here." for i in range(9))
    body += "\n\nend."
    chunks = chunker.chunk(body)
    assert all(
        c.token_count >= SMALL.min_tokens or len(chunks) == 1 for c in chunks[:-1]
    )
    assert chunks[-1].content.rstrip().endswith("end.")


# --------------------------------------------------------------------------
# breadcrumbs
# --------------------------------------------------------------------------


def test_breadcrumb_carries_heading_context(chunker):
    body = (
        "# Guide\n\nIntro paragraph here.\n\n"
        "## Setup\n\n" + "\n\n".join(f"Setup step {i} explained." for i in range(20))
    )
    chunks = chunker.chunk(body, title="Handbook")
    later = chunks[-1].content
    assert later.startswith("Handbook")
    assert "Guide" in later.split("\n")[0]


def test_breadcrumb_can_be_disabled():
    config = ChunkConfig(
        target_tokens=60,
        overlap_tokens=12,
        min_tokens=8,
        hard_max_tokens=90,
        include_heading_breadcrumb=False,
    )
    chunker = MarkdownChunker(count_tokens=word_count, config=config)
    chunks = chunker.chunk("# Guide\n\nBody text.", title="Handbook")
    assert not chunks[0].content.startswith("Handbook")


# --------------------------------------------------------------------------
# config guards + default profile
# --------------------------------------------------------------------------


def test_overlap_must_be_smaller_than_target():
    with pytest.raises(ValueError):
        MarkdownChunker(config=ChunkConfig(target_tokens=64, overlap_tokens=64))


def test_default_config_respects_the_model_window():
    from ingest.config import CHUNKING, EMBEDDING

    assert CHUNKING.hard_max_tokens < EMBEDDING.max_input_tokens
    assert CHUNKING.target_tokens < CHUNKING.hard_max_tokens


def test_default_chunker_stays_inside_the_model_window():
    from ingest.config import CHUNKING, EMBEDDING

    chunker = MarkdownChunker(count_tokens=HeuristicTokenCounter())
    body = "\n\n".join(
        f"Paragraph {i}: " + "a moderately long sentence about retrieval. " * 6
        for i in range(40)
    )
    chunks = chunker.chunk(body, title="Big Note")
    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk.token_count <= EMBEDDING.max_input_tokens
        assert chunk.token_count <= CHUNKING.hard_max_tokens
