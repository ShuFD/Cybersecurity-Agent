from __future__ import annotations

import re
import urllib.parse
from typing import Any, Dict, Iterable, List

from .base import result_data


def _paths(routes: Iterable[Any]) -> List[str]:
    out = []
    for route in routes or []:
        value = route.get("path") if isinstance(route, dict) else route
        value = str(value or "").strip()
        if value and value not in out:
            out.append(value)
    return out[:300]


def _parameters(forms: Iterable[Any], urls: Iterable[str]) -> List[str]:
    out = []
    for form in forms or []:
        for field in (form or {}).get("fields") or [] if isinstance(form, dict) else []:
            name = field.get("name") if isinstance(field, dict) else field
            if name and str(name) not in out:
                out.append(str(name))
    for url in urls or []:
        try:
            names = urllib.parse.parse_qs(urllib.parse.urlparse(str(url)).query).keys()
        except ValueError:
            names = []
        for name in names:
            if name not in out:
                out.append(name)
    return out[:200]


def _cookie_metadata(cookies: Iterable[Any]) -> List[Any]:
    out = []
    for cookie in cookies or []:
        if isinstance(cookie, dict):
            safe = {key: cookie.get(key) for key in ("name", "length", "sha256", "secure", "httponly", "samesite") if key in cookie}
            if safe:
                out.append(safe)
        else:
            name = str(cookie or "").split(";", 1)[0].split("=", 1)[0].strip()
            if name:
                out.append({"name": name})
    return out[:50]


def extract_web(*, tool_name: str, args: Dict[str, Any], result: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    lowered = str(tool_name or "").lower()
    if "web" not in lowered and not (isinstance(result, dict) and result.get("verb")):
        return {"facts": [], "hypotheses": []}
    data = result_data(result)
    facts = []
    urls = []
    for key in ("url", "source_url", "base_url"):
        if data.get(key):
            urls.append(str(data.get(key)))
    for item in data.get("links") or []:
        value = item.get("url") if isinstance(item, dict) else item
        if value:
            urls.append(str(value))
    if urls:
        facts.append({"key": "web.urls", "value": list(dict.fromkeys(urls))[:300], "merge": "union", "confidence": 1.0})
    if isinstance(data.get("status_code"), int):
        facts.append({"key": "web.last_status_code", "value": data.get("status_code"), "confidence": 1.0})
    if data.get("content_type"):
        facts.append({"key": "web.content_types", "value": [str(data.get("content_type"))], "merge": "union", "confidence": 1.0})

    routes = _paths(data.get("routes") or [])
    if not routes:
        interesting = [item.get("path") for item in data.get("results") or [] if isinstance(item, dict) and item.get("interesting")]
        routes = _paths(interesting)
    if routes:
        facts.append({"key": "web.routes", "value": routes, "merge": "union", "confidence": 0.95})

    forms = data.get("forms") or []
    if isinstance(forms, list) and forms:
        facts.append({"key": "web.forms", "value": forms[:80], "merge": "union", "confidence": 1.0})
        facts.append({"key": "web.has_forms", "value": True, "confidence": 1.0})
    parameters = _parameters(forms, urls)
    if parameters:
        facts.append({"key": "web.parameters", "value": parameters, "merge": "union", "confidence": 0.95})

    headers = data.get("headers")
    if isinstance(headers, dict) and headers:
        safe_headers = {
            str(key).lower(): value
            for key, value in headers.items()
            if str(key).lower() not in {"authorization", "cookie", "set-cookie"}
        }
        facts.append({"key": "web.headers", "value": safe_headers, "merge": "dict", "confidence": 1.0})
        server = " ".join(str(safe_headers.get(key) or "") for key in ("server", "x-powered-by"))
        hints = []
        for pattern, name in (
            (r"werkzeug|flask", "python-flask"),
            (r"django", "python-django"),
            (r"express", "node-express"),
            (r"php", "php"),
            (r"asp\.net|iis", "aspnet"),
            (r"nginx", "nginx"),
            (r"apache", "apache"),
        ):
            if re.search(pattern, server, re.IGNORECASE):
                hints.append(name)
        if hints:
            facts.append({"key": "web.framework_hints", "value": hints, "merge": "union", "confidence": 0.8})
    cookies = data.get("cookies") or data.get("set_cookies") or []
    if cookies:
        facts.append({"key": "web.cookie_metadata", "value": _cookie_metadata(cookies), "merge": "union", "confidence": 1.0})
        facts.append({"key": "web.has_cookies", "value": True, "confidence": 1.0})
    if data.get("saved_path"):
        facts.append({"key": "web.downloaded_assets", "value": [str(data.get("saved_path"))], "merge": "union", "confidence": 1.0})
    if data.get("json") is not None:
        facts.append({"key": "web.json_response_observed", "value": True, "confidence": 1.0})
    return {"facts": facts, "hypotheses": []}
