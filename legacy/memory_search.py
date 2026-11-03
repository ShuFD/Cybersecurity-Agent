import os
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_MEMORY_DIR = PROJECT_ROOT / "memory"
MEMORY_EXTENSIONS = {".md", ".txt", ".py"}
SKIP_DIRS = {"__pycache__", ".git", ".venv"}
MANAGED_INDEX_DIRS = {"attack_memory"}


def _terms(query):
    return [
        t
        for t in re.findall(r"[\w\u4e00-\u9fff]+", (query or "").lower())
        if len(t) > 1
    ]


def _iter_memory_files(memory_dir):
    base = Path(memory_dir or DEFAULT_MEMORY_DIR)
    if not base.is_dir():
        return
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and d not in MANAGED_INDEX_DIRS]
        root_path = Path(root)
        for name in sorted(files):
            path = root_path / name
            if path.suffix.lower() not in MEMORY_EXTENSIONS:
                continue
            yield path


def _score(path, text, terms):
    hay = text.lower()
    rel = str(path).lower()
    score = 0
    for term in terms:
        score += hay.count(term)
        if term in rel:
            score += 3
    return score


def _snippet(text, terms, context_chars):
    lower = text.lower()
    positions = [lower.find(term) for term in terms if lower.find(term) >= 0]
    pos = min(positions) if positions else 0
    start = max(0, pos - context_chars // 2)
    end = min(len(text), pos + context_chars // 2)
    snippet = text[start:end].strip()
    return re.sub(r"\s+", " ", snippet)


def _attack_memory_matches(query, memory_dir, limit):
    try:
        from ctf_attack_memory.index import attack_hits_for_memory_search
    except Exception:
        return []
    try:
        return attack_hits_for_memory_search(query, memory_dir=memory_dir, limit=limit)
    except Exception:
        return []


def search_memory(
    query,
    memory_dir=None,
    limit=5,
    context_chars=360,
    max_file_chars=200_000,
    include_attack_memory=False,
):
    terms = _terms(query)
    if not terms and not str(query or "").strip():
        return []
    base = Path(memory_dir or DEFAULT_MEMORY_DIR)
    matches = []
    if terms:
        for path in _iter_memory_files(base) or []:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")[
                    :max_file_chars
                ]
            except OSError:
                continue
            score = _score(path, text, terms)
            if score <= 0:
                continue
            try:
                rel = str(path.relative_to(base))
            except ValueError:
                rel = str(path)
            matches.append(
                {
                    "path": rel,
                    "score": score,
                    "snippet": _snippet(text, terms, context_chars),
                }
            )
    result_limit = max(1, int(limit or 5))
    if include_attack_memory:
        attack_matches = _attack_memory_matches(query, base, result_limit)
        # A crypto knowledge card is the curated runtime boundary.  Do not let
        # unrelated operational-memory files outrank it merely because they
        # repeat query terms more often.
        knowledge_cards = [
            item for item in attack_matches if item.get("kind") == "knowledge_card"
        ]
        if knowledge_cards:
            return knowledge_cards[:result_limit]
        matches.extend(attack_matches)
    matches.sort(
        key=lambda item: (
            -float(item.get("score", 0)),
            item.get("path", ""),
            item.get("record_id", ""),
        )
    )
    return matches[:result_limit]
