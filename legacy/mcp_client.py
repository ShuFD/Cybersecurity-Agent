import json
import os
import atexit
import collections
import hashlib
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from registry_state import is_enabled


PROJECT_ROOT = Path(__file__).resolve().parent
MCP_PROTOCOL_VERSION = "2025-11-25"
MCP_TOOL_NAME_MAX_LEN = 64
MCP_CONFIG_PATH_LABELS = (
    "settings.json",
    "settings.local.json",
    ".secheur-agent/settings.json",
    ".secheur-agent/settings.local.json",
    ".secheur-agent/mcp.json",
    ".mcp.json",
)


def mcp_config_path_hint():
    return ", ".join(MCP_CONFIG_PATH_LABELS[:-1]) + f", or {MCP_CONFIG_PATH_LABELS[-1]}"


def _read_json(path):
    try:
        path = Path(path)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _optional_timeout(value):
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        return None
    return timeout if timeout > 0 else None


def _global_timeout_from_config(raw):
    if not isinstance(raw, dict):
        return None
    mcp_options = raw.get("mcp")
    if isinstance(mcp_options, dict):
        timeout = _optional_timeout(mcp_options.get("timeout"))
        if timeout is not None:
            return timeout
    return _optional_timeout(raw.get("mcpTimeout"))


def _merge_config_file(path, target, options):
    raw = _read_json(path)
    if not isinstance(raw, dict):
        return
    timeout = _global_timeout_from_config(raw)
    if timeout is not None:
        options["timeout"] = timeout
    servers = raw.get("mcpServers", raw)
    if not isinstance(servers, dict):
        return
    for name, config in servers.items():
        if isinstance(config, dict) and (config.get("command") or config.get("url")):
            target[name] = dict(config)


def load_mcp_configs(project_root=None, user_settings_path=None, include_disabled=False):
    root = Path(project_root or PROJECT_ROOT)
    merged = {}
    options = {}
    if user_settings_path:
        _merge_config_file(user_settings_path, merged, options)
    _merge_config_file(root / "settings.json", merged, options)
    _merge_config_file(root / "settings.local.json", merged, options)
    _merge_config_file(root / ".secheur-agent" / "settings.json", merged, options)
    _merge_config_file(root / ".secheur-agent" / "settings.local.json", merged, options)
    _merge_config_file(root / ".secheur-agent" / "mcp.json", merged, options)
    _merge_config_file(root / ".mcp.json", merged, options)
    if "timeout" in options:
        for config in merged.values():
            config.setdefault("timeout", options["timeout"])
    if not include_disabled:
        merged = {
            name: cfg
            for name, cfg in merged.items()
            if is_enabled(root, "mcpServers", name)
        }
    return merged


def mcp_config_paths(project_root=None, user_settings_path=None):
    root = Path(project_root or PROJECT_ROOT)
    paths = []
    if user_settings_path:
        paths.append(Path(user_settings_path))
    paths.extend([
        root / "settings.json",
        root / "settings.local.json",
        root / ".secheur-agent" / "settings.json",
        root / ".secheur-agent" / "settings.local.json",
    ])
    paths.extend([root / ".secheur-agent" / "mcp.json", root / ".mcp.json"])
    return paths


def _file_signature(paths):
    signature = []
    for path in paths:
        path = Path(path)
        try:
            st = path.stat()
            signature.append((str(path), st.st_mtime_ns, st.st_size))
        except OSError:
            signature.append((str(path), None, None))
    return tuple(signature)


def _configs_signature(configs):
    try:
        return json.dumps(configs or {}, ensure_ascii=False, sort_keys=True)
    except Exception:
        return repr(configs)


def _timeout_from_config(config, default):
    timeout = _optional_timeout((config or {}).get("timeout", default))
    return timeout if timeout is not None else default


def _transport_from_config(config):
    transport = str((config or {}).get("transport") or "").strip().lower().replace("-", "_")
    if transport in {"http", "streamable_http", "sse"} or (config or {}).get("url"):
        return "http"
    return "stdio"


def _tool_list_from_result(result, server_name):
    tools = result.get("tools") if isinstance(result, dict) else []
    out = []
    for tool in tools or []:
        if not isinstance(tool, dict) or not tool.get("name"):
            continue
        out.append(
            {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                "serverName": server_name,
            }
        )
    return out


def _tool_result_text(result):
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        texts = []
        for item in result["content"]:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(str(item.get("text", "")))
        return "\n".join(texts)
    return json.dumps(result, ensure_ascii=False)


def _raise_json_rpc_error(msg):
    if "error" in msg:
        err = msg["error"] or {}
        raise RuntimeError(f"MCP error {err.get('code')}: {err.get('message')}")


def _json_rpc_result(msg):
    _raise_json_rpc_error(msg)
    return msg.get("result")


def _iter_sse_data(text):
    data_lines = []
    for raw_line in str(text or "").splitlines():
        line = raw_line.rstrip("\r")
        if not line:
            if data_lines:
                yield "\n".join(data_lines)
                data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field != "data":
            continue
        if value.startswith(" "):
            value = value[1:]
        data_lines.append(value)
    if data_lines:
        yield "\n".join(data_lines)


def _find_json_rpc_response(messages, req_id):
    for msg in messages:
        if isinstance(msg, list):
            nested = _find_json_rpc_response(msg, req_id)
            if nested is not None:
                return nested
            continue
        if not isinstance(msg, dict):
            continue
        if msg.get("id") == req_id:
            return msg
    return None


def _safe_mcp_name_part(value, fallback):
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_")
    while "__" in safe:
        safe = safe.replace("__", "_")
    return safe or fallback


def _fit_mcp_prefixed_name(name, raw):
    if len(name) <= MCP_TOOL_NAME_MAX_LEN:
        return name
    digest = hashlib.sha1("\0".join(raw).encode("utf-8", "ignore")).hexdigest()[:10]
    suffix = f"_{digest}"
    keep = max(1, MCP_TOOL_NAME_MAX_LEN - len(suffix))
    stem = name[:keep].rstrip("_") or "mcp"
    return f"{stem}{suffix}"


def _unique_mcp_prefixed_name(server_name, tool_name, name_map):
    server_part = _safe_mcp_name_part(server_name, "server")
    tool_part = _safe_mcp_name_part(tool_name, "tool")
    base = f"mcp__{server_part}__{tool_part}"
    raw = (server_name, tool_name)
    name = _fit_mcp_prefixed_name(base, raw)
    suffix = 2
    while name in name_map and name_map[name] != raw:
        name = _fit_mcp_prefixed_name(f"{base}_{suffix}", raw)
        suffix += 1
    name_map[name] = raw
    return name


class McpConnection:
    def __init__(self, server_name, command, args=None, env=None, cwd=None, timeout=15):
        self.server_name = server_name
        self.command = command
        self.args = args or []
        self.env = env or {}
        self.cwd = str(cwd) if cwd else None
        self.timeout = timeout
        self.process = None
        self.next_id = 1
        self.lock = threading.Lock()
        self._stdout_queue = queue.Queue()
        self._pending_responses = {}
        self._reader_thread = None
        self._stderr_thread = None
        self.stderr_tail = collections.deque(maxlen=50)

    def connect(self):
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in self.env.items()})
        self.process = subprocess.Popen(
            [self.command, *self.args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=self.cwd,
            bufsize=1,
        )
        self._reader_thread = threading.Thread(target=self._read_stdout_lines, daemon=True)
        self._reader_thread.start()
        self._stderr_thread = threading.Thread(target=self._drain_stderr_lines, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr_lines(self):
        # 必须持续排水，否则 server 写满 stderr 管道缓冲区后会永久阻塞
        proc = self.process
        if not proc or not proc.stderr:
            return
        try:
            for line in proc.stderr:
                self.stderr_tail.append(line.rstrip("\n"))
        except Exception:
            pass

    def _read_stdout_lines(self):
        if not self.process or not self.process.stdout:
            return
        try:
            for line in self.process.stdout:
                self._stdout_queue.put(line)
        finally:
            self._stdout_queue.put(None)

    def _write(self, msg):
        if not self.process or not self.process.stdin:
            raise RuntimeError(f"MCP server '{self.server_name}' is not connected")
        self.process.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def _read_response(self, req_id):
        if not self.process or not self.process.stdout:
            raise RuntimeError(f"MCP server '{self.server_name}' is not connected")
        deadline = time.time() + self.timeout
        if req_id in self._pending_responses:
            msg = self._pending_responses.pop(req_id)
            if "error" in msg:
                err = msg["error"] or {}
                raise RuntimeError(f"MCP error {err.get('code')}: {err.get('message')}")
            return msg.get("result")
        while time.time() < deadline:
            remaining = max(0, deadline - time.time())
            try:
                line = self._stdout_queue.get(timeout=remaining)
            except queue.Empty:
                break
            if line is None:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") != req_id:
                if "id" in msg:
                    self._pending_responses[msg["id"]] = msg
                continue
            if "error" in msg:
                err = msg["error"] or {}
                raise RuntimeError(f"MCP error {err.get('code')}: {err.get('message')}")
            return msg.get("result")
        raise TimeoutError(f"MCP server '{self.server_name}' timed out waiting for {req_id}")

    def request(self, method, params=None):
        with self.lock:
            req_id = self.next_id
            self.next_id += 1
            self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
            return self._read_response(req_id)

    def notify(self, method, params=None):
        with self.lock:
            self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def initialize(self):
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "secheur-agent", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized")

    def list_tools(self):
        result = self.request("tools/list")
        return _tool_list_from_result(result, self.server_name)

    def call_tool(self, name, args):
        result = self.request("tools/call", {"name": name, "arguments": args or {}})
        return _tool_result_text(result)

    def close(self):
        if not self.process:
            return
        proc = self.process
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=1)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=1)
            except Exception:
                pass
        for stream in (proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except Exception:
                pass
        self.process = None


class McpHttpConnection:
    def __init__(self, server_name, url, headers=None, timeout=15, protocol_version=None):
        self.server_name = server_name
        self.url = str(url)
        self.headers = {str(k): str(v) for k, v in (headers or {}).items()}
        self.timeout = timeout
        self.protocol_version = str(protocol_version or MCP_PROTOCOL_VERSION)
        self.session_id = ""
        self.next_id = 1
        self.lock = threading.Lock()
        self.stderr_tail = collections.deque(maxlen=50)

    def connect(self):
        return None

    def _headers(self):
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        headers.update(self.headers)
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    def _parse_response_body(self, raw_body, content_type, req_id):
        text = raw_body.decode("utf-8", errors="replace")
        if "text/event-stream" in (content_type or "").lower():
            messages = []
            for data in _iter_sse_data(text):
                if data.strip() == "[DONE]":
                    continue
                messages.append(json.loads(data))
            msg = _find_json_rpc_response(messages, req_id)
            if msg is None:
                raise RuntimeError(f"MCP HTTP response missing JSON-RPC id {req_id}")
            return _json_rpc_result(msg)
        if not text.strip():
            raise RuntimeError(f"MCP HTTP response for id {req_id} was empty")
        msg = json.loads(text)
        if isinstance(msg, list):
            msg = _find_json_rpc_response(msg, req_id)
            if msg is None:
                raise RuntimeError(f"MCP HTTP response missing JSON-RPC id {req_id}")
        return _json_rpc_result(msg)

    def _post(self, msg, expect_response):
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=data,
            headers=self._headers(),
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                session_id = response.headers.get("Mcp-Session-Id") or response.headers.get("MCP-Session-Id")
                if session_id:
                    self.session_id = session_id
                raw_body = response.read()
                if not expect_response:
                    return None
                return self._parse_response_body(raw_body, response.headers.get("Content-Type", ""), msg.get("id"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"MCP HTTP {e.code}: {body[:500]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"MCP HTTP connection failed: {e.reason}") from e

    def request(self, method, params=None):
        with self.lock:
            req_id = self.next_id
            self.next_id += 1
            return self._post(
                {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}},
                expect_response=True,
            )

    def notify(self, method, params=None):
        with self.lock:
            return self._post(
                {"jsonrpc": "2.0", "method": method, "params": params or {}},
                expect_response=False,
            )

    def initialize(self):
        result = self.request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "capabilities": {},
                "clientInfo": {"name": "secheur-agent", "version": "0.1.0"},
            },
        )
        if isinstance(result, dict) and result.get("protocolVersion"):
            self.protocol_version = str(result["protocolVersion"])
        self.notify("notifications/initialized")

    def list_tools(self):
        return _tool_list_from_result(self.request("tools/list"), self.server_name)

    def call_tool(self, name, args):
        return _tool_result_text(self.request("tools/call", {"name": name, "arguments": args or {}}))

    def close(self):
        return None


class McpManager:
    def __init__(self, configs=None, project_root=None, timeout=15):
        self.configs = configs
        self.project_root = Path(project_root or PROJECT_ROOT)
        self.timeout = timeout
        self.connections = {}
        self.tools = []
        self.tool_name_map = {}
        self.diagnostics = {}
        self.connected = False
        self.config_signature = None
        atexit.register(self.disconnect_all)

    def _current_configs_and_signature(self):
        if self.configs is not None:
            return self.configs, ("explicit", _configs_signature(self.configs))
        configs = load_mcp_configs(self.project_root)
        return configs, (
            "files",
            _file_signature(mcp_config_paths(self.project_root)),
            _configs_signature(configs),
        )

    def connect_all(self):
        configs, signature = self._current_configs_and_signature()
        has_errors = any(
            isinstance(diag, dict) and diag.get("status") == "error"
            for diag in self.diagnostics.values()
        )
        if self.connected and signature == self.config_signature and not has_errors:
            return
        if self.connected:
            self.disconnect_all()
        self.connections = {}
        self.tools = []
        self.tool_name_map = {}
        self.diagnostics = {}
        self.connected = True
        self.config_signature = signature
        for name, cfg in configs.items():
            timeout = _timeout_from_config(cfg, self.timeout)
            transport = _transport_from_config(cfg)
            self.diagnostics[name] = {
                "status": "connecting",
                "transport": transport,
                "command": cfg.get("command"),
                "args": cfg.get("args") or [],
                "url": cfg.get("url") or "",
                "cwd": cfg.get("cwd") or "",
                "timeout": timeout,
            }
            if transport == "http":
                if not cfg.get("url"):
                    self.diagnostics[name] = {
                        "status": "error",
                        "transport": transport,
                        "url": "",
                        "timeout": timeout,
                        "message": "MCP HTTP transport requires url",
                    }
                    continue
                conn = McpHttpConnection(
                    name,
                    cfg.get("url"),
                    headers=cfg.get("headers"),
                    timeout=timeout,
                    protocol_version=cfg.get("protocolVersion") or cfg.get("protocol_version"),
                )
            elif cfg.get("command"):
                conn = McpConnection(name, cfg["command"], cfg.get("args"), cfg.get("env"), cfg.get("cwd"), timeout=timeout)
            else:
                self.diagnostics[name] = {
                    "status": "error",
                    "transport": transport,
                    "command": "",
                    "url": "",
                    "timeout": timeout,
                    "message": "MCP server requires command or url",
                }
                continue
            try:
                conn.connect()
                conn.initialize()
                tools = conn.list_tools()
            except Exception as e:
                msg = str(e)
                if conn.stderr_tail:
                    msg += "\nstderr: " + "\n".join(list(conn.stderr_tail)[-5:])
                self.diagnostics[name] = {
                    "status": "error",
                    "transport": transport,
                    "command": cfg.get("command"),
                    "args": cfg.get("args") or [],
                    "url": cfg.get("url") or "",
                    "cwd": cfg.get("cwd") or "",
                    "timeout": timeout,
                    "message": msg,
                }
                conn.close()
                continue
            self.connections[name] = conn
            self.tools.extend(tools)
            self.diagnostics[name] = {
                "status": "connected",
                "transport": transport,
                "command": cfg.get("command"),
                "args": cfg.get("args") or [],
                "url": cfg.get("url") or "",
                "cwd": cfg.get("cwd") or "",
                "timeout": timeout,
                "tools": [tool.get("name") for tool in tools],
            }

    def get_diagnostics(self):
        return json.loads(json.dumps(self.diagnostics, ensure_ascii=False))

    def get_tool_schemas(self):
        schemas = []
        tool_name_map = {}
        sorted_tools = sorted(
            self.tools,
            key=lambda tool: f"mcp__{tool.get('serverName', '')}__{tool.get('name', '')}",
        )
        for tool in sorted_tools:
            schema_name = _unique_mcp_prefixed_name(
                str(tool.get("serverName", "")),
                str(tool.get("name", "")),
                tool_name_map,
            )
            schemas.append(
                {
                    "type": "function",
                    "function": {
                        "name": schema_name,
                        "description": tool.get("description") or f"MCP tool {tool['name']} from {tool['serverName']}",
                        "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
                    },
                }
            )
        self.tool_name_map = tool_name_map
        return schemas

    def call_tool(self, prefixed_name, args):
        mapped = self.tool_name_map.get(prefixed_name)
        if mapped:
            server_name, tool_name = mapped
        else:
            parts = (prefixed_name or "").split("__")
            if len(parts) < 3 or parts[0] != "mcp":
                raise ValueError(f"Invalid MCP tool name: {prefixed_name}")
            server_name = parts[1]
            tool_name = "__".join(parts[2:])
        if server_name not in self.connections:
            raise RuntimeError(f"MCP server '{server_name}' is not connected")
        return self.connections[server_name].call_tool(tool_name, args)

    def disconnect_all(self):
        for conn in self.connections.values():
            conn.close()
        self.connections = {}
        self.tools = []
        self.tool_name_map = {}
        self.diagnostics = {}
        self.connected = False
        self.config_signature = None
