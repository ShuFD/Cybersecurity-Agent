import json
import tempfile
import unittest
from pathlib import Path

from agent_loop import get_tool_meta
from ctf_attack_memory.index import build_index
from ctf_attack_memory.schema import AttackMemoryRecord
from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False
    memoryReferenceEnabled = False
    knowledgeBaseEnabled = True


class MemorySearchIntegrationTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_do_memory_search_returns_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            memory_dir.mkdir()
            (memory_dir / "web_setup_sop.md").write_text("Browser setup uses CDP bridge.\n", encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            output, outcome = self._run_generator(handler.do_memory_search({"query": "cdp browser"}, None))

        self.assertIn("web_setup_sop.md", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["matches"][0]["path"], "web_setup_sop.md")
        self.assertIn("Browser setup", outcome.next_prompt)

    def test_do_memory_search_is_read_only_and_parallel_safe(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")

        meta = get_tool_meta(handler, "memory_search")

        self.assertTrue(meta.read_only)
        self.assertTrue(meta.concurrency_safe)

    def test_do_memory_search_reports_no_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = Path(tmp) / "memory"
            handler.memory_dir.mkdir()

            output, outcome = self._run_generator(handler.do_memory_search({"query": "missing"}, None))

        self.assertIn("No memory matched", output)
        self.assertEqual(outcome.data["status"], "not_found")

    def test_do_memory_search_does_not_include_attack_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        category="pwn",
                        event="Pwn CTF",
                        challenge="heap notes",
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning"],
                        text_chunk="glibc tcache poisoning controls the freelist.",
                        code_snippet="free(a); free(a);",
                        source_url="https://example.test/pwn",
                    )
                ],
                memory_dir / "attack_memory" / "pwn_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            output, outcome = self._run_generator(
                handler.do_memory_search({"query": "glibc tcache poisoning"}, None)
            )

        self.assertIn("No memory matched", output)
        self.assertEqual(outcome.data["status"], "not_found")

    def test_do_memory_search_filters_matches_denied_by_read_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memory"
            memory_dir.mkdir()
            (memory_dir / "public_sop.md").write_text("CDP browser public note.\n", encoding="utf-8")
            (memory_dir / "private_sop.md").write_text("CDP browser private secret.\n", encoding="utf-8")
            settings = root / "settings.json"
            settings.write_text('{"permissions": {"deny": ["Read(*private*)"]}}', encoding="utf-8")
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir
            handler.permission_settings_paths = [settings]

            output, outcome = self._run_generator(handler.do_memory_search({"query": "cdp browser", "limit": 5}, None))

        self.assertIn("public_sop.md", output)
        self.assertNotIn("private_sop.md", output)
        self.assertNotIn("private secret", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["permission_skipped"], 1)

    def test_do_attack_memory_search_returns_pwn_index_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        category="pwn",
                        event="Pwn CTF",
                        challenge="heap notes",
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning", "double free"],
                        text_chunk="glibc tcache poisoning after a double free controls the freelist.",
                        code_snippet="free(a); free(a);",
                        source_url="https://example.test/pwn",
                    )
                ],
                memory_dir / "attack_memory" / "pwn_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            output, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {"query": "glibc heap tcache poisoning double free"}, None
                )
            )

        self.assertIn("heap notes", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(
            outcome.data["matches"][0]["path"],
            "attack_memory/pwn_v1/records.jsonl",
        )
        self.assertEqual(outcome.data["quality"]["status"], "accepted")
        self.assertEqual(outcome.data["matches"][0]["category"], "pwn")
        self.assertIn("recognition_signals", outcome.data["matches"][0])
        self.assertIn("failure_modes", outcome.data["matches"][0])
        self.assertEqual(
            outcome.data["knowledge_packet"][0]["record_id"],
            outcome.data["matches"][0]["record_id"],
        )
        self.assertIn("attack_steps", outcome.data["knowledge_packet"][0])

    def test_do_attack_memory_search_honors_explicit_category(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        category="crypto",
                        event="Crypto CTF",
                        challenge="small exponent",
                        crypto_type=["RSA"],
                        attack_pattern=["rsa small exponent eth root"],
                        text_chunk="RSA e=3 with a small plaintext uses an integer cube root.",
                        code_snippet="m = iroot(c, 3)[0]",
                        source_url="https://example.test/crypto",
                    )
                ],
                memory_dir / "attack_memory" / "crypto_v1",
            )
            build_index(
                [
                    AttackMemoryRecord(
                        category="pwn",
                        event="Pwn CTF",
                        challenge="heap notes",
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning", "double free"],
                        text_chunk="Tcache poisoning after a double free controls a freelist.",
                        code_snippet="free(a); free(a);",
                        source_url="https://example.test/pwn",
                    )
                ],
                memory_dir / "attack_memory" / "pwn_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            _, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {
                        "query": "RSA e=3 tcache poisoning double free",
                        "category": "crypto",
                    },
                    None,
                )
            )

        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(outcome.data["categories"], ["crypto"])
        self.assertEqual({item["category"] for item in outcome.data["matches"]}, {"crypto"})

    def test_do_attack_memory_search_withholds_ambiguous_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        category="reverse",
                        event="Reverse CTF",
                        challenge="checksum verifier",
                        crypto_type=["binary-analysis"],
                        attack_pattern=["recover checksum"],
                        text_chunk="Inspect the checksum verifier routine.",
                        code_snippet="",
                        source_url="https://example.test/reverse",
                    )
                ],
                memory_dir / "attack_memory" / "reverse_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            output, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {"query": "checksum verifier", "category": "reverse"},
                    None,
                )
            )

        self.assertIn("no high-confidence technique card", output)
        self.assertEqual(outcome.data["status"], "not_found")
        self.assertEqual(outcome.data["quality"]["status"], "ambiguous")
        self.assertEqual(outcome.data["matches"], [])
        self.assertEqual(outcome.data["knowledge_packet"], [])
        self.assertEqual(outcome.data["candidates"][0]["quality_status"], "ambiguous")

    def test_do_attack_memory_search_rejects_unknown_category(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")

        output, outcome = self._run_generator(
            handler.do_attack_memory_search(
                {"query": "firmware", "category": "hardware"},
                None,
            )
        )

        self.assertIn("Unsupported attack memory category", output)
        self.assertEqual(outcome.data["status"], "error")

    def test_bundled_attack_memory_accepts_required_runtime_queries(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        handler.memory_dir = Path(__file__).resolve().parents[1] / "memory"
        cases = (
            ("web", "exploit this command injection vulnerability"),
            ("web", "bypass this CSRF protection"),
            ("web", "exploit this SQL injection vulnerability"),
            ("pwn", "exploit this use-after-free vulnerability"),
            ("reverse", "reverse this crackme"),
            ("crypto", "factor this RSA modulus with close prime factors"),
        )

        for category, query in cases:
            with self.subTest(category=category, query=query):
                _, outcome = self._run_generator(
                    handler.do_attack_memory_search(
                        {"query": query, "category": category, "top_k": 5},
                        None,
                    )
                )
                self.assertEqual(outcome.data["status"], "success")
                self.assertEqual(outcome.data["quality"]["status"], "accepted")
                self.assertTrue(outcome.data["knowledge_packet"])
                self.assertEqual(
                    {item["category"] for item in outcome.data["matches"]},
                    {category},
                )

    def test_bundled_attack_memory_accepts_chinese_family_queries(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        handler.memory_dir = Path(__file__).resolve().parents[1] / "memory"
        cases = (
            ("web", "\u547d\u4ee4\u6ce8\u5165"),
            ("web", "\u8de8\u7ad9\u8bf7\u6c42\u4f2a\u9020"),
            ("pwn", "\u91ca\u653e\u540e\u91cd\u7528"),
            ("reverse", "\u6ce8\u518c\u7801"),
        )

        for category, query in cases:
            with self.subTest(category=category, query=query):
                _, outcome = self._run_generator(
                    handler.do_attack_memory_search(
                        {"query": query, "category": category, "top_k": 1},
                        None,
                    )
                )
                self.assertEqual(outcome.data["status"], "success")
                self.assertEqual(outcome.data["matches"][0]["category"], category)

    def test_generic_rsa_factorization_withholds_unconfirmed_draft_card(self):
        handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
        handler.memory_dir = Path(__file__).resolve().parents[1] / "memory"

        _, generic = self._run_generator(
            handler.do_attack_memory_search(
                {"query": "factor this RSA modulus", "category": "crypto"},
                None,
            )
        )
        _, conflicting = self._run_generator(
            handler.do_attack_memory_search(
                {
                    "query": "factor this RSA modulus; its prime factors are far apart",
                    "category": "crypto",
                },
                None,
            )
        )

        self.assertEqual(generic.data["status"], "not_found")
        fermat = next(
            item for item in generic.data["candidates"]
            if "fermat" in str(item.get("label") or "").lower()
        )
        self.assertEqual(fermat["quality_status"], "ambiguous")
        self.assertIn("review_status_draft", fermat["quality"]["reasons"])
        self.assertIn("unconfirmed_preconditions", fermat["quality"]["reasons"])

        conflicting_fermat = next(
            item for item in conflicting.data["candidates"]
            if "fermat" in str(item.get("label") or "").lower()
        )
        self.assertEqual(conflicting_fermat["quality_status"], "rejected")
        self.assertIn(
            "close_prime_precondition_conflict",
            conflicting_fermat["quality"]["reasons"],
        )

    def test_quality_gate_filters_after_a_wider_candidate_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        id="missing-source",
                        category="pwn",
                        event="Pwn CTF",
                        challenge="tcache poisoning " * 20,
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning"],
                        text_chunk="tcache poisoning controls the freelist " * 20,
                        code_snippet="free(a)",
                        source_url="",
                    ),
                    AttackMemoryRecord(
                        id="usable-source",
                        category="pwn",
                        event="Pwn CTF",
                        challenge="heap notes",
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning"],
                        text_chunk="Tcache poisoning controls the freelist.",
                        code_snippet="free(a)",
                        source_url="https://example.test/usable",
                    ),
                ],
                memory_dir / "attack_memory" / "pwn_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            _, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {"query": "tcache poisoning", "category": "pwn", "top_k": 1},
                    None,
                )
            )

        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(
            [item["record_id"] for item in outcome.data["matches"]],
            ["usable-source"],
        )
        rejected = next(
            item for item in outcome.data["candidates"]
            if item["record_id"] == "missing-source"
        )
        self.assertEqual(rejected["quality_status"], "rejected")

    def test_runtime_packet_has_contract_fields_and_a_hard_size_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            long_text = "X" * 500
            build_index(
                [
                    AttackMemoryRecord(
                        id="large-card",
                        category="pwn",
                        event="Pwn CTF",
                        challenge="heap notes " + ("C" * 1000),
                        crypto_type=["glibc heap"],
                        attack_pattern=["tcache poisoning"],
                        text_chunk=(
                            f"## Recognition signals\n- {long_text}\n"
                            f"## Attack method\n1. {long_text}\n2. {long_text}\n"
                            f"## Failure modes\n- {long_text}\n"
                        ),
                        code_snippet="A" * 4000,
                        source_url="https://example.test/" + ("s" * 1500),
                    )
                ],
                memory_dir / "attack_memory" / "pwn_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            _, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {
                        "query": "glibc heap tcache poisoning",
                        "category": "pwn",
                        "top_k": 1,
                        "include_full_record": True,
                    },
                    None,
                )
            )

        self.assertEqual(outcome.data["status"], "success")
        packet = outcome.data["knowledge_packet"]
        self.assertLessEqual(
            len(json.dumps(packet, ensure_ascii=False, separators=(",", ":"))),
            9000,
        )
        self.assertTrue(packet[0]["label"])
        self.assertTrue(packet[0]["attack_pattern"])
        self.assertTrue(packet[0].get("source_urls") or packet[0]["source_url"])

    def test_do_attack_memory_search_requires_its_independent_switch(self):
        parent = DummyParent()
        parent.memoryReferenceEnabled = True
        parent.knowledgeBaseEnabled = False
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        output, outcome = self._run_generator(
            handler.do_attack_memory_search({"query": "tcache poisoning"}, None)
        )

        message = "Attack knowledge base is disabled. Enable it before using attack_memory_search."
        self.assertEqual(output, message + "\n")
        self.assertEqual(outcome.data, {"status": "error", "msg": message})

    def test_do_attack_memory_search_returns_reverse_index_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp) / "memory"
            build_index(
                [
                    AttackMemoryRecord(
                        category="reverse",
                        event="Reverse CTF",
                        challenge="ELF triage",
                        crypto_type=["binary-triage"],
                        attack_pattern=["file checksec", "strings symbols"],
                        text_chunk="ELF static triage uses file, checksec, strings, and symbols.",
                        code_snippet="file target; checksec --file target; strings target",
                        source_url="https://example.test/reverse",
                    )
                ],
                memory_dir / "attack_memory" / "reverse_v1",
            )
            handler = SecHeurAgentHandler(DummyParent(), [], cwd="./temp")
            handler.memory_dir = memory_dir

            output, outcome = self._run_generator(
                handler.do_attack_memory_search(
                    {"query": "ELF static triage strings symbols"}, None
                )
            )

        self.assertIn("ELF triage", output)
        self.assertEqual(outcome.data["status"], "success")
        self.assertEqual(
            outcome.data["matches"][0]["path"],
            "attack_memory/reverse_v1/records.jsonl",
        )


if __name__ == "__main__":
    unittest.main()
