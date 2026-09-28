"""The Judge contract: schema validation and the FakeJudge every curate test uses."""

from __future__ import annotations

import json

import pytest

from ingest.curate.judge import (
    FakeJudge,
    JudgeError,
    JudgeOutputInvalid,
    JudgeResult,
    JudgeUsage,
    validate_output,
)
from ingest.errors import IngestError

SECRET = "sk-ant-api03-PLANTEDSECRETvalue0123456789"

ISSUE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "count": {"type": "integer", "minimum": 0},
        "items": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "count"],
    "additionalProperties": False,
}


def valid_output(**overrides) -> dict:
    return {"summary": "a bug", "count": 2, **overrides}


# --- validate_output ---------------------------------------------------------


def test_valid_output_is_returned_as_an_equal_dict():
    output = valid_output(items=["a"])
    assert validate_output(output, ISSUE_SCHEMA) == output


def test_validated_output_is_a_copy_not_the_callers_object():
    output = valid_output(items=["a"])
    validated = validate_output(output, ISSUE_SCHEMA)
    validated["items"].append("b")
    assert output["items"] == ["a"]


def test_missing_required_field_is_rejected_with_its_name():
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output({"summary": "x"}, ISSUE_SCHEMA)
    assert excinfo.value.messages
    assert "count" in str(excinfo.value)


def test_wrong_type_is_rejected_and_names_the_path_and_keyword():
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output(valid_output(count="two"), ISSUE_SCHEMA)
    text = str(excinfo.value)
    assert "count" in text
    assert "type" in text


def test_a_schema_valid_answer_that_is_not_an_object_is_still_refused():
    # Every caller indexes the answer by key, so an array is refused even when
    # the schema would allow it.
    schema = {"type": "array", "items": {"type": "integer"}}
    with pytest.raises(JudgeOutputInvalid):
        validate_output([1], schema)


def test_draft_2020_12_prefix_items_rejects_extra_array_members():
    schema = {
        "type": "object",
        "properties": {"pair": {"type": "array", "prefixItems": [{"type": "integer"}], "items": False}},
    }
    assert validate_output({"pair": [1]}, schema) == {"pair": [1]}
    with pytest.raises(JudgeOutputInvalid):
        validate_output({"pair": [1, 2]}, schema)


def test_messages_never_carry_the_invalid_value():
    output = valid_output(count=SECRET, items=[SECRET, 3])
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output(output, ISSUE_SCHEMA)
    assert SECRET not in str(excinfo.value)
    assert all(SECRET not in message for message in excinfo.value.messages)


def test_messages_never_carry_an_unexpected_key_name():
    output = valid_output(**{SECRET: "x"})
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output(output, ISSUE_SCHEMA)
    assert SECRET not in str(excinfo.value)
    assert "additionalProperties" in str(excinfo.value)


def test_messages_are_capped():
    schema = {"type": "object", "properties": {}, "additionalProperties": {"type": "integer"}}
    output = {f"k{index}": "not-int" for index in range(50)}
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output(output, schema)
    assert len(excinfo.value.messages) <= 11  # ten errors plus an "and N more" line


def test_an_invalid_schema_is_a_judge_error_not_an_output_error():
    with pytest.raises(JudgeError) as excinfo:
        validate_output({}, {"type": "not-a-type"})
    assert not isinstance(excinfo.value, JudgeOutputInvalid)


def test_error_hierarchy_roots_in_ingest_error():
    assert issubclass(JudgeOutputInvalid, JudgeError)
    assert issubclass(JudgeError, IngestError)


# --- FakeJudge: queue --------------------------------------------------------


def test_queue_answers_in_order_and_records_calls():
    judge = FakeJudge([valid_output(count=1), valid_output(count=2)])
    first = judge.judge("prompt one", ISSUE_SCHEMA)
    second = judge.judge("prompt two", ISSUE_SCHEMA)
    assert first.output["count"] == 1
    assert second.output["count"] == 2
    assert [call.prompt for call in judge.calls] == ["prompt one", "prompt two"]
    assert judge.calls[0].schema == ISSUE_SCHEMA


def test_result_carries_estimated_usage_and_model():
    output = valid_output()
    prompt = "x" * 400
    result = FakeJudge([output], model="fake-model").judge(prompt, ISSUE_SCHEMA)
    assert isinstance(result, JudgeResult)
    assert result.model == "fake-model"
    assert result.usage == JudgeUsage(
        input_tokens=100, output_tokens=len(json.dumps(output)) // 4, cost_usd=None
    )


def test_exhausted_queue_raises_judge_error():
    judge = FakeJudge([valid_output()])
    judge.judge("one", ISSUE_SCHEMA)
    with pytest.raises(JudgeError, match="exhausted"):
        judge.judge("two", ISSUE_SCHEMA)


def test_queued_exception_instance_is_raised_and_the_call_still_recorded():
    judge = FakeJudge([JudgeError("boom"), valid_output()])
    with pytest.raises(JudgeError, match="boom"):
        judge.judge("one", ISSUE_SCHEMA)
    assert judge.judge("two", ISSUE_SCHEMA).output == valid_output()
    assert len(judge.calls) == 2


def test_queued_exception_class_is_raised():
    judge = FakeJudge([TimeoutError])
    with pytest.raises(TimeoutError):
        judge.judge("one", ISSUE_SCHEMA)


def test_queued_invalid_output_fails_validation_like_the_real_judge():
    judge = FakeJudge([{"summary": "no count"}])
    with pytest.raises(JudgeOutputInvalid):
        judge.judge("one", ISSUE_SCHEMA)


def test_queue_is_copied_so_the_caller_list_is_not_consumed():
    answers = [valid_output()]
    FakeJudge(answers).judge("one", ISSUE_SCHEMA)
    assert answers == [valid_output()]


# --- FakeJudge: responder ----------------------------------------------------


def test_responder_sees_prompt_and_schema():
    seen = []

    def responder(prompt: str, schema: dict) -> dict:
        seen.append((prompt, schema))
        return valid_output(summary=prompt.upper())

    judge = FakeJudge(responder)
    assert judge.judge("abc", ISSUE_SCHEMA).output["summary"] == "ABC"
    assert judge.judge("def", ISSUE_SCHEMA).output["summary"] == "DEF"
    assert seen == [("abc", ISSUE_SCHEMA), ("def", ISSUE_SCHEMA)]


def test_responder_exception_propagates():
    def responder(prompt: str, schema: dict) -> dict:
        raise JudgeError("responder failed")

    with pytest.raises(JudgeError, match="responder failed"):
        FakeJudge(responder).judge("abc", ISSUE_SCHEMA)


def test_responder_output_is_validated():
    judge = FakeJudge(lambda prompt, schema: {"summary": 1, "count": 0})
    with pytest.raises(JudgeOutputInvalid):
        judge.judge("abc", ISSUE_SCHEMA)


# --- request validation ------------------------------------------------------


@pytest.mark.parametrize("prompt", ["", "   ", None, 3])
def test_blank_or_non_string_prompt_is_refused(prompt):
    with pytest.raises(JudgeError):
        FakeJudge([valid_output()]).judge(prompt, ISSUE_SCHEMA)


def test_non_dict_schema_is_refused():
    with pytest.raises(JudgeError):
        FakeJudge([valid_output()]).judge("abc", ["not", "a", "schema"])


def test_calls_are_exposed_read_only():
    judge = FakeJudge([valid_output()])
    judge.judge("abc", ISSUE_SCHEMA)
    assert isinstance(judge.calls, tuple)


def test_a_long_schema_value_is_truncated_in_the_message():
    schema = {"type": "object", "properties": {"kind": {"enum": [f"kind_{i:03d}" for i in range(40)]}}}
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        validate_output({"kind": "other"}, schema)
    assert "..." in str(excinfo.value)
    assert "kind_039" not in str(excinfo.value)
