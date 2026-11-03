import json
import os
import tempfile
import time
import unittest
import warnings
from pathlib import Path
from unittest import mock

import session_resume
from runtime_session_log import (
    SessionCompactBoundary,
    SessionLogEvent,
    append_session_event,
    legacy_session_log_sidecar_path,
    session_log_sidecar_path,
)
from session_resume import (
    extract_last_history_block,
    format_resume_list,
    list_session_logs,
    list_restorable_sessions,
    restore_history_from_log,
    restore_latest_history,
)


class SessionResumeTests(unittest.TestCase):
    def _write_log(self, path, content, mtime=None):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def test_list_session_logs_returns_newest_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_dir = Path(tmp)
            older = self._write_log(log_dir / "model_responses_1.txt", "old", mtime=time.time() - 20)
            newer = self._write_log(log_dir / "model_responses_2.txt", "new", mtime=time.time() - 5)

            logs = list_session_logs(log_dir)

            self.assertEqual([log.path for log in logs], [newer, older])

    def test_extract_last_history_block_handles_escaped_newlines(self):
        with tempfile.TemporaryDirectory() as tmp:
            text = json.dumps(
                {
                    "content": [
                        {"type": "text", "text": "prefix\\n<history>first</history>"},
                        {"type": "text", "text": "later\\n<history>second\\nline</history>"},
                    ]
                },
                ensure_ascii=False,
            )
            path = self._write_log(Path(tmp) / "model_responses_1.txt", text)

            self.assertEqual(extract_last_history_block(path), "second\nline")

    def test_restore_history_from_log_prefers_complete_prompt_response_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            response = [{"type": "text", "text": "hi"}]
            path = self._write_log(
                Path(tmp) / "model_responses_1.txt",
                "=== Prompt === 2026-06-01 10:00:00\n"
                + json.dumps(prompt, ensure_ascii=False, indent=2)
                + "\n\n=== Response === 2026-06-01 10:00:01\n"
                + repr(response)
                + "\n\n",
            )

            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                history = restore_history_from_log(path)

            self.assertEqual(history, [prompt, {"role": "assistant", "content": response}])

    def test_legacy_repr_response_pairs_emit_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            response = [{"type": "text", "text": "hi"}]
            path = self._write_log(
                Path(tmp) / "model_responses_1.txt",
                "=== Prompt === 2026-06-01 10:00:00\n"
                + json.dumps(prompt, ensure_ascii=False)
                + "\n\n=== Response === 2026-06-01 10:00:01\n"
                + repr(response)
                + "\n\n",
            )

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                history = restore_history_from_log(path)

            self.assertEqual(history, [prompt, {"role": "assistant", "content": response}])
            self.assertTrue(any("legacy" in str(item.message).lower() for item in caught))

    def test_restore_history_from_log_prefers_json_response_pairs(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            response = [{"type": "text", "text": "hi"}]
            path = self._write_log(
                Path(tmp) / "model_responses_1.txt",
                "=== Prompt === 2026-06-01 10:00:00\n"
                + json.dumps(prompt, ensure_ascii=False, indent=2)
                + "\n\n=== Response === 2026-06-01 10:00:01\n"
                + json.dumps(response, ensure_ascii=False, indent=2)
                + "\n\n",
            )

            history = restore_history_from_log(path)

            self.assertEqual(history, [prompt, {"role": "assistant", "content": response}])

    def test_json_response_pairs_do_not_use_literal_eval(self):
        with tempfile.TemporaryDirectory() as tmp:
            prompt = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            response = [{"type": "text", "text": "hi"}]
            path = self._write_log(
                Path(tmp) / "model_responses_1.txt",
                "=== Prompt === 2026-06-01 10:00:00\n"
                + json.dumps(prompt, ensure_ascii=False)
                + "\n\n=== Response === 2026-06-01 10:00:01\n"
                + json.dumps(response, ensure_ascii=False)
                + "\n\n",
            )

            with mock.patch.object(session_resume.ast, "literal_eval", side_effect=AssertionError("literal_eval should not be used")):
                history = restore_history_from_log(path)

            self.assertEqual(history, [prompt, {"role": "assistant", "content": response}])

    def test_restore_history_from_log_falls_back_to_last_working_memory_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_log(
                Path(tmp) / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: old</history>"}\n'
                '{"text": "\\n<history>[USER]: latest\\n[Agent] done</history>"}\n',
            )

            history = restore_history_from_log(path)

            self.assertEqual(len(history), 1)
            self.assertEqual(history[0]["role"], "user")
            self.assertIn("[USER]: latest", history[0]["content"][0]["text"])

    def test_restore_history_from_log_prefers_structured_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "structured hello"}],
                source="desktop",
                ts=1.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=1,
                role="assistant",
                content=[{"type": "text", "text": "structured world"}],
                source="llm",
                ts=2.0,
            ))

            history = restore_history_from_log(text_log)

            self.assertEqual(history, [
                {"role": "user", "content": [{"type": "text", "text": "structured hello"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "structured world"}]},
            ])

    def test_restore_history_from_log_falls_back_to_legacy_structured_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy</history>"}\n',
            )
            jsonl = legacy_session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "legacy structured hello"}],
                source="desktop",
                ts=1.0,
            ))

            history = restore_history_from_log(text_log)

            self.assertEqual(history, [
                {"role": "user", "content": [{"type": "text", "text": "legacy structured hello"}]},
            ])

    def test_restore_history_from_log_falls_back_to_text_when_structured_sidecar_is_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: fallback text history</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            jsonl.parent.mkdir(parents=True, exist_ok=True)
            jsonl.write_text(
                '{"schema_version":1,"type":"message","role":"user","content":"not-list"}\n',
                encoding="utf-8",
            )

            history = restore_history_from_log(text_log)

        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["role"], "user")
        self.assertIn("fallback text history", history[0]["content"][0]["text"])

    def test_restore_history_from_log_skips_bad_structured_lines_when_text_has_no_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                "no recoverable text history\n",
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "structured before corrupt line"}],
                source="desktop",
                ts=1.0,
            ))
            with jsonl.open("a", encoding="utf-8") as f:
                f.write("{bad json\n")
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=2,
                role="assistant",
                content=[{"type": "text", "text": "structured after corrupt line"}],
                source="llm",
                ts=2.0,
            ))

            history = restore_history_from_log(text_log)

        self.assertEqual(history, [
            {"role": "user", "content": [{"type": "text", "text": "structured before corrupt line"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "structured after corrupt line"}]},
        ])

    def test_restore_history_from_structured_log_respects_last_compact_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "old user"}],
                source="desktop",
                ts=1.0,
            ))
            append_session_event(jsonl, SessionCompactBoundary(
                session_id="sess-a",
                turn_id=2,
                summary_content=[{"type": "text", "text": "compact summary"}],
                kept_from_turn_id=2,
                source="compact",
                ts=2.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-a",
                turn_id=3,
                role="assistant",
                content=[{"type": "text", "text": "new assistant"}],
                source="llm",
                ts=3.0,
            ))

            history = restore_history_from_log(text_log)

            self.assertEqual(history, [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "<system-reminder>\ncompact boundary: use the next compact summary for earlier conversation history.\n</system-reminder>",
                        }
                    ],
                    "is_compact_boundary": True,
                },
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "compact summary"}],
                    "is_compact_summary": True,
                },
                {"role": "assistant", "content": [{"type": "text", "text": "new assistant"}]},
            ])

    def test_restore_history_from_structured_log_rebuilds_compacted_message_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                uuid="old-user",
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "old user"}],
                source="llm",
                ts=1.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="old-assistant",
                parent_uuid="old-user",
                session_id="sess-a",
                turn_id=2,
                role="assistant",
                content=[{"type": "text", "text": "old assistant"}],
                source="llm",
                ts=2.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="kept-user",
                parent_uuid="old-assistant",
                session_id="sess-a",
                turn_id=3,
                role="user",
                content=[{"type": "text", "text": "kept user"}],
                source="llm",
                ts=3.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="kept-assistant",
                parent_uuid="kept-user",
                session_id="sess-a",
                turn_id=4,
                role="assistant",
                content=[{"type": "text", "text": "kept assistant"}],
                source="llm",
                ts=4.0,
            ))
            append_session_event(jsonl, SessionCompactBoundary(
                uuid="boundary",
                parent_uuid="kept-assistant",
                kept_from_uuid="kept-user",
                session_id="sess-a",
                turn_id=5,
                summary_content=[{"type": "text", "text": "compact summary"}],
                kept_from_turn_id=3,
                source="compact",
                ts=5.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="new-user",
                parent_uuid="boundary",
                session_id="sess-a",
                turn_id=6,
                role="user",
                content=[{"type": "text", "text": "new user"}],
                source="llm",
                ts=6.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="new-assistant",
                parent_uuid="new-user",
                session_id="sess-a",
                turn_id=7,
                role="assistant",
                content=[{"type": "text", "text": "new assistant"}],
                source="llm",
                ts=7.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="orphan-user",
                parent_uuid="missing-parent",
                session_id="sess-a",
                turn_id=8,
                role="user",
                content=[{"type": "text", "text": "orphan user"}],
                source="llm",
                ts=8.0,
            ))

            history = restore_history_from_log(text_log)

            self.assertEqual(history, [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "<system-reminder>\ncompact boundary: use the next compact summary for earlier conversation history.\n</system-reminder>",
                        }
                    ],
                    "is_compact_boundary": True,
                },
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "compact summary"}],
                    "is_compact_summary": True,
                },
                {"role": "user", "content": [{"type": "text", "text": "kept user"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "kept assistant"}]},
                {"role": "user", "content": [{"type": "text", "text": "new user"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "new assistant"}]},
            ])

    def test_restore_history_from_structured_log_follows_boundary_parent_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            text_log = self._write_log(
                Path(tmp) / "model_responses" / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                uuid="kept-user",
                session_id="sess-a",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "kept user"}],
                source="llm",
                ts=1.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="wrong-branch",
                parent_uuid="kept-user",
                session_id="sess-a",
                turn_id=2,
                role="assistant",
                content=[{"type": "text", "text": "wrong branch"}],
                source="llm",
                ts=2.0,
            ))
            append_session_event(jsonl, SessionLogEvent(
                uuid="right-branch",
                parent_uuid="kept-user",
                session_id="sess-a",
                turn_id=3,
                role="assistant",
                content=[{"type": "text", "text": "right branch"}],
                source="llm",
                ts=3.0,
            ))
            append_session_event(jsonl, SessionCompactBoundary(
                uuid="boundary",
                parent_uuid="right-branch",
                kept_from_uuid="kept-user",
                session_id="sess-a",
                turn_id=4,
                summary_content=[{"type": "text", "text": "compact summary"}],
                kept_from_turn_id=1,
                source="compact",
                ts=4.0,
            ))

            history = restore_history_from_log(text_log)

        packed = json.dumps(history, ensure_ascii=False)
        self.assertIn("right branch", packed)
        self.assertNotIn("wrong branch", packed)

    def test_restore_latest_history_uses_newest_recoverable_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_dir = Path(tmp)
            self._write_log(log_dir / "model_responses_1.txt", "no history", mtime=time.time() - 5)
            recoverable = self._write_log(
                log_dir / "model_responses_2.txt",
                '{"text": "\\n<history>[USER]: recover me</history>"}',
                mtime=time.time() - 20,
            )

            restored = restore_latest_history(log_dir)

            self.assertEqual(restored.path, recoverable)
            self.assertIn("recover me", restored.history[0]["content"][0]["text"])

    def test_restore_latest_history_discovers_jsonl_only_session_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            jsonl = root / "sessions" / "model_responses_1.jsonl"
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-jsonl-only",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "jsonl-only hello"}],
                source="desktop",
                ts=1.0,
            ))

            restored = restore_latest_history(log_dir)

        self.assertEqual(restored.path, jsonl)
        self.assertEqual(restored.history, [
            {"role": "user", "content": [{"type": "text", "text": "jsonl-only hello"}]},
        ])

    def test_restore_latest_history_prefers_structured_sidecar_path_for_text_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            now = time.time()
            text_log = self._write_log(
                log_dir / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy duplicate</history>"}\n',
                mtime=now,
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-sidecar",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "structured latest"}],
                source="desktop",
                ts=1.0,
            ))
            os.utime(jsonl, (now - 100, now - 100))

            restored = restore_latest_history(log_dir)

        self.assertEqual(restored.path, jsonl)
        self.assertEqual(restored.history, [
            {"role": "user", "content": [{"type": "text", "text": "structured latest"}]},
        ])

    def test_restore_latest_history_discovers_arbitrary_session_jsonl_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            jsonl = root / "sessions" / "session-alpha.jsonl"
            append_session_event(jsonl, SessionLogEvent(
                session_id="session-alpha",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "arbitrary jsonl hello"}],
                source="desktop",
                ts=1.0,
            ))

            restored = restore_latest_history(log_dir)

        self.assertEqual(restored.path, jsonl)
        self.assertEqual(restored.history, [
            {"role": "user", "content": [{"type": "text", "text": "arbitrary jsonl hello"}]},
        ])

    def test_format_resume_list_includes_jsonl_only_session_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            jsonl = root / "sessions" / "model_responses_1.jsonl"
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-jsonl-only",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "resume list preview text"}],
                source="desktop",
                ts=1.0,
            ))

            sessions = list_restorable_sessions(log_dir)
            text = format_resume_list(log_dir)

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].path, jsonl)
        self.assertEqual(sessions[0].message_count, 1)
        self.assertIn(str(jsonl), text)
        self.assertIn("resume list preview text", text)
        self.assertIn("/resume <path>", text)

    def test_resume_list_deduplicates_text_log_with_structured_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            text_log = self._write_log(
                log_dir / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy duplicate</history>"}\n',
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-sidecar",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "structured sidecar preview"}],
                source="desktop",
                ts=1.0,
            ))

            sessions = list_restorable_sessions(log_dir)
            text = format_resume_list(log_dir)

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].path, jsonl)
        self.assertIn(str(jsonl), text)
        self.assertNotIn(str(text_log), text)
        self.assertIn("structured sidecar preview", text)

    def test_resume_list_reports_structured_sidecar_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "model_responses"
            now = time.time()
            text_log = self._write_log(
                log_dir / "model_responses_1.txt",
                '{"text": "\\n<history>[USER]: legacy duplicate</history>"}\n',
                mtime=now,
            )
            jsonl = session_log_sidecar_path(text_log)
            append_session_event(jsonl, SessionLogEvent(
                session_id="sess-sidecar",
                turn_id=1,
                role="user",
                content=[{"type": "text", "text": "structured sidecar metadata"}],
                source="desktop",
                ts=1.0,
            ))
            os.utime(jsonl, (now - 100, now - 100))
            jsonl_stat = jsonl.stat()

            sessions = list_restorable_sessions(log_dir)

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].path, jsonl)
        self.assertEqual(sessions[0].mtime, jsonl_stat.st_mtime)
        self.assertEqual(sessions[0].size, jsonl_stat.st_size)


if __name__ == "__main__":
    unittest.main()
