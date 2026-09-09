"""Content hashing for change detection.

``rag.documents.content_hash`` is the sha256 of the *normalised* body. The
normalisation exists so that cosmetic churn — a CRLF checkout on Windows, a
trailing newline added by an editor, trailing spaces stripped by a formatter —
does not trigger a needless re-embed of the whole document.
"""

from __future__ import annotations

import hashlib
import unicodedata


def normalise_body(body: str) -> str:
    """Canonical form of a document body, used only for hashing.

    Steps, in order:
      1. Unicode NFC — so a composed and a decomposed "é" hash the same.
      2. CRLF/CR -> LF — Windows checkouts and OneDrive round-trips flip these.
      3. Strip trailing whitespace on every line.
      4. Collapse any run of blank lines to one, and strip leading/trailing
         blank lines. Two blank lines and five blank lines mean the same thing
         in markdown, so the difference is churn, not content.

    The stored body is the original text; only the hash input is normalised.
    """
    if not isinstance(body, str):
        raise TypeError(f"body must be str, got {type(body).__name__}")

    text = unicodedata.normalize("NFC", body)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]

    collapsed: list[str] = []
    blank_run = 0
    for line in lines:
        if line:
            blank_run = 0
            collapsed.append(line)
            continue
        blank_run += 1
        if blank_run == 1:
            collapsed.append(line)

    while collapsed and not collapsed[0]:
        collapsed.pop(0)
    while collapsed and not collapsed[-1]:
        collapsed.pop()

    return "\n".join(collapsed)


def content_hash(body: str) -> str:
    """sha256 hex digest of the normalised body."""
    return hashlib.sha256(normalise_body(body).encode("utf-8")).hexdigest()
