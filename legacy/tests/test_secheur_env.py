import os
import unittest
from unittest.mock import patch

from secheur_env import ensure_env, get_env


class SecheurEnvTests(unittest.TestCase):
    def test_get_env_reads_primary_name(self):
        with patch.dict(os.environ, {"SECHEUR_LANG": "en"}, clear=True):
            self.assertEqual(get_env("SECHEUR_LANG", "zh"), "en")

    def test_get_env_uses_default_when_primary_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(get_env("SECHEUR_PERMISSION_MODE", "default"), "default")

    def test_ensure_env_sets_primary_name_when_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            value = ensure_env("SECHEUR_LANG", "zh")

            self.assertEqual(value, "zh")
            self.assertEqual(os.environ["SECHEUR_LANG"], "zh")

    def test_ensure_env_keeps_primary_value(self):
        with patch.dict(os.environ, {"SECHEUR_LANG": "en"}, clear=True):
            value = ensure_env("SECHEUR_LANG", "zh")

            self.assertEqual(value, "en")
            self.assertEqual(os.environ["SECHEUR_LANG"], "en")


if __name__ == "__main__":
    unittest.main()
