import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


MODULE_ROOT = Path(__file__).resolve().parent.parent
MEMORY_DIR_ENV = "SECHEUR_WEB_VERB_MEMORY_DIR"
WEB_SIGNAL_FILES = {
    "app.py",
    "server.py",
    "main.py",
    "index.php",
    "package.json",
    "routes.js",
    "Dockerfile",
    "docker-compose.yml",
}
WEB_EXTS = {".py", ".js", ".ts", ".php", ".html", ".htm", ".json"}
SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".pytest_cache", "memory", "temp"}


def build_web_verb_context(
    prompt: Any,
    *,
    project_root: Optional[str] = None,
    task_dir: Optional[str] = None,
    enabled: bool = True,
) -> Dict[str, Any]:
    root = _first_existing_dir(task_dir, project_root, os.getcwd()) or Path(os.getcwd())
    text_signals = _extract_text_signals(str(prompt or ""))
    file_signals = _extract_file_signals(root)
    traits = sorted(set(text_signals["traits"] + file_signals["traits"]))
    urls = sorted(set(text_signals["urls"]))
    is_web_task = bool(urls or traits or file_signals["web_files"])
    recommended = _recommend_verbs(traits, urls, file_signals)
    digest_payload = {
        "traits": traits,
        "url_host_count": len({re.sub(r"^https?://", "", url).split("/", 1)[0] for url in urls}),
        "web_file_tokens": sorted(file_signals["tokens"])[:80],
    }
    digest = hashlib.sha256(json.dumps(digest_payload, sort_keys=True).encode()).hexdigest()[:16]
    return {
        "enabled": bool(enabled),
        "is_web_task": is_web_task,
        "root": str(root),
        "digest": digest,
        "traits": traits,
        "urls": urls[:12],
        "web_files": file_signals["web_files"][:30],
        "recommended_tools": ["web_verb_call"] if is_web_task else [],
        "recommended_verbs": recommended,
    }


def format_web_verb_prompt(context: Dict[str, Any]) -> str:
    if not context or not context.get("enabled"):
        return ""
    verbs = context.get("recommended_verbs") or []
    if not context.get("is_web_task"):
        verbs = ["web.fetch", "web.inspect_headers", "web.check_common_files"]
    lines = [
        "[Web Verb Typed Actions]",
        "The frontend Web Verb switch is ON for this turn. This is independent from heuristic-learning.",
        "For Web, HTTP, browser, and Web CTF work, prefer typed web actions through the `web_verb_call` tool before raw clicks, DOM scripts, or ad-hoc curl.",
        f"Detected web traits: {', '.join(context.get('traits') or []) or 'none'}",
        f"Observed URLs: {', '.join(context.get('urls') or []) or 'none'}",
        f"Recommended verbs: {', '.join(verbs) or 'none'}",
        "Call format: web_verb_call({\"verb\":\"web.extract_forms\", \"args\":{\"url\":\"http://host/login\"}}).",
        "Each verb returns structured data and writes a web_verb_trace.jsonl record for reproducibility.",
        "If a verb returns structured failure, replan at the verb level or then fall back to lower-level web tools.",
    ]
    return "\n".join(lines)


def record_success(*, parent: Any, handler: Any, oracle_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not getattr(parent, "web_verbs_enabled", False):
        return {"status": "disabled"}
    used = list(getattr(parent, "web_verbs_used", []) or [])
    if not used:
        return {"status": "no_verbs_used"}
    if getattr(parent, "_web_verb_success_recorded", False):
        return {"status": "already_recorded"}

    context = getattr(parent, "web_verb_context", None) or {}
    memory_dir = _memory_dir()
    memory_dir.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": _utc_now(),
        "fingerprint_digest": context.get("digest"),
        "traits": context.get("traits") or [],
        "urls": context.get("urls") or [],
        "used_verbs": used,
        "oracle_status": (oracle_result or {}).get("status") or ("correct" if (oracle_result or {}).get("correct") else ""),
        "attempt": (oracle_result or {}).get("attempt") or (oracle_result or {}).get("attempts_total"),
    }
    _append_jsonl(memory_dir / "web_verb_success_cases.jsonl", entry)
    update = _update_rule(memory_dir / "web_verb_rules.jsonl", context, used)
    setattr(parent, "_web_verb_success_recorded", True)
    return {"status": "recorded", "memory_dir": str(memory_dir), "rule_update": update, "used_verbs": used}


def _extract_text_signals(text: str) -> Dict[str, Any]:
    urls = re.findall(r"https?://[^\s'\"<>]+", text or "", flags=re.I)
    lowered = text.lower()
    traits = []
    checks = {
        "http_service": r"https?://|localhost:\d+|127\.0\.0\.1:\d+|:\d{2,5}\b",
        "html_form": r"\bform\b|login|username|password|csrf|submit",
        "api_endpoint": r"\bapi\b|json|graphql|endpoint",
        "cookie_or_jwt": r"\bcookie\b|session|jwt|bearer|token",
        "web_source": r"flask|fastapi|express|php|django|route|app\.route|router\.",
        "asset_download": r"download|captcha|image|attachment|static|source map|bundle",
    }
    for trait, pattern in checks.items():
        if re.search(pattern, lowered, flags=re.I):
            traits.append(trait)
    return {"urls": urls, "traits": traits}


def _extract_file_signals(root: Path) -> Dict[str, Any]:
    web_files = []
    traits = []
    tokens = set()
    if not root.exists():
        return {"web_files": [], "traits": [], "tokens": []}
    for path in _iter_files(root):
        rel = _safe_rel(path, root)
        name_l = path.name.lower()
        if path.name in WEB_SIGNAL_FILES or path.suffix.lower() in WEB_EXTS:
            web_files.append(rel)
            tokens.update(re.findall(r"[A-Za-z0-9]{2,32}", rel.lower()))
        if path.name in {"package.json", "routes.js"}:
            traits.append("javascript_source")
        if path.name in {"app.py", "server.py", "main.py"}:
            traits.append("python_web_source")
        if path.name == "index.php" or path.suffix.lower() == ".php":
            traits.append("php_source")
        if path.name in {"Dockerfile", "docker-compose.yml"}:
            traits.append("deployable_service")
    return {"web_files": web_files, "traits": sorted(set(traits + (["web_source"] if web_files else []))), "tokens": sorted(tokens)}


def _recommend_verbs(traits: List[str], urls: List[str], file_signals: Dict[str, Any]) -> List[str]:
    traits_set = set(traits)
    verbs = []
    if urls:
        verbs.extend(["web.inspect_headers", "web.fetch", "web.check_common_files"])
    if "web_source" in traits_set or file_signals.get("web_files"):
        verbs.extend(["web.search_source_routes", "web.enumerate_routes"])
    if traits_set & {"html_form", "web_source", "python_web_source", "php_source"}:
        verbs.extend(["web.extract_forms", "web.submit_form"])
    if "api_endpoint" in traits_set:
        verbs.extend(["web.fetch_json", "web.enumerate_routes"])
    if "cookie_or_jwt" in traits_set:
        verbs.append("web.inspect_cookies")
    if "asset_download" in traits_set:
        verbs.append("web.download_asset")
    if not verbs and (urls or file_signals.get("web_files")):
        verbs.extend(["web.fetch", "web.inspect_headers"])
    return _dedupe(verbs)[:12]


def _update_rule(path: Path, context: Dict[str, Any], used: List[Dict[str, Any]]) -> Dict[str, Any]:
    rules = _read_jsonl(path)
    rule_id = "web/" + str(context.get("digest") or hashlib.sha1(json.dumps(context, sort_keys=True).encode()).hexdigest()[:16])
    used_names = _dedupe(item.get("verb") for item in used if item.get("verb"))
    for rule in rules:
        if rule.get("id") == rule_id:
            rule["success_count"] = int(rule.get("success_count") or 0) + 1
            rule["last_success"] = _utc_now()
            rule["verbs"] = _dedupe(list(rule.get("verbs") or []) + used_names)
            _write_jsonl(path, rules)
            return {"status": "updated", "rule_id": rule_id, "success_count": rule["success_count"]}
    rules.append(
        {
            "id": rule_id,
            "created": _utc_now(),
            "last_success": _utc_now(),
            "success_count": 1,
            "traits": context.get("traits") or [],
            "verbs": used_names,
        }
    )
    _write_jsonl(path, rules)
    return {"status": "created", "rule_id": rule_id, "success_count": 1}


def _iter_files(root: Path) -> Iterable[Path]:
    count = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".cache")]
        for name in sorted(files):
            count += 1
            if count > 220:
                return
            yield Path(current) / name


def _memory_dir() -> Path:
    configured = os.environ.get(MEMORY_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return MODULE_ROOT / "memory"


def _append_jsonl(path: Path, item: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _write_jsonl(path: Path, items: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    tmp.replace(path)


def _dedupe(values) -> List[str]:
    out = []
    for value in values or []:
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace(os.sep, "/")
    except Exception:
        return path.name


def _first_existing_dir(*values: Any) -> Optional[Path]:
    for value in values:
        if not value:
            continue
        try:
            path = Path(value).expanduser().resolve()
        except Exception:
            continue
        if path.is_dir():
            return path
    return None


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
