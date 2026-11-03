import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agentmain
from frontends.model_config import (
    build_mykey_py,
    delete_model_config,
    load_all_configs,
    load_current_config,
    mask_secret,
    merge_model_config,
    upsert_model_config,
    write_model_config,
)


class ModelConfigTests(unittest.TestCase):
    def test_builds_loadable_native_oai_config(self):
        content = build_mykey_py(
            {
                "name": "work-model",
                "type": "native_oai",
                "apikey": "sk-test-secret",
                "apibase": "https://api.example.com/v1",
                "model": "gpt-test",
                "api_mode": "chat_completions",
                "proxy": "",
            },
            generated_at="2026-06-01 10:00",
        )

        self.assertIn("mixin_config", content)
        self.assertIn("'llm_nos': ['work-model']", content)
        self.assertIn("native_oai_config", content)
        self.assertIn("'apikey': 'sk-test-secret'", content)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mykey.py"
            path.write_text(content, encoding="utf-8")
            loaded = load_current_config(path)

        self.assertEqual(loaded["name"], "work-model")
        self.assertEqual(loaded["apikey"], "sk-test-secret")
        self.assertEqual(loaded["model"], "gpt-test")

    def test_preserves_existing_api_key_when_form_key_is_blank(self):
        merged = merge_model_config(
            {
                "name": "new-name",
                "type": "native_oai",
                "apikey": "",
                "apibase": "https://api.example.com/v1",
                "model": "gpt-new",
            },
            {"apikey": "sk-existing-secret"},
        )

        self.assertEqual(merged["apikey"], "sk-existing-secret")

    def test_builds_loadable_native_anthropic_config_with_advanced_fields(self):
        content = build_mykey_py(
            {
                "name": "anthropic-relay",
                "type": "native_anthropic",
                "apikey": "sk-ant-test-secret",
                "apibase": "https://api.anthropic.com",
                "model": "anthropic-test",
                "relay_compat_system_prompt": True,
                "thinking_type": "enabled",
                "thinking_budget_tokens": 32768,
                "max_tokens": 32768,
                "stream": False,
            },
            generated_at="2026-06-01 10:00",
        )

        self.assertIn("native_anthropic_config", content)
        self.assertIn("'relay_compat_system_prompt': True", content)
        self.assertIn("'thinking_budget_tokens': 32768", content)
        self.assertIn("'stream': False", content)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mykey.py"
            path.write_text(content, encoding="utf-8")
            loaded = load_current_config(path)

        self.assertEqual(loaded["type"], "native_anthropic")
        self.assertEqual(loaded["thinking_budget_tokens"], 32768)
        self.assertIs(loaded["stream"], False)

    def test_preserves_existing_advanced_fields_when_form_omits_them(self):
        merged = merge_model_config(
            {
                "name": "anthropic-relay",
                "type": "native_anthropic",
                "apikey": "",
                "apibase": "https://relay.example.com",
                "model": "anthropic-test",
                "relay_compat_system_prompt": True,
                "thinking_type": "enabled",
            },
            {
                "apikey": "sk-existing-secret",
                "reasoning_effort": "high",
                "thinking_budget_tokens": 32768,
                "max_tokens": 32768,
                "max_retries": 3,
                "connect_timeout": 10,
                "read_timeout": 180,
                "temperature": 1,
                "context_win": 800000,
                "user_agent": "secheur-agent/1.0",
                "stream": False,
            },
        )

        self.assertEqual(merged["apikey"], "sk-existing-secret")
        self.assertEqual(merged["reasoning_effort"], "high")
        self.assertEqual(merged["thinking_budget_tokens"], 32768)
        self.assertEqual(merged["max_tokens"], 32768)
        self.assertEqual(merged["context_win"], 800000)
        self.assertEqual(merged["user_agent"], "secheur-agent/1.0")
        self.assertIs(merged["stream"], False)

    def test_preserves_existing_cost_fields_when_form_omits_them(self):
        merged = merge_model_config(
            {
                "name": "priced-model",
                "type": "native_oai",
                "apikey": "",
                "apibase": "https://api.example.com/v1",
                "model": "gpt-test",
            },
            {
                "apikey": "sk-existing-secret",
                "input_cost_per_1m": 3.0,
                "output_cost_per_1m": 15.0,
                "cache_read_cost_per_1m": 0.3,
                "cache_creation_cost_per_1m": 3.75,
            },
        )

        self.assertEqual(merged["input_cost_per_1m"], 3.0)
        self.assertEqual(merged["output_cost_per_1m"], 15.0)
        self.assertEqual(merged["cache_read_cost_per_1m"], 0.3)
        self.assertEqual(merged["cache_creation_cost_per_1m"], 3.75)

    def test_write_model_config_creates_backup_without_losing_existing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mykey.py"
            path.write_text("old_config = {'name': 'old'}\n", encoding="utf-8")

            write_model_config(
                {
                    "name": "work-model",
                    "type": "native_oai",
                    "apikey": "sk-test-secret",
                    "apibase": "https://api.example.com/v1",
                    "model": "gpt-test",
                    "api_mode": "chat_completions",
                },
                path,
            )

            self.assertEqual((Path(tmp) / "mykey.py.bak").read_text(encoding="utf-8"), "old_config = {'name': 'old'}\n")
            self.assertIn("native_oai_config", path.read_text(encoding="utf-8"))

    def test_masks_secret_without_revealing_middle(self):
        self.assertEqual(mask_secret("sk-1234567890abcdef"), "sk-1...cdef")
        self.assertEqual(mask_secret(""), "")

    def test_delete_model_config_removes_profile_and_selects_remaining_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mykey.py"
            upsert_model_config(path, {
                "name": "openai",
                "type": "native_oai",
                "apikey": "sk-openai",
                "apibase": "https://api.openai.example/v1",
                "model": "gpt-test",
            })
            upsert_model_config(path, {
                "name": "anthropic",
                "type": "native_anthropic",
                "apikey": "sk-anthropic",
                "apibase": "https://api.anthropic.example",
                "model": "claude-test",
            })

            result = delete_model_config(path, "anthropic")
            loaded = load_all_configs(path)
            text = path.read_text(encoding="utf-8")

            self.assertEqual(result["deletedName"], "anthropic")
            self.assertEqual([profile["name"] for profile in loaded["profiles"]], ["openai"])
            self.assertEqual(loaded["activeNames"], ["openai"])
            self.assertNotIn("sk-anthropic", text)

    def test_delete_last_model_config_removes_mykey_file_after_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mykey.py"
            upsert_model_config(path, {
                "name": "openai",
                "type": "native_oai",
                "apikey": "sk-openai",
                "apibase": "https://api.openai.example/v1",
                "model": "gpt-test",
            })

            result = delete_model_config(path, "openai")

            self.assertEqual(result["deletedName"], "openai")
            self.assertFalse(path.exists())
            self.assertTrue((Path(tmp) / "mykey.py.bak").exists())

    def test_load_tool_schema_does_not_rebind_default_global_schema(self):
        original_schema = agentmain.TOOLS_SCHEMA
        try:
            cn_schema = agentmain.load_tool_schema("_cn")

            self.assertEqual(agentmain.TOOLS_SCHEMA, original_schema)
            self.assertNotEqual(cn_schema[0]["function"]["description"], original_schema[0]["function"]["description"])
        finally:
            agentmain.TOOLS_SCHEMA = original_schema

    def test_next_llm_updates_only_current_agent_tool_schema(self):
        class FakeClient:
            def __init__(self, model):
                self.backend = SimpleNamespace(model=model, name=model, history=[])
                self.last_tools = "cached"

        original_schema = agentmain.TOOLS_SCHEMA
        agent = object.__new__(agentmain.SecHeurAgent)
        agent.llmclients = [FakeClient("claude-test"), FakeClient("glm-4")]
        agent.llmclient = agent.llmclients[0]
        agent.llm_no = 0
        agent.base_tools_schema = original_schema
        try:
            with patch.object(agentmain, "reload_mykeys", return_value=({}, False)):
                agent.next_llm(1)

            self.assertIs(agentmain.TOOLS_SCHEMA, original_schema)
            self.assertIsNot(agent.base_tools_schema, original_schema)
            self.assertNotEqual(
                agent.base_tools_schema[0]["function"]["description"],
                original_schema[0]["function"]["description"],
            )
        finally:
            agentmain.TOOLS_SCHEMA = original_schema


if __name__ == "__main__":
    unittest.main()
