import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


MAX_BODY_BYTES = 2_000_000
MAX_TEXT_CHARS = 80_000
MAX_SOURCE_FILES = 160
SKIP_DIRS = {".git", "__pycache__", ".venv", "venv", "node_modules", ".pytest_cache", "memory", "temp"}
SOURCE_EXTS = {".py", ".js", ".ts", ".php", ".rb", ".go", ".java", ".html", ".htm"}
COMMON_PATHS = [
    "/",
    "/robots.txt",
    "/sitemap.xml",
    "/admin",
    "/login",
    "/logout",
    "/api",
    "/api/health",
    "/api/v1",
    "/flag",
    "/.git/HEAD",
    "/debug",
    "/console",
    "/static/app.js",
]


@dataclass(frozen=True)
class VerbSpec:
    name: str
    description: str
    policy_tags: Tuple[str, ...]
    required_args: Tuple[str, ...]
    handler: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]


class LinkAndFormParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title_parts: List[str] = []
        self.links: List[Dict[str, str]] = []
        self.forms: List[Dict[str, Any]] = []
        self._in_title = False
        self._current_form: Optional[Dict[str, Any]] = None

    def handle_starttag(self, tag, attrs):
        attrs_dict = {str(k).lower(): str(v or "") for k, v in attrs}
        tag_l = str(tag or "").lower()
        if tag_l == "title":
            self._in_title = True
        elif tag_l == "a" and attrs_dict.get("href"):
            self.links.append({"href": attrs_dict.get("href", ""), "text": ""})
        elif tag_l == "form":
            self._current_form = {
                "method": (attrs_dict.get("method") or "GET").upper(),
                "action": attrs_dict.get("action") or "",
                "fields": [],
            }
        elif self._current_form is not None and tag_l in {"input", "textarea", "select", "button"}:
            field = {
                "tag": tag_l,
                "name": attrs_dict.get("name") or "",
                "type": attrs_dict.get("type") or tag_l,
                "value": attrs_dict.get("value") or "",
            }
            if field["name"] or tag_l == "button":
                self._current_form["fields"].append(field)

    def handle_endtag(self, tag):
        tag_l = str(tag or "").lower()
        if tag_l == "title":
            self._in_title = False
        elif tag_l == "form" and self._current_form is not None:
            self.forms.append(self._current_form)
            self._current_form = None

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(str(data or "").strip())


def get_specs() -> Dict[str, VerbSpec]:
    return {
        "web.fetch": VerbSpec(
            "web.fetch",
            "Fetch an HTTP page and return status, title, links, text, and evidence metadata.",
            ("read_only", "network"),
            ("url",),
            verb_fetch,
        ),
        "web.fetch_json": VerbSpec(
            "web.fetch_json",
            "Fetch an HTTP endpoint and parse the response as JSON.",
            ("read_only", "network"),
            ("url",),
            verb_fetch_json,
        ),
        "web.inspect_headers": VerbSpec(
            "web.inspect_headers",
            "Inspect HTTP status and response headers with a HEAD request and GET fallback.",
            ("read_only", "network"),
            ("url",),
            verb_inspect_headers,
        ),
        "web.check_common_files": VerbSpec(
            "web.check_common_files",
            "Probe common CTF web paths such as robots.txt, admin, API roots, and flag hints.",
            ("read_only", "network", "ctf_probe"),
            ("base_url",),
            verb_check_common_files,
        ),
        "web.search_source_routes": VerbSpec(
            "web.search_source_routes",
            "Extract likely routes from Flask, FastAPI, Express, PHP, and HTML source files.",
            ("read_only",),
            (),
            verb_search_source_routes,
        ),
        "web.enumerate_routes": VerbSpec(
            "web.enumerate_routes",
            "Combine source route extraction and light live probing into a structured route list.",
            ("read_only", "network", "ctf_probe"),
            (),
            verb_enumerate_routes,
        ),
        "web.extract_forms": VerbSpec(
            "web.extract_forms",
            "Fetch a page and extract HTML forms with methods, actions, and fields.",
            ("read_only", "network"),
            ("url",),
            verb_extract_forms,
        ),
        "web.submit_form": VerbSpec(
            "web.submit_form",
            "Submit an HTML form or equivalent URL-encoded request and return the structured response.",
            ("network", "state_changing"),
            ("url", "fields"),
            verb_submit_form,
        ),
        "web.inspect_cookies": VerbSpec(
            "web.inspect_cookies",
            "Inspect Set-Cookie headers or a provided Cookie header without logging full secrets.",
            ("read_only", "network", "credential_sensitive"),
            (),
            verb_inspect_cookies,
        ),
        "web.download_asset": VerbSpec(
            "web.download_asset",
            "Download an asset to tool_results/web_verbs/assets and return path, hash, and metadata.",
            ("read_only", "network", "file_write"),
            ("url",),
            verb_download_asset,
        ),
    }


def verb_fetch(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    response = _http_request(str(args.get("url") or ""), timeout=_timeout(args), headers=_headers(args))
    text = _decode_body(response["body"], response["headers"])
    parser = _parse_html(text)
    return {
        "url": response["url"],
        "status_code": response["status_code"],
        "content_type": response["headers"].get("content-type", ""),
        "title": " ".join(parser.title_parts).strip(),
        "links": parser.links[:80],
        "text": _html_to_text(text)[: int(args.get("max_text_chars") or MAX_TEXT_CHARS)],
        "body_sha256": _sha256_bytes(response["body"]),
    }


def verb_fetch_json(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    response = _http_request(str(args.get("url") or ""), timeout=_timeout(args), headers=_headers(args))
    text = _decode_body(response["body"], response["headers"])
    try:
        parsed = json.loads(text)
        status = "success"
        error = ""
    except Exception as exc:
        parsed = None
        status = "parse_error"
        error = f"{type(exc).__name__}: {exc}"
    return {
        "status": status,
        "url": response["url"],
        "status_code": response["status_code"],
        "content_type": response["headers"].get("content-type", ""),
        "json": parsed,
        "text_preview": text[:4000],
        "error": error,
    }


def verb_inspect_headers(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    url = str(args.get("url") or "")
    try:
        response = _http_request(url, method="HEAD", timeout=_timeout(args), headers=_headers(args))
        method = "HEAD"
    except Exception:
        response = _http_request(url, method="GET", timeout=_timeout(args), headers=_headers(args), max_bytes=0)
        method = "GET"
    return {
        "url": response["url"],
        "method": method,
        "status_code": response["status_code"],
        "headers": _safe_headers(response["headers"]),
    }


def verb_check_common_files(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    base_url = _base_url(str(args.get("base_url") or args.get("url") or ""))
    paths = args.get("paths") if isinstance(args.get("paths"), list) else COMMON_PATHS
    hits = []
    for path in paths[:80]:
        url = urllib.parse.urljoin(base_url + "/", str(path).lstrip("/"))
        try:
            response = _http_request(url, timeout=_timeout(args), headers=_headers(args), max_bytes=4096)
            body = _decode_body(response["body"], response["headers"])
            hits.append(
                {
                    "path": "/" + str(path).lstrip("/"),
                    "url": response["url"],
                    "status_code": response["status_code"],
                    "content_type": response["headers"].get("content-type", ""),
                    "interesting": response["status_code"] < 400 and bool(body.strip()),
                    "preview": _one_line(body[:500]),
                }
            )
        except Exception as exc:
            hits.append({"path": "/" + str(path).lstrip("/"), "status": "error", "error": str(exc)[:180]})
    return {"base_url": base_url, "results": hits}


def verb_search_source_routes(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    source_dir = Path(str(args.get("source_dir") or context.get("cwd") or ".")).resolve()
    routes = []
    for path in _iter_source_files(source_dir):
        rel = _safe_rel(path, source_dir)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        routes.extend(_routes_from_text(text, rel))
    routes = _dedupe_routes(routes)
    return {"source_dir": str(source_dir), "routes": routes[:300], "route_count": len(routes)}


def verb_enumerate_routes(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    source = verb_search_source_routes(args, context) if (args.get("source_dir") or context.get("cwd")) else {"routes": []}
    live = {}
    if args.get("base_url") or args.get("url"):
        live = verb_check_common_files({"base_url": args.get("base_url") or args.get("url"), **args}, context)
    routes = list(source.get("routes") or [])
    for item in live.get("results") or []:
        if item.get("interesting"):
            routes.append(
                {
                    "method": "GET",
                    "path": item.get("path") or "",
                    "source": "live_probe",
                    "confidence": 0.55,
                    "status_code": item.get("status_code"),
                    "content_type": item.get("content_type", ""),
                }
            )
    routes = _dedupe_routes(routes)
    return {"routes": routes[:300], "source_routes": source.get("route_count", 0), "live_probe": live}


def verb_extract_forms(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    response = _http_request(str(args.get("url") or ""), timeout=_timeout(args), headers=_headers(args))
    text = _decode_body(response["body"], response["headers"])
    parser = _parse_html(text)
    base = response["url"]
    forms = []
    for idx, form in enumerate(parser.forms):
        item = dict(form)
        item["id"] = f"form-{idx}"
        item["resolved_action"] = urllib.parse.urljoin(base, item.get("action") or base)
        forms.append(item)
    return {"url": base, "forms": forms, "form_count": len(forms)}


def verb_submit_form(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    url = str(args.get("action") or args.get("url") or "")
    method = str(args.get("method") or "POST").upper()
    fields = args.get("fields") if isinstance(args.get("fields"), dict) else {}
    headers = {"Content-Type": "application/x-www-form-urlencoded", **_headers(args)}
    body = urllib.parse.urlencode({str(k): str(v) for k, v in fields.items()}).encode("utf-8")
    response = _http_request(url, method=method, data=body if method != "GET" else None, timeout=_timeout(args), headers=headers)
    text = _decode_body(response["body"], response["headers"])
    return {
        "url": response["url"],
        "method": method,
        "status_code": response["status_code"],
        "content_type": response["headers"].get("content-type", ""),
        "text": _html_to_text(text)[: int(args.get("max_text_chars") or 12000)],
        "set_cookies": _cookie_previews(response["headers"].get("set-cookie", "")),
    }


def verb_inspect_cookies(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    raw_values: List[str] = []
    if args.get("cookie_header"):
        raw_values.append(str(args.get("cookie_header") or ""))
    if args.get("url"):
        response = _http_request(str(args.get("url") or ""), timeout=_timeout(args), headers=_headers(args), max_bytes=1024)
        if response["headers"].get("set-cookie"):
            raw_values.append(response["headers"].get("set-cookie", ""))
    cookies = []
    for raw in raw_values:
        cookies.extend(_cookie_previews(raw))
    return {"cookie_count": len(cookies), "cookies": cookies}


def verb_download_asset(args: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    response = _http_request(str(args.get("url") or ""), timeout=_timeout(args), headers=_headers(args))
    root = _artifact_root(context)
    root.mkdir(parents=True, exist_ok=True)
    name = _safe_filename(Path(urllib.parse.urlparse(response["url"]).path).name or "asset.bin")
    suffix = hashlib.sha1((response["url"] + str(time.time())).encode()).hexdigest()[:8]
    path = root / f"{Path(name).stem[:40]}-{suffix}{Path(name).suffix[:12]}"
    path.write_bytes(response["body"])
    return {
        "url": response["url"],
        "saved_path": str(path),
        "size": len(response["body"]),
        "sha256": _sha256_bytes(response["body"]),
        "content_type": response["headers"].get("content-type", ""),
    }


def _http_request(
    url: str,
    *,
    method: str = "GET",
    data: Optional[bytes] = None,
    timeout: float = 12,
    headers: Optional[Dict[str, str]] = None,
    max_bytes: int = MAX_BODY_BYTES,
) -> Dict[str, Any]:
    if not url:
        raise ValueError("url is required")
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": "SecHeur-WebVerb/1.0", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(max_bytes) if max_bytes else b""
            return {"url": resp.geturl(), "status_code": int(resp.status), "headers": _headers_dict(resp.headers), "body": body}
    except urllib.error.HTTPError as exc:
        body = exc.read(max_bytes) if max_bytes else b""
        return {"url": exc.geturl(), "status_code": int(exc.code), "headers": _headers_dict(exc.headers), "body": body}


def _headers(args: Dict[str, Any]) -> Dict[str, str]:
    raw = args.get("headers")
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items()}


def _timeout(args: Dict[str, Any]) -> float:
    try:
        return min(60.0, max(2.0, float(args.get("timeout") or 12)))
    except Exception:
        return 12.0


def _headers_dict(headers) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key in headers.keys():
        values = headers.get_all(key) if hasattr(headers, "get_all") else [headers.get(key)]
        out[str(key).lower()] = ", ".join(str(v) for v in values if v is not None)
    return out


def _safe_headers(headers: Dict[str, str]) -> Dict[str, str]:
    out = {}
    for key, value in headers.items():
        if key.lower() in {"set-cookie", "cookie", "authorization"}:
            out[key] = _secret_preview(value)
        else:
            out[key] = value
    return out


def _parse_html(text: str) -> LinkAndFormParser:
    parser = LinkAndFormParser()
    try:
        parser.feed(text or "")
    except Exception:
        pass
    return parser


def _html_to_text(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text or "")
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _decode_body(body: bytes, headers: Dict[str, str]) -> str:
    content_type = headers.get("content-type", "")
    match = re.search(r"charset=([\w.-]+)", content_type, flags=re.I)
    encoding = match.group(1) if match else "utf-8"
    return body.decode(encoding, errors="replace")


def _iter_source_files(root: Path) -> Iterable[Path]:
    count = 0
    if not root.exists():
        return []
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".cache")]
        for name in sorted(files):
            path = Path(current) / name
            if path.suffix.lower() not in SOURCE_EXTS and name not in {"Dockerfile", "docker-compose.yml"}:
                continue
            count += 1
            if count > MAX_SOURCE_FILES:
                return
            yield path


def _routes_from_text(text: str, source: str) -> List[Dict[str, Any]]:
    routes: List[Dict[str, Any]] = []
    patterns = [
        (r"@[\w.]+\.route\(\s*['\"]([^'\"]+)['\"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?", "PY_ROUTE"),
        (r"@[\w.]+\.(get|post|put|delete|patch)\(\s*['\"]([^'\"]+)['\"]", "PY_METHOD"),
        (r"\b(?:app|router)\.(get|post|put|delete|patch|all)\(\s*['\"`]([^'\"`]+)['\"`]", "EXPRESS"),
        (r"\bRoute::(get|post|put|delete|patch|any)\(\s*['\"]([^'\"]+)['\"]", "LARAVEL"),
    ]
    for pattern, kind in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            if kind == "PY_ROUTE":
                path = match.group(1)
                methods_raw = match.group(2) or "GET"
                methods = re.findall(r"['\"]?([A-Z]{3,7})['\"]?", methods_raw.upper()) or ["GET"]
            else:
                methods = [match.group(1).upper()]
                path = match.group(2)
            for method in methods:
                routes.append({"method": method, "path": path, "source": source, "confidence": 0.9})
    if source.endswith(".php"):
        route = "/" + source.replace("\\", "/")
        if route.endswith("/index.php"):
            route = route[: -len("index.php")]
        routes.append({"method": "GET", "path": route, "source": source, "confidence": 0.5})
    return routes


def _dedupe_routes(routes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for route in routes:
        key = (route.get("method", "GET"), route.get("path", ""))
        if not key[1] or key in seen:
            continue
        seen.add(key)
        out.append(route)
    return out


def _cookie_previews(raw: str) -> List[Dict[str, str]]:
    cookies = []
    for piece in re.split(r",\s*(?=[A-Za-z0-9_.-]+=)", raw or ""):
        first = piece.split(";", 1)[0].strip()
        if "=" not in first:
            continue
        name, value = first.split("=", 1)
        cookies.append({"name": name.strip(), "preview": _secret_preview(value.strip()), "sha256": hashlib.sha256(value.strip().encode()).hexdigest()})
    return cookies


def _secret_preview(value: str) -> str:
    value = str(value or "")
    if len(value) <= 10:
        return value[:2] + "..." if value else ""
    return value[:6] + "..." + value[-4:]


def _artifact_root(context: Dict[str, Any]) -> Path:
    base = Path(str(context.get("run_dir") or context.get("cwd") or ".")).resolve()
    return base / "tool_results" / "web_verbs" / "assets"


def _base_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme:
        url = "http://" + url
        parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "", "", "", "")).rstrip("/")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data or b"").hexdigest()


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _safe_rel(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve())).replace(os.sep, "/")
    except Exception:
        return path.name


def _safe_filename(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name or "asset.bin")).strip("._") or "asset.bin"
