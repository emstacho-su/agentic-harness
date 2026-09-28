"""``uv run ingest curate <stage>`` — the read-only curator (Phase C of
docs/memory-sprint-requirements.md).

Python does every read and write; the LLM is a pure function behind the ``Judge``
protocol (text and a JSON schema in, JSON out, no tools). Stages: ``inventory``
(R-C1), ``extract`` (R-C2), ``ledger`` (R-C3).
"""
