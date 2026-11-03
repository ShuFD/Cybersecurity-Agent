from __future__ import annotations

import re
from typing import Any, Dict

from .base import category, command_text, detect_architecture, output_text, result_data


def extract_reverse(*, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    command = command_text(tool_name, args)
    text = output_text(result)
    relevant = category(state) == "reverse" or any(
        marker in command for marker in ("objdump", "readelf", "radare", " r2", "strings", "ghidra", "jadx", "wasm")
    )
    if not relevant:
        return {"facts": [], "hypotheses": []}
    data = result_data(result)
    facts = []
    hypotheses = []
    file_info = data.get("file") or data.get("detected_file")
    if file_info:
        facts.append({"key": "reverse.file_type", "value": str(file_info), "confidence": 1.0})
    architecture = detect_architecture(str(file_info or text))
    if architecture:
        facts.append({"key": "reverse.architecture", "value": architecture, "confidence": 0.95})
    if re.search(r"\bupx\b|packed executable|packer", text, re.IGNORECASE):
        facts.append({"key": "reverse.packed_signature", "value": True, "confidence": 0.9})
    if "strings" in command and text.strip():
        lines = [line.strip() for line in text.splitlines() if 4 <= len(line.strip()) <= 240]
        facts.append({"key": "reverse.interesting_strings", "value": lines[:120], "merge": "union", "confidence": 0.75})
    imports = []
    if any(marker in command for marker in ("readelf", "objdump", " nm")):
        for line in text.splitlines():
            match = re.search(r"\b(?:UND|U)\s+([A-Za-z_][A-Za-z0-9_@.]*)", line)
            if match:
                imports.append(match.group(1))
    if imports:
        facts.append({"key": "reverse.imports", "value": list(dict.fromkeys(imports))[:200], "merge": "union", "confidence": 0.9})
    if re.search(r"anti[-_ ]debug|ptrace|isdebuggerpresent", text, re.IGNORECASE):
        hypotheses.append(
            {
                "id": "reverse.anti_debug_possible",
                "claim": "The analysis output contains an anti-debugging indicator.",
                "confidence": 0.65,
            }
        )
    return {"facts": facts, "hypotheses": hypotheses}
