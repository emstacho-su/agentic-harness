"""Persistence for ``rag.documents`` and ``rag.chunks``.

The pipeline talks to the :class:`ChunkStore` protocol, so the tests run against
an in-memory fake and never need a database. :class:`PostgresStore` is the real
implementation and is the only place SQL is written.

Write model: one transaction per document. Upsert on ``(source, external_id)``,
delete that document's chunks, insert the new ones. If anything in that sequence
fails the document keeps its previous chunks — never a half-rewritten document.
"""

from __future__ import annotations

import logging
import os
from typing import Protocol, Sequence

from .config import CHUNKS_TABLE, DOCUMENTS_TABLE, VECTOR_TYPE, DbSettings
from .embedding import vector_literal
from .errors import ConfigError, StoreError
from .jsonutil import dumps
from .models import Chunk, DocumentState, SourceDocument

log = logging.getLogger(__name__)

# TCP keepalives so the OS notices a half-open socket rather than the next query
# discovering it. Embedding runs leave the connection idle for long stretches and
# Supabase's pooler will otherwise reap it silently.
_KEEPALIVE_KWARGS: dict[str, object] = {
    "keepalives": 1,
    "keepalives_idle": 30,
    "keepalives_interval": 10,
    "keepalives_count": 5,
}


def connect_kwargs(settings: DbSettings) -> dict[str, object]:
    """Everything psycopg.connect needs beyond the URL — TLS included.

    libpq's default is ``sslmode=prefer``, which neither verifies the server
    certificate nor refuses a plaintext downgrade. This connection carries the
    service-role credential and every document body, so it is ``verify-full``
    against the pinned Supabase CA, mirroring the MCP server's
    ``rejectUnauthorized: true``. The only way off that is the explicit
    ``DATABASE_SSL=disable`` for a local Postgres; there is no "no-verify".
    """
    kwargs: dict[str, object] = {"autocommit": False, **_KEEPALIVE_KWARGS}
    if settings.ssl_disabled:
        kwargs["sslmode"] = "disable"
        return kwargs
    if not settings.ssl_root_cert:
        raise ConfigError(
            "DATABASE_CA_CERT is not set. TLS is verified (sslmode=verify-full) and "
            "Supabase signs with its own root CA, so the pinned certificate is required: "
            "set DATABASE_CA_CERT (or PGSSLROOTCERT) to certs/prod-ca.crt using an "
            "absolute C:/... path. For a local Postgres only, DATABASE_SSL=disable."
        )
    if not os.path.isfile(settings.ssl_root_cert):
        raise ConfigError(
            f"DATABASE_CA_CERT points at {settings.ssl_root_cert}, which does not exist "
            "or is not a file. Use an absolute C:/... path (not an MSYS /c/... path); "
            "the Supabase CA lives at certs/prod-ca.crt in this repo."
        )
    kwargs["sslmode"] = "verify-full"
    kwargs["sslrootcert"] = settings.ssl_root_cert
    return kwargs

_UPSERT_DOCUMENT = f"""
INSERT INTO {DOCUMENTS_TABLE}
    (source, collection, agent, external_id, title, body, metadata, content_hash)
VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)
ON CONFLICT (source, external_id) DO UPDATE SET
    collection   = EXCLUDED.collection,
    agent        = EXCLUDED.agent,
    title        = EXCLUDED.title,
    body         = EXCLUDED.body,
    metadata     = EXCLUDED.metadata,
    content_hash = EXCLUDED.content_hash
RETURNING id, (xmax = 0) AS inserted
"""

_SELECT_STATE = f"""
SELECT id, content_hash
FROM {DOCUMENTS_TABLE}
WHERE source = %s AND external_id = %s
"""

_DELETE_CHUNKS = f"DELETE FROM {CHUNKS_TABLE} WHERE document_id = %s"

_SELECT_EXTERNAL_IDS = f"SELECT external_id FROM {DOCUMENTS_TABLE} WHERE source = %s"

# rag.chunks cascades from rag.documents, so deleting the parent is enough.
_DELETE_DOCUMENTS = (
    f"DELETE FROM {DOCUMENTS_TABLE} WHERE source = %s AND external_id = ANY(%s)"
)

_INSERT_CHUNK = f"""
INSERT INTO {CHUNKS_TABLE}
    (document_id, chunk_index, content, token_count, embedding)
VALUES (%s, %s, %s, %s, %s::{VECTOR_TYPE})
"""


class ChunkStore(Protocol):
    """What the pipeline needs from a persistence layer."""

    def get_document_state(
        self, source: str, external_id: str
    ) -> DocumentState | None: ...

    def replace_document(
        self,
        document: SourceDocument,
        content_hash: str,
        chunks: Sequence[Chunk],
        embeddings: Sequence[Sequence[float]],
    ) -> tuple[int, bool]: ...

    def list_external_ids(self, source: str) -> set[str]: ...

    def delete_documents(self, source: str, external_ids: Sequence[str]) -> int: ...

    def close(self) -> None: ...


class PostgresStore:
    """psycopg-backed :class:`ChunkStore`.

    Holds one connection for the length of a run. That connection sits idle while
    each document is chunked and embedded locally — seconds at a time, minutes in
    aggregate — and Supabase's Supavisor pooler drops connections that go quiet.
    A dropped connection previously failed every remaining document with
    "the connection is closed", so operations reconnect once and retry.
    """

    def __init__(
        self,
        connection,
        database_url: str | None = None,
        connect_options: dict[str, object] | None = None,
    ) -> None:
        self._conn = connection
        self._database_url = database_url
        # The exact kwargs the first connection used, so a reconnect can never
        # come back with weaker TLS or without keepalives.
        self._connect_options = dict(connect_options or {"autocommit": False})

    # -- connection resilience ---------------------------------------------

    def _reconnect(self) -> bool:
        """Replace a dead connection. Returns False if that is not possible."""
        if not self._database_url:
            return False
        try:
            import psycopg

            try:
                self._conn.close()
            except Exception:  # noqa: BLE001 - already dead; nothing to salvage
                pass
            self._conn = psycopg.connect(self._database_url, **self._connect_options)
            log.warning("Database connection was dropped; reconnected.")
            return True
        except Exception as exc:  # noqa: BLE001
            log.error("Reconnect failed: %s", exc)
            return False

    @staticmethod
    def _is_connection_loss(exc: Exception) -> bool:
        """Distinguish a dead connection from a genuine query error.

        Retrying a constraint violation would just fail again; retrying a dropped
        connection succeeds. Only the latter is worth a second attempt.
        """
        text = str(exc).lower()
        markers = (
            "connection is closed",
            "connection already closed",
            "server closed the connection",
            "connection reset",
            "terminating connection",
            "eof detected",
            "ssl connection has been closed",
            "consuming input failed",
        )
        if any(m in text for m in markers):
            return True
        return type(exc).__name__ in {"OperationalError", "InterfaceError"}

    def _run(self, what: str, operation):
        """Execute ``operation``; on connection loss reconnect once and retry."""
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001
            if not self._is_connection_loss(exc):
                raise
            log.warning("%s hit a dropped connection: %s", what, exc)
            if not self._reconnect():
                raise
            return operation()

    # -- construction ------------------------------------------------------

    @classmethod
    def from_settings(cls, settings: DbSettings) -> "PostgresStore":
        if not settings.can_connect:
            raise ConfigError(
                "DATABASE_URL is not set. Export it (or put it in ingest/.env and "
                "source it) before running a write ingest; use --dry-run to plan "
                "without a database."
            )
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - install-time problem
            raise ConfigError(
                "psycopg is not installed. Run `uv sync` in ingest/."
            ) from exc

        options = connect_kwargs(settings)  # raises ConfigError before any I/O
        try:
            conn = psycopg.connect(settings.database_url, **options)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            raise StoreError(f"Could not connect to the database: {exc}") from exc
        return cls(conn, database_url=settings.database_url, connect_options=options)

    # -- reads -------------------------------------------------------------

    def get_document_state(self, source: str, external_id: str) -> DocumentState | None:
        def _lookup():
            with self._conn.cursor() as cur:
                cur.execute(_SELECT_STATE, (source, external_id))
                found = cur.fetchone()
            self._conn.rollback()  # end the implicit read transaction
            return found

        try:
            row = self._run(f"Lookup of {source}/{external_id}", _lookup)
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Lookup of {source}/{external_id} failed: {exc}") from exc

        if row is None:
            return None
        return DocumentState(document_id=int(row[0]), content_hash=str(row[1]))

    # -- writes ------------------------------------------------------------

    def replace_document(
        self,
        document: SourceDocument,
        content_hash: str,
        chunks: Sequence[Chunk],
        embeddings: Sequence[Sequence[float]],
    ) -> tuple[int, bool]:
        if len(chunks) != len(embeddings):
            raise StoreError(
                f"{document.external_id}: {len(chunks)} chunks but "
                f"{len(embeddings)} embeddings"
            )
        if not chunks:
            raise StoreError(f"{document.external_id}: refusing to write 0 chunks")

        def _write() -> tuple[int, bool]:
            # The whole document — upsert, chunk delete, chunk insert — is one
            # transaction, so a retry after a dropped connection re-runs it
            # cleanly rather than leaving a document with half its chunks.
            with self._conn.cursor() as cur:
                cur.execute(
                    _UPSERT_DOCUMENT,
                    (
                        document.source,
                        document.collection,
                        document.agent,
                        document.external_id,
                        document.title,
                        document.body,
                        dumps(document.metadata),
                        content_hash,
                    ),
                )
                row = cur.fetchone()
                if row is None:
                    raise StoreError(
                        f"{document.external_id}: upsert returned no id"
                    )
                doc_id, was_inserted = int(row[0]), bool(row[1])

                cur.execute(_DELETE_CHUNKS, (doc_id,))
                cur.executemany(
                    _INSERT_CHUNK,
                    [
                        (
                            doc_id,
                            chunk.chunk_index,
                            chunk.content,
                            chunk.token_count,
                            vector_literal(embedding),
                        )
                        for chunk, embedding in zip(chunks, embeddings)
                    ],
                )
            self._conn.commit()
            return doc_id, was_inserted

        try:
            document_id, inserted = self._run(
                f"Write of {document.source}/{document.external_id}", _write
            )
        except StoreError:
            self._safe_rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(
                f"Write of {document.source}/{document.external_id} failed: {exc}"
            ) from exc

        return document_id, inserted

    # -- orphan sweep ------------------------------------------------------

    def list_external_ids(self, source: str) -> set[str]:
        try:
            with self._conn.cursor() as cur:
                cur.execute(_SELECT_EXTERNAL_IDS, (source,))
                rows = cur.fetchall()
            self._conn.rollback()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Listing external ids for {source} failed: {exc}") from exc
        return {str(row[0]) for row in rows}

    def delete_documents(self, source: str, external_ids: Sequence[str]) -> int:
        ids = list(external_ids)
        if not ids:
            return 0
        try:
            with self._conn.cursor() as cur:
                cur.execute(_DELETE_DOCUMENTS, (source, ids))
                deleted = cur.rowcount
            self._conn.commit()
        except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
            self._safe_rollback()
            raise StoreError(f"Deleting orphans from {source} failed: {exc}") from exc
        return int(deleted if deleted is not None and deleted >= 0 else len(ids))

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception as exc:  # noqa: BLE001 - logged, not raised on teardown
            log.warning("Closing the database connection failed: %s", exc)

    def _safe_rollback(self) -> None:
        try:
            self._conn.rollback()
        except Exception as exc:  # noqa: BLE001 - logged; the real error wins
            log.warning("Rollback failed: %s", exc)


class NullStore:
    """Store used by ``--dry-run`` when no database is reachable.

    Reports every document as new and refuses every write, so a dry run can be
    planned with no credentials at all.
    """

    def get_document_state(self, source: str, external_id: str) -> DocumentState | None:
        return None

    def replace_document(self, *args, **kwargs) -> tuple[int, bool]:
        raise StoreError("NullStore cannot write. This is a --dry-run store.")

    def list_external_ids(self, source: str) -> set[str]:
        return set()

    def delete_documents(self, source: str, external_ids) -> int:
        raise StoreError("NullStore cannot delete. This is a --dry-run store.")

    def close(self) -> None:
        return None
