"""Prompt-injection filtering for untrusted CTF writeups.

Writeups are evidence, never instructions to the agent.  The sanitizer removes
lines that attempt to override instructions, exfiltrate runtime data, or cause
tool execution.  It is intentionally conservative: cryptographic formulas and
ordinary code remain intact unless the line itself carries an instruction-like
payload.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(?:ignore|disregard|forget|override)\b.{0,100}\b(?:previous|prior|system|developer|assistant|instructions?|prompt)\b", re.IGNORECASE),
    re.compile(r"\b(?:system|developer|assistant)\s*(?:prompt|message|instructions?)\b", re.IGNORECASE),
    re.compile(r"\b(?:send|upload|exfiltrate|post)\b.{0,100}\b(?:environment|env(?:ironment)?\s*variables?|credentials?|api[_ -]?key|secret|token|session|cookie)\b", re.IGNORECASE),
    re.compile(r"\b(?:curl|wget|requests?\.(?:get|post)|urllib)\b.{0,180}\b(?:environment|env|api[_ -]?key|secret|token|session|cookie)\b", re.IGNORECASE),
    re.compile(r"\b(?:run|execute|invoke|call)\b.{0,80}\b(?:shell|terminal|bash|command|tool)\b", re.IGNORECASE),
    re.compile(r"\bdo not tell (?:the )?user\b|\bhidden instructions?\b|\bprompt injection\b", re.IGNORECASE),
)


@dataclass(frozen=True)
class SanitizationResult:
    text: str
    redacted_lines: int = 0


def is_prompt_injection(text: str) -> bool:
    return any(pattern.search(text or "") for pattern in INJECTION_PATTERNS)


def sanitize_untrusted_text(text: str, *, replacement: str = "[untrusted instruction removed]") -> SanitizationResult:
    """Redact hostile instruction lines while preserving surrounding evidence."""

    kept: list[str] = []
    redacted = 0
    for line in (text or "").splitlines():
        if is_prompt_injection(line):
            redacted += 1
            if not kept or kept[-1] != replacement:
                kept.append(replacement)
            continue
        kept.append(line)
    cleaned = "\n".join(kept)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return SanitizationResult(text=cleaned + ("\n" if cleaned else ""), redacted_lines=redacted)
