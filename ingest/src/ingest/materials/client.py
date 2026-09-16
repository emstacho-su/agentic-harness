"""Read-only PostgREST client for the bb2dash file corpus.

bb2dash's ``public`` schema *is* exposed on its REST surface (unlike the
harness ``rag`` schema), and the service role is required because the corpus
tables carry RLS with insert-only anon policies. The key is sent in headers and
never appears in an error message or a log line.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from ..errors import ConfigError, SourceError

log = logging.getLogger(__name__)

# The one project this exporter may read. The harness-memory project has the
# same 384-dim shape, so a wrong URL would not error — it would export nothing
# or the wrong thing. Pin it.
BB2DASH_PROJECT_REF = "goultdzqcavefcgnifdy"
SUPABASE_HOST_SUFFIX = ".supabase.co"
REQUIRED_SCHEME = "https"

# The only root this exporter ever requests. Built from the constants above, so
# whatever shape SUPABASE_URL has, nothing from it is interpolated into the URL.
BB2DASH_ROOT = f"{REQUIRED_SCHEME}://{BB2DASH_PROJECT_REF}{SUPABASE_HOST_SUFFIX}"

# One request shape: files with their text units embedded via the FK.
FILE_COLUMNS = (
    "id,file_name,course_id,bucket,week_no,path,sha256,captured_at,"
    "text_status,superseded_by"
)
TEXT_COLUMNS = "unit_no,unit_kind,text"
SELECT = f"{FILE_COLUMNS},bb_file_text({TEXT_COLUMNS})"

DEFAULT_PAGE_SIZE = 100
DEFAULT_TIMEOUT_SECONDS = 60

REQUIRED_FILE_FIELDS = ("id", "file_name", "course_id", "bb_file_text")
REQUIRED_UNIT_FIELDS = ("unit_no", "unit_kind", "text")

Opener = Callable[..., Any]


def assert_bb2dash_url(base_url: str | None) -> str:
    """Check ``SUPABASE_URL`` names the bb2dash project, and return the pinned root.

    Only the *scheme* and the *hostname* of the supplied URL are compared. What
    comes back is :data:`BB2DASH_ROOT`, assembled from the constants above — the
    caller's string is never returned. Returning it meant a path suffix
    (``.../rest/v1``) or a non-default port survived the check and was then
    interpolated into every request URL, because the host matched and nothing
    looked at the rest.
    """
    if not base_url or not base_url.strip():
        raise ConfigError("SUPABASE_URL is missing; pass the bb2dash .env with --env-file")
    parts = urllib.parse.urlsplit(base_url.strip())
    if parts.scheme != REQUIRED_SCHEME:
        # The service-role key travels in a header; anything but TLS would send
        # it in cleartext, and a missing scheme parses the host as a path.
        raise ConfigError(
            f"SUPABASE_URL must start with {REQUIRED_SCHEME}://, got "
            f"{parts.scheme or 'no scheme'}. The bb2dash key is only ever sent over TLS."
        )
    # urlsplit already lowercases nothing but the scheme; hostname is lowercased
    # by urllib, and a trailing-dot FQDN is kept, so it fails the comparison.
    host = parts.hostname or ""
    expected = f"{BB2DASH_PROJECT_REF}{SUPABASE_HOST_SUFFIX}"
    if host != expected:
        raise ConfigError(
            f"SUPABASE_URL host is '{host}', not the bb2dash project ({expected}). "
            "This exporter reads class materials from bb2dash only."
        )
    if _has_extras(parts):
        # Not fatal — the host is right — but say so rather than dropping it
        # silently, because the operator wrote it for a reason. The URL is not
        # echoed: it may carry a query string, and this exporter never logs one.
        log.warning(
            "SUPABASE_URL carries a port, path or query; requests use %s only.",
            BB2DASH_ROOT,
        )
    return BB2DASH_ROOT


def _has_extras(parts: urllib.parse.SplitResult) -> bool:
    """Does the URL carry anything beyond scheme and host?

    ``SplitResult.port`` parses lazily and raises ``ValueError`` on a port that
    is not a number or is out of range — an untyped traceback out of a function
    whose whole contract is to raise :class:`ConfigError`. A port that cannot be
    parsed is certainly an extra, so it answers the question either way.
    """
    try:
        has_port = parts.port is not None
    except ValueError:
        has_port = True
    return has_port or bool(parts.path.strip("/")) or bool(parts.query) or bool(parts.fragment)


def fetch_materials(
    base_url: str,
    service_role: str,
    *,
    course: str | None = None,
    opener: Opener | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    """Every ``bb_files`` row with its text units, ordered by id.

    Pages with the ``Range`` header so a growing corpus never needs a bigger
    single response. ``opener`` is injectable for tests; the default is
    ``urllib.request.urlopen``.
    """
    root = assert_bb2dash_url(base_url)
    if not service_role or not service_role.strip():
        raise ConfigError("SUPABASE_SERVICE_ROLE is missing from the bb2dash .env")
    if page_size < 1:
        raise ConfigError("page_size must be >= 1")

    open_url = opener or urllib.request.urlopen
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = _fetch_page(open_url, root, service_role.strip(), course, offset, page_size, timeout)
        rows.extend(validate_row(row) for row in page)
        if len(page) < page_size:
            break
        offset += page_size

    log.info("fetched %d file(s) from bb2dash%s", len(rows), f" ({course})" if course else "")
    return rows


def _fetch_page(
    open_url: Opener,
    root: str,
    service_role: str,
    course: str | None,
    offset: int,
    page_size: int,
    timeout: float,
) -> list[dict[str, Any]]:
    query = {"select": SELECT, "order": "id.asc"}
    if course:
        query["course_id"] = f"eq.{course}"
    url = f"{root}/rest/v1/bb_files?" + urllib.parse.urlencode(query, safe=",().")

    request = urllib.request.Request(url, method="GET")
    request.add_header("apikey", service_role)
    request.add_header("Authorization", f"Bearer {service_role}")
    request.add_header("Accept", "application/json")
    request.add_header("Range-Unit", "items")
    request.add_header("Range", f"{offset}-{offset + page_size - 1}")

    path = urllib.parse.urlsplit(url).path
    try:
        with open_url(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Never include the request object or headers: they carry the key.
        raise SourceError(f"bb2dash REST returned HTTP {exc.code} for {path}") from None
    except urllib.error.URLError as exc:
        raise SourceError(f"bb2dash REST unreachable: {exc.reason}") from None
    except (OSError, ValueError) as exc:
        raise SourceError(f"bb2dash REST response unreadable: {exc}") from None

    if not isinstance(payload, list):
        raise SourceError(f"bb2dash REST returned {type(payload).__name__}, expected a list")
    return payload


def validate_row(row: Any) -> dict[str, Any]:
    """Fail fast on a row that does not look like ``bb_files`` + text units."""
    if not isinstance(row, dict):
        raise SourceError(f"file row is {type(row).__name__}, expected an object")
    missing = [name for name in REQUIRED_FILE_FIELDS if name not in row]
    if missing:
        raise SourceError(f"file row missing {missing}")
    if not isinstance(row["id"], int) or isinstance(row["id"], bool):
        raise SourceError(f"file id must be an int, got {row['id']!r}")
    if not isinstance(row["file_name"], str) or not row["file_name"].strip():
        raise SourceError(f"file {row['id']}: file_name must be a non-empty string")
    # course_id is nullable in bb_files: the classifier fills it in after capture.
    # A null here is a planning decision (skip), not a malformed row.
    if row["course_id"] is not None and not isinstance(row["course_id"], str):
        raise SourceError(f"file {row['id']}: course_id must be a string or null")
    units = row["bb_file_text"]
    if not isinstance(units, list):
        raise SourceError(f"file {row['id']}: bb_file_text must be a list")
    for unit in units:
        _validate_unit(row["id"], unit)
    return row


def _validate_unit(file_id: int, unit: Any) -> None:
    if not isinstance(unit, dict):
        raise SourceError(f"file {file_id}: text unit is {type(unit).__name__}")
    missing = [name for name in REQUIRED_UNIT_FIELDS if name not in unit]
    if missing:
        raise SourceError(f"file {file_id}: text unit missing {missing}")
    if not isinstance(unit["unit_no"], int):
        raise SourceError(f"file {file_id}: unit_no must be an int")
    if not isinstance(unit["unit_kind"], str) or not isinstance(unit["text"], str):
        raise SourceError(f"file {file_id}: unit_kind and text must be strings")
