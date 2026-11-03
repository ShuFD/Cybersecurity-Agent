import tempfile
import unittest
from pathlib import Path

import skill_registry
from skill_registry import (
    discover_skills,
    execute_skill,
    reset_skill_cache,
    resolve_skill_prompt,
)


def write_skill(root, folder, body, meta=None):
    meta = meta or {}
    path = Path(root) / folder / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for key, value in meta.items():
        lines.append(f"{key}: {value}")
    lines += ["---", "", body]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


class SkillRegistryTests(unittest.TestCase):
    def tearDown(self):
        reset_skill_cache()

    def test_default_project_skill_dir_is_project_state_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"

            self.assertEqual(
                skill_registry._default_project_skill_dir(root),
                root / ".secheur-agent" / "skills",
            )

    def test_discovers_project_skill_from_skill_md(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project" / "skill"
            write_skill(
                project_dir,
                "commit",
                "Commit these changes: $ARGUMENTS",
                {"name": "commit", "description": "Create a git commit"},
            )

            skills = discover_skills(project_skill_dir=project_dir, user_skill_dir=Path(tmp) / "none")

        self.assertEqual([skill.name for skill in skills], ["commit"])
        self.assertEqual(skills[0].description, "Create a git commit")

    def test_project_skill_overrides_user_skill_with_same_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            user_dir = Path(tmp) / "user"
            project_dir = Path(tmp) / "project"
            write_skill(user_dir, "review", "user prompt", {"name": "review", "description": "user"})
            write_skill(project_dir, "review", "project prompt", {"name": "review", "description": "project"})

            skills = discover_skills(project_skill_dir=project_dir, user_skill_dir=user_dir)

        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0].description, "project")
        self.assertEqual(skills[0].prompt_template, "project prompt")

    def test_discovers_skills_from_multiple_project_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_dir = root / "project" / "skill"
            second_dir = root / "extras"
            write_skill(first_dir, "review", "Review.", {"name": "review"})
            write_skill(second_dir, "audit", "Audit.", {"name": "audit"})

            skills = discover_skills(project_skill_dir=[first_dir, second_dir], user_skill_dir=root / "missing")

        self.assertEqual(sorted(skill.name for skill in skills), ["audit", "review"])

    def test_project_state_skill_dir_overrides_legacy_project_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_skill(root / "skill", "review", "legacy skill", {"name": "review", "description": "legacy"})
            write_skill(root / ".secheur-agent" / "skills", "review", "state skill", {"name": "review", "description": "state"})

            skills = discover_skills(project_root=root, user_skill_dir=root / "missing")

        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0].description, "state")
        self.assertEqual(skills[0].prompt_template, "state skill")

    def test_resolve_skill_prompt_replaces_arguments_and_skill_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            skill_path = write_skill(
                project_dir,
                "ship",
                "Args=${ARGUMENTS}\nDir=${SECHEUR_SKILL_DIR}",
                {"name": "ship", "description": "ship it"},
            )
            skill = discover_skills(project_skill_dir=project_dir, user_skill_dir=Path(tmp) / "none")[0]

            prompt = resolve_skill_prompt(skill, "v1")

        self.assertIn("Args=v1", prompt)
        self.assertIn(f"Dir={skill_path.parent}", prompt)

    def test_execute_skill_returns_prompt_and_allowed_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            write_skill(
                project_dir,
                "audit",
                "Audit $ARGUMENTS",
                {"name": "audit", "description": "Audit code", "allowed-tools": "file_read,code_run"},
            )

            result = execute_skill("audit", "diff", project_skill_dir=project_dir, user_skill_dir=Path(tmp) / "none")

        self.assertEqual(result["context"], "inline")
        self.assertEqual(result["allowed_tools"], ["file_read", "code_run"])
        self.assertEqual(result["prompt"], "Audit diff")

    def test_execute_fork_skill_returns_fork_return_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_dir = Path(tmp) / "project"
            write_skill(
                project_dir,
                "deep-review",
                "Review $ARGUMENTS independently.",
                {"name": "deep-review", "description": "Deep review", "context": "fork"},
            )

            result = execute_skill("deep-review", "diff", project_skill_dir=project_dir, user_skill_dir=Path(tmp) / "none")

        self.assertEqual(result["context"], "fork")
        self.assertIn("fork-return skill task", result["prompt"])
        self.assertIn("Review diff independently.", result["prompt"])

    def test_execute_skill_returns_none_for_unknown_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = execute_skill("missing", "", project_skill_dir=Path(tmp) / "project", user_skill_dir=Path(tmp) / "user")

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
