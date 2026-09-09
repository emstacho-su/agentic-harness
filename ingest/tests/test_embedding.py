"""Embedder contract, without downloading a model."""

from __future__ import annotations

import pytest

from ingest.config import EMBEDDING, EmbeddingConfig
from ingest.embedding import FastEmbedEmbedder, vector_literal
from ingest.errors import EmbeddingError
from ingest.tokenizer import HeuristicTokenCounter, model_token_counter, tokenizer_from_embedder


class StubModel:
    def __init__(self, vectors) -> None:
        self.vectors = vectors
        self.batch_sizes: list[int] = []

    def embed(self, texts, batch_size=32):
        self.batch_sizes.append(batch_size)
        return iter(self.vectors)


def embedder_with(vectors, config: EmbeddingConfig = EMBEDDING) -> FastEmbedEmbedder:
    embedder = FastEmbedEmbedder(config=config)
    embedder._model = StubModel(vectors)  # noqa: SLF001 - injecting the backend
    return embedder


# --------------------------------------------------------------------------


def test_config_is_the_single_source_of_model_truth():
    assert EMBEDDING.model_name == "BAAI/bge-small-en-v1.5"
    assert EMBEDDING.dimensions == 384
    assert EMBEDDING.max_input_tokens == 512


def test_embed_returns_plain_float_lists():
    embedder = embedder_with([[0.5] * 384, [0.25] * 384])
    vectors = embedder.embed(["a", "b"])
    assert len(vectors) == 2
    assert all(isinstance(value, float) for value in vectors[0])


def test_empty_input_short_circuits():
    assert embedder_with([]).embed([]) == []


def test_blank_text_is_rejected_before_the_model_runs():
    with pytest.raises(EmbeddingError):
        embedder_with([]).embed(["fine", "   "])


def test_wrong_dimension_is_caught_with_a_message_about_the_column():
    embedder = embedder_with([[0.1] * 768])
    with pytest.raises(EmbeddingError) as excinfo:
        embedder.embed(["a"])
    assert "384" in str(excinfo.value)


def test_vector_count_mismatch_is_caught():
    embedder = embedder_with([[0.1] * 384])
    with pytest.raises(EmbeddingError):
        embedder.embed(["a", "b"])


def test_backend_exception_becomes_a_typed_error():
    class Broken:
        def embed(self, texts, batch_size=32):
            raise RuntimeError("onnx exploded")

    embedder = FastEmbedEmbedder()
    embedder._model = Broken()  # noqa: SLF001
    with pytest.raises(EmbeddingError):
        embedder.embed(["a"])


def test_batch_size_must_be_positive():
    with pytest.raises(ValueError):
        FastEmbedEmbedder(batch_size=0)


# --------------------------------------------------------------------------


def test_vector_literal_is_pgvector_text_form():
    assert vector_literal([1, 2.5, -0.25]) == "[1.0,2.5,-0.25]"


def test_vector_literal_round_trips_dimension_count():
    literal = vector_literal([0.0] * 384)
    assert literal.count(",") == 383


# --------------------------------------------------------------------------


def test_heuristic_counter_is_deterministic_and_nonzero():
    counter = HeuristicTokenCounter()
    assert counter("") == 0
    assert counter("hello world") == counter("hello world")
    assert counter("hello world") >= 2


def test_heuristic_counter_charges_long_words_extra():
    counter = HeuristicTokenCounter()
    assert counter("internationalisation") > counter("cat")


def test_model_token_counter_uses_the_real_tokenizer_when_present():
    class Encoded:
        ids = [1, 2, 3, 4]

    class Tok:
        def encode(self, text):
            return Encoded()

    count = model_token_counter(Tok())
    assert count("anything") == 4
    assert count("") == 0


def test_model_token_counter_falls_back_loudly(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="ingest.tokenizer"):
        count = model_token_counter(_unreachable_tokenizer())
    assert count("some words here") > 0
    assert any("heuristic" in record.message.lower() for record in caplog.records)


def _unreachable_tokenizer():
    return None


def test_tokenizer_probe_finds_a_nested_attribute():
    class Tok:
        def encode(self, text):
            return None

    class Inner:
        tokenizer = Tok()

    class Outer:
        model = Inner()

    assert isinstance(tokenizer_from_embedder(Outer()), Tok)


def test_tokenizer_probe_returns_none_when_absent():
    assert tokenizer_from_embedder(object()) is None
