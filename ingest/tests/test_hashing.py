"""Change detection depends entirely on these being right."""

from __future__ import annotations

import pytest

from ingest.hashing import content_hash, normalise_body


def test_identical_bodies_hash_identically():
    assert content_hash("hello world") == content_hash("hello world")


def test_different_bodies_hash_differently():
    assert content_hash("hello world") != content_hash("hello worlds")


@pytest.mark.parametrize(
    "a, b",
    [
        ("line one\nline two", "line one\r\nline two"),  # CRLF checkout
        ("line one\nline two", "line one\rline two"),  # old-Mac CR
        ("text", "text   "),  # trailing spaces
        ("text\n", "text\n\n\n"),  # trailing blank lines
        ("a\n\n\n\n\nb", "a\n\nb"),  # collapsed blank runs
        ("\n\ntext", "text"),  # leading blank lines
    ],
)
def test_cosmetic_differences_do_not_change_the_hash(a, b):
    assert content_hash(a) == content_hash(b)


def test_unicode_normalisation():
    composed = "café"
    decomposed = "café"
    assert composed != decomposed
    assert content_hash(composed) == content_hash(decomposed)


def test_real_content_change_does_change_the_hash():
    before = "# Title\n\nSome body text.\n"
    after = "# Title\n\nSome body text, edited.\n"
    assert content_hash(before) != content_hash(after)


def test_normalise_keeps_meaningful_blank_line():
    assert normalise_body("a\n\nb") == "a\n\nb"


def test_hash_is_sha256_hex():
    digest = content_hash("anything")
    assert len(digest) == 64
    assert all(c in "0123456789abcdef" for c in digest)


def test_non_string_body_rejected():
    with pytest.raises(TypeError):
        normalise_body(None)  # type: ignore[arg-type]
