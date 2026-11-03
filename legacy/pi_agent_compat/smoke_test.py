#!/usr/bin/env python3
"""Smoke-test an installed Pi legacy planning kernel without external I/O."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("legacy_root", type=Path)
    parser.add_argument("--bridge", type=Path)
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    sys.path.insert(0, str(args.legacy_root.resolve()))

    from plan_runtime import PlanRuntime, ProgressController
    from task_descriptor import parse_task_descriptor

    prompt = "\n".join(
        (
            "Target ID: demo/misc/Life",
            "Target URL:",
            "nc 127.0.0.1 31337",
            "Use verify_flag",
        )
    )
    descriptor = parse_task_descriptor(prompt)
    with tempfile.TemporaryDirectory(prefix="secheur-pi-smoke-") as run_dir:
        runtime = PlanRuntime.initialize(prompt, task_descriptor=descriptor, run_dir=run_dir)
        assert runtime.status()["runnable_node_ids"] == ["misc_tcp_capture_banner"]

    controller = ProgressController(replan_after=2, phase_replan_after=4, stop_after=6)
    decisions = [
        controller.after_tool(
            tool_name="plan_status",
            args={"sequence": turn},
            result={"status": "success"},
            turn=turn,
        )
        for turn in range(1, 7)
    ]
    assert descriptor.category == "misc"
    assert descriptor.first_endpoint("tcp").port == 31337
    assert decisions[-1]["action"] == "STOP_STUCK"
    assert controller.snapshot()["terminal_state"] == "stuck"

    if args.bridge:
        with tempfile.TemporaryDirectory(prefix="secheur-pi-bridge-smoke-") as state_dir:
            requests = [
                {
                    "id": 1,
                    "tool": "__task_start",
                    "args": {
                        "prompt": prompt,
                        "session_id": "planning-smoke",
                        "state_dir": state_dir,
                        "ctf_verbs_enabled": True,
                    },
                    "permissionMode": "default",
                },
                {"id": 2, "tool": "__turn_start", "args": {"turn": 1}},
                {"id": 3, "tool": "plan_status", "args": {}},
                {
                    "id": 4,
                    "tool": "__observe_external_tool",
                    "args": {
                        "tool_name": "mcp__smoke__probe",
                        "args": {"target": "same"},
                        "data": {"status": "success", "content": "banner"},
                    },
                },
            ]
            completed = subprocess.run(
                [sys.executable, str(args.bridge.resolve()), "--cwd", str(args.project_root.resolve())],
                input="".join(json.dumps(request) + "\n" for request in requests),
                text=True,
                capture_output=True,
                timeout=30,
                check=True,
            )
            responses = []
            for line in completed.stdout.splitlines():
                if not line.strip():
                    continue
                try:
                    responses.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise AssertionError(
                        "bridge emitted non-JSON stdout: "
                        f"{line!r}; stderr={completed.stderr[-2000:]!r}"
                    ) from error
            assert len(responses) == len(requests)
            response = responses[0]
            assert response["ok"] is True
            assert response["data"]["diagnostics"] == []
            assert response["data"]["task_descriptor"]["classification"]["category"] == "misc"
            assert response["data"]["task_descriptor_path"]
            assert "[Evidence-Grounded Program Plan]" in response["nextPrompt"]
            assert "misc_tcp_capture_banner" in response["nextPrompt"]
            assert "[Web Verb Typed Actions]" not in response["nextPrompt"]
            assert responses[2]["ok"] is True
            assert responses[2]["data"]["status"] == "success"
            assert responses[3]["ok"] is True
            assert responses[3]["data"]["status"] == "observed"
            assert responses[3]["data"]["progress_controller"]["evidence_revision"] >= 1
    print("server_planning_smoke=OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
