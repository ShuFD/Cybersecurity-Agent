"""Host input admission tests; synthetic files only, no worker or model calls."""
import hashlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

if sys.platform == "win32":
    def unavailable_lock(*args):
        raise AssertionError("These tests never acquire process locks")
    sys.modules.setdefault("fcntl", types.SimpleNamespace(flock=unavailable_lock, LOCK_EX=2, LOCK_NB=4, LOCK_UN=8))

from sandbox_eval_controller import RunSandbox, copy_scoped_attachments, validate_required_attachments


def entry(path="input.bin", content=b"synthetic input"):
    return {"path": path, "sha256": hashlib.sha256(content).hexdigest()}


class InputManifestTests(unittest.TestCase):
    def test_missing_requirements_are_unknown_and_empty_delivery_is_allowed(self):
        self.assertEqual(validate_required_attachments({"attachments": []}),
                         {"requirements": "not_declared", "deliveredCount": 0})
        self.assertEqual(validate_required_attachments({"attachments": [], "requiredAttachments": []}),
                         {"requirements": "verified", "requiredCount": 0, "deliveredCount": 0})

    def test_required_attachment_not_delivered_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "required_input_missing"):
            validate_required_attachments({"attachments": [], "requiredAttachments": [entry()]})

    def test_requirement_hash_must_match_delivery_manifest(self):
        with self.assertRaisesRegex(ValueError, "required_input_mismatch"):
            validate_required_attachments({"attachments": [entry(content=b"other")],
                                           "requiredAttachments": [entry()]})

    def test_requirement_subset_allows_extra_declared_files(self):
        result = validate_required_attachments({"attachments": [entry(), entry("extra.bin")],
                                                "requiredAttachments": [entry()]})
        self.assertEqual(result, {"requirements": "verified", "requiredCount": 1, "deliveredCount": 2})

    def test_invalid_paths_and_duplicate_aliases_are_rejected(self):
        for path in ("../input", "/input", "C:/input", "dir\\input", "input\0", "."):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "input_manifest_invalid"):
                validate_required_attachments({"attachments": [entry(path)]})
        with self.assertRaisesRegex(ValueError, "input_manifest_invalid"):
            validate_required_attachments({"attachments": [entry("dir/input"), entry("dir//input")]})

    def test_malformed_manifests_fail_instead_of_becoming_empty(self):
        for scope in ({}, {"attachments": None}, {"attachments": "file"},
                      {"attachments": [{}]}, {"attachments": [{"path": "file", "sha256": "not-a-digest"}]},
                      {"attachments": [], "requiredAttachments": "file"}):
            with self.subTest(scope=scope), self.assertRaisesRegex(ValueError, "input_manifest_invalid"):
                validate_required_attachments(scope)

    def test_real_copied_bytes_must_match_the_pinned_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "input.bin").write_bytes(b"synthetic input")
            scope = {"attachmentRoot": str(source), "attachments": [entry()], "requiredAttachments": [entry()]}
            records = copy_scoped_attachments(scope, root / "worker")
            self.assertEqual(records[0]["sha256"], entry()["sha256"])
            self.assertEqual((root / "worker/input.bin").read_bytes(), b"synthetic input")
            (source / "input.bin").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "frozen manifest"):
                copy_scoped_attachments(scope, root / "changed-worker")


class AdmissionBeforeWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_confirmed_missing_input_never_starts_worker_or_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            scope = {"attachments": [], "requiredAttachments": [entry()], "targetUrl": ""}
            sandbox = RunSandbox({"privateRoot": temporary, "scopes": {"fixture": scope}},
                                 object(), "fixture", "synthetic-run")
            sandbox.node = AsyncMock()
            with self.assertRaisesRegex(ValueError, "required_input_missing"):
                await sandbox.start({"run_id": "synthetic-run", "target_url": ""})
            sandbox.node.assert_not_called()
            self.assertIsNone(sandbox.bridge)
            self.assertFalse(sandbox.admitted)
            self.assertFalse(sandbox.root.exists())
            self.assertEqual(sandbox.input_admission, {"status": "rejected", "reason": "required_input_missing"})


if __name__ == "__main__":
    unittest.main()
