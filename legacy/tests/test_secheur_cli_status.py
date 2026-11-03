import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from secheur_cli import cli


class SecheurCliStatusTests(unittest.TestCase):
    def test_status_works_without_psutil_when_bridge_is_ready(self):
        buffer = io.StringIO()
        with patch.object(cli, "get_bridge_status", return_value={
            "ok": True,
            "ready": True,
            "projectRoot": "/tmp/project",
        }), patch.object(cli, "get_agent_processes", return_value=None), redirect_stdout(buffer):
            cli.cmd_status()

        output = buffer.getvalue()
        self.assertIn("Bridge 运行中", output)
        self.assertIn("/tmp/project", output)
        self.assertIn("未安装 psutil", output)

    def test_status_reports_not_running_without_bridge_or_process_scan(self):
        buffer = io.StringIO()
        with patch.object(cli, "get_bridge_status", return_value=None), patch.object(cli, "get_agent_processes", return_value=None), redirect_stdout(buffer):
            cli.cmd_status()

        output = buffer.getvalue()
        self.assertIn("未安装 psutil", output)
        self.assertIn("SecHeur Agent 进程未运行", output)

    def test_status_reads_bridge_status_url_from_environment(self):
        with patch.dict(cli.os.environ, {"SECHEUR_STATUS_URL": "http://127.0.0.1:54321/status"}), \
             patch.object(cli, "get_bridge_status", return_value=None) as get_bridge_status, \
             patch.object(cli, "get_agent_processes", return_value=None), \
             redirect_stdout(io.StringIO()):
            cli.cmd_status()

        get_bridge_status.assert_called_once_with("http://127.0.0.1:54321/status")


if __name__ == "__main__":
    unittest.main()
