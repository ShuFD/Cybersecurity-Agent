import unittest

from ctf_attack_memory.knowledge import EvidenceSpan, KnowledgeCard
from ctf_attack_memory.quality import clean_crypto_cards, clean_pwn_records
from ctf_attack_memory.schema import AttackMemoryRecord


class AttackMemoryQualityTests(unittest.TestCase):
    def test_pwn_summary_with_inherited_labels_is_rejected(self):
        record = AttackMemoryRecord(
            id="summary",
            event="",
            challenge="🤖 本文的AI摘要",
            source_title="🤖 本文的AI摘要",
            category="pwn",
            crypto_type=["glibc heap"],
            attack_pattern=["house of force", "house of spirit"],
            text_chunk="This article summarizes House of Force and House of Spirit techniques.",
            code_snippet="",
            source_url="https://example.test/overview",
        )

        candidates, rejected, report = clean_pwn_records([record])

        self.assertEqual(candidates, [])
        self.assertEqual(report.rejected, 1)
        self.assertIn("generic_or_summary_title", rejected[0]["reasons"])

    def test_pwn_record_is_reclassified_to_one_primary_pattern(self):
        record = AttackMemoryRecord(
            id="tcache",
            event="Demo CTF",
            challenge="heap-notes",
            source_title="heap-notes",
            category="pwn",
            crypto_type=["heap"],
            attack_pattern=["house of force"],
            text_chunk="Use-after-free lets us poison the tcache freelist; overwrite next then allocate the target.",
            code_snippet="edit(idx, target)\ncreate(size)",
            source_url="https://example.test/tcache",
        )

        candidates, rejected, _report = clean_pwn_records([record])

        self.assertEqual(rejected, [])
        self.assertEqual(candidates[0].attack_pattern, ["tcache poisoning"])

    def test_generic_crypto_card_is_not_published(self):
        card = KnowledgeCard(
            id="draft",
            title="Crypto: crc linear forgery",
            category="crypto",
            attack_family="crc linear forgery",
            primitive=["Hash/MAC"],
            preconditions=["The challenge exposes the attack-specific relation described by this method."],
            steps=["Extract the exact parameters and equations for the named attack."],
            failure_modes=["Unknown assumptions."],
            evidence=[EvidenceSpan(source_id="e", source_url="https://example.test", locator="test", content_hash="hash")],
            claims=[],
            source_record_ids=["e"],
        )

        published, rejected, report = clean_crypto_cards([card])

        self.assertEqual(published, [])
        self.assertEqual(report.rejected, 1)
        self.assertIn("generic_preconditions", rejected[0]["reasons"])
        self.assertIn("generic_steps", rejected[0]["reasons"])


if __name__ == "__main__":
    unittest.main()
