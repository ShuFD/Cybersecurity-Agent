"""Exercise the staging helper without running the catalog/gold import."""
import ast
import os
import shutil
import tempfile
import unittest
from pathlib import Path

source = Path(os.environ.get('STAGING_TEST_MODULE', str(Path(__file__).with_name('stage-official-catalogs.py'))))
tree = ast.parse(source.read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'restore_intercode_placeholder')
namespace = {'shutil': shutil}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
restore = namespace['restore_intercode_placeholder']


class PlaceholderRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.src = Path(self.temp.name) / 'source'
        self.dst = Path(self.temp.name) / 'public'
        self.src.mkdir()
        self.dst.mkdir()
        (self.src / 'solution').mkdir()
        (self.src / 'solution' / 'README.md').write_text('PRIVATE_FIXTURE')

    def tearDown(self):
        self.temp.cleanup()

    def test_restores_only_exact_empty_official_marker(self):
        (self.src / '.placeholder').touch()
        restore(self.src, self.dst, [])
        self.assertEqual([p.name for p in self.dst.iterdir()], ['.placeholder'])
        self.assertEqual((self.dst / '.placeholder').read_bytes(), b'')
        restore(self.src, self.dst, [])
        self.assertEqual(len(list(self.dst.iterdir())), 1)

    def test_does_not_invent_missing_marker(self):
        restore(self.src, self.dst, [])
        self.assertEqual(list(self.dst.iterdir()), [])

    def test_does_not_copy_nonempty_marker_or_change_attachment_tasks(self):
        (self.src / '.placeholder').write_text('unexpected')
        restore(self.src, self.dst, [])
        self.assertEqual(list(self.dst.iterdir()), [])
        (self.src / '.placeholder').write_bytes(b'')
        restore(self.src, self.dst, ['handout.txt'])
        self.assertEqual(list(self.dst.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
