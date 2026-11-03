import ast
import subprocess
import unittest
from pathlib import Path


def _is_git_ignored(root, path):
    rel = path.relative_to(root).as_posix()
    return subprocess.run(
        ["git", "check-ignore", "-q", "--", rel],
        cwd=root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


class NoBareExceptTests(unittest.TestCase):
    def test_python_files_do_not_use_bare_except(self):
        offenders = []
        root = Path(__file__).resolve().parents[1]
        for path in root.rglob("*.py"):
            if any(part in {".git", ".venv", "__pycache__"} for part in path.parts):
                continue
            if _is_git_ignored(root, path):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler) and node.type is None:
                    offenders.append(f"{path.relative_to(root)}:{node.lineno}")

        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
