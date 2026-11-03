import unittest

from ctf_attack_memory.distill import distill_crypto_records
from ctf_attack_memory.schema import AttackMemoryRecord


class CryptoDistillationTests(unittest.TestCase):
    def _record(self, record_id, text, *, source_url, code="", gate_score=4.0):
        return AttackMemoryRecord(
            id=record_id,
            event="Demo CTF",
            challenge="demo",
            category="crypto",
            crypto_type=["RSA"],
            attack_pattern=["rsa small exponent eth root"],
            text_chunk=text,
            code_snippet=code,
            source_url=source_url,
            gate_score=gate_score,
        )

    def test_distillation_rejects_a_label_without_actionable_evidence(self):
        cards, report = distill_crypto_records(
            [
                self._record(
                    "label-only",
                    "RSA e=3 small exponent cube root is a known attack.",
                    source_url="https://example.test/label",
                )
            ]
        )

        self.assertEqual(cards, [])
        self.assertEqual(report.eligible_records, 0)
        self.assertEqual(report.rejected_records, 1)

    def test_distillation_keeps_bounded_distinct_evidence_and_concrete_steps(self):
        records = [
            self._record(
                "one",
                "For RSA e=3, compute the integer cube root then verify pow(m, e, n) == c.",
                source_url="https://example.test/one",
                code="m = iroot(c, 3)[0]",
            ),
            self._record(
                "duplicate-url",
                "RSA e=3 compute the integer cube root and verify the result.",
                source_url="https://example.test/one",
                code="m = iroot(c, 3)[0]",
            ),
            self._record(
                "two",
                "Solve RSA e=3 by an exact cube root; re-encrypt the candidate to verify it.",
                source_url="https://example.test/two",
            ),
            self._record(
                "three",
                "Recover the plaintext with the integer cube root for RSA e=3 and verify it.",
                source_url="https://example.test/three",
            ),
            self._record(
                "four",
                "Compute the integer cube root of RSA e=3 ciphertext and verify the plaintext.",
                source_url="https://example.test/four",
            ),
        ]

        cards, report = distill_crypto_records(records)

        self.assertEqual(report.cards_created, 1)
        self.assertEqual(len(cards[0].evidence), 3)
        self.assertEqual(len(cards[0].source_record_ids), 3)
        self.assertIn("Compute the exact integer e-th root of c.", cards[0].steps)
        self.assertNotIn("Identify the observable", " ".join(cards[0].steps))


if __name__ == "__main__":
    unittest.main()
