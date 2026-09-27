"""``ingest verify`` on the command line: exit codes, the report, --json, --seed."""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from ingest import envfile, verify_cli
from ingest.cli import SUBCOMMANDS, main
from ingest.errors import EmbeddingError, StoreError
from ingest.loaders import load_vault
from ingest.verify import CHECK_ORDER
from ingest.verify_cli import EXIT_CLEAN, EXIT_FINDINGS, EXIT_UNAVAILABLE, run_verify, untruncated
from test_verify import FIXTURE_VAULT, FakeReader, HashEmbedder, word_count

# A value from an env file that must never reach any output.
SECRET = "s3cret-value-never-printed"


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """No repo .env, no real machine file; whatever a run loads is undone after it."""
    saved = dict(os.environ)
    monkeypatch.setattr(envfile, "find_env_file", lambda start=None: None)
    monkeypatch.setenv("HARNESS_MACHINE_ENV", str(tmp_path / "no-machine.env"))
    monkeypatch.delenv("HARNESS_REALMS", raising=False)
    yield
    for key in set(os.environ) - set(saved):
        del os.environ[key]
    os.environ.update(saved)


@pytest.fixture
def clean_vault(tmp_path: Path) -> Path:
    """The fixture vault without its planted duplicate, so a matching store is clean."""
    vault = tmp_path / "vault"
    shutil.copytree(FIXTURE_VAULT, vault)
    (vault / "projects" / "alpha" / "notes" / "shared-b.md").unlink()
    return vault


def reader_for(vault: Path) -> FakeReader:
    return FakeReader.from_loaded(load_vault(vault))


def run(vault: Path, reader: FakeReader, *extra: str, embedder=None) -> int:
    return run_verify(
        ["--path", vault.as_posix(), *extra],
        reader=reader, embedder=embedder or HashEmbedder(), count_tokens=word_count,
    )


# -- exit codes ------------------------------------------------------------------------


def test_a_clean_store_exits_zero_and_says_so(clean_vault: Path, capsys) -> None:
    reader = reader_for(clean_vault)

    assert run(clean_vault, reader) == EXIT_CLEAN
    out = capsys.readouterr().out
    assert out.rstrip().splitlines()[-1] == "verify: clean"
    for name in CHECK_ORDER:
        assert name in out
    assert reader.closed is False  # an injected reader belongs to the caller


def test_findings_exit_one_and_the_last_line_counts_them(clean_vault: Path, capsys) -> None:
    reader = reader_for(clean_vault)
    reader.stale_hash("alpha-index-0001")
    reader.null_embedding(1)

    assert run(clean_vault, reader) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert out.rstrip().splitlines()[-1] == "verify: 2 finding(s) in 2 check(s)"
    assert "alpha-index-0001" in out


def test_the_planted_duplicate_in_the_fixture_is_a_finding(capsys) -> None:
    reader = reader_for(FIXTURE_VAULT)

    assert run(FIXTURE_VAULT, reader) == EXIT_FINDINGS
    assert "shared-b.md" in capsys.readouterr().out


def test_a_missing_vault_exits_two_with_one_error_line(tmp_path: Path, capsys) -> None:
    code = run(tmp_path / "nowhere", FakeReader())

    assert code == EXIT_UNAVAILABLE
    err = capsys.readouterr().err.strip().splitlines()
    assert err[-1].startswith("error: ")
    assert "does not exist" in err[-1]


class BrokenReader(FakeReader):
    def documents(self):
        raise StoreError("the connection is closed")


def test_a_store_failure_exits_two(clean_vault: Path, capsys) -> None:
    assert run(clean_vault, BrokenReader()) == EXIT_UNAVAILABLE
    assert "error: the connection is closed" in capsys.readouterr().err


class NoModelEmbedder(HashEmbedder):
    def embed(self, texts):
        raise EmbeddingError("Could not load embedding model")


def test_a_missing_model_exits_two(clean_vault: Path, capsys) -> None:
    assert run(clean_vault, reader_for(clean_vault), embedder=NoModelEmbedder()) == EXIT_UNAVAILABLE
    assert "error: Could not load embedding model" in capsys.readouterr().err


class CrashingEmbedder(HashEmbedder):
    def embed(self, texts):
        raise RuntimeError("tokenizer blew up")


class UnreadableReader(FakeReader):
    def chunk_texts(self):
        raise OSError("permission denied reading a note")


@pytest.mark.parametrize(
    ("reader_of", "embedder", "expected"),
    [
        (reader_for, CrashingEmbedder(), "error: RuntimeError: tokenizer blew up"),
        (lambda vault: UnreadableReader(), HashEmbedder(), "error: OSError: permission denied reading a note"),
    ],
    ids=["embedder", "reader"],
)
def test_an_unexpected_failure_exits_two_not_one(clean_vault: Path, capsys, reader_of, embedder, expected) -> None:
    # Exit 1 means "findings"; a crash must never be logged by the nightly job as one.
    assert run(clean_vault, reader_of(clean_vault), embedder=embedder) == EXIT_UNAVAILABLE
    err = capsys.readouterr().err.strip().splitlines()
    assert err[-1] == expected


def test_an_unexpected_failure_never_prints_the_database_url(clean_vault: Path, monkeypatch, capsys) -> None:
    url = f"postgresql://u:{SECRET}@h/db"
    monkeypatch.setenv("DATABASE_URL", url)

    class LeakyReader(FakeReader):
        def documents(self):
            raise RuntimeError(f"bad conninfo {url}")

    assert run(clean_vault, LeakyReader()) == EXIT_UNAVAILABLE
    captured = capsys.readouterr()
    assert SECRET not in captured.err
    assert SECRET not in captured.out
    assert "RuntimeError" in captured.err


def test_a_realm_this_machine_does_not_list_exits_two(clean_vault: Path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("HARNESS_REALMS", "projects:push")

    assert run(clean_vault, reader_for(clean_vault)) == EXIT_UNAVAILABLE
    assert "classes" in capsys.readouterr().err


def test_a_database_that_is_not_configured_exits_two(clean_vault: Path, monkeypatch, capsys) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)

    code = run_verify(["--path", clean_vault.as_posix()], embedder=HashEmbedder(), count_tokens=word_count)

    assert code == EXIT_UNAVAILABLE
    assert "DATABASE_URL" in capsys.readouterr().err


# -- usage ----------------------------------------------------------------------------


def test_path_is_required() -> None:
    with pytest.raises(SystemExit) as caught:
        run_verify([], reader=FakeReader(), embedder=HashEmbedder(), count_tokens=word_count)
    assert caught.value.code == 2


@pytest.mark.parametrize("value", ["0", "-3"])
def test_a_sample_below_one_is_refused(clean_vault: Path, value: str, capsys) -> None:
    assert run(clean_vault, reader_for(clean_vault), "--sample", value) == EXIT_UNAVAILABLE
    assert "--sample" in capsys.readouterr().err


def test_the_subcommand_is_dispatched_from_the_main_entry_point(tmp_path: Path, capsys) -> None:
    assert SUBCOMMANDS["verify"] is run_verify
    # No reader injected: the vault is walked first, so a missing one fails before any connection.
    assert main(["verify", "--path", (tmp_path / "missing").as_posix()]) == EXIT_UNAVAILABLE
    assert "error:" in capsys.readouterr().err


# -- output ----------------------------------------------------------------------------


def test_json_lists_every_check_and_every_finding(clean_vault: Path, capsys) -> None:
    reader = reader_for(clean_vault)
    for chunk in reader.chunks[:3]:
        reader.null_embedding(chunk.chunk_id)

    assert run(clean_vault, reader, "--json") == EXIT_FINDINGS
    payload = json.loads(capsys.readouterr().out)

    assert payload["clean"] is False
    assert payload["finding_count"] == 3
    assert [check["name"] for check in payload["checks"]] == list(CHECK_ORDER)
    embeddings = next(c for c in payload["checks"] if c["name"] == "embeddings")
    assert embeddings["count"] == 3
    assert {"subject", "detail", "severity"} <= set(embeddings["findings"][0])


def test_the_text_report_shows_at_most_twenty_findings_per_check(tmp_path: Path, capsys) -> None:
    vault = tmp_path / "vault"
    (vault / "notes").mkdir(parents=True)
    for index in range(25):
        (vault / "notes" / f"n{index:02}.md").write_text(f"# Note {index}\n\nBody {index}.\n", encoding="utf-8")

    assert run(vault, FakeReader()) == EXIT_FINDINGS
    out = capsys.readouterr().out
    assert out.count("no row") == 20
    assert "... and 5 more" in out
    assert out.rstrip().splitlines()[-1] == "verify: 25 finding(s) in 1 check(s)"


def test_seed_makes_the_sample_reproducible(tmp_path: Path, capsys) -> None:
    vault = tmp_path / "vault"
    (vault / "notes").mkdir(parents=True)
    for index in range(40):
        (vault / "notes" / f"n{index:02}.md").write_text(f"# Note {index}\n\nBody {index}.\n", encoding="utf-8")
    reader = reader_for(vault)

    for seed in ("7", "7", "8"):
        run(vault, reader, "--sample", "5", "--seed", seed)
    capsys.readouterr()

    first, again, other = reader.requested_samples
    assert first == again
    assert first != other
    assert len(first) == 5


def test_nothing_from_an_env_file_is_printed(clean_vault: Path, tmp_path: Path, capsys) -> None:
    env_file = tmp_path / "test.env"
    env_file.write_text(f"DATABASE_URL=postgresql://u:{SECRET}@h/db\nSOME_TOKEN={SECRET}\n", encoding="utf-8")

    run(clean_vault, reader_for(clean_vault), "--env-file", env_file.as_posix(), "-v")
    captured = capsys.readouterr()

    assert SECRET not in captured.out
    assert SECRET not in captured.err


# -- the real tokenizer, without the model ----------------------------------------------


def test_untruncated_counts_past_the_limit_the_model_tokenizer_truncates_at() -> None:
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel
    from tokenizers.pre_tokenizers import Whitespace

    vocabulary = {"[UNK]": 0, "word": 1}
    tokenizer = Tokenizer(WordLevel(vocabulary, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = Whitespace()
    tokenizer.enable_truncation(max_length=4)
    text = " ".join(["word"] * 10)

    assert len(tokenizer.encode(text).ids) == 4
    assert len(untruncated(tokenizer).encode(text).ids) == 10
    # The original is left as it was: the embedder still needs its truncation.
    assert len(tokenizer.encode(text).ids) == 4


def test_untruncated_refuses_a_tokenizer_it_cannot_copy() -> None:
    class Opaque:
        def encode(self, text):  # pragma: no cover - never reached
            raise AssertionError

    with pytest.raises(EmbeddingError):
        untruncated(Opaque())


def test_the_module_exports_its_exit_codes() -> None:
    assert (verify_cli.EXIT_CLEAN, verify_cli.EXIT_FINDINGS, verify_cli.EXIT_UNAVAILABLE) == (0, 1, 2)


def test_the_audit_cutoff_is_the_database_clock_read_before_the_walk(monkeypatch, clean_vault: Path, capsys) -> None:
    # Rows the nightly ingest wrote minutes earlier predate this cutoff, so they are compared.
    from datetime import datetime, timezone

    db_now = datetime(2026, 9, 28, 3, 6, tzinfo=timezone.utc)
    events: list[str] = []
    reader = FakeReader.from_loaded(load_vault(clean_vault))
    real_load = verify_cli.load_vault
    walked = []

    def clock():
        events.append("clock")
        return db_now

    def load(*args, **kwargs):
        events.append("walk")
        return real_load(*args, **kwargs)

    real_walk = verify_cli._walk

    def walk(path, walked_at):
        walked.append(walked_at)
        return real_walk(path, walked_at)

    reader.database_now = clock
    monkeypatch.setattr(verify_cli, "load_vault", load)
    monkeypatch.setattr(verify_cli, "_walk", walk)

    run_verify(["--path", str(clean_vault)], reader=reader, embedder=HashEmbedder(), count_tokens=word_count)

    assert events[:2] == ["clock", "walk"]
    assert walked == [db_now]
