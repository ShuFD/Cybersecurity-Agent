from __future__ import annotations

import hashlib
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from .models import (
    SCHEMA_VERSION,
    AssetDescriptor,
    CategoryCandidate,
    EndpointDescriptor,
    ParseDiagnostic,
    SourceRef,
    TaskCapabilities,
    TaskClassification,
    TaskDescriptor,
    TaskIdentity,
    VerificationDescriptor,
)


TARGET_ID_LABELS = ("Target ID", "Challenge ID", "target_id", "challenge_id")
GOAL_LABELS = (
    "Original task goal",
    "Task objective",
    "Challenge objective",
    "Task goal",
    "\u4efb\u52a1\u76ee\u6807",
    "\u9898\u76ee\u76ee\u6807",
)
ASSET_LABELS = (
    "Official assets",
    "Official asset",
    "Official attachment",
    "Attachment path",
    "Asset path",
    "\u9644\u4ef6\u8def\u5f84",
    "\u9644\u4ef6\u76ee\u5f55",
    "\u5b98\u65b9\u9644\u4ef6",
    "\u6587\u4ef6\u8def\u5f84",
)
ENDPOINT_LABELS = (
    "Target URL",
    "Target endpoint",
    "Endpoint",
    "Remote",
    "Service",
    "\u76ee\u6807\u5730\u5740",
    "\u8fdc\u7a0b\u5730\u5740",
    "\u670d\u52a1\u5730\u5740",
)
CATEGORY_LABELS = ("Category", "Challenge category", "Task category", "\u9898\u76ee\u7c7b\u578b", "\u7c7b\u578b")

CATEGORY_ALIASES = {
    "web": "web",
    "pwn": "pwn",
    "reverse": "reverse",
    "reversing": "reverse",
    "rev": "reverse",
    "forensic": "forensics",
    "forensics": "forensics",
    "misc": "misc",
    "crypto": "crypto",
    "cryptography": "crypto",
    "osint": "osint",
    "malware": "malware",
    "ai": "ai_ml",
    "ml": "ai_ml",
    "ai-ml": "ai_ml",
    "ai_ml": "ai_ml",
}


@dataclass(frozen=True)
class PromptLine:
    number: int
    raw: str
    normalized: str


@dataclass(frozen=True)
class LabeledValue:
    label: str
    value: str
    source: SourceRef


def _lines(text: str) -> Tuple[PromptLine, ...]:
    return tuple(
        PromptLine(index, raw, re.sub(r"\s+", " ", raw).strip())
        for index, raw in enumerate(text.replace("\r\n", "\n").replace("\r", "\n").split("\n"), 1)
    )


def _unsafe_value(value: str) -> bool:
    return bool(
        re.search(
            r"(?is)<FINAL_ANSWER>|(?:candidate|answer|flag|\u5019\u9009|\u7b54\u6848|\u65d7\u6807)\s*[:\uff1a=]",
            str(value or ""),
        )
    )


def _clean_value(value: str, limit: int = 1000) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip().strip("'\"`")
    return "" if not cleaned or _unsafe_value(cleaned) else cleaned[:limit]


def _match_label(line: PromptLine, aliases: Sequence[str]) -> Optional[Tuple[str, str]]:
    for alias in sorted(aliases, key=len, reverse=True):
        match = re.match(rf"^\s*{re.escape(alias)}\s*[:\uff1a=]\s*(.*?)\s*$", line.raw, re.IGNORECASE)
        if match:
            return alias, match.group(1)
    return None


def _labeled_values(lines: Sequence[PromptLine], aliases: Sequence[str], limit: int = 1000) -> Tuple[LabeledValue, ...]:
    found: List[LabeledValue] = []
    for index, line in enumerate(lines):
        matched = _match_label(line, aliases)
        if not matched:
            continue
        label, inline = matched
        raw_value = inline
        end_line = line.number
        if not raw_value.strip():
            for following in lines[index + 1 :]:
                if not following.normalized:
                    continue
                raw_value = following.raw
                end_line = following.number
                break
        value = _clean_value(raw_value, limit=limit)
        if value:
            found.append(
                LabeledValue(
                    label=label,
                    value=value,
                    source=SourceRef(
                        kind="labeled_field",
                        label=label,
                        line_start=line.number,
                        line_end=end_line,
                        raw=str(raw_value).strip()[:500],
                    ),
                )
            )
    return tuple(found)


def _sanitize_task_text(text: str, limit: int = 1800) -> str:
    value = re.sub(r"(?is)<FINAL_ANSWER>.*?(?:</FINAL_ANSWER>|$)", "", str(text or ""))
    value = re.sub(
        r"(?im)^[ \t]*(?:Target ID|Challenge ID|target_id|challenge_id)[ \t]*[:\uff1a]"
        r"[ \t]*(?:\r?\n[ \t]*[^\r\n]+|[^\r\n]+)[ \t]*(?:\r?\n|$)",
        "",
        value,
    )
    value = re.sub(
        r"(?im)^.*(?:<candidate[^>]*>|[\"']?(?:candidate|answer|flag|\u5019\u9009|\u7b54\u6848|\u65d7\u6807)[\"']?\s*[:\uff1a=]).*$",
        "",
        value,
    )
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    return value[:limit]


def _parse_url(raw: str, source: SourceRef) -> Optional[EndpointDescriptor]:
    match = re.search(r"https?://[^\s<>'\"`]+", raw, re.IGNORECASE)
    if not match:
        return None
    url = match.group(0).rstrip(".,;)")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        return None
    return EndpointDescriptor(
        protocol=parsed.scheme.lower(),
        host=str(parsed.hostname),
        port=port,
        url=url,
        raw=raw.strip()[:500],
        confidence=1.0,
        source=source,
    )


def _parse_nc(raw: str, source: SourceRef) -> Optional[EndpointDescriptor]:
    try:
        tokens = shlex.split(raw, posix=True)
    except ValueError:
        return None
    command_index = next(
        (index for index, token in enumerate(tokens) if PurePosixPath(token.lower()).name in {"nc", "ncat", "netcat"}),
        None,
    )
    if command_index is None:
        return None
    positional: List[str] = []
    skip_next = False
    options_with_value = {"-i", "-p", "-s", "-w", "--idle-timeout", "--source-port", "--wait"}
    for token in tokens[command_index + 1 :]:
        if skip_next:
            skip_next = False
            continue
        if token in options_with_value:
            skip_next = True
            continue
        if token.startswith("-"):
            continue
        positional.append(token)
    if len(positional) < 2 or not positional[-1].isdigit():
        return None
    port = int(positional[-1])
    host = positional[-2].strip("[]")
    if not host or not 1 <= port <= 65535:
        return None
    return EndpointDescriptor(
        protocol="tcp",
        host=host,
        port=port,
        raw=raw.strip()[:500],
        confidence=1.0,
        source=source,
    )


def _parse_host_port(raw: str, source: SourceRef) -> Optional[EndpointDescriptor]:
    match = re.fullmatch(r"\s*(?:tcp://)?(\[[^]]+\]|[A-Za-z0-9_.-]+):(\d{1,5})\s*", raw, re.IGNORECASE)
    if not match:
        return None
    port = int(match.group(2))
    if not 1 <= port <= 65535:
        return None
    return EndpointDescriptor(
        protocol="tcp",
        host=match.group(1).strip("[]"),
        port=port,
        raw=raw.strip()[:500],
        confidence=0.95,
        source=source,
    )


def _endpoints(text: str, lines: Sequence[PromptLine]) -> Tuple[EndpointDescriptor, ...]:
    candidates: List[EndpointDescriptor] = []
    labeled = _labeled_values(lines, ENDPOINT_LABELS)
    for item in labeled:
        endpoint = _parse_url(item.value, item.source) or _parse_nc(item.value, item.source) or _parse_host_port(item.value, item.source)
        if endpoint:
            candidates.append(endpoint)
    for line in lines:
        source = SourceRef(kind="syntax", line_start=line.number, line_end=line.number, raw=line.raw[:500])
        endpoint = _parse_url(line.raw, source) or _parse_nc(line.raw, source)
        if endpoint:
            candidates.append(endpoint)
    unique: List[EndpointDescriptor] = []
    seen = set()
    for item in candidates:
        marker = (item.protocol, item.host.lower(), item.port, item.url)
        if marker not in seen:
            seen.add(marker)
            unique.append(item)
    return tuple(unique)


def _asset_kind(path: str) -> str:
    lowered = path.lower()
    if lowered.endswith(("/", "\\")):
        return "directory"
    if PurePosixPath(lowered.replace("\\", "/")).suffix in {".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"}:
        return "archive"
    if PurePosixPath(lowered.replace("\\", "/")).suffix:
        return "file"
    return "unknown"


def _asset_status(path: str, project_root: Optional[str], task_dir: Optional[str]) -> Tuple[str, Optional[bool], str]:
    value = str(path or "").strip()
    if os.name == "nt" and value.startswith("/"):
        return _asset_kind(value), None, "container"
    try:
        candidate = Path(value).expanduser()
        if candidate.exists():
            return ("directory" if candidate.is_dir() else "file"), True, "host"
        roots = [Path(item).expanduser().resolve(strict=False) for item in (project_root, task_dir) if item]
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return _asset_kind(value), None, "unknown"
    if any(resolved == root or root in resolved.parents for root in roots):
        return _asset_kind(value), False, "host"
    return _asset_kind(value), None, "unknown"


def _assets(lines: Sequence[PromptLine], project_root: Optional[str], task_dir: Optional[str]) -> Tuple[AssetDescriptor, ...]:
    result: List[AssetDescriptor] = []
    seen = set()
    for item in _labeled_values(lines, ASSET_LABELS):
        path = item.value.strip()
        if path in seen:
            continue
        seen.add(path)
        kind, exists, scope = _asset_status(path, project_root, task_dir)
        result.append(
            AssetDescriptor(
                path=path,
                kind=kind,
                exists=exists,
                scope=scope,
                confidence=1.0,
                source=item.source,
            )
        )
    return tuple(result)


def _normalized_category(value: str) -> str:
    lowered = re.sub(r"[^a-z0-9_-]+", "", str(value or "").lower())
    return CATEGORY_ALIASES.get(lowered, "")


def _classification(text: str, lines: Sequence[PromptLine], target_id: str) -> Tuple[TaskClassification, Tuple[ParseDiagnostic, ...]]:
    scores: Dict[str, int] = {}
    signals: Dict[str, List[str]] = {}

    def add(category: str, score: int, signal: str) -> None:
        if not category:
            return
        scores[category] = scores.get(category, 0) + score
        signals.setdefault(category, []).append(signal)

    for item in _labeled_values(lines, CATEGORY_LABELS, limit=80):
        add(_normalized_category(item.value), 100, f"explicit_category:{item.value}")
    for part in target_id.replace("\\", "/").split("/"):
        category = _normalized_category(part)
        if category:
            add(category, 100, f"target_id_segment:{part}")

    keyword_rules = (
        ("forensics", r"\bforensics?\b|\u53d6\u8bc1|pcap|memory dump|disk image|stegan", 45),
        ("reverse", r"\breverse\b|reversing|\u9006\u5411|\u53cd\u7f16\u8bd1|crackme|\bapk\b|\bwasm\b", 45),
        ("pwn", r"\bpwn\b|binary exploitation|\u6808\u6ea2\u51fa|\u5806\u5229\u7528|\u683c\u5f0f\u5316\u5b57\u7b26\u4e32|checksec", 45),
        ("web", r"\bweb\b|\u7f51\u7ad9|\u7f51\u9875|sql\u6ce8\u5165|\bssti\b|\bxss\b|\bssrf\b", 45),
        ("crypto", r"\bcrypto(?:graphy)?\b|\u5bc6\u7801|\brsa\b|\baes\b|\becc\b", 45),
        ("osint", r"\bosint\b|open.source intelligence|\u5f00\u6e90\u60c5\u62a5", 45),
        ("malware", r"\bmalware\b|\u6076\u610f\u8f6f\u4ef6|\bransomware\b", 45),
        ("ai_ml", r"\bmachine learning\b|\bneural network\b|\bllm\b|\u673a\u5668\u5b66\u4e60", 35),
        ("misc", r"\bmisc(?:ellaneous)?\b|\u6742\u9879", 35),
    )
    lowered = text.lower()
    for category, pattern, score in keyword_rules:
        if re.search(pattern, lowered, re.IGNORECASE):
            add(category, score, f"keyword:{category}")
    if re.search(r"https?://", text, re.IGNORECASE):
        add("web", 15, "http_endpoint")

    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    candidates = tuple(CategoryCandidate(category=key, score=value, source=",".join(signals.get(key) or ())) for key, value in ranked)
    diagnostics: List[ParseDiagnostic] = []
    if not ranked:
        return TaskClassification(category="generic", confidence=0.0), ()
    winner, winning_score = ranked[0]
    if len(ranked) > 1 and winning_score >= 90 and ranked[1][1] >= 90 and winning_score - ranked[1][1] < 20:
        diagnostics.append(
            ParseDiagnostic(
                code="conflicting_categories",
                field="classification.category",
                message=f"Conflicting high-confidence categories: {winner} and {ranked[1][0]}",
            )
        )
        return TaskClassification(category="unknown", confidence=0.0, candidates=candidates), tuple(diagnostics)
    confidence = min(1.0, winning_score / 100.0)
    return TaskClassification(
        category=winner,
        confidence=confidence,
        candidates=candidates,
        signals=tuple(signals.get(winner) or ()),
    ), tuple(diagnostics)


def parse_task_descriptor(
    prompt: Any,
    *,
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
) -> TaskDescriptor:
    text = str(prompt or "")
    document = _lines(text)
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]
    target_values = _labeled_values(document, TARGET_ID_LABELS, limit=240)
    goal_values = _labeled_values(document, GOAL_LABELS, limit=1000)
    target_id = target_values[0].value if target_values else ""
    goal = goal_values[0].value if goal_values else ""
    title = target_id.replace("\\", "/").rstrip("/").split("/")[-1] if target_id else ""
    endpoints = _endpoints(text, document)
    assets = _assets(document, project_root, task_dir)
    classification, category_warnings = _classification(text, document, target_id)
    pure_attachment = bool(re.search(r"(?i)pure[ -]?attachment|\u7eaf\u9644\u4ef6", text))
    has_http = any(item.protocol in {"http", "https"} for item in endpoints)
    has_tcp = any(item.protocol == "tcp" for item in endpoints)
    has_assets = bool(assets)
    mode = "hybrid" if endpoints and assets else "remote" if endpoints else "local" if assets else "unknown"
    verification_tool = "verify_flag" if "verify_flag" in text else "check_flag" if "check_flag" in text else ""
    is_ctf = bool(target_id and ("<FINAL_ANSWER>" in text or verification_tool))
    verification = VerificationDescriptor(
        required=bool(is_ctf and verification_tool),
        tool=verification_tool,
        answer_format="flag" if is_ctf else "",
    )
    capabilities = TaskCapabilities(
        has_http_endpoint=has_http,
        has_tcp_endpoint=has_tcp,
        has_assets=has_assets,
        pure_attachment=pure_attachment,
        remote_only=bool(endpoints and not assets),
    )
    unknowns: List[str] = []
    if is_ctf and not target_id:
        unknowns.append("identity.target_id")
    if classification.category in {"generic", "unknown"}:
        unknowns.append("classification.category")
    if not endpoints and not assets:
        unknowns.append("task.entrypoint")
    if has_tcp:
        unknowns.extend(("tcp.application_protocol", "tcp.interaction_model"))
    provenance: Dict[str, Tuple[SourceRef, ...]] = {}
    if target_values:
        provenance["identity.target_id"] = tuple(item.source for item in target_values)
    if goal_values:
        provenance["identity.goal"] = tuple(item.source for item in goal_values)
    if endpoints:
        provenance["endpoints"] = tuple(item.source for item in endpoints)
    if assets:
        provenance["assets"] = tuple(item.source for item in assets)
    return TaskDescriptor(
        schema_version=SCHEMA_VERSION,
        prompt_digest=digest,
        is_ctf=is_ctf,
        sanitized_task_text=_sanitize_task_text(text),
        identity=TaskIdentity(target_id=target_id, title=title, goal=goal),
        classification=classification,
        mode=mode,
        endpoints=endpoints,
        assets=assets,
        verification=verification,
        capabilities=capabilities,
        unknowns=tuple(dict.fromkeys(unknowns)),
        warnings=category_warnings,
        provenance=provenance,
    )


def coerce_task_descriptor(
    value: Any = None,
    *,
    prompt: Any = "",
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
) -> TaskDescriptor:
    if isinstance(value, TaskDescriptor):
        return value
    if isinstance(value, dict) and value.get("schema_version"):
        return TaskDescriptor.from_dict(value)
    return parse_task_descriptor(prompt, project_root=project_root, task_dir=task_dir)
