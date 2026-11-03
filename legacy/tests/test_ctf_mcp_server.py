import base64
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


def load_ctf_mcp_server():
    mcp_module = types.ModuleType("mcp")
    mcp_server_module = types.ModuleType("mcp.server")
    fastmcp_module = types.ModuleType("mcp.server.fastmcp")

    class FakeFastMCP:
        def __init__(self, *args, **kwargs):
            self.settings = types.SimpleNamespace(host="127.0.0.1", port=8000)

        def tool(self):
            return lambda fn: fn

        def run(self, *args, **kwargs):
            return None

    fastmcp_module.FastMCP = FakeFastMCP
    sys.modules.setdefault("mcp", mcp_module)
    sys.modules.setdefault("mcp.server", mcp_server_module)
    sys.modules.setdefault("mcp.server.fastmcp", fastmcp_module)

    server_path = Path(__file__).resolve().parents[1] / "ctf-mcp" / "server.py"
    spec = importlib.util.spec_from_file_location("ctf_mcp_server", server_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IsolatedWorkdir:
    def __init__(self, server):
        self.server = server
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary_directory.name).resolve()
        self.host_path = Path("/host/ctf-work")
        self.original = (server.WORKDIR, server.ALLOWED_PATH_ROOTS, server.HOST_WORKDIRS)

    def __enter__(self):
        self.server.WORKDIR = self.path
        self.server.ALLOWED_PATH_ROOTS = (self.path,)
        self.server.HOST_WORKDIRS = (self.host_path,)
        return self.path

    def __exit__(self, exc_type, exc_value, traceback):
        self.server.WORKDIR, self.server.ALLOWED_PATH_ROOTS, self.server.HOST_WORKDIRS = self.original
        self.temporary_directory.cleanup()


class CtfMcpServerCliTests(unittest.TestCase):
    def test_parse_args_defaults_to_stdio(self):
        server = load_ctf_mcp_server()

        args = server.parse_args([])

        self.assertEqual(args.transport, "stdio")
        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 8000)

    def test_parse_args_accepts_http_transport_host_and_port(self):
        server = load_ctf_mcp_server()

        args = server.parse_args([
            "--transport",
            "streamable-http",
            "--host",
            "0.0.0.0",
            "--port",
            "18080",
        ])

        self.assertEqual(args.transport, "streamable-http")
        self.assertEqual(args.host, "0.0.0.0")
        self.assertEqual(args.port, 18080)

    def test_new_ctf_tools_are_allowlisted(self):
        server = load_ctf_mcp_server()

        expected_tools = {
            "7z",
            "7zz",
            "convert",
            "tesseract",
            "avr-objdump",
            "avr-gdb",
            "simavr",
            "ruby",
            "zsteg",
            "one_gadget",
        }

        self.assertTrue(expected_tools.issubset(server.ALLOWED_TOOLS))

    def test_host_workdir_path_maps_to_container_workdir(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server) as workdir:
            mapped = server._safe_path("/host/ctf-work/challenge/assets/chal.bin")

        self.assertEqual(mapped, workdir / "challenge" / "assets" / "chal.bin")

    def test_paths_outside_allowed_roots_are_blocked(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server) as workdir:
            self.assertEqual(server._safe_path("inside.bin"), workdir / "inside.bin")
            with self.assertRaisesRegex(ValueError, "outside allowed CTF roots"):
                server._safe_path(workdir.parent / "outside.bin")

    def test_path_aliases_are_supported_by_file_tools(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server) as workdir:
            sample = workdir / "sample.bin"
            sample.write_bytes(b"abc")
            calls = []
            server._file_info = lambda path: "ASCII text"

            def fake_run(cmd, **kwargs):
                calls.append(cmd)
                return {"stdout": "dummysha  sample.bin\n", "exit_code": 0}

            server._run = fake_run
            for alias in ("path", "file", "filename", "file_path", "target"):
                result = server.identify_file(**{alias: "sample.bin"})
                self.assertEqual(result["path"], str(sample))
            server.checksec_file(filename="sample.bin")
            server.binwalk_scan(file="sample.bin")
            server.strings_extract(target="sample.bin")

        self.assertIn(["checksec", "--file", str(sample)], calls)
        self.assertIn(["binwalk", str(sample)], calls)
        self.assertIn(["strings", "-a", "-n", "4", str(sample)], calls)

    def test_run_ctf_tool_accepts_all_deployed_argument_forms(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server):
            calls = []

            def fake_run(cmd, **kwargs):
                calls.append(cmd)
                return {"exit_code": 0}

            server._run = fake_run
            server.run_ctf_tool(argv=["ls", "-l"])
            server.run_ctf_tool(command="ls -l")
            server.run_ctf_tool(cmd=["ls", "-l"])
            server.run_ctf_tool(tool="ls", args=["-l"])
            server.run_ctf_tool(args=["ls", "-l"])

        self.assertEqual(calls, [["ls", "-l"]] * 5)

    def test_run_ctf_tool_rewrites_host_paths_and_blocks_other_absolute_paths(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server) as workdir:
            calls = []
            server._run = lambda cmd, **kwargs: calls.append(cmd) or {"exit_code": 0}
            server.run_ctf_tool(cmd=["ls", "/host/ctf-work/challenge"])
            with self.assertRaisesRegex(ValueError, "outside allowed CTF roots"):
                server.run_ctf_tool(cmd=["cat", "/etc/passwd"])

        self.assertEqual(calls, [["ls", str(workdir / "challenge")]])

    def test_missing_executable_returns_shell_compatible_exit_code(self):
        server = load_ctf_mcp_server()

        with IsolatedWorkdir(server) as workdir:
            result = server._run(["secheur-definitely-missing-executable"], cwd=workdir)

        self.assertEqual(result["exit_code"], 127)
        self.assertFalse(result["timed_out"])
        self.assertIn("executable not found", result["stderr"])

    def test_upload_image_writes_data_url_without_overwriting(self):
        server = load_ctf_mcp_server()
        raw = b"\x89PNG\r\n\x1a\nminimal-test-payload"
        payload = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")

        with IsolatedWorkdir(server) as workdir:
            result = server.upload_image(payload, filename="sample.png")
            self.assertEqual((workdir / "sample.png").read_bytes(), raw)
            with self.assertRaises(FileExistsError):
                server.upload_image(payload, filename="sample.png")
            with self.assertRaisesRegex(ValueError, "invalid base64 data"):
                server.upload_image("not-base64!", filename="bad.png")

        self.assertEqual(result["size"], len(raw))
        self.assertEqual(result["path"], str(workdir / "sample.png"))


if __name__ == "__main__":
    unittest.main()
