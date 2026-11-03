from __future__ import annotations

from typing import Any, Dict

from .base import detect_architecture, output_text, result_data


def extract_generic(*, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    data = result_data(result)
    text = output_text(result)
    facts = []
    files = data.get("files")
    if isinstance(files, list):
        facts.append({"key": "artifact.files", "value": [str(item) for item in files], "merge": "union", "confidence": 1.0})
    path = data.get("path") or data.get("saved_path")
    if path:
        facts.append({"key": "artifact.paths", "value": [str(path)], "merge": "union", "confidence": 1.0})
    if data.get("sha256"):
        facts.append({"key": "artifact.sha256", "value": str(data.get("sha256")).split()[0], "confidence": 1.0})
    if isinstance(data.get("size"), int):
        facts.append({"key": "artifact.size", "value": data.get("size"), "confidence": 1.0})
    file_info = data.get("file") or data.get("detected_file")
    if file_info:
        facts.append({"key": "artifact.file_type", "value": str(file_info), "confidence": 1.0})
        observed_path = str(args.get("path") or args.get("file_path") or path or "").strip()
        if observed_path:
            facts.append(
                {
                    "key": "artifact.file_types",
                    "value": {observed_path.replace("\\", "/"): str(file_info)},
                    "merge": "dict",
                    "confidence": 1.0,
                }
            )
    architecture = data.get("architecture") or data.get("selected_arch") or detect_architecture(str(file_info or text))
    if architecture:
        facts.append({"key": "artifact.architecture", "value": architecture, "confidence": 0.95})
    if isinstance(data.get("timed_out"), bool):
        facts.append({"key": f"tool.{tool_name}.timed_out", "value": data.get("timed_out"), "confidence": 1.0})
    return {"facts": facts, "hypotheses": []}
