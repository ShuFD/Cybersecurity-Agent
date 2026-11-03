import json
import re
from dataclasses import dataclass
from pathlib import Path

from registry_state import is_enabled


PROJECT_ROOT = Path(__file__).resolve().parent


@dataclass
class FrontmatterResult:
    meta: dict
    body: str


@dataclass
class SkillDefinition:
    name: str
    description: str
    when_to_use: str = ""
    allowed_tools: list[str] | None = None
    user_invocable: bool = True
    context: str = "inline"
    prompt_template: str = ""
    source: str = "project"
    skill_dir: str = ""


_cached_skills = None


def parse_frontmatter(content):
    lines = content.split("\n")
    if not lines or lines[0].strip() != "---":
        return FrontmatterResult({}, content.strip())
    end_idx = -1
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx < 0:
        return FrontmatterResult({}, content.strip())

    meta = {}
    for line in lines[1:end_idx]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key:
            meta[key] = value.strip().strip('"').strip("'")
    return FrontmatterResult(meta, "\n".join(lines[end_idx + 1:]).strip())


def _default_user_skill_dir():
    return None


def _default_project_skill_dir(project_root=None):
    return Path(project_root or PROJECT_ROOT) / ".secheur-agent" / "skills"


def _normalize_skill_dirs(value, project_root=None):
    if value is None:
        return []
    if isinstance(value, (str, Path)):
        raw_items = str(value).splitlines() if isinstance(value, str) else [value]
    else:
        raw_items = list(value)
    root = Path(project_root or PROJECT_ROOT)
    dirs = []
    seen = set()
    for item in raw_items:
        text = str(item).strip()
        if not text:
            continue
        path = Path(text).expanduser()
        if not path.is_absolute():
            path = root / path
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        dirs.append(path)
    return dirs


def project_skill_dirs(project_root=None, extra_skill_dirs=None):
    root = Path(project_root or PROJECT_ROOT)
    return [
        root / "skill",
        root / "skills",
        root / ".secheur-agent" / "skills",
        *_normalize_skill_dirs(extra_skill_dirs, project_root=root),
    ]


def _default_project_skill_dirs(project_root=None):
    return project_skill_dirs(project_root)


def reset_skill_cache():
    global _cached_skills
    _cached_skills = None


def _parse_allowed_tools(value):
    if not value:
        return None
    value = str(value).strip()
    if value.startswith("["):
        try:
            parsed = json.loads(value)
            return [str(item).strip() for item in parsed if str(item).strip()]
        except Exception:
            value = value.strip("[]")
    return [item.strip().strip('"').strip("'") for item in value.split(",") if item.strip()]


def _parse_skill_file(path, source):
    try:
        parsed = parse_frontmatter(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    meta = parsed.meta
    name = meta.get("name") or path.parent.name
    if not name:
        return None
    user_invocable = str(meta.get("user-invocable", meta.get("user_invocable", "true"))).lower() != "false"
    context = "fork" if meta.get("context") == "fork" else "inline"
    return SkillDefinition(
        name=name,
        description=meta.get("description", ""),
        when_to_use=meta.get("when_to_use") or meta.get("when-to-use") or "",
        allowed_tools=_parse_allowed_tools(meta.get("allowed-tools") or meta.get("allowed_tools")),
        user_invocable=user_invocable,
        context=context,
        prompt_template=parsed.body,
        source=source,
        skill_dir=str(path.parent),
    )


def _load_skills_from_dir(base_dir, source, skills):
    base_dir = Path(base_dir)
    if not base_dir.is_dir():
        return
    for entry in sorted(base_dir.iterdir()):
        if not entry.is_dir():
            continue
        skill_file = entry / "SKILL.md"
        if not skill_file.exists():
            continue
        skill = _parse_skill_file(skill_file, source)
        if skill:
            skills[skill.name] = skill


def discover_skills(project_skill_dir=None, user_skill_dir=None, project_root=None, include_disabled=False, extra_skill_dirs=None):
    global _cached_skills
    use_cache = project_skill_dir is None and user_skill_dir is None and extra_skill_dirs is None and include_disabled
    if use_cache and _cached_skills is not None:
        return list(_cached_skills)

    skills = {}
    if user_skill_dir is not None:
        _load_skills_from_dir(user_skill_dir, "user", skills)
    if project_skill_dir is not None:
        for skill_dir in _normalize_skill_dirs(project_skill_dir, project_root=project_root):
            _load_skills_from_dir(skill_dir, "project", skills)
    else:
        for skill_dir in project_skill_dirs(project_root, extra_skill_dirs=extra_skill_dirs):
            _load_skills_from_dir(skill_dir, "project", skills)
    root = Path(project_root or PROJECT_ROOT)
    result = [
        skill for skill in skills.values()
        if include_disabled or is_enabled(root, "skills", skill.name)
    ]
    if use_cache:
        _cached_skills = result
    return list(result)


def get_skill_by_name(name, project_skill_dir=None, user_skill_dir=None, project_root=None, extra_skill_dirs=None):
    for skill in discover_skills(
        project_skill_dir=project_skill_dir,
        user_skill_dir=user_skill_dir,
        project_root=project_root,
        extra_skill_dirs=extra_skill_dirs,
    ):
        if skill.name == name:
            return skill
    return None


def resolve_skill_prompt(skill, args=""):
    prompt = skill.prompt_template
    prompt = re.sub(r"\$ARGUMENTS|\$\{ARGUMENTS\}", args or "", prompt)
    prompt = prompt.replace("${SECHEUR_SKILL_DIR}", skill.skill_dir)
    return prompt


def _fork_skill_prompt(skill, args=""):
    body = resolve_skill_prompt(skill, args)
    return (
        f"[Skill:{skill.name}] Run this as a fork-return skill task.\n"
        "Work independently on the focused skill task, use only necessary tools, and return a concise report "
        "with results, evidence, and residual risks.\n\n"
        f"Arguments:\n{args or ''}\n\n"
        f"Skill instructions:\n{body}"
    )


def execute_skill(skill_name, args="", project_skill_dir=None, user_skill_dir=None, project_root=None, extra_skill_dirs=None):
    skill = get_skill_by_name(
        skill_name,
        project_skill_dir=project_skill_dir,
        user_skill_dir=user_skill_dir,
        project_root=project_root,
        extra_skill_dirs=extra_skill_dirs,
    )
    if not skill:
        return None
    prompt = _fork_skill_prompt(skill, args) if skill.context == "fork" else resolve_skill_prompt(skill, args)
    return {
        "prompt": prompt,
        "allowed_tools": skill.allowed_tools,
        "context": skill.context,
        "source": skill.source,
        "skill_dir": skill.skill_dir,
    }


def build_skill_descriptions(project_root=None, project_skill_dir=None, extra_skill_dirs=None):
    skills = discover_skills(project_root=project_root, project_skill_dir=project_skill_dir, extra_skill_dirs=extra_skill_dirs)
    if not skills:
        return ""
    lines = ["# Available Skills", ""]
    lines.append("The list below is only metadata. When a skill is relevant, call the `skill` tool before continuing so the full SKILL.md instructions are loaded.")
    lines.append("")
    for skill in skills:
        prefix = f"/{skill.name}" if skill.user_invocable else skill.name
        desc = f": {skill.description}" if skill.description else ""
        lines.append(f"- {prefix}{desc}")
        if skill.when_to_use:
            lines.append(f"  When to use: {skill.when_to_use}")
    lines.append("")
    lines.append("Use the `skill` tool with `skill_name` and optional `args` to invoke a skill.")
    return "\n".join(lines)
