from __future__ import annotations

import re
import json
from typing import Any, Dict


def result_data(result: Any) -> Dict[str, Any]:
    if not isinstance(result, dict):
        return {}
    data = result.get("data")
    if isinstance(data, dict):
        return result_data(data)
    nested = result.get("result")
    if isinstance(nested, dict):
        return result_data(nested)
    if isinstance(nested, str):
        try:
            parsed = json.loads(nested)
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            return result_data(parsed)
    return result


def output_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        return ""
    data = result_data(result)
    parts = []
    for key in ("stdout", "stderr", "content", "text", "text_preview", "file", "detected_file", "error"):
        value = data.get(key)
        if value not in (None, ""):
            parts.append(str(value))
    nested = result.get("result")
    if isinstance(nested, str):
        parts.append(nested)
    return "\n".join(parts)


def command_text(tool_name: str, args: Dict[str, Any]) -> str:
    values = [tool_name]
    for key in ("argv", "cmd", "command", "script", "verb"):
        value = args.get(key)
        if isinstance(value, list):
            values.extend(str(item) for item in value)
        elif value:
            values.append(str(value))
    return " ".join(values).lower()


def detect_architecture(text: str) -> str:
    lowered = str(text or "").lower()
    patterns = (
        (r"x86[-_ ]?64|amd64|64-bit.*x86", "x86_64"),
        (r"80386|\bi[3-6]86\b|32-bit.*x86", "i386"),
        (r"aarch64|arm64", "aarch64"),
        (r"\barm\b", "arm"),
        (r"mips.*lsb|mipsel", "mipsel"),
        (r"\bmips\b", "mips"),
        (r"risc-?v|riscv", "riscv64"),
        (r"wasm|webassembly", "wasm"),
    )
    for pattern, value in patterns:
        if re.search(pattern, lowered):
            return value
    return ""


def category(state: Dict[str, Any]) -> str:
    record = (state.get("facts") or {}).get("task.category")
    if isinstance(record, dict):
        return str(record.get("value") or "")
    return str(record or "")
