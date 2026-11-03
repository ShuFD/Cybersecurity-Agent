import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from agent_loop import get_tool_meta
from agentmain import load_tool_schema
from ctf_verbs import call_verb as _call_verb
from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False
    ctf_verbs_enabled = False
    ctf_verb_context = None
    ctf_verbs_used = []
    ctf_sessions_open = []
    ctf_sessions_used = []


def _build_test_binary(tmp: Path) -> Path:
    src = tmp / "vuln.c"
    src.write_text(
        "#include <stdio.h>\n#include <string.h>\n"
        "int main(int argc, char **argv){\n"
        "    char buf[64];\n"
        "    if (argc<2) return 1;\n"
        "    strcpy(buf, argv[1]);\n"
        "    printf(\"%s\\n\", buf);\n"
        "    return 0;\n}\n",
        encoding="utf-8",
    )
    bin_path = tmp / "vuln"
    res = subprocess.run(
        ["gcc", "-fno-stack-protector", "-no-pie", "-o", str(bin_path), str(src)],
        capture_output=True,
        check=False,
    )
    if res.returncode != 0:
        raise unittest.SkipTest(f"compiler unavailable: {res.stderr.decode()[:200]}")
    return bin_path


def _run_generator(gen):
    chunks = []
    while True:
        try:
            chunks.append(next(gen))
        except StopIteration as done:
            return "".join(chunks), done.value


class CtfVerbHandlerRegistrationTests(unittest.TestCase):
    def test_ctf_verb_call_present_in_default_schema(self):
        schema = load_tool_schema()
        names = [t["function"]["name"] for t in schema if t.get("type") == "function"]
        self.assertIn("ctf_verb_call", names)

    def test_ctf_verb_call_present_in_cn_schema(self):
        schema = load_tool_schema("_cn")
        names = [t["function"]["name"] for t in schema if t.get("type") == "function"]
        self.assertIn("ctf_verb_call", names)

    def test_ctf_verb_call_schema_marks_verb_required(self):
        schema = load_tool_schema()
        tool = next(
            t["function"] for t in schema if t["function"]["name"] == "ctf_verb_call"
        )
        params = tool["parameters"]
        self.assertIn("verb", params["properties"])
        self.assertIn("verb", params["required"])
        self.assertEqual(params["properties"]["verb"]["type"], "string")

    def test_handler_marks_ctf_verb_call_read_only_and_concurrency_safe(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        meta = get_tool_meta(handler, "ctf_verb_call")
        self.assertTrue(meta.read_only)
        self.assertTrue(meta.concurrency_safe)
        self.assertFalse(getattr(meta, "destructive", False))


class CtfVerbHandlerDispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.bin_path = _build_test_binary(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_do_ctf_verb_call_dispatches_pwn_inspect_binary(self):
        handler = SecHeurAgentHandler(
            DummyParent(),
            [],
            cwd=str(self.tmp),
        )
        gen = handler.do_ctf_verb_call(
            {"verb": "pwn.inspect_binary", "args": {"path": str(self.bin_path)}},
            None,
        )
        output, outcome = _run_generator(gen)
        self.assertIn("[CTF Verb]", output)
        self.assertIn("pwn.inspect_binary", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["data"]["arch"], "x86_64")

    def test_do_ctf_verb_call_returns_structured_error_for_unknown_verb(self):
        handler = SecHeurAgentHandler(
            DummyParent(),
            [],
            cwd=str(self.tmp),
        )
        gen = handler.do_ctf_verb_call({"verb": "pwn.nonesuch", "args": {}}, None)
        output, outcome = _run_generator(gen)
        self.assertIn("unknown ctf verb", output)
        self.assertEqual(outcome.data["status"], "error")
        self.assertIn("available_verbs", outcome.data)

    def test_do_ctf_verb_call_session_lifecycle_end_to_end(self):
        handler = SecHeurAgentHandler(
            DummyParent(),
            [],
            cwd=str(self.tmp),
        )
        opened_gen = handler.do_ctf_verb_call(
            {"verb": "pwn.open_session", "args": {"path": str(self.bin_path)}},
            None,
        )
        _, opened = _run_generator(opened_gen)
        self.assertEqual(opened.data["status"], "success")
        session_id = opened.data["data"]["session_id"]

        append_gen = handler.do_ctf_verb_call(
            {
                "verb": "pwn.append_event",
                "args": {"session_id": session_id, "kind": "probe", "payload": {"offset": 36}},
            },
            None,
        )
        _, appended = _run_generator(append_gen)
        self.assertEqual(appended.data["status"], "recorded")
        self.assertEqual(appended.data["data"]["events_count"], 1)

        close_gen = handler.do_ctf_verb_call(
            {
                "verb": "pwn.close_session",
                "args": {
                    "session_id": session_id,
                    "summary": {"outcome": "shell_obtained"},
                },
            },
            None,
        )
        _, closed = _run_generator(close_gen)
        self.assertEqual(closed.data["status"], "closed")
        self.assertEqual(closed.data["data"]["events_count"], 1)
        self.assertEqual(
            len(handler.parent.ctf_sessions_used),
            1,
            "closed session is recorded on the parent for experience replay",
        )

    def test_handler_records_used_verbs_on_parent(self):
        handler = SecHeurAgentHandler(
            DummyParent(),
            [],
            cwd=str(self.tmp),
        )
        _run_generator(
            handler.do_ctf_verb_call(
                {"verb": "pwn.checksec", "args": {"path": str(self.bin_path)}},
                None,
            )
        )
        self.assertEqual(len(handler.parent.ctf_verbs_used), 1)
        trace = handler.parent.ctf_verbs_used[0]
        self.assertEqual(trace["verb"], "pwn.checksec")
        self.assertEqual(trace["status"], "success")
        self.assertTrue(trace["trace_id"].startswith("ct_"))

    def test_trace_path_written_under_run_dir(self):
        run_dir = self.tmp / "run"
        run_dir.mkdir()
        handler = SecHeurAgentHandler(
            DummyParent(),
            [],
            cwd=str(run_dir),
        )
        _run_generator(
            handler.do_ctf_verb_call(
                {
                    "verb": "pwn.identify_libc",
                    "args": {"leaks": [{"name": "system", "address": "0x7ffff7c55410"}]},
                },
                None,
            )
        )
        trace_path = run_dir / "ctf_verb_trace.jsonl"
        self.assertTrue(trace_path.exists(), "trace file should be written under run_dir")
        entries = [
            json.loads(line)
            for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual(entries[0]["verb"], "pwn.identify_libc")
        self.assertEqual(entries[0]["category"], "pwn")


class CtfVerbSchemaConventionTests(unittest.TestCase):
    """Mirror the schema shape that web_verb_call exposes so the model prompt
    sees a consistent tool surface across both verb families."""

    def test_ctf_verb_call_schema_matches_web_verb_call_shape(self):
        schema = load_tool_schema()
        ctf = next(
            t["function"] for t in schema if t["function"]["name"] == "ctf_verb_call"
        )
        web = next(
            t["function"] for t in schema if t["function"]["name"] == "web_verb_call"
        )
        self.assertEqual(
            list(ctf["parameters"]["properties"].keys()),
            list(web["parameters"]["properties"].keys()),
        )
        self.assertEqual(
            ctf["parameters"]["required"],
            web["parameters"]["required"],
        )
        self.assertEqual(
            list(ctf["parameters"]["properties"]["args"].keys()),
            list(web["parameters"]["properties"]["args"].keys()),
        )


if __name__ == "__main__":
    unittest.main()
