from __future__ import annotations

import re
from typing import Any, Dict

from .base import category, command_text, output_text, result_data


def extract_forensics(*, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    command = command_text(tool_name, args)
    text = output_text(result)
    relevant = category(state) == "forensics" or any(
        marker in command
        for marker in ("binwalk", "exiftool", "foremost", "volatility", " tshark", "capinfos", "zsteg", "steghide")
    )
    if not relevant:
        return {"facts": [], "hypotheses": []}
    data = result_data(result)
    facts = []
    hypotheses = []
    file_info = data.get("file") or data.get("detected_file")
    if file_info:
        facts.append({"key": "forensics.file_type", "value": str(file_info), "confidence": 1.0})
    if "binwalk" in command and text.strip():
        signatures = []
        for line in text.splitlines():
            if re.match(r"^\s*(?:0x[0-9a-f]+|\d+)\s+", line, re.IGNORECASE):
                signatures.append(line.strip()[:300])
        facts.append({"key": "forensics.embedded_signatures", "value": signatures[:200], "merge": "union", "confidence": 0.9})
        facts.append({"key": "forensics.embedded_scan_complete", "value": True, "confidence": 1.0})
    if "exiftool" in command and text.strip():
        metadata = {}
        for line in text.splitlines()[:300]:
            if ":" in line:
                key, value = line.split(":", 1)
                if key.strip() and value.strip():
                    metadata[key.strip()] = value.strip()[:500]
        if metadata:
            facts.append({"key": "forensics.metadata", "value": metadata, "merge": "dict", "confidence": 0.95})
    if "tshark" in command or "capinfos" in command:
        protocols = re.findall(r"\b(?:HTTP2?|DNS|TCP|UDP|TLS|ICMP|FTP|SMTP|SSH|QUIC|ARP)\b", text, re.IGNORECASE)
        if protocols:
            facts.append(
                {
                    "key": "forensics.pcap_protocols",
                    "value": list(dict.fromkeys(item.upper() for item in protocols)),
                    "merge": "union",
                    "confidence": 0.9,
                }
            )
    entropy = data.get("entropy")
    if isinstance(entropy, (int, float)):
        facts.append({"key": "forensics.entropy", "value": float(entropy), "confidence": 1.0})
        if float(entropy) >= 7.5:
            hypotheses.append(
                {
                    "id": "forensics.high_entropy_payload",
                    "claim": "High entropy suggests compressed or encrypted content.",
                    "confidence": 0.6,
                }
            )
    return {"facts": facts, "hypotheses": hypotheses}
