import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ctf_verbs import (
    build_ctf_verb_context,
    call_verb,
    format_ctf_verb_prompt,
    list_verbs,
    record_success,
)


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


class CtfVerbRegistrationTests(unittest.TestCase):
    def test_list_verbs_includes_pwn_and_reverse_categories(self):
        verbs = list_verbs()
        names = {item["name"] for item in verbs}
        self.assertIn("pwn.inspect_binary", names)
        self.assertIn("pwn.checksec", names)
        self.assertIn("pwn.find_gadgets", names)
        self.assertIn("pwn.cyclic_offset", names)
        self.assertIn("pwn.identify_libc", names)
        self.assertIn("pwn.open_session", names)
        self.assertIn("re.triage", names)
        self.assertIn("re.strings", names)
        self.assertIn("re.functions", names)
        self.assertIn("re.detect_packer", names)
        self.assertIn("re.diff_against", names)
        self.assertIn("re.decompile", names)

    def test_session_verbs_carry_file_write_tag(self):
        verbs = {item["name"]: item for item in list_verbs()}
        for name in ("pwn.open_session", "pwn.append_event", "pwn.close_session"):
            self.assertIn("file_write", verbs[name]["policy_tags"])
            self.assertIn("read_only", verbs[name]["policy_tags"])

    def test_atomic_pwn_verbs_are_pure_read_only(self):
        atomic = (
            "pwn.inspect_binary",
            "pwn.checksec",
            "pwn.find_gadgets",
            "pwn.disasm",
            "pwn.cyclic_offset",
            "pwn.identify_libc",
            "pwn.glibc_offsets",
        )
        verbs = {item["name"]: item for item in list_verbs()}
        for name in atomic:
            self.assertEqual(verbs[name]["policy_tags"], ["read_only"], name)


class CtfPwnVerbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.bin_path = _build_test_binary(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_inspect_binary_returns_arch_and_libc(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "pwn.inspect_binary", {"path": str(self.bin_path)}, ctx
        )
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertEqual(data["arch"], "x86_64")
        self.assertEqual(data["bits"], 64)
        self.assertIn("protections", data)
        self.assertIn("libc_candidates", data)

    def test_checksec_returns_protections_dict(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb("pwn.checksec", {"path": str(self.bin_path)}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertIn("protections", result["data"])
        self.assertIn("canary", result["data"]["protections"])

    def test_find_gadgets_finds_at_least_one_ret(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "pwn.find_gadgets",
            {"path": str(self.bin_path), "kind": "ret", "max": 8},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertGreater(result["data"]["gadget_count"], 0)
        instructions = result["data"]["gadgets"][0]["instructions"]
        self.assertTrue(instructions, "gadget has at least one instruction")
        self.assertEqual(instructions[-1], "ret")

    def test_cyclic_offset_pattern_round_trip(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        pattern_result = call_verb(
            "pwn.cyclic_offset", {"length": 4096}, ctx
        )
        self.assertEqual(pattern_result["status"], "success")
        pattern = pattern_result["data"]["pattern"]
        needle = pattern[36 : 36 + 4]
        offset_result = call_verb(
            "pwn.cyclic_offset",
            {"length": 4096, "value": pattern_result["data"]["pattern"][36 : 36 + 4]},
            ctx,
        )
        self.assertEqual(offset_result["status"], "success")
        self.assertEqual(offset_result["data"]["offset"], 36)
        self.assertEqual(
            offset_result["data"]["value_endian"],
            "little" if needle.isascii() else "unknown",
        )

    def test_cyclic_offset_handles_crash_register_value(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "pwn.cyclic_offset",
            {"length": 4096, "value": "jaaa"},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["offset"], 36)

    def test_identify_libc_selects_known_version(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "pwn.identify_libc",
            {
                "leaks": [
                    {"name": "system", "address": "0x7ffff7c55410"},
                    {"name": "dup2", "address": "0x7ffff7d11130"},
                ]
            },
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertGreater(len(result["data"]["candidates"]), 0)
        self.assertEqual(result["data"]["candidates"][0]["version"], "2.31")

    def test_glibc_offsets_lookup(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb("pwn.glibc_offsets", {"version": "2.31"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertIn("system", result["data"]["offsets"])
        self.assertIn("str_bin_sh", result["data"]["offsets"])


class CtfReverseVerbTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.bin_path = _build_test_binary(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_triage_detects_c_and_lists_sections(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb("re.triage", {"path": str(self.bin_path)}, ctx)
        self.assertEqual(result["status"], "success")
        data = result["data"]
        self.assertIn("c_cpp", data["languages"])
        self.assertGreater(len(data["sections"]), 1)
        sections = {entry["name"] for entry in data["sections"]}
        self.assertIn(".text", sections)
        self.assertFalse(data["stripped"])

    def test_strings_filters_and_truncates(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "re.strings",
            {
                "path": str(self.bin_path),
                "min_len": 4,
                "max_count": 200,
                "contains": "/lib",
            },
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertGreater(result["data"]["string_count"], 0)
        for entry in result["data"]["strings"]:
            self.assertIn("/lib", entry["value"])

    def test_functions_returns_named_symbols(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb(
            "re.functions",
            {"path": str(self.bin_path), "max_count": 32},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        names = {item["name"] for item in result["data"]["functions"]}
        self.assertIn("main", names)

    def test_detect_packer_returns_low_confidence_for_unpacked(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        result = call_verb("re.detect_packer", {"path": str(self.bin_path)}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["packer"], None)
        self.assertLess(result["data"]["confidence"], 0.3)

    def test_diff_against_same_binary(self):
        ctx = {"cwd": str(self.tmp), "run_dir": str(self.tmp)}
        baseline = self.tmp / "baseline.bin"
        target = self.tmp / "target.bin"
        baseline.write_bytes(self.bin_path.read_bytes())
        target.write_bytes(self.bin_path.read_bytes())
        result = call_verb(
            "re.diff_against",
            {"baseline_path": str(baseline), "path": str(target)},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["size_delta"], 0)
        self.assertEqual(result["data"]["added_count"], 0)
        self.assertEqual(result["data"]["removed_count"], 0)


class CtfSessionLifecycleTests(unittest.TestCase):
    def test_open_append_close_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = {"cwd": tmp, "run_dir": tmp}
            opened = call_verb(
                "pwn.open_session",
                {"path": "/bin/true", "recipe_hint": "demo"},
                ctx,
            )
            self.assertEqual(opened["status"], "success")
            session_id = opened["data"]["session_id"]
            transcript_path = Path(opened["data"]["transcript_path"])
            self.assertTrue(transcript_path.exists())

            for idx, kind in enumerate(["probe", "leak", "control", "exec"]):
                res = call_verb(
                    "pwn.append_event",
                    {
                        "session_id": session_id,
                        "kind": kind,
                        "payload": {"step": idx, "addr": f"0x{idx:08x}"},
                    },
                    ctx,
                )
                self.assertEqual(res["status"], "recorded")
                self.assertEqual(res["data"]["kind"], kind)

            closed = call_verb(
                "pwn.close_session",
                {
                    "session_id": session_id,
                    "summary": {"outcome": "shell_obtained", "payload_bytes": 64},
                },
                ctx,
            )
            self.assertEqual(closed["status"], "closed")
            self.assertEqual(closed["data"]["events_count"], 4)
            summary_path = Path(closed["data"]["summary_path"])
            self.assertTrue(summary_path.exists())
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["events_count"], 4)
            self.assertEqual(summary["summary"]["outcome"], "shell_obtained")

            append_after_close = call_verb(
                "pwn.append_event",
                {"session_id": session_id, "kind": "extra", "payload": {}},
                ctx,
            )
            self.assertEqual(append_after_close["status"], "error")

            lines = transcript_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 4)
            entries = [json.loads(line) for line in lines]
            self.assertEqual([e["kind"] for e in entries], ["probe", "leak", "control", "exec"])


class CtfTraceTests(unittest.TestCase):
    def test_call_writes_trace_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = {"cwd": tmp, "run_dir": tmp}
            res = call_verb(
                "pwn.identify_libc",
                {"leaks": [{"name": "system", "address": "0x7ffff7c55410"}]},
                ctx,
            )
            self.assertEqual(res["status"], "success")
            trace = Path(tmp) / "ctf_verb_trace.jsonl"
            self.assertTrue(trace.exists())
            entries = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(entries[0]["verb"], "pwn.identify_libc")
            self.assertEqual(entries[0]["category"], "pwn")

    def test_unknown_verb_returns_structured_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = {"cwd": tmp, "run_dir": tmp}
            res = call_verb("pwn.nonesuch", {}, ctx)
            self.assertEqual(res["status"], "error")
            self.assertIn("available_verbs", res)

    def test_missing_required_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = {"cwd": tmp, "run_dir": tmp}
            res = call_verb("pwn.inspect_binary", {}, ctx)
            self.assertEqual(res["status"], "error")
            self.assertIn("missing required args", res["error"])


class CtfRecommenderTests(unittest.TestCase):
    def test_build_context_flags_pwn_task_and_recommends_verbs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "vuln").write_bytes(b"\x7fELF" + b"\x00" * 200)
            context = build_ctf_verb_context(
                "heap exploit with tcache, glibc 2.31 ret2libc",
                project_root=tmp,
                enabled=True,
            )
            self.assertTrue(context["is_pwn_or_re_task"])
            verbs = context["recommended_verbs"]
            self.assertIn("pwn.inspect_binary", verbs)
            self.assertIn("pwn.identify_libc", verbs)

    def test_format_prompt_mentions_session_recorder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "vuln").write_bytes(b"\x7fELF" + b"\x00" * 200)
            context = build_ctf_verb_context(
                "kernel exploit via modprobe_path, heap + heap spray",
                project_root=tmp,
                enabled=True,
            )
            prompt = format_ctf_verb_prompt(context)
            self.assertIn("ctf_verb_call", prompt)
            self.assertIn("pwn.open_session", prompt)

    def test_record_success_persists_used_verbs(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory = Path(tmp) / "memory"
            parent = SimpleNamespace(
                ctf_verbs_enabled=True,
                ctf_verbs_used=[
                    {"verb": "pwn.inspect_binary", "status": "success", "trace_id": "ct_1"},
                ],
                ctf_sessions_used=[
                    {"session_id": "psn_x", "outcome": "shell_obtained", "events_count": 6},
                ],
                ctf_verb_context={
                    "digest": "abc",
                    "traits": ["heap_exploit"],
                    "binary_paths": ["/tmp/vuln"],
                },
            )
            with patch.dict(
                "os.environ",
                {"SECHEUR_CTF_VERB_MEMORY_DIR": str(memory)},
                clear=False,
            ):
                result = record_success(
                    parent=parent,
                    handler=SimpleNamespace(),
                    oracle_result={"correct": True, "attempt": 1},
                )
            self.assertEqual(result["status"], "recorded")
            self.assertTrue((memory / "ctf_verb_success_cases.jsonl").exists())
            rules_text = (memory / "ctf_verb_rules.jsonl").read_text(encoding="utf-8")
            self.assertIn("pwn.inspect_binary", rules_text)
            self.assertIn("shell_obtained", rules_text)


if __name__ == "__main__":
    unittest.main()
