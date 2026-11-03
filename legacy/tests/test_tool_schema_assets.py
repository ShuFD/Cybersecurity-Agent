import json
from pathlib import Path

import agentmain


ROOT = Path(__file__).resolve().parents[1]


def _load_schema(name):
    return json.loads((ROOT / "assets" / name).read_text(encoding="utf-8"))


def _tool(schema, name):
    return next(item["function"] for item in schema if item["function"]["name"] == name)


def test_code_run_schema_exposes_background_mode():
    schema = _load_schema("tools_schema.json")
    props = _tool(schema, "code_run")["parameters"]["properties"]

    assert "run_in_background" in props


def test_code_run_schema_exposes_bash_type():
    default_type = _tool(_load_schema("tools_schema.json"), "code_run")["parameters"]["properties"]["type"]
    cn_type = _tool(_load_schema("tools_schema_cn.json"), "code_run")["parameters"]["properties"]["type"]

    assert "bash" in default_type["enum"]
    assert "bash" in cn_type["enum"]


def test_loaded_code_run_type_enum_values_are_unique():
    loaded_type = _tool(agentmain.load_tool_schema(), "code_run")["parameters"]["properties"]["type"]

    assert loaded_type["enum"] == list(dict.fromkeys(loaded_type["enum"]))


def test_code_run_schema_hides_inline_eval_from_model_tools():
    default_props = _tool(_load_schema("tools_schema.json"), "code_run")["parameters"]["properties"]
    cn_props = _tool(_load_schema("tools_schema_cn.json"), "code_run")["parameters"]["properties"]

    assert "inline_eval" not in default_props
    assert "inline_eval" not in cn_props


def test_task_output_schema_is_available_in_default_and_cn_assets():
    default_names = [item["function"]["name"] for item in _load_schema("tools_schema.json")]
    cn_names = [item["function"]["name"] for item in _load_schema("tools_schema_cn.json")]

    assert "task_output" in default_names
    assert "task_output" in cn_names
    assert "task_stop" in default_names
    assert "task_stop" in cn_names


def test_exit_plan_mode_schema_is_available_in_default_and_cn_assets():
    default_names = [item["function"]["name"] for item in _load_schema("tools_schema.json")]
    cn_names = [item["function"]["name"] for item in _load_schema("tools_schema_cn.json")]

    assert "exit_plan_mode" in default_names
    assert "exit_plan_mode" in cn_names


def test_exit_plan_mode_schema_exposes_allowed_prompts():
    default_props = _tool(_load_schema("tools_schema.json"), "exit_plan_mode")["parameters"]["properties"]
    cn_props = _tool(_load_schema("tools_schema_cn.json"), "exit_plan_mode")["parameters"]["properties"]

    assert default_props["allowedPrompts"]["items"]["properties"]["tool"]["enum"] == ["Bash"]
    assert "prompt" in default_props["allowedPrompts"]["items"]["properties"]
    assert cn_props["allowedPrompts"]["items"]["properties"]["tool"]["enum"] == ["Bash"]
    assert "prompt" in cn_props["allowedPrompts"]["items"]["properties"]


def test_exit_plan_mode_schema_documents_allowed_prompt_effect():
    default_props = _tool(_load_schema("tools_schema.json"), "exit_plan_mode")["parameters"]["properties"]
    cn_props = _tool(_load_schema("tools_schema_cn.json"), "exit_plan_mode")["parameters"]["properties"]

    assert "matching non-destructive test commands may be auto-approved" in default_props["allowedPrompts"]["description"]
    assert "run tests" in default_props["allowedPrompts"]["items"]["properties"]["prompt"]["description"]
    assert "匹配的非破坏测试命令可自动放行" in cn_props["allowedPrompts"]["description"]
    assert "run tests" in cn_props["allowedPrompts"]["items"]["properties"]["prompt"]["description"]
