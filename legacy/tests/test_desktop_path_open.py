import unittest
from pathlib import Path

from aiohttp import web

from frontends.desktop_bridge import resolve_open_target


class DesktopPathOpenTests(unittest.TestCase):
    def test_resolve_open_target_supports_mykey_template(self):
        root = Path("/project")

        target = resolve_open_target(root, {"kind": "mykeyTemplate"})

        self.assertEqual(target, root / "mykey_template.py")

    def test_resolve_open_target_rejects_mykey_file_kind(self):
        root = Path("/project")

        with self.assertRaises(web.HTTPBadRequest):
            resolve_open_target(root, {"kind": "mykey"})

    def test_resolve_open_target_rejects_unknown_kind(self):
        root = Path("/project")

        with self.assertRaises(web.HTTPBadRequest):
            resolve_open_target(root, {"kind": "unknown"})

    def test_resolve_open_target_supports_explicit_path(self):
        root = Path("/project")
        path = root / "skill" / "example"

        target = resolve_open_target(root, {"path": str(path)})

        self.assertEqual(target, path)

    def test_resolve_open_target_resolves_relative_path_under_project_root(self):
        root = Path("/project")

        target = resolve_open_target(root, {"path": "skill/example"})

        self.assertEqual(target, root / "skill" / "example")

    def test_resolve_open_target_rejects_path_outside_project_root(self):
        root = Path("/project")

        with self.assertRaises(web.HTTPBadRequest):
            resolve_open_target(root, {"path": "/tmp/example"})

    def test_resolve_open_target_defaults_to_root_for_invalid_payload(self):
        root = Path("/project")

        target = resolve_open_target(root, None)

        self.assertEqual(target, root)


if __name__ == "__main__":
    unittest.main()
