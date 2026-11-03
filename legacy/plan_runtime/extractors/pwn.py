from __future__ import annotations

import re
from typing import Any, Dict

from .base import category, command_text, detect_architecture, output_text, result_data


def _protection(text: str, name: str) -> Any:
    patterns = {
        "canary": (r"canary\s+found|stack canary:\s*yes", r"no canary|canary:\s*no"),
        "nx": (r"nx\s+enabled|nx:\s*yes", r"nx\s+disabled|nx:\s*no"),
        "pie": (r"pie\s+enabled|pie:\s*yes", r"no pie|pie:\s*no"),
    }
    yes, no = patterns[name]
    if re.search(yes, text, re.IGNORECASE):
        return True
    if re.search(no, text, re.IGNORECASE):
        return False
    return None


def extract_pwn(*, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    command = command_text(tool_name, args)
    text = output_text(result)
    lowered = text.lower()
    relevant = category(state) == "pwn" or any(
        marker in command for marker in ("checksec", "gdb", "pwndbg", "ropgadget", "one_gadget", "run_linux_elf")
    )
    if not relevant:
        return {"facts": [], "hypotheses": []}
    data = result_data(result)
    facts = []
    architecture = data.get("selected_arch") or detect_architecture(text)
    if architecture:
        facts.append({"key": "binary.architecture", "value": architecture, "confidence": 0.95})
    file_info = data.get("detected_file") or data.get("file")
    if file_info:
        facts.append({"key": "binary.file_type", "value": str(file_info), "confidence": 1.0})
    if "checksec" in command or "relro" in lowered or "canary" in lowered:
        protections = {}
        for name in ("canary", "nx", "pie"):
            value = _protection(text, name)
            if value is not None:
                protections[name] = value
        if "full relro" in lowered:
            protections["relro"] = "full"
        elif "partial relro" in lowered:
            protections["relro"] = "partial"
        elif "no relro" in lowered:
            protections["relro"] = "none"
        if protections:
            facts.append({"key": "binary.protections", "value": protections, "merge": "dict", "confidence": 1.0})
    crash = bool(re.search(r"segmentation fault|sigsegv|stack smashing detected|core dumped", text, re.IGNORECASE))
    if crash:
        facts.append({"key": "binary.crash_observed", "value": True, "confidence": 1.0})
    libc_paths = list(dict.fromkeys(re.findall(r"(?:/[^\s]+)?libc(?:-[\d.]+)?\.so(?:\.6)?", text)))
    if libc_paths:
        facts.append({"key": "binary.linked_libc", "value": libc_paths[:20], "merge": "union", "confidence": 0.95})
    if data.get("exit_code") is not None:
        facts.append({"key": "binary.last_exit_code", "value": data.get("exit_code"), "confidence": 1.0})
    return {"facts": facts, "hypotheses": []}
