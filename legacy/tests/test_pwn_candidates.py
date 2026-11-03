import unittest

from ctf_attack_memory.pwn_cards import extract_pwn_candidates
from ctf_attack_memory.schema import AttackMemoryRecord


class PwnCandidateTests(unittest.TestCase):
    def test_extracts_challenge_bound_candidate_with_required_fields(self):
        record = AttackMemoryRecord(
            id="demo",
            event="Demo CTF 2024",
            challenge="allocator",
            category="pwn",
            crypto_type=["glibc heap"],
            attack_pattern=["tcache poisoning"],
            text_chunk=(
                "On glibc 2.31, a use-after-free lets us leak the heap base. "
                "We free controlled chunks, poison the tcache next pointer, allocate the target, "
                "then trigger free()."
            ),
            code_snippet="free(a)\nedit(a, target)\nmalloc(size)",
            source_url="https://example.test/demo",
        )

        cards, rejected = extract_pwn_candidates([record])

        self.assertEqual(rejected, [])
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0].challenge, "allocator")
        self.assertEqual(cards[0].glibc_versions, ["glibc 2.31"])
        self.assertEqual(cards[0].vulnerability_primitives, ["use-after-free"])
        self.assertGreaterEqual(len(cards[0].exploit_steps), 2)

    def test_rejects_record_missing_challenge_or_glibc_constraint(self):
        record = AttackMemoryRecord(
            id="bad",
            event="",
            challenge="overview",
            category="pwn",
            crypto_type=["heap"],
            attack_pattern=["tcache poisoning"],
            text_chunk="Use-after-free can poison tcache and overwrite a pointer.",
            code_snippet="",
            source_url="https://example.test/bad",
        )

        cards, rejected = extract_pwn_candidates([record])

        self.assertEqual(cards, [])
        self.assertIn("missing_challenge_name", rejected[0]["reasons"])
        self.assertIn("missing_glibc_version_constraint", rejected[0]["reasons"])


if __name__ == "__main__":
    unittest.main()
