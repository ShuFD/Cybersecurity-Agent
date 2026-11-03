import re
from datetime import date
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
INCLUDE_PATTERN = re.compile(r"^[ \t]*@include[ \t]+(.+?)[ \t]*$", re.MULTILINE)
TEMPLATE_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")
MAX_INCLUDE_DEPTH = 8


def _is_within_root(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _resolve_include_path(include_target, including_file, project_root):
    raw = include_target.strip().strip('"').strip("'")
    candidate = Path(raw)
    if not candidate.is_absolute():
        project_candidate = project_root / raw
        local_candidate = including_file.parent / raw
        candidate = project_candidate if project_candidate.exists() else local_candidate
    return candidate.resolve()


def _template_values(path, project_root):
    path = Path(path).resolve()
    project_root = Path(project_root).resolve()
    return {
        "PROJECT_ROOT": str(project_root),
        "RULE_FILE": str(path),
        "RULE_DIR": str(path.parent),
        "DATE": date.today().isoformat(),
    }


def _expand_template_variables(text, path, project_root):
    values = _template_values(path, project_root)

    def replace_var(match):
        name = match.group(1)
        return values.get(name, match.group(0))

    return TEMPLATE_PATTERN.sub(replace_var, text)


def _expand_includes(path, project_root, seen=None, depth=0):
    path = Path(path).resolve()
    project_root = Path(project_root).resolve()
    seen = set(seen or ())
    if depth > MAX_INCLUDE_DEPTH:
        return f"[include skipped: max depth exceeded for {path}]\n"
    if not _is_within_root(path, project_root):
        return f"[include skipped: outside project root: {path}]\n"
    if path in seen:
        return f"[include skipped: cycle: {path}]\n"
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        return f"[include skipped: {path}: {e}]\n"
    text = _expand_template_variables(text, path, project_root)

    next_seen = {*seen, path}

    def replace_include(match):
        include_path = _resolve_include_path(match.group(1), path, project_root)
        return _expand_includes(include_path, project_root, next_seen, depth + 1).rstrip("\n")

    return INCLUDE_PATTERN.sub(replace_include, text)


def load_project_prompt_extensions(project_root=None):
    root = Path(project_root or PROJECT_ROOT).resolve()
    rules_dir = root / ".secheur-agent" / "rules"
    if not rules_dir.is_dir():
        return ""
    rule_files = sorted(p for p in rules_dir.glob("*.md") if p.is_file())
    if not rule_files:
        return ""

    parts = ["# Project Rules", ""]
    for path in rule_files:
        rel = path.relative_to(root)
        parts.append(f"## {rel}")
        parts.append(_expand_includes(path, root).strip())
        parts.append("")
    return "\n".join(parts).strip() + "\n"
