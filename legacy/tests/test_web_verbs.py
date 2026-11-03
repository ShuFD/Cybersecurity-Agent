import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from web_verbs import build_web_verb_context, call_verb, format_web_verb_prompt, record_success


class WebVerbTests(unittest.TestCase):
    def test_search_source_routes_extracts_flask_and_express_routes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app.py").write_text(
                "@app.route('/login', methods=['GET','POST'])\ndef login(): pass\n",
                encoding="utf-8",
            )
            (root / "routes.js").write_text("router.post('/api/check', handler)\n", encoding="utf-8")
            result = call_verb("web.search_source_routes", {"source_dir": str(root)}, {"cwd": str(root)})

        self.assertEqual(result["status"], "success")
        paths = {(item["method"], item["path"]) for item in result["data"]["routes"]}
        self.assertIn(("GET", "/login"), paths)
        self.assertIn(("POST", "/login"), paths)
        self.assertIn(("POST", "/api/check"), paths)

    def test_extract_forms_from_mocked_fetch_and_writes_trace(self):
        html = b"<html><title>T</title><form action='/login' method='post'><input name='u'><input name='p' type='password'></form></html>"

        def fake_request(url, **kwargs):
            return {"url": "http://example.test/login", "status_code": 200, "headers": {"content-type": "text/html"}, "body": html}

        with tempfile.TemporaryDirectory() as tmp:
            with patch("web_verbs.builtin._http_request", fake_request):
                result = call_verb("web.extract_forms", {"url": "http://example.test/login"}, {"cwd": tmp})
            trace_path = Path(tmp) / "web_verb_trace.jsonl"

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["data"]["form_count"], 1)
            self.assertEqual(result["data"]["forms"][0]["resolved_action"], "http://example.test/login")
            self.assertTrue(trace_path.exists())

    def test_recommender_detects_web_task_and_formats_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app.py").write_text("@app.route('/admin')\ndef admin(): pass\n", encoding="utf-8")
            context = build_web_verb_context("http://127.0.0.1:8000 login cookie", project_root=str(root), enabled=True)
            prompt = format_web_verb_prompt(context)

        self.assertTrue(context["is_web_task"])
        self.assertIn("web_verb_call", context["recommended_tools"])
        self.assertIn("web.extract_forms", context["recommended_verbs"])
        self.assertIn("Web Verb switch is ON", prompt)

    def test_success_learning_records_used_verbs(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory = Path(tmp) / "memory"
            parent = SimpleNamespace(
                web_verbs_enabled=True,
                web_verbs_used=[{"verb": "web.extract_forms", "status": "success", "trace_id": "wv_1"}],
                web_verb_context={"digest": "abc", "traits": ["html_form"], "urls": ["http://example.test"]},
            )
            with patch.dict("os.environ", {"SECHEUR_WEB_VERB_MEMORY_DIR": str(memory)}, clear=False):
                result = record_success(parent=parent, handler=SimpleNamespace(), oracle_result={"correct": True, "attempt": 1})

            self.assertEqual(result["status"], "recorded")
            self.assertTrue((memory / "web_verb_success_cases.jsonl").exists())
            rule_text = (memory / "web_verb_rules.jsonl").read_text(encoding="utf-8")
            self.assertIn("web.extract_forms", rule_text)


if __name__ == "__main__":
    unittest.main()
