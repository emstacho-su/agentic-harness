"""ClaudeCliJudge, driven by a fake runner. No test here ever starts `claude`."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from ingest.curate import claude_cli
from ingest.curate.claude_cli import (
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_S,
    HOOKS_OFF_SETTINGS,
    JUDGE_INSTRUCTION,
    ClaudeCliJudge,
    build_argv,
)
from ingest.curate.judge import JudgeError, JudgeOutputInvalid, JudgeUsage

REPO_ROOT = Path(__file__).resolve().parents[2]
EXE = "C:/fake/bin/claude.exe"
SECRET = "sk-ant-api03-PLANTEDSECRETvalue0123456789"

SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}, "count": {"type": "integer"}},
    "required": ["summary", "count"],
    "additionalProperties": False,
}
SCHEMA_JSON = json.dumps(SCHEMA, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class Completed:
    returncode: int
    stdout: str
    stderr: str = ""


@dataclass(frozen=True)
class Seen:
    argv: list[str]
    stdin: str
    cwd: Path
    timeout: float
    cwd_existed: bool
    cwd_entries: tuple[str, ...]


class FakeRunner:
    """Records what the judge would have run and answers with a canned result."""

    def __init__(self, answer: Completed | BaseException) -> None:
        self.answer = answer
        self.seen: list[Seen] = []

    def __call__(self, argv: list[str], stdin: str, cwd: Path, timeout: float) -> Completed:
        self.seen.append(
            Seen(
                argv=list(argv),
                stdin=stdin,
                cwd=Path(cwd),
                timeout=timeout,
                cwd_existed=Path(cwd).is_dir(),
                cwd_entries=tuple(entry.name for entry in Path(cwd).iterdir()),
            )
        )
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


def result_json(**overrides) -> str:
    payload = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "",
        "structured_output": {"summary": "a bug", "count": 2},
        "session_id": "00000000-0000-0000-0000-000000000000",
        "total_cost_usd": 0.0123,
        "usage": {
            "input_tokens": 1000,
            "output_tokens": 50,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 30,
        },
    }
    payload.update(overrides)
    return json.dumps(payload)


def make_judge(answer: Completed | BaseException, **kwargs) -> tuple[ClaudeCliJudge, FakeRunner]:
    runner = FakeRunner(answer)
    judge = ClaudeCliJudge(runner=runner, which=lambda name: EXE, **kwargs)
    return judge, runner


def expected_argv(model: str = DEFAULT_MODEL) -> list[str]:
    return [
        EXE,
        "-p", JUDGE_INSTRUCTION,
        "--output-format", "json",
        "--json-schema", SCHEMA_JSON,
        "--model", model,
        "--tools", "",
        "--disallowedTools", "mcp__*",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--safe-mode",
        "--settings", HOOKS_OFF_SETTINGS,
        "--disable-slash-commands",
    ]  # fmt: skip


# --- the command -------------------------------------------------------------


def test_argv_is_exactly_the_designed_command():
    judge, runner = make_judge(Completed(0, result_json()))
    judge.judge("the prompt", SCHEMA)
    assert runner.seen[0].argv == expected_argv()


def test_build_argv_matches_what_the_judge_runs():
    assert build_argv(EXE, SCHEMA, DEFAULT_MODEL) == expected_argv()


def test_tools_are_disabled_with_an_empty_list_not_a_missing_value():
    argv = build_argv(EXE, SCHEMA, DEFAULT_MODEL)
    assert argv[argv.index("--tools") + 1] == ""
    assert "--allowedTools" not in argv and "--allowed-tools" not in argv
    assert "--mcp-config" not in argv
    # --tools does not reach MCP tools, so they are denied separately.
    assert argv[argv.index("--disallowedTools") + 1] == "mcp__*"


def test_the_fixed_instruction_is_the_positional_prompt_right_after_p():
    # --tools and --disallowedTools take a variadic list; a positional prompt
    # placed after them would be swallowed as a tool name.
    argv = build_argv(EXE, SCHEMA, DEFAULT_MODEL)
    assert argv[1:3] == ["-p", JUDGE_INSTRUCTION]
    assert "\n" not in JUDGE_INSTRUCTION and len(JUDGE_INSTRUCTION) < 200


def test_hooks_off_settings_disables_all_hooks():
    assert json.loads(HOOKS_OFF_SETTINGS) == {"disableAllHooks": True}


def test_model_is_injectable():
    judge, runner = make_judge(Completed(0, result_json()), model="claude-haiku-5")
    result = judge.judge("the prompt", SCHEMA)
    assert runner.seen[0].argv == expected_argv("claude-haiku-5")
    assert result.model == "claude-haiku-5"


def test_default_model_is_sonnet_5():
    assert DEFAULT_MODEL == "claude-sonnet-5"


def test_prompt_goes_on_stdin_and_never_on_argv():
    prompt = f"Extract issues.\n{SECRET}\n" + "x" * 50_000
    judge, runner = make_judge(Completed(0, result_json()))
    judge.judge(prompt, SCHEMA)
    assert runner.seen[0].stdin == prompt
    assert all(SECRET not in arg for arg in runner.seen[0].argv)


def test_cwd_is_a_fresh_empty_temp_dir_outside_the_repo_and_removed_after():
    judge, runner = make_judge(Completed(0, result_json()))
    judge.judge("one", SCHEMA)
    judge.judge("two", SCHEMA)
    first, second = runner.seen
    assert first.cwd_existed and first.cwd_entries == ()
    assert REPO_ROOT not in first.cwd.resolve().parents
    assert first.cwd.resolve() != REPO_ROOT
    assert first.cwd != second.cwd
    assert not first.cwd.exists() and not second.cwd.exists()


def test_timeout_is_passed_to_the_runner():
    judge, runner = make_judge(Completed(0, result_json()), timeout_s=12.5)
    judge.judge("p", SCHEMA)
    assert runner.seen[0].timeout == 12.5
    assert DEFAULT_TIMEOUT_S == 300.0


def test_oversized_schema_is_refused_before_running():
    big = {"type": "object", "properties": {f"field_{i:05d}": {"type": "string"} for i in range(2000)}}
    judge, runner = make_judge(Completed(0, result_json()))
    with pytest.raises(JudgeError, match="schema"):
        judge.judge("p", big)
    assert runner.seen == []


# --- parsing -----------------------------------------------------------------


def test_success_returns_validated_output_usage_and_cost():
    judge, _ = make_judge(Completed(0, result_json()))
    result = judge.judge("p", SCHEMA)
    assert result.output == {"summary": "a bug", "count": 2}
    assert result.usage == JudgeUsage(input_tokens=1230, output_tokens=50, cost_usd=0.0123)
    assert result.model == DEFAULT_MODEL


def test_missing_cache_fields_and_cost_are_tolerated():
    stdout = result_json(usage={"input_tokens": 10, "output_tokens": 5})
    payload = json.loads(stdout)
    del payload["total_cost_usd"]
    judge, _ = make_judge(Completed(0, json.dumps(payload)))
    assert judge.judge("p", SCHEMA).usage == JudgeUsage(10, 5, None)


def test_missing_usage_is_an_error():
    payload = json.loads(result_json())
    del payload["usage"]
    judge, _ = make_judge(Completed(0, json.dumps(payload)))
    with pytest.raises(JudgeError, match="usage"):
        judge.judge("p", SCHEMA)


def test_negative_or_non_integer_token_counts_are_an_error():
    judge, _ = make_judge(Completed(0, result_json(usage={"input_tokens": -1, "output_tokens": "5"})))
    with pytest.raises(JudgeError, match="usage"):
        judge.judge("p", SCHEMA)


def test_is_error_is_a_judge_error_naming_the_subtype():
    stdout = result_json(is_error=True, subtype="error_max_structured_output_retries", result=SECRET)
    judge, _ = make_judge(Completed(0, stdout))
    with pytest.raises(JudgeError, match="error_max_structured_output_retries") as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert SECRET not in str(excinfo.value)


def test_non_zero_exit_reports_code_and_a_short_stderr_excerpt():
    stderr = "E" * 200 + "TAIL-THAT-MUST-BE-CUT"
    judge, _ = make_judge(Completed(2, result_json(result=SECRET), stderr))
    with pytest.raises(JudgeError) as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    message = str(excinfo.value)
    assert "exit code 2" in message
    assert "E" * 150 in message
    assert "TAIL-THAT-MUST-BE-CUT" not in message
    assert SECRET not in message


def test_timeout_is_a_judge_error():
    judge, _ = make_judge(subprocess.TimeoutExpired(cmd=["claude"], timeout=300, output=SECRET))
    with pytest.raises(JudgeError, match="timed out") as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert SECRET not in str(excinfo.value)


def test_os_error_starting_the_process_is_a_judge_error():
    judge, _ = make_judge(PermissionError("access denied"))
    with pytest.raises(JudgeError, match="could not start"):
        judge.judge("p", SCHEMA)


@pytest.mark.parametrize("stdout", ["", "not json at all " + SECRET, "[1, 2]", '"a string"'])
def test_stdout_that_is_not_a_json_object_is_a_judge_error(stdout):
    judge, _ = make_judge(Completed(0, stdout))
    with pytest.raises(JudgeError, match="JSON") as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert SECRET not in str(excinfo.value)
    assert not isinstance(excinfo.value, JudgeOutputInvalid)


def test_missing_structured_output_is_a_judge_error():
    payload = json.loads(result_json(result=f"here you go {SECRET}"))
    del payload["structured_output"]
    judge, _ = make_judge(Completed(0, json.dumps(payload)))
    with pytest.raises(JudgeError, match="structured_output") as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert SECRET not in str(excinfo.value)
    assert not isinstance(excinfo.value, JudgeOutputInvalid)


def test_schema_invalid_structured_output_is_judge_output_invalid_without_the_value():
    stdout = result_json(structured_output={"summary": "ok", "count": SECRET})
    judge, _ = make_judge(Completed(0, stdout))
    with pytest.raises(JudgeOutputInvalid) as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert "count" in str(excinfo.value)
    assert SECRET not in str(excinfo.value)


def test_a_secret_planted_everywhere_never_reaches_any_error_text():
    stdout = result_json(
        is_error=True, subtype=SECRET, result=SECRET, structured_output={SECRET: SECRET}
    )
    judge, _ = make_judge(Completed(1, stdout, stderr="short failure"))
    with pytest.raises(JudgeError) as excinfo:
        judge.judge(f"prompt {SECRET}", SCHEMA)
    assert SECRET not in str(excinfo.value)
    assert SECRET not in repr(excinfo.value.args)


def test_an_unrecognised_subtype_is_not_echoed():
    judge, _ = make_judge(Completed(0, result_json(is_error=True, subtype=SECRET)))
    with pytest.raises(JudgeError) as excinfo:
        judge.judge("p", SCHEMA)
    assert SECRET not in str(excinfo.value)


# --- the executable ----------------------------------------------------------


def test_claude_not_on_path_is_a_clear_judge_error():
    runner = FakeRunner(Completed(0, result_json()))
    judge = ClaudeCliJudge(runner=runner, which=lambda name: None)
    with pytest.raises(JudgeError, match="PATH"):
        judge.judge("p", SCHEMA)
    assert runner.seen == []


def test_executable_is_looked_up_by_name_claude():
    asked = []
    runner = FakeRunner(Completed(0, result_json()))
    judge = ClaudeCliJudge(runner=runner, which=lambda name: asked.append(name) or EXE)
    judge.judge("p", SCHEMA)
    assert asked == ["claude"]


def test_blank_prompt_is_refused_before_running():
    judge, runner = make_judge(Completed(0, result_json()))
    with pytest.raises(JudgeError):
        judge.judge("  ", SCHEMA)
    assert runner.seen == []


def test_default_runner_uses_list_argv_utf8_and_no_shell(monkeypatch, tmp_path):
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        captured.update(kwargs)
        return subprocess.CompletedProcess(argv, 0, stdout="{}", stderr="")

    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)
    completed = claude_cli.subprocess_runner(["claude", "-p"], "hello", tmp_path, 9.0)
    assert completed.returncode == 0
    assert captured["argv"] == ["claude", "-p"]
    assert captured["input"] == "hello"
    assert captured["cwd"] == tmp_path
    assert captured["timeout"] == 9.0
    assert captured["encoding"] == "utf-8"
    assert captured["capture_output"] is True
    assert captured.get("shell", False) is False


def test_default_runner_drops_api_key_variables_so_the_login_is_used(monkeypatch, tmp_path):
    captured = {}

    def fake_run(argv, **kwargs):
        captured.update(kwargs)
        return subprocess.CompletedProcess(argv, 0, stdout="{}", stderr="")

    monkeypatch.setattr(claude_cli.subprocess, "run", fake_run)
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", SECRET)
    monkeypatch.setenv("KEEP_ME", "yes")
    claude_cli.subprocess_runner(["claude"], "hello", tmp_path, 9.0)
    env = captured["env"]
    assert "ANTHROPIC_API_KEY" not in env and "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["KEEP_ME"] == "yes"


@pytest.mark.parametrize("kwargs", [{"model": "  "}, {"timeout_s": 0}, {"timeout_s": -1.0}])
def test_bad_construction_is_refused(kwargs):
    with pytest.raises(JudgeError):
        ClaudeCliJudge(runner=FakeRunner(Completed(0, result_json())), which=lambda n: EXE, **kwargs)


def test_a_workdir_that_cannot_be_removed_is_logged_not_raised(monkeypatch, caplog):
    def refuse(path):
        raise PermissionError("in use")

    monkeypatch.setattr(claude_cli.shutil, "rmtree", refuse)
    judge, runner = make_judge(Completed(0, result_json()))
    with caplog.at_level("WARNING", logger=claude_cli.__name__):
        assert judge.judge("p", SCHEMA).output["count"] == 2
    assert "could not remove judge workdir" in caplog.text
    runner.seen[0].cwd.rmdir()
