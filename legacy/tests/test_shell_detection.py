import unittest

from secheur_core import resolve_shell_command


class ShellDetectionTests(unittest.TestCase):
    def test_windows_shell_prefers_pwsh_when_available(self):
        cmd = resolve_shell_command(
            "Write-Output ok",
            os_name="nt",
            shell_env="",
            which=lambda name: "C:/pwsh.exe" if name == "pwsh" else None,
        )

        self.assertEqual(cmd[:3], ["pwsh", "-NoProfile", "-NonInteractive"])
        self.assertIn("Write-Output ok", cmd[-1])

    def test_windows_shell_falls_back_to_powershell(self):
        cmd = resolve_shell_command(
            "Write-Output ok",
            os_name="nt",
            shell_env="",
            which=lambda name: None,
        )

        self.assertEqual(cmd[0], "powershell")

    def test_posix_shell_uses_zsh_from_environment(self):
        cmd = resolve_shell_command(
            "echo ok",
            os_name="posix",
            shell_env="/bin/zsh",
            which=lambda name: f"/bin/{name}",
        )

        self.assertEqual(cmd, ["zsh", "-lc", "echo ok"])

    def test_posix_shell_falls_back_to_bash(self):
        cmd = resolve_shell_command(
            "echo ok",
            os_name="posix",
            shell_env="/bin/fish",
            which=lambda name: "/bin/bash" if name == "bash" else None,
        )

        self.assertEqual(cmd, ["bash", "-lc", "echo ok"])


if __name__ == "__main__":
    unittest.main()
