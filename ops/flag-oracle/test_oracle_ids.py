"""Offline Oracle regression tests; never touches production answers or quota."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from unittest import mock

import server
import sync_from_ctf_field as sync
import secheur_verify_proxy as proxy


IDS = (
    "nyu/development/2013/CSAW-Quals/misc/Networking 2",
    "nyu/development/2013/CSAW-Quals/web/Guess Harder",
    "nyu/test/2018/CSAW-Quals/pwn/get_it?",
    "nyu/test/2022/CSAW-Finals/crypto/The Lengths we Extend Ourselves",
    "cybench/benchmark/hackthebox/cyber-apocalypse-2024/web/[Very Easy] Flag Command",
)


class OracleIdTests(unittest.TestCase):
    def test_field_ids_round_trip_in_isolated_db(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server.FlagOracleStore(Path(directory) / "oracle.sqlite3", "fixture-secret-at-least-sixteen")
            for index, challenge_id in enumerate(IDS):
                flag = f"fixture{{{index}}}"
                store.set_challenge(server.Challenge(challenge_id), [flag])
                result = store.verify(
                    challenge_id, flag, agent_id="fixture", run_id="fixture", record_mode="baseline"
                )
                self.assertEqual(result["status"], "correct")
                self.assertIsNone(result["attemptId"])

    def test_rejects_nonprintable_and_oversized_ids(self):
        for challenge_id in ("", "bad\nname", "bad\x00name", "x" * 201):
            with self.subTest(challenge_id=repr(challenge_id)):
                with self.assertRaises(ValueError):
                    server.normalize_challenge_id(challenge_id)

    def test_multiflag_sync_never_puts_answers_in_process_args(self):
        answers = ["fixture{first}", "fixture{second}"]
        with mock.patch.object(sync.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{"ok":true}'
            run.return_value.stderr = ""
            sync.set_challenge(
                oracle_py=Path("/python"), oracle_server=Path("/server.py"),
                db=Path("/fixture.sqlite3"), secret="fixture-secret-at-least-sixteen",
                challenge_id=IDS[-1], title="fixture", benchmark="fixture",
                category="fixture", difficulty="fixture", flags=answers, dry_run=False,
            )
            args, kwargs = run.call_args
            self.assertNotIn("fixture{", " ".join(args[0]))
            self.assertIn("--flags-json-stdin", args[0])
            self.assertEqual(json.loads(kwargs["input"]), answers)

    def test_cli_accepts_multiple_flags_from_json_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "oracle.sqlite3"
            flags = ["fixture{first}", "fixture{second}"]
            with mock.patch.dict("server.os.environ", {"CTF_ORACLE_SECRET": "fixture-secret-at-least-sixteen"}), mock.patch(
                "server.sys.stdin", io.StringIO(json.dumps(flags))
            ), mock.patch("server.sys.stdout", new_callable=io.StringIO):
                server.main(["--db", str(db), "set-challenge", "--id", IDS[-1], "--flags-json-stdin"])
            store = server.FlagOracleStore(db, "fixture-secret-at-least-sixteen")
            for flag in flags:
                result = store.verify(IDS[-1], flag, agent_id="fixture", run_id="fixture", record_mode="baseline")
                self.assertEqual(result["status"], "correct")

    def test_proxy_reports_oracle_bad_request_without_false_quota_result(self):
        state = proxy.State("http://127.0.0.1:18181", "fixture-token")
        with mock.patch.object(proxy, "urlopen", side_effect=HTTPError("fixture", 400, "bad request", {}, None)):
            result = state.verify({
                "challenge_id": IDS[0], "flag": "fixture{candidate}",
                "agent_id": "fixture", "run_id": "fixture",
            })
        self.assertEqual(result, {"ok": False, "status": "invalid_request"})


if __name__ == "__main__":
    unittest.main()
