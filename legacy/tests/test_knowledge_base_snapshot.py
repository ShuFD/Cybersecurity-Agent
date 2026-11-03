import json
import tempfile
import unittest
from pathlib import Path

from ctf_attack_memory.index import KNOWLEDGE_CARDS_FILE, MANIFEST_FILE, knowledge_base_snapshot


class KnowledgeBaseSnapshotTests(unittest.TestCase):
    def _write_index(self, root: Path, name: str, *, record_count: int, cards: str) -> Path:
        directory = root / "attack_memory" / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / MANIFEST_FILE).write_text(
            json.dumps({"schema_version": "attack-memory-index.v1", "record_count": record_count}),
            encoding="utf-8",
        )
        target = directory / KNOWLEDGE_CARDS_FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(cards, encoding="utf-8")
        return directory

    def test_fingerprint_covers_every_category_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_index(root, "crypto_v1", record_count=10, cards='{"id":"a"}\n')
            self._write_index(root, "web_v1", record_count=4, cards='{"id":"b"}\n')

            snapshot = knowledge_base_snapshot(root)

            self.assertEqual(snapshot["schema_version"], "attack-memory-index.v1")
            self.assertEqual(snapshot["record_count"], 14)
            self.assertEqual(snapshot["categories"], ["crypto_v1", "web_v1"])
            self.assertEqual(snapshot["card_fingerprint"], knowledge_base_snapshot(root)["card_fingerprint"])

    def test_fingerprint_changes_when_one_category_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_index(root, "crypto_v1", record_count=10, cards='{"id":"a"}\n')
            self._write_index(root, "web_v1", record_count=4, cards='{"id":"b"}\n')
            before = knowledge_base_snapshot(root)["card_fingerprint"]

            self._write_index(root, "web_v1", record_count=5, cards='{"id":"b"}\n{"id":"c"}\n')
            after = knowledge_base_snapshot(root)["card_fingerprint"]

            # An ablation report can only claim a fixed corpus while this holds.
            self.assertNotEqual(before, after)

    def test_missing_corpus_reports_nothing_rather_than_a_placeholder(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(knowledge_base_snapshot(Path(tmp) / "absent"), {})

    def test_counts_a_category_that_ships_cards_without_a_manifest(self):
        # Crypto publishes cards only, with no manifest; a snapshot that ignored
        # it would understate the corpus an agent can actually search.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "attack_memory" / "crypto_v1"
            cards = directory / KNOWLEDGE_CARDS_FILE
            cards.parent.mkdir(parents=True)
            cards.write_text('{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n', encoding="utf-8")
            (directory / MANIFEST_FILE).unlink(missing_ok=True)

            snapshot = knowledge_base_snapshot(root)

            self.assertEqual(snapshot["record_count"], 3)
            self.assertEqual(snapshot["categories"], ["crypto_v1"])
            self.assertIn("card_fingerprint", snapshot)


if __name__ == "__main__":
    unittest.main()
