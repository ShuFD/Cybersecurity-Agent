import unittest

from ctf_attack_memory.pwn_seed import local_pwn_seed_candidates


class PwnSeedTests(unittest.TestCase):
    def test_local_seeds_are_challenge_bound_candidates(self):
        cards = local_pwn_seed_candidates()

        self.assertGreaterEqual(len(cards), 3)
        for card in cards:
            self.assertTrue(card.event)
            self.assertTrue(card.challenge)
            self.assertTrue(card.glibc_versions)
            self.assertTrue(card.vulnerability_primitives)
            self.assertGreaterEqual(len(card.exploit_steps), 2)
            self.assertEqual(card.review_status, "candidate")
            self.assertTrue(card.source_url.startswith("file://"))


if __name__ == "__main__":
    unittest.main()
