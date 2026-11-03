from __future__ import annotations

import ast
import base64
from dataclasses import dataclass
import re
import shlex
from typing import Literal


def _utf8_safe_text(text):
    return str(text).encode("utf-8", errors="replace").decode("utf-8")


RiskLevel = Literal["readonly", "write", "destructive"]

CONNECTORS = {"&&", "||", ";", "|"}
SHELL_COMMAND_SPLIT_LIMIT = 50
SHELL_COMMAND_SPLIT_LIMIT_REASON = "command split limit exceeded"
SAFE_WRAPPERS = {"time", "nice", "env", "command", "exec", "nohup", "setsid", "stdbuf", "timeout"}
BUILTIN_DISPATCH_COMMANDS = {".", "command", "eval", "exec", "source"}
SHELL_COMPOUND_LEADING_TOKENS = {"!", "{", "do", "else", "if", "then", "until", "while"}
SHELL_COMPOUND_TRAILING_TOKENS = {"}", "done", "esac", "fi"}
SAFE_WRAPPER_OPTIONS_WITH_VALUES = {
    "env": {
        "-S",
        "-u",
        "--block-signal",
        "--chdir",
        "--default-signal",
        "--ignore-signal",
        "--split-string",
        "--unset",
    },
    "exec": {"-a"},
    "nice": {"-n", "--adjustment"},
    "stdbuf": {"-e", "-i", "-o", "--error", "--input", "--output"},
    "time": {"-f", "-o", "--format", "--output"},
    "timeout": {"-k", "-s", "--kill-after", "--signal"},
}
XARGS_OPTIONS_WITH_VALUES = {
    "-E",
    "-I",
    "-L",
    "-P",
    "-a",
    "-d",
    "-e",
    "-i",
    "-n",
    "-s",
    "--arg-file",
    "--delimiter",
    "--eof",
    "--max-args",
    "--max-chars",
    "--max-lines",
    "--max-procs",
    "--replace",
}
READONLY_COMMANDS = {
    "cat",
    "find",
    "grep",
    "head",
    "less",
    "ls",
    "pwd",
    "rg",
    "sed",
    "tail",
    "test",
    "wc",
}
FIND_FILE_OUTPUT_ACTIONS = {"-fls", "-fprint", "-fprint0", "-fprintf"}
GIT_READONLY_SUBCOMMANDS = {
    "branch",
    "diff",
    "grep",
    "log",
    "ls-files",
    "remote",
    "rev-parse",
    "show",
    "status",
}
GIT_WRITE_SUBCOMMANDS = {
    "add",
    "am",
    "apply",
    "bisect",
    "checkout",
    "cherry-pick",
    "commit",
    "fetch",
    "merge",
    "pull",
    "push",
    "rebase",
    "restore",
    "revert",
    "stash",
    "switch",
    "tag",
}
GIT_REMOTE_WRITE_SUBCOMMANDS = {
    "add",
    "prune",
    "remove",
    "rename",
    "rm",
    "set-branches",
    "set-head",
    "set-url",
    "update",
}
GIT_BRANCH_WRITE_FLAGS = {
    "--copy",
    "--copy-force",
    "--edit-description",
    "--move",
    "--move-force",
    "--set-upstream-to",
    "--unset-upstream",
    "-c",
    "-C",
    "-m",
    "-M",
    "-u",
}
GIT_BUILTIN_SUBCOMMANDS = {
    "add",
    "am",
    "annotate",
    "apply",
    "archive",
    "backfill",
    "bisect",
    "blame",
    "branch",
    "bugreport",
    "bundle",
    "cat-file",
    "check-attr",
    "check-ignore",
    "check-mailmap",
    "check-ref-format",
    "checkout",
    "checkout--worker",
    "checkout-index",
    "cherry",
    "cherry-pick",
    "clean",
    "clone",
    "column",
    "commit",
    "commit-graph",
    "commit-tree",
    "config",
    "count-objects",
    "credential",
    "credential-cache",
    "credential-cache--daemon",
    "credential-store",
    "describe",
    "diagnose",
    "diff",
    "diff-files",
    "diff-index",
    "diff-pairs",
    "diff-tree",
    "difftool",
    "fast-export",
    "fast-import",
    "fetch",
    "fetch-pack",
    "fmt-merge-msg",
    "for-each-ref",
    "for-each-repo",
    "format-patch",
    "fsck",
    "fsck-objects",
    "fsmonitor--daemon",
    "gc",
    "get-tar-commit-id",
    "grep",
    "hash-object",
    "help",
    "history",
    "hook",
    "index-pack",
    "init",
    "init-db",
    "interpret-trailers",
    "last-modified",
    "log",
    "ls-files",
    "ls-remote",
    "ls-tree",
    "mailinfo",
    "mailsplit",
    "maintenance",
    "merge",
    "merge-base",
    "merge-file",
    "merge-index",
    "merge-ours",
    "merge-recursive",
    "merge-recursive-ours",
    "merge-recursive-theirs",
    "merge-subtree",
    "merge-tree",
    "mktag",
    "mktree",
    "multi-pack-index",
    "mv",
    "name-rev",
    "notes",
    "pack-objects",
    "pack-redundant",
    "pack-refs",
    "patch-id",
    "pickaxe",
    "prune",
    "prune-packed",
    "pull",
    "push",
    "range-diff",
    "read-tree",
    "rebase",
    "receive-pack",
    "reflog",
    "refs",
    "remote",
    "remote-ext",
    "remote-fd",
    "repack",
    "replace",
    "replay",
    "repo",
    "rerere",
    "reset",
    "restore",
    "rev-list",
    "rev-parse",
    "revert",
    "rm",
    "send-pack",
    "shortlog",
    "show",
    "show-branch",
    "show-index",
    "show-ref",
    "sparse-checkout",
    "stage",
    "stash",
    "status",
    "stripspace",
    "submodule--helper",
    "switch",
    "symbolic-ref",
    "tag",
    "unpack-file",
    "unpack-objects",
    "update-index",
    "update-ref",
    "update-server-info",
    "upload-archive",
    "upload-archive--writer",
    "upload-pack",
    "var",
    "verify-commit",
    "verify-pack",
    "verify-tag",
    "version",
    "whatchanged",
    "worktree",
    "write-tree",
}
GIT_OPTIONS_WITH_VALUES = {
    "-C",
    "-c",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
}
GIT_RESTORE_OPTIONS_WITH_VALUES = {
    "--conflict",
    "--pathspec-from-file",
    "--source",
    "-s",
}
ELEVATION_OPTIONS_WITH_VALUES = {
    "-C",
    "-c",
    "-g",
    "-h",
    "-p",
    "-T",
    "-t",
    "-u",
    "--chdir",
    "--close-from",
    "--group",
    "--host",
    "--login-class",
    "--prompt",
    "--role",
    "--type",
    "--user",
}
ELEVATION_SHORT_OPTIONS_WITH_VALUES = {
    option[1:] for option in ELEVATION_OPTIONS_WITH_VALUES if re.fullmatch(r"-[A-Za-z]", option)
}
REMOTE_FETCH_COMMANDS = {
    "curl",
    "iwr",
    "irm",
    "invoke-restmethod",
    "invoke-webrequest",
    "wget",
}
SHELL_EVALUATORS = {"bash", "fish", "sh", "zsh"}
SOURCE_EVALUATORS = {".", "source"}
SCRIPT_EVALUATORS = {"iex", "invoke-expression"}
POWERSHELL_EVALUATORS = {"powershell", "powershell.exe", "pwsh", "pwsh.exe"}
CMD_EVALUATORS = {"cmd", "cmd.exe"}
PYTHON_COMMANDS = {"py", "python", "python2", "python3"}
NODE_COMMANDS = {"node", "nodejs"}
DATABASE_COMMANDS = {"mysql", "psql", "sqlite3"}
DATABASE_INLINE_SQL_OPTIONS = {
    "mysql": {"-e", "--execute"},
    "psql": {"-c", "--command"},
}
DATABASE_INLINE_SQL_LONG_OPTION_PREFIXES = {
    "mysql": {"--execute"},
    "psql": {"--command"},
}
REDIS_COMMANDS = {"redis-cli"}
REDIS_OPTIONS_WITH_VALUES = {"-a", "-h", "-n", "-p", "-u", "--pass", "--raw", "--user"}
REDIS_DESTRUCTIVE_COMMANDS = {"del", "flushall", "flushdb", "unlink"}
CONTAINER_RUNTIME_COMMANDS = {"docker", "podman"}
CONTAINER_LEGACY_COMPOSE_COMMANDS = {"docker-compose", "podman-compose"}
CONTAINER_DELETE_TOPLEVEL_SUBCOMMANDS = {"rm", "rmi"}
CONTAINER_DELETE_GROUP_SUBCOMMANDS = {
    "builder": {"prune"},
    "container": {"prune", "rm", "remove"},
    "image": {"prune", "rm", "remove", "rmi"},
    "network": {"prune", "rm", "remove"},
    "system": {"prune"},
    "volume": {"prune", "rm", "remove"},
}
CONTAINER_GLOBAL_OPTIONS_WITH_VALUES = {"--config", "--context", "-c", "--host", "-H", "--log-level"}
CONTAINER_COMPOSE_OPTIONS_WITH_VALUES = {
    "--ansi",
    "--env-file",
    "--file",
    "--parallel",
    "--profile",
    "--progress",
    "--project-directory",
    "--project-name",
    "-f",
    "-p",
}
CONTAINER_COMPOSE_DELETE_SUBCOMMANDS = {"down", "rm", "remove"}
INFRASTRUCTURE_COMMANDS = {"helm", "kubectl", "terraform", "tofu"}
CLOUD_COMMANDS = {"aws", "az", "gcloud"}
APT_COMMANDS = {"apt", "apt-get"}
DNF_COMMANDS = {"dnf", "yum"}
PYTHON_PACKAGE_COMMANDS = {"pip", "pip3"}
CONDA_COMMANDS = {"conda", "mamba"}
NODE_PACKAGE_COMMANDS = {"npm"}
PACKAGE_MANAGER_COMMANDS = (
    APT_COMMANDS
    | DNF_COMMANDS
    | {"brew", "cargo", "gem"}
    | PYTHON_PACKAGE_COMMANDS
    | CONDA_COMMANDS
    | NODE_PACKAGE_COMMANDS
)
PACKAGE_MANAGER_OPTIONS_WITH_VALUES = {
    "--cache-dir",
    "--config-file",
    "--globalconfig",
    "--prefix",
    "--python",
    "--root",
    "--setopt",
    "--userconfig",
    "-c",
    "-o",
}
KUBECTL_GLOBAL_OPTIONS_WITH_VALUES = {
    "--as",
    "--as-group",
    "--cluster",
    "--context",
    "--kubeconfig",
    "--namespace",
    "--server",
    "--token",
    "--user",
    "-n",
}
HELM_GLOBAL_OPTIONS_WITH_VALUES = {"--kube-context", "--kubeconfig", "--namespace", "--registry-config", "-n"}
TERRAFORM_GLOBAL_OPTIONS_WITH_VALUES = {"-chdir"}
AWS_GLOBAL_OPTIONS_WITH_VALUES = {
    "--ca-bundle",
    "--cli-input-json",
    "--cli-input-yaml",
    "--endpoint-url",
    "--output",
    "--profile",
    "--query",
    "--region",
}
GCLOUD_GLOBAL_OPTIONS_WITH_VALUES = {
    "--account",
    "--billing-project",
    "--configuration",
    "--flags-file",
    "--format",
    "--project",
    "--quiet",
}
AZ_GLOBAL_OPTIONS_WITH_VALUES = {
    "--output",
    "--query",
    "--subscription",
}
PYTHON_INLINE_CODE_EVALUATORS = {"exec", "eval"}
PYTHON_INLINE_CODE_MAX_DEPTH = 3
PYTHON_DESTRUCTIVE_PATTERNS = (
    re.compile(r"\bshutil\.rmtree\s*\("),
    re.compile(r"\bos\.(?:remove|removedirs|rmdir|unlink)\s*\("),
    re.compile(r"\b(?:pathlib\.)?Path\s*\([^)]*\)\.(?:rmdir|unlink)\s*\("),
)
PYTHON_WRITE_MODES = {"w", "a", "x", "+"}
PYTHON_DESTRUCTIVE_FILE_CALLS = {
    ("os", "remove"),
    ("os", "removedirs"),
    ("os", "rmdir"),
    ("os", "unlink"),
    ("shutil", "rmtree"),
}
PYTHON_PATH_FACTORY_CALLS = {("pathlib", "Path")}
PYTHON_PATH_DELETE_METHODS = {"rmdir", "unlink"}
PYTHON_SHELL_CALLS = {
    ("os", "system"),
    ("os", "popen"),
}
PYTHON_OS_EXEC_CALLS = {
    ("os", "execl"),
    ("os", "execle"),
    ("os", "execlp"),
    ("os", "execlpe"),
    ("os", "execv"),
    ("os", "execve"),
    ("os", "execvp"),
    ("os", "execvpe"),
}
PYTHON_OS_SPAWN_CALLS = {
    ("os", "spawnl"),
    ("os", "spawnle"),
    ("os", "spawnlp"),
    ("os", "spawnlpe"),
    ("os", "spawnv"),
    ("os", "spawnve"),
    ("os", "spawnvp"),
    ("os", "spawnvpe"),
}
PYTHON_OS_POSIX_SPAWN_CALLS = {
    ("os", "posix_spawn"),
    ("os", "posix_spawnp"),
}
PYTHON_SUBPROCESS_CALLS = {
    ("subprocess", "run"),
    ("subprocess", "call"),
    ("subprocess", "check_call"),
    ("subprocess", "check_output"),
    ("subprocess", "Popen"),
}
PYTHON_IMPORT_MODULE_CALLS = {("importlib", "import_module")}
PYTHON_INLINE_IMPORTABLE_CALLS = (
    PYTHON_SHELL_CALLS
    | PYTHON_OS_EXEC_CALLS
    | PYTHON_OS_SPAWN_CALLS
    | PYTHON_OS_POSIX_SPAWN_CALLS
    | PYTHON_SUBPROCESS_CALLS
    | PYTHON_DESTRUCTIVE_FILE_CALLS
    | PYTHON_PATH_FACTORY_CALLS
    | PYTHON_IMPORT_MODULE_CALLS
)
PYTHON_INLINE_TARGET_MODULES = {"os", "pathlib", "shutil", "subprocess"}
PYTHON_INLINE_MODULES = PYTHON_INLINE_TARGET_MODULES | {"importlib", "sys"}
NODE_DESTRUCTIVE_PATTERNS = (
    re.compile(r"\brequire\s*\(\s*['\"](?:node:)?fs(?:/promises)?['\"]\s*\)\s*\.\s*(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\("),
    re.compile(r"\b[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\("),
)
NODE_DEVICE_WRITE_PATTERNS = (
    re.compile(
        r"\brequire\s*\(\s*['\"](?:node:)?fs(?:/promises)?['\"]\s*\)\s*\.\s*"
        r"(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)"
        r"\s*\(\s*['\"](/dev/(?:disk/|mapper/|rdisk|sd|hd|xvd|nvme|mmcblk)[^'\"]*)['\"]"
    ),
    re.compile(
        r"\b[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*"
        r"(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)"
        r"\s*\(\s*['\"](/dev/(?:disk/|mapper/|rdisk|sd|hd|xvd|nvme|mmcblk)[^'\"]*)['\"]"
    ),
)
STDIN_SOURCE_PATHS = {"/dev/fd/0", "/dev/stdin", "/proc/self/fd/0"}
FILE_DELETE_COMMANDS = {"del", "erase", "rd", "remove-item", "rm", "rmdir", "unlink"}
PROCESS_TERMINATION_COMMANDS = {"kill", "killall", "pkill", "stop-process", "taskkill"}
SYSTEM_DESTRUCTIVE_COMMANDS = {"format", "reboot", "shutdown"}
FILE_OVERWRITE_COMMANDS = {"shred"}
DISKUTIL_DESTRUCTIVE_SUBCOMMANDS = {
    "erasedisk",
    "erasevolume",
    "partitiondisk",
    "randomdisk",
    "secureerase",
    "zerodisk",
}
DISKUTIL_DESTRUCTIVE_GROUP_SUBCOMMANDS = {
    "apfs": {"deletecontainer", "deletevolume", "erasevolume"},
}
PERMISSION_CHANGE_COMMANDS = {"chmod"}
OWNERSHIP_CHANGE_COMMANDS = {"chgrp", "chown"}
REDIRECTION_OPERATORS = {">", ">>", ">|", "&>", "&>>", "<>"}
DEVICE_REDIRECTION_PREFIXES = (
    "/dev/disk/",
    "/dev/mapper/",
    "/dev/rdisk",
    "/dev/sd",
    "/dev/hd",
    "/dev/xvd",
    "/dev/nvme",
    "/dev/mmcblk",
)
SYSTEM_COMMAND_DIR_PREFIXES = (
    "/bin/",
    "/sbin/",
    "/usr/bin/",
    "/usr/sbin/",
)


@dataclass(frozen=True)
class ShellRiskReport:
    level: RiskLevel
    reason: str
    matched_command: str
    commands: list[str]
    env_prefixes: dict[str, str]


class ShellCommandSplitLimitExceeded(Exception):
    def __init__(self, command: str):
        self.command = str(command or "")
        super().__init__(self.command)


def _decode_ansi_c_quoted_text(text: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        index += 1
        if index >= len(text):
            out.append("\\")
            break
        escaped = text[index]
        if escaped == "x":
            digits = ""
            cursor = index + 1
            while (
                cursor < len(text)
                and len(digits) < 2
                and text[cursor] in "0123456789abcdefABCDEF"
            ):
                digits += text[cursor]
                cursor += 1
            if digits:
                out.append(chr(int(digits, 16)))
                index = cursor
                continue
            out.append("x")
        else:
            out.append({
                "a": "\a",
                "b": "\b",
                "e": "\x1b",
                "E": "\x1b",
                "f": "\f",
                "n": "\n",
                "r": "\r",
                "t": "\t",
                "v": "\v",
                "\\": "\\",
                "'": "'",
                '"': '"',
                "?": "?",
            }.get(escaped, escaped))
        index += 1
    return "".join(out)


def _find_closing_ansi_c_quote(text: str, start: int) -> int | None:
    index = start + 2
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'":
            return index
        index += 1
    return None


def _normalize_ansi_c_quoted_strings(command: str) -> str:
    text = str(command or "")
    out: list[str] = []
    index = 0
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            out.append(text[index:index + 2])
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            out.append(char)
            index += 1
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            out.append(char)
            index += 1
            continue
        if (
            not in_single_quote
            and not in_double_quote
            and char == "$"
            and index + 1 < len(text)
            and text[index + 1] == "'"
        ):
            end = _find_closing_ansi_c_quote(text, index)
            if end is None:
                out.append(char)
                index += 1
                continue
            decoded = _decode_ansi_c_quoted_text(text[index + 2:end])
            out.append(shlex.quote(decoded))
            index = end + 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _normalize_unquoted_ifs_expansion(command: str) -> str:
    text = str(command or "")
    out: list[str] = []
    index = 0
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            out.append(text[index:index + 2])
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            out.append(char)
            index += 1
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            out.append(char)
            index += 1
            continue
        if not in_single_quote and not in_double_quote and text.startswith("${IFS}", index):
            out.append(" ")
            index += len("${IFS}")
            continue
        if not in_single_quote and not in_double_quote and text.startswith("$IFS", index):
            after = index + len("$IFS")
            if after >= len(text) or not re.match(r"[A-Za-z0-9_]", text[after]):
                out.append(" ")
                index = after
                continue
        out.append(char)
        index += 1
    return "".join(out)


def _normalize_shell_lexical_forms(command: str) -> str:
    return _normalize_unquoted_ifs_expansion(_normalize_ansi_c_quoted_strings(command))


def _split_tokens(command: str) -> list[str]:
    lexer = shlex.shlex(_normalize_shell_lexical_forms(command), posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = list(lexer)
    merged: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if index + 1 < len(tokens) and tokens[index + 1] == "|" and re.fullmatch(r"(?:\d+|&)?(?:>>?|>)", token):
            merged.append(token + "|")
            index += 2
            continue
        merged.append(token)
        index += 1
    return merged


def _split_words(command: str) -> list[str]:
    lexer = shlex.shlex(_normalize_shell_lexical_forms(command), posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def _join_tokens(tokens: list[str]) -> str:
    return shlex.join(tokens).strip()


def _looks_like_python_command_name(name: str) -> bool:
    return name in PYTHON_COMMANDS or bool(re.fullmatch(r"python\d(?:\.\d+)?", name))


def _command_semantic_name(name: str) -> str:
    lowered = str(name or "").lower()
    if "/" not in lowered:
        return lowered
    if lowered.startswith(SYSTEM_COMMAND_DIR_PREFIXES):
        return lowered.rsplit("/", 1)[-1]
    basename = lowered.rsplit("/", 1)[-1]
    dangerous_names = (
        FILE_DELETE_COMMANDS
        | FILE_OVERWRITE_COMMANDS
        | PROCESS_TERMINATION_COMMANDS
        | SYSTEM_DESTRUCTIVE_COMMANDS
        | PERMISSION_CHANGE_COMMANDS
        | OWNERSHIP_CHANGE_COMMANDS
        | SHELL_EVALUATORS
        | SOURCE_EVALUATORS
        | SCRIPT_EVALUATORS
        | POWERSHELL_EVALUATORS
        | CMD_EVALUATORS
        | DATABASE_COMMANDS
        | REDIS_COMMANDS
        | CONTAINER_RUNTIME_COMMANDS
        | CONTAINER_LEGACY_COMPOSE_COMMANDS
        | INFRASTRUCTURE_COMMANDS
        | CLOUD_COMMANDS
        | PACKAGE_MANAGER_COMMANDS
        | REMOTE_FETCH_COMMANDS
        | {"rm", "find", "truncate", "dd", "xargs", "sudo", "doas", "eval"}
    )
    return (
        basename
        if basename in dangerous_names
        or _looks_like_python_command_name(basename)
        or basename in NODE_COMMANDS
        or _is_filesystem_format_command(basename)
        else lowered
    )


def _is_escaped(text: str, index: int) -> bool:
    slash_count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        slash_count += 1
        cursor -= 1
    return slash_count % 2 == 1


def _find_matching_subshell(text: str, start: int) -> int | None:
    depth = 1
    index = start + 2
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
        elif char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
        elif not in_single_quote and not in_double_quote:
            if char == "$" and index + 1 < len(text) and text[index + 1] == "(":
                depth += 1
                index += 2
                continue
            if char == ")":
                depth -= 1
                if depth == 0:
                    return index
        index += 1

    return None


def _find_matching_process_substitution(text: str, start: int) -> int | None:
    depth = 1
    index = start + 2
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
        elif char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
        elif not in_single_quote and not in_double_quote:
            if (
                index + 1 < len(text)
                and text[index] in {"$", "<", ">"}
                and text[index + 1] == "("
            ):
                depth += 1
                index += 2
                continue
            if char == ")":
                depth -= 1
                if depth == 0:
                    return index
        index += 1

    return None


def _find_closing_backtick(text: str, start: int) -> int | None:
    index = start + 1
    while index < len(text):
        if text[index] == "`" and not _is_escaped(text, index):
            return index
        index += 1
    return None


def _extract_command_substitutions(command: str) -> list[str]:
    text = str(command or "")
    substitutions: list[str] = []
    index = 0
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            index += 1
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            index += 1
            continue
        if not in_single_quote and char == "$" and index + 1 < len(text) and text[index + 1] == "(":
            end = _find_matching_subshell(text, index)
            if end is None:
                index += 2
                continue
            substitutions.append(text[index + 2 : end])
            index = end + 1
            continue
        if not in_single_quote and char == "`":
            end = _find_closing_backtick(text, index)
            if end is None:
                index += 1
                continue
            substitutions.append(text[index + 1 : end])
            index = end + 1
            continue
        index += 1

    return [substitution.strip() for substitution in substitutions if substitution.strip()]


def _is_process_substitution_start(text: str, index: int) -> bool:
    return index + 1 < len(text) and text[index] in {"<", ">"} and text[index + 1] == "("


def _extract_process_substitutions(command: str) -> list[tuple[str, str]]:
    text = str(command or "")
    substitutions: list[tuple[str, str]] = []
    index = 0
    in_single_quote = False
    in_double_quote = False

    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            index += 1
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            index += 1
            continue
        if not in_single_quote and not in_double_quote and _is_process_substitution_start(text, index):
            end = _find_matching_process_substitution(text, index)
            if end is None:
                index += 2
                continue
            inner = text[index + 2 : end].strip()
            if inner:
                substitutions.append((char, inner))
            index = end + 1
            continue
        index += 1

    return substitutions


def _normalize_command_segment(segment: str) -> str:
    text = segment.strip()
    if not text:
        return ""
    if _extract_command_substitutions(text) or _extract_process_substitutions(text):
        return text
    try:
        return _join_tokens(_split_words(text))
    except ValueError:
        return text


def split_shell_commands(command: str, limit: int = SHELL_COMMAND_SPLIT_LIMIT) -> list[str]:
    return [segment for segment, _connector in _split_shell_segments(command, limit=limit)]


def _split_shell_segments(command: str, limit: int = SHELL_COMMAND_SPLIT_LIMIT) -> list[tuple[str, str]]:
    commands: list[tuple[str, str]] = []
    text = str(command or "")
    start = 0
    index = 0
    in_single_quote = False
    in_double_quote = False

    while index < len(text) and len(commands) < limit:
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == "'" and not in_double_quote:
            in_single_quote = not in_single_quote
            index += 1
            continue
        if char == '"' and not in_single_quote:
            in_double_quote = not in_double_quote
            index += 1
            continue
        if not in_single_quote and char == "$" and index + 1 < len(text) and text[index + 1] == "(":
            end = _find_matching_subshell(text, index)
            index = end + 1 if end is not None else index + 2
            continue
        if not in_single_quote and not in_double_quote and _is_process_substitution_start(text, index):
            end = _find_matching_process_substitution(text, index)
            index = end + 1 if end is not None else index + 2
            continue
        if not in_single_quote and char == "`":
            end = _find_closing_backtick(text, index)
            index = end + 1 if end is not None else index + 1
            continue
        if not in_single_quote and not in_double_quote:
            connector_width = 0
            if text.startswith("&&", index) or text.startswith("||", index):
                connector_width = 2
            elif char == "|" and index > 0 and text[index - 1] == ">":
                connector_width = 0
            elif char in {";", "|"}:
                connector_width = 1
            if connector_width:
                segment = _normalize_command_segment(text[start:index])
                if segment:
                    commands.append((segment, text[index:index + connector_width]))
                start = index + connector_width
                index = start
                continue
        index += 1

    if len(commands) < limit:
        segment = _normalize_command_segment(text[start:])
        if segment:
            commands.append((segment, ""))

    return commands[:limit]


def _shell_command_split_limit_exceeded(command: str, limit: int = SHELL_COMMAND_SPLIT_LIMIT) -> bool:
    if limit < 1:
        return bool(str(command or "").strip())
    return len(_split_shell_segments(command, limit=limit + 1)) > limit


def _split_shell_commands_for_classification(
    command: str,
    limit: int = SHELL_COMMAND_SPLIT_LIMIT,
) -> list[str]:
    if _shell_command_split_limit_exceeded(command, limit=limit):
        raise ShellCommandSplitLimitExceeded(command)
    return split_shell_commands(command, limit=limit)


def _split_shell_segments_for_classification(
    command: str,
    limit: int = SHELL_COMMAND_SPLIT_LIMIT,
) -> list[tuple[str, str]]:
    if _shell_command_split_limit_exceeded(command, limit=limit):
        raise ShellCommandSplitLimitExceeded(command)
    return _split_shell_segments(command, limit=limit)


def _collect_env_prefixes(tokens: list[str]) -> tuple[dict[str, str], list[str]]:
    env: dict[str, str] = {}
    rest = list(tokens)
    while rest:
        token = rest[0]
        if "=" not in token or token.startswith("="):
            break
        key, value = token.split("=", 1)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            break
        env[key] = value
        rest = rest[1:]
    return env, rest


def _wrapper_option_takes_value(wrapper: str, option: str) -> bool:
    options_with_values = SAFE_WRAPPER_OPTIONS_WITH_VALUES.get(wrapper, set())
    if option in options_with_values:
        return True
    return False


def _strip_wrapper_non_command_args(wrapper: str, rest: list[str]) -> list[str]:
    if wrapper != "timeout" or not rest:
        return rest
    if rest[0] == "--":
        return rest[1:]
    return rest[1:]


def _env_split_string_option(option: str, rest: list[str]) -> tuple[list[str], list[str], bool]:
    if option == "-S" or option == "--split-string":
        if not rest:
            return [], rest, True
        try:
            return _split_words(rest[0]), rest[1:], True
        except ValueError:
            return [], rest[1:], True
    if option.startswith("--split-string="):
        try:
            return _split_words(option.split("=", 1)[1]), rest, True
        except ValueError:
            return [], rest, True
    return [], rest, False


def _strip_wrappers(tokens: list[str]) -> list[str]:
    _env, rest = _strip_wrappers_and_collect_env(tokens)
    return rest


def _strip_wrappers_and_collect_env(tokens: list[str]) -> tuple[dict[str, str], list[str]]:
    rest = list(tokens)
    env, rest = _collect_env_prefixes(rest)
    while rest and _command_semantic_name(rest[0]) in SAFE_WRAPPERS:
        wrapper = _command_semantic_name(rest[0])
        rest = rest[1:]
        while rest and rest[0].startswith("-"):
            option = rest[0]
            rest = rest[1:]
            if wrapper == "env":
                split_tokens, rest, handled = _env_split_string_option(option, rest)
                if handled:
                    # env -S turns its argument into the utility argv; remaining
                    # tokens belong to that utility, not to env option parsing.
                    rest = split_tokens + rest
                    break
            if _wrapper_option_takes_value(wrapper, option) and rest:
                rest = rest[1:]
        rest = _strip_wrapper_non_command_args(wrapper, rest)
        wrapper_env, rest = _collect_env_prefixes(rest)
        env.update(wrapper_env)
    return env, rest


def _time_wrapper_output_targets(tokens: list[str]) -> list[str]:
    rest = list(tokens)
    _env, rest = _collect_env_prefixes(rest)
    targets: list[str] = []
    while rest and _command_semantic_name(rest[0]) in SAFE_WRAPPERS:
        wrapper = _command_semantic_name(rest[0])
        rest = rest[1:]
        while rest and rest[0].startswith("-"):
            option = rest[0]
            rest = rest[1:]
            if wrapper == "env":
                split_tokens, rest, handled = _env_split_string_option(option, rest)
                if handled:
                    rest = split_tokens + rest
                    break
            if wrapper == "time":
                if option in {"-o", "--output"} and rest:
                    targets.append(rest[0])
                    rest = rest[1:]
                    continue
                if option.startswith("--output="):
                    target = option.split("=", 1)[1]
                    if target:
                        targets.append(target)
                    continue
            if _wrapper_option_takes_value(wrapper, option) and rest:
                rest = rest[1:]
        rest = _strip_wrapper_non_command_args(wrapper, rest)
        _wrapper_env, rest = _collect_env_prefixes(rest)
    return targets


def _env_split_string_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "env":
        return []
    rest = list(tokens[1:])
    while rest:
        token = rest[0]
        if token == "--":
            return []
        if token in {"-S", "--split-string"} or token.startswith("--split-string="):
            _env, stripped = _strip_wrappers_and_collect_env(tokens)
            return [_join_tokens(stripped)] if stripped else []
        if token in SAFE_WRAPPER_OPTIONS_WITH_VALUES.get("env", set()) and len(rest) > 1:
            rest = rest[2:]
            continue
        if any(token.startswith(option + "=") for option in SAFE_WRAPPER_OPTIONS_WITH_VALUES.get("env", set()) if option.startswith("--")):
            rest = rest[1:]
            continue
        if token.startswith("-"):
            rest = rest[1:]
            continue
        return []
    return []


def _strip_shell_compound_tokens(tokens: list[str]) -> list[str]:
    rest = list(tokens)
    changed = False
    if rest and _command_semantic_name(rest[0]) == "case":
        try:
            in_index = rest.index("in")
        except ValueError:
            in_index = -1
        if in_index >= 0:
            for index in range(in_index + 1, len(rest)):
                if rest[index].endswith(")"):
                    return rest[index + 1 :]
    while rest:
        first = rest[0]
        first_name = _command_semantic_name(first)
        if first_name in SHELL_COMPOUND_LEADING_TOKENS:
            rest = rest[1:]
            changed = True
            continue
        if first.startswith("(") and len(first) > 1:
            rest[0] = first[1:]
            changed = True
            continue
        break
    while rest:
        last = rest[-1]
        last_name = _command_semantic_name(last)
        if last_name in SHELL_COMPOUND_TRAILING_TOKENS:
            rest = rest[:-1]
            changed = True
            continue
        if last.endswith(")") and len(last) > 1:
            rest[-1] = last[:-1]
            changed = True
            continue
        break
    return rest if changed else []


def _compound_segment_commands(command: str) -> list[str]:
    try:
        tokens = _split_tokens(command)
    except ValueError:
        return []
    stripped = _strip_shell_compound_tokens(tokens)
    return [_join_tokens(stripped)] if stripped else []


def _coproc_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "coproc":
        return []
    rest = list(tokens[1:])
    if rest and rest[0] == "--":
        rest = rest[1:]
    if not rest:
        return []
    if len(rest) >= 2 and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", rest[0]) and rest[1] == "{":
        rest = rest[2:]
    elif rest and rest[0] == "{":
        rest = rest[1:]
    return [_join_tokens(rest)] if rest else []


def _shell_function_definitions(command: str) -> list[tuple[str, str, str]]:
    text = str(command or "")
    definitions: list[tuple[str, str, str]] = []
    patterns = (
        re.compile(r"(?:^|[;&|]\s*)(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{(?P<body>.*?)\}", re.DOTALL),
        re.compile(r"(?:^|[;&|]\s*)function\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\))?\s*\{(?P<body>.*?)\}", re.DOTALL),
    )
    for pattern in patterns:
        for match in pattern.finditer(text):
            definitions.append((match.group("name"), match.group("body"), text[match.end() :]))
    return definitions


def _shell_function_invoked(function_name: str, tail: str) -> bool:
    for segment in _split_shell_commands_for_classification(tail):
        try:
            tokens = _split_tokens(segment)
        except ValueError:
            continue
        if _command_name(tokens) == function_name:
            return True
    return False


def _called_shell_function_body_commands(command: str) -> list[str]:
    commands: list[str] = []
    for function_name, body, tail in _shell_function_definitions(command):
        if not _shell_function_invoked(function_name, tail):
            continue
        for body_command in _split_shell_commands_for_classification(body):
            if body_command not in commands:
                commands.append(body_command)
    return commands


def _nested_shell_command(tokens: list[str]) -> str | None:
    if not tokens or _command_semantic_name(tokens[0]) not in {"bash", "sh", "zsh", "fish"}:
        return None
    for index, token in enumerate(tokens[1:], start=1):
        if token == "--":
            return None
        if token in {"-c", "/c", "--command"} and index + 1 < len(tokens):
            return tokens[index + 1]
        if token.startswith("-") and not token.startswith("--") and "c" in token[1:] and index + 1 < len(tokens):
            return tokens[index + 1]
    return None


def _decode_powershell_encoded_command(value: str) -> str | None:
    try:
        data = base64.b64decode(value, validate=True)
    except Exception:
        return None
    for encoding in ("utf-16le", "utf-8"):
        try:
            text = data.decode(encoding).strip("\ufeff").strip()
        except UnicodeDecodeError:
            continue
        if text:
            return text
    return None


def _nested_powershell_command(tokens: list[str]) -> str | None:
    if not tokens or _command_semantic_name(tokens[0]) not in POWERSHELL_EVALUATORS:
        return None
    options_with_values = {
        "-args",
        "-configurationname",
        "-executionpolicy",
        "-file",
        "-inputformat",
        "-outputformat",
        "-settingsfile",
        "-windowstyle",
        "-workingdirectory",
    }
    index = 1
    while index < len(tokens):
        token = tokens[index]
        lower = token.lower()
        if lower == "--":
            return None
        if lower in {"-command", "-c"} and index + 1 < len(tokens):
            return tokens[index + 1].strip()
        if lower.startswith("-command:") or lower.startswith("-command="):
            return token.split(token[8], 1)[1].strip()
        if lower in {"-encodedcommand", "-enc", "-e"} and index + 1 < len(tokens):
            return _decode_powershell_encoded_command(tokens[index + 1])
        if lower.startswith("-encodedcommand:") or lower.startswith("-encodedcommand="):
            return _decode_powershell_encoded_command(token.split(token[15], 1)[1])
        if lower in options_with_values and index + 1 < len(tokens):
            index += 2
            continue
        if lower.startswith("-") and any(
            lower.startswith(option + ":") or lower.startswith(option + "=")
            for option in options_with_values
        ):
            index += 1
            continue
        index += 1
    return None


def _nested_cmd_command(tokens: list[str]) -> str | None:
    if not tokens or _command_semantic_name(tokens[0]) not in CMD_EVALUATORS:
        return None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        lower = token.lower()
        if lower in {"/c", "/k"} and index + 1 < len(tokens):
            return _join_tokens(tokens[index + 1 :])
        if lower.startswith(("/c", "/k")) and len(token) > 2:
            rest = [token[2:]] + tokens[index + 1 :]
            return _join_tokens(rest)
        index += 1
    return None


def _is_python_command(name: str) -> bool:
    name = _command_semantic_name(name)
    return _looks_like_python_command_name(name)


def _is_node_command(name: str) -> bool:
    return _command_semantic_name(name) in NODE_COMMANDS


def _python_inline_code(tokens: list[str]) -> str | None:
    if not tokens or not _is_python_command(tokens[0]):
        return None
    for index, token in enumerate(tokens[1:], start=1):
        if token == "-c" and index + 1 < len(tokens):
            return tokens[index + 1]
        if token.startswith("-c") and len(token) > 2:
            return token[2:]
    return None


def _node_inline_code(tokens: list[str]) -> str | None:
    if not tokens or not _is_node_command(tokens[0]):
        return None
    for index, token in enumerate(tokens[1:], start=1):
        lower = token.lower()
        if lower == "--":
            return None
        if lower in {"-e", "--eval"} and index + 1 < len(tokens):
            return tokens[index + 1]
        if lower.startswith("--eval="):
            return token.split("=", 1)[1]
        if lower.startswith("-e") and len(token) > 2:
            return token[2:]
    return None


def _node_inline_is_destructive(code: str) -> bool:
    return any(pattern.search(code or "") for pattern in NODE_DESTRUCTIVE_PATTERNS)


def _node_inline_writes_device(code: str) -> bool:
    return any(pattern.search(code or "") for pattern in NODE_DEVICE_WRITE_PATTERNS)


def _strip_heredoc_delimiter(raw: str) -> str:
    value = str(raw or "").strip()
    if (len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}):
        return value[1:-1]
    return value


def _python_command_reads_stdin(tokens: list[str]) -> bool:
    if not tokens:
        return False
    try:
        _env, tokens = _strip_wrappers_and_collect_env(tokens)
    except ValueError:
        return False
    if not tokens or not _is_python_command(tokens[0]):
        return False
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in {"-", "--"}:
            index += 1
            continue
        if token in {"-W", "-X"} and index + 1 < len(tokens):
            index += 2
            continue
        if token.startswith(("-W", "-X")) and len(token) > 2:
            index += 1
            continue
        if token.startswith("-") and token not in {"-c", "-m"}:
            index += 1
            continue
        return False
    return True


def _python_heredoc_code(command: str) -> str | None:
    lines = str(command or "").splitlines()
    if len(lines) < 2:
        return None
    header = lines[0]
    match = re.search(r"<<-?\s*([^\s]+)", header)
    if not match:
        return None
    before_heredoc = header[:match.start()].strip()
    try:
        tokens = _split_tokens(before_heredoc)
    except ValueError:
        return None
    if not _python_command_reads_stdin(tokens):
        return None
    delimiter = _strip_heredoc_delimiter(match.group(1))
    body: list[str] = []
    for line in lines[1:]:
        if line.strip() == delimiter:
            return "\n".join(body).strip()
        body.append(line)
    return None


def _shell_command_reads_stdin(tokens: list[str]) -> bool:
    if not tokens:
        return False
    try:
        _env, tokens = _strip_wrappers_and_collect_env(tokens)
    except ValueError:
        return False
    elevated = _nested_elevated_command(tokens)
    if elevated:
        try:
            return _shell_command_reads_stdin(_split_tokens(elevated))
        except ValueError:
            return False
    if not tokens or _command_semantic_name(tokens[0]) not in SHELL_EVALUATORS:
        if not tokens or _command_semantic_name(tokens[0]) not in SOURCE_EVALUATORS:
            return False
        return any(token in STDIN_SOURCE_PATHS for token in tokens[1:])
    for token in tokens[1:]:
        lower = token.lower()
        if lower in {"-c", "--command"} or lower.startswith("--command="):
            return False
        if lower.startswith("-"):
            short_flags = lower.lstrip("-")
            if not lower.startswith("--") and "c" in short_flags:
                return False
    return True


def _split_shell_script_lines(script: str) -> list[str]:
    commands: list[str] = []
    for line in str(script or "").splitlines():
        line = line.strip()
        if not line:
            continue
        commands.extend(_split_shell_commands_for_classification(line))
    return commands


def _shell_heredoc_commands(command: str) -> list[str]:
    lines = str(command or "").splitlines()
    if len(lines) < 2:
        return []
    header = lines[0]
    match = re.search(r"<<-?\s*([^\s]+)", header)
    if not match:
        return []
    before_heredoc = header[:match.start()].strip()
    try:
        tokens = _split_tokens(before_heredoc)
    except ValueError:
        return []
    if not _shell_command_reads_stdin(tokens):
        return []
    delimiter = _strip_heredoc_delimiter(match.group(1))
    body: list[str] = []
    for line in lines[1:]:
        if line.strip() == delimiter:
            return _split_shell_script_lines("\n".join(body))
        body.append(line)
    return []


def _shell_here_string_commands(command: str) -> list[str]:
    commands: list[str] = []
    for segment, _connector in _split_shell_segments_for_classification(command):
        try:
            tokens = _split_tokens(segment)
        except ValueError:
            continue
        for index, token in enumerate(tokens):
            script = None
            if token == "<<<" and index + 1 < len(tokens):
                script = tokens[index + 1]
            elif token.startswith("<<<") and len(token) > 3:
                script = token[3:]
            if script is None:
                continue
            if _shell_command_reads_stdin(tokens[:index]):
                commands.extend(_split_shell_commands_for_classification(script))
    return commands


def _shell_stdin_script_commands(command: str) -> list[str]:
    commands = _shell_heredoc_commands(command)
    commands.extend(cmd for cmd in _shell_here_string_commands(command) if cmd not in commands)
    return commands


def _shell_or_source_accepts_script_arg(tokens: list[str]) -> bool:
    if not tokens:
        return False
    try:
        _env, tokens = _strip_wrappers_and_collect_env(tokens)
    except ValueError:
        return False
    elevated = _nested_elevated_command(tokens)
    if elevated:
        try:
            return _shell_or_source_accepts_script_arg(_split_tokens(elevated))
        except ValueError:
            return False
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    if name in SOURCE_EVALUATORS:
        return True
    if name not in SHELL_EVALUATORS:
        return False
    for token in tokens[1:]:
        lower = token.lower()
        if lower in {"-c", "--command"} or lower.startswith("--command="):
            return False
        if lower.startswith("-") and not lower.startswith("--") and "c" in lower.lstrip("-"):
            return False
    return True


def _literal_output_script(command: str) -> str | None:
    try:
        _env, tokens = _strip_wrappers_and_collect_env(_split_tokens(command))
    except ValueError:
        return None
    if not tokens:
        return None
    name = _command_semantic_name(tokens[0])
    if name == "echo":
        args = list(tokens[1:])
        interpret_escapes = False
        while args and args[0] in {"-n", "-e", "-E"}:
            if args[0] == "-e":
                interpret_escapes = True
            if args[0] == "-E":
                interpret_escapes = False
            args = args[1:]
        output = " ".join(args).strip()
        if interpret_escapes:
            output = output.replace("\\n", "\n")
        return output or None
    if name == "printf" and len(tokens) >= 3:
        fmt = tokens[1]
        if fmt in {"%s", "%s\n", "%s\\n"}:
            separator = "\n" if fmt in {"%s\n", "%s\\n"} else ""
            return separator.join(tokens[2:]).strip() or None
        if fmt in {"%b", "%b\n", "%b\\n"}:
            separator = "\n" if fmt in {"%b\n", "%b\\n"} else ""
            output = separator.join(_decode_ansi_c_quoted_text(token) for token in tokens[2:])
            return output.strip() or None
    return None


def _process_substitution_literal_script_commands(command: str) -> list[str]:
    commands: list[str] = []
    for segment, _connector in _split_shell_segments_for_classification(command):
        try:
            tokens = _split_tokens(segment)
        except ValueError:
            continue
        if not _shell_or_source_accepts_script_arg(tokens):
            continue
        for operator, substitution in _extract_process_substitutions(segment):
            if operator != "<":
                continue
            commands.extend(_base64_literal_decode_pipeline_script_commands(substitution))
            for producer in _split_shell_commands_for_classification(substitution):
                script = _literal_output_script(producer)
                if script:
                    commands.extend(_split_shell_script_lines(script))
    return commands


def _python_inline_destructive_file_operation(code: str, depth: int = 0) -> str | None:
    code = _utf8_safe_text(code)
    for pattern in PYTHON_DESTRUCTIVE_PATTERNS:
        match = pattern.search(code or "")
        if match:
            return match.group(0)
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return None
    if depth < PYTHON_INLINE_CODE_MAX_DEPTH:
        for nested_code in _python_inline_literal_nested_codes(tree):
            matched = _python_inline_destructive_file_operation(nested_code, depth=depth + 1)
            if matched:
                return matched
    module_aliases, call_aliases = _python_inline_import_aliases(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        call_name = _python_inline_call_name(node.func, module_aliases, call_aliases)
        if call_name in PYTHON_DESTRUCTIVE_FILE_CALLS:
            return _python_call_source(code, node, call_name)
        if _python_inline_path_delete_call(node.func, module_aliases, call_aliases):
            return ast.get_source_segment(code, node) or "Path delete operation"
    return None


def _python_literal_string(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _python_open_mode_writes(mode: str | None) -> bool:
    if mode is None:
        return False
    return any(flag in mode for flag in PYTHON_WRITE_MODES)


def _python_inline_device_write_operation(code: str, depth: int = 0) -> str | None:
    code = _utf8_safe_text(code)
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return None
    if depth < PYTHON_INLINE_CODE_MAX_DEPTH:
        for nested_code in _python_inline_literal_nested_codes(tree):
            matched = _python_inline_device_write_operation(nested_code, depth=depth + 1)
            if matched:
                return matched
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "open" or not node.args:
            continue
        target = _python_literal_string(node.args[0])
        if not target or not _is_device_redirection_target(target):
            continue
        mode = _python_literal_string(node.args[1]) if len(node.args) > 1 else None
        for keyword in node.keywords:
            if keyword.arg == "mode":
                mode = _python_literal_string(keyword.value)
        if _python_open_mode_writes(mode):
            return ast.get_source_segment(code, node) or "python device write"
    return None


def _python_inline_is_destructive(code: str, depth: int = 0) -> bool:
    return _python_inline_destructive_file_operation(code, depth=depth) is not None


def _python_call_source(code: str, node: ast.Call, call_name: tuple[str, str] | None) -> str:
    source = ast.get_source_segment(code, node)
    if source:
        return source
    if call_name:
        return f"{call_name[0]}.{call_name[1]}(...)"
    return "python destructive file operation"


def _python_inline_shell_commands(code: str, depth: int = 0) -> list[str]:
    code = _utf8_safe_text(code)
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return []
    module_aliases, call_aliases = _python_inline_import_aliases(tree)
    commands: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        call_name = _python_inline_call_name(node.func, module_aliases, call_aliases)
        if call_name in PYTHON_SHELL_CALLS:
            commands.extend(_python_literal_shell_command_arg(node, require_shell_keyword=False))
        elif call_name in PYTHON_OS_EXEC_CALLS:
            commands.extend(_python_literal_os_process_command_args(node, call_name[1], module_aliases, argv_index=1))
        elif call_name in PYTHON_OS_SPAWN_CALLS:
            commands.extend(_python_literal_os_process_command_args(node, call_name[1], module_aliases, argv_index=2))
        elif call_name in PYTHON_OS_POSIX_SPAWN_CALLS:
            commands.extend(_python_literal_posix_spawn_command_args(node, module_aliases))
        elif call_name in PYTHON_SUBPROCESS_CALLS:
            commands.extend(_python_literal_subprocess_command_arg(node, module_aliases))
    if depth < PYTHON_INLINE_CODE_MAX_DEPTH:
        for nested_code in _python_inline_literal_nested_codes(tree):
            commands.extend(_python_inline_shell_commands(nested_code, depth=depth + 1))
    return commands


def _python_inline_literal_nested_codes(tree: ast.AST) -> list[str]:
    codes: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in PYTHON_INLINE_CODE_EVALUATORS
            and node.args
        ):
            code = _python_inline_literal_code_arg(node.args[0])
            if code:
                codes.append(code)
    return codes


def _python_inline_literal_code_arg(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "compile"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    ):
        return node.args[0].value
    return None


def _python_inline_import_aliases(
    tree: ast.AST,
) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
    module_aliases = {module: module for module in PYTHON_INLINE_MODULES}
    call_aliases: dict[str, tuple[str, str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in PYTHON_INLINE_MODULES:
                    module_aliases[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module in PYTHON_INLINE_MODULES:
            for alias in node.names:
                call_name = (node.module, alias.name)
                if call_name in PYTHON_INLINE_IMPORTABLE_CALLS:
                    call_aliases[alias.asname or alias.name] = call_name
    _python_inline_assignment_aliases(tree, module_aliases, call_aliases)
    return module_aliases, call_aliases


def _python_inline_assignment_aliases(
    tree: ast.AST,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            call_name = _python_inline_call_name(node.value, module_aliases, call_aliases)
            if call_name not in PYTHON_INLINE_IMPORTABLE_CALLS:
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    call_aliases[target.id] = call_name
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            call_name = _python_inline_call_name(node.value, module_aliases, call_aliases)
            if call_name in PYTHON_INLINE_IMPORTABLE_CALLS:
                call_aliases[node.target.id] = call_name


def _python_inline_call_name(
    func: ast.expr,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> tuple[str, str] | None:
    if isinstance(func, ast.Attribute):
        module = _python_inline_attribute_module(func.value, module_aliases, call_aliases)
        return (module, func.attr) if module else None
    if isinstance(func, ast.Name):
        return call_aliases.get(func.id)
    if isinstance(func, ast.Call):
        return _python_inline_getattr_call_name(func, module_aliases, call_aliases)
    return None


def _python_inline_getattr_call_name(
    call: ast.Call,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> tuple[str, str] | None:
    if (
        not isinstance(call.func, ast.Name)
        or call.func.id != "getattr"
        or len(call.args) < 2
        or not isinstance(call.args[1], ast.Constant)
        or not isinstance(call.args[1].value, str)
    ):
        return None
    module = _python_inline_attribute_module(call.args[0], module_aliases, call_aliases)
    return (module, call.args[1].value) if module else None


def _python_inline_attribute_module(
    value: ast.expr,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> str | None:
    if isinstance(value, ast.Name):
        return module_aliases.get(value.id)
    if (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id == "__import__"
        and value.args
        and isinstance(value.args[0], ast.Constant)
        and isinstance(value.args[0].value, str)
        and value.args[0].value in PYTHON_INLINE_MODULES
    ):
        return value.args[0].value
    if isinstance(value, ast.Call):
        return _python_inline_import_module_target(value, module_aliases, call_aliases)
    return None


def _python_inline_import_module_target(
    call: ast.Call,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> str | None:
    if (
        not call.args
        or not isinstance(call.args[0], ast.Constant)
        or not isinstance(call.args[0].value, str)
        or call.args[0].value not in PYTHON_INLINE_TARGET_MODULES
    ):
        return None
    return (
        call.args[0].value
        if _python_inline_call_name(call.func, module_aliases, call_aliases) in PYTHON_IMPORT_MODULE_CALLS
        else None
    )


def _python_inline_path_delete_call(
    func: ast.expr,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> bool:
    if _python_inline_path_getattr_delete_call(func, module_aliases, call_aliases):
        return True
    if not isinstance(func, ast.Attribute) or func.attr not in PYTHON_PATH_DELETE_METHODS:
        return False
    if not isinstance(func.value, ast.Call):
        return False
    return _python_inline_call_name(func.value.func, module_aliases, call_aliases) in PYTHON_PATH_FACTORY_CALLS


def _python_inline_path_getattr_delete_call(
    func: ast.expr,
    module_aliases: dict[str, str],
    call_aliases: dict[str, tuple[str, str]],
) -> bool:
    if (
        not isinstance(func, ast.Call)
        or not isinstance(func.func, ast.Name)
        or func.func.id != "getattr"
        or len(func.args) < 2
        or not isinstance(func.args[0], ast.Call)
        or not isinstance(func.args[1], ast.Constant)
        or not isinstance(func.args[1].value, str)
        or func.args[1].value not in PYTHON_PATH_DELETE_METHODS
    ):
        return False
    return _python_inline_call_name(func.args[0].func, module_aliases, call_aliases) in PYTHON_PATH_FACTORY_CALLS


def _python_literal_shell_command_arg(node: ast.Call, *, require_shell_keyword: bool) -> list[str]:
    if not node.args:
        return []
    if require_shell_keyword and not _python_call_has_shell_true(node):
        return []
    command = node.args[0]
    if isinstance(command, ast.Constant) and isinstance(command.value, str):
        return _split_shell_commands_for_classification(command.value)
    return []


def _python_literal_subprocess_command_arg(node: ast.Call, module_aliases: dict[str, str] | None = None) -> list[str]:
    command = _python_subprocess_command_node(node)
    if command is None:
        return []
    if isinstance(command, ast.Constant) and isinstance(command.value, str):
        if _python_call_has_shell_true(node):
            return _split_shell_commands_for_classification(command.value)
        return []
    argv = _python_literal_argv(command, module_aliases)
    return [_join_find_exec_tokens(argv)] if argv else []


def _python_literal_os_process_command_args(
    node: ast.Call,
    name: str,
    module_aliases: dict[str, str] | None = None,
    *,
    argv_index: int,
) -> list[str]:
    if len(node.args) <= argv_index:
        return []
    if name.startswith(("execv", "spawnv")):
        argv = _python_literal_argv(node.args[argv_index], module_aliases)
    else:
        args = list(node.args[argv_index:])
        if name.endswith("e") and args and _python_literal_argv_element(args[-1], module_aliases) is None:
            args = args[:-1]
        argv = _python_literal_args(args, module_aliases)
    return [_join_find_exec_tokens(argv)] if argv else []


def _python_literal_posix_spawn_command_args(
    node: ast.Call,
    module_aliases: dict[str, str] | None = None,
) -> list[str]:
    if len(node.args) < 2:
        return []
    argv = _python_literal_argv(node.args[1], module_aliases)
    return [_join_find_exec_tokens(argv)] if argv else []


def _python_subprocess_command_node(node: ast.Call) -> ast.AST | None:
    if node.args:
        return node.args[0]
    for keyword in node.keywords:
        if keyword.arg == "args":
            return keyword.value
    return None


def _python_call_has_shell_true(node: ast.Call) -> bool:
    for keyword in node.keywords:
        if keyword.arg == "shell" and isinstance(keyword.value, ast.Constant) and keyword.value.value is True:
            return True
    return False


def _python_literal_argv(node: ast.AST, module_aliases: dict[str, str] | None = None) -> list[str]:
    if not isinstance(node, (ast.List, ast.Tuple)):
        return []
    return _python_literal_args(list(node.elts), module_aliases)


def _python_literal_args(nodes: list[ast.AST], module_aliases: dict[str, str] | None = None) -> list[str]:
    argv: list[str] = []
    for element in nodes:
        value = _python_literal_argv_element(element, module_aliases)
        if value is None:
            return []
        argv.append(value)
    return argv


def _python_literal_argv_element(node: ast.AST, module_aliases: dict[str, str] | None = None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if (
        isinstance(node, ast.Attribute)
        and node.attr == "executable"
        and isinstance(node.value, ast.Name)
        and (module_aliases or {}).get(node.value.id) == "sys"
    ):
        return "python"
    return None


def _nested_eval_command(tokens: list[str]) -> str | None:
    if not tokens or tokens[0] != "eval":
        return None
    rest = tokens[1:]
    if not rest:
        return None
    if len(rest) == 1:
        return rest[0].strip()
    return _join_tokens(rest)


def _trap_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "trap":
        return []
    rest = list(tokens[1:])
    while rest and rest[0] in {"-l", "-p"}:
        rest = rest[1:]
    if rest and rest[0] == "--":
        rest = rest[1:]
    if not rest:
        return []
    payload = rest[0].strip()
    if not payload or payload == "-":
        return []
    return _split_shell_commands_for_classification(payload)


def _nested_builtin_command(tokens: list[str]) -> str | None:
    if not tokens or _command_semantic_name(tokens[0]) != "builtin":
        return None
    rest = list(tokens[1:])
    if rest and rest[0] == "--":
        rest = rest[1:]
    if not rest or _command_semantic_name(rest[0]) not in BUILTIN_DISPATCH_COMMANDS:
        return None
    return _join_tokens(rest)


def _expand_builtin_dispatch(nested: str, nested_tokens: list[str]) -> list[str]:
    commands = _split_shell_commands_for_classification(nested)

    eval_nested = _nested_eval_command(nested_tokens)
    if eval_nested:
        commands.extend(
            command
            for command in _split_shell_commands_for_classification(eval_nested)
            if command not in commands
        )

    _env, stripped = _strip_wrappers_and_collect_env(nested_tokens)
    if stripped:
        stripped_command = _join_tokens(stripped)
        if stripped_command not in commands:
            commands.append(stripped_command)
    return commands


def _builtin_nested_commands(tokens: list[str]) -> list[str]:
    nested = _nested_builtin_command(tokens)
    if not nested:
        return []
    try:
        nested_tokens = _split_tokens(nested)
    except ValueError:
        return _split_shell_commands_for_classification(nested)
    return _expand_builtin_dispatch(nested, nested_tokens)


def _builtin_nested_commands_from_text(command: str) -> list[str]:
    match = re.match(r"^\s*builtin(?:\s+--)?\s+(.+?)\s*$", str(command or ""))
    if not match:
        return []
    nested = match.group(1).strip()
    try:
        nested_tokens = _split_tokens(nested)
    except ValueError:
        return _split_shell_commands_for_classification(nested)
    if not nested_tokens or _command_semantic_name(nested_tokens[0]) not in BUILTIN_DISPATCH_COMMANDS:
        return []
    return _expand_builtin_dispatch(nested, nested_tokens)


def _join_find_exec_tokens(tokens: list[str]) -> str:
    return " ".join("{}" if token == "{}" else shlex.quote(token) for token in tokens).strip()


def _find_exec_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "find":
        return []
    commands: list[str] = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token not in {"-exec", "-execdir", "-ok", "-okdir"}:
            index += 1
            continue
        index += 1
        nested: list[str] = []
        while index < len(tokens):
            current = tokens[index]
            if current in {";", "+"}:
                break
            nested.append(current)
            index += 1
        if nested:
            commands.append(_join_find_exec_tokens(nested))
        index += 1
    return commands


def _xargs_option_takes_value(option: str) -> bool:
    if option in XARGS_OPTIONS_WITH_VALUES:
        return True
    value_options = ("-E", "-I", "-L", "-P", "-a", "-d", "-e", "-i", "-n", "-s")
    return any(option.startswith(short) and len(option) > len(short) for short in value_options)


def _nested_commands_from_tokens(tokens: list[str]) -> list[str]:
    nested = _nested_shell_command(tokens)
    eval_nested = _nested_eval_command(tokens)
    elevated_nested = _nested_elevated_command(tokens)
    powershell_nested = _nested_powershell_command(tokens)
    cmd_nested = _nested_cmd_command(tokens)
    python_code = _python_inline_code(tokens)
    commands: list[str] = []
    for command in (nested, eval_nested, elevated_nested, powershell_nested, cmd_nested):
        if command:
            commands.extend(_split_shell_commands_for_classification(command))
    if nested:
        commands.extend(_base64_literal_command_substitution_script_commands(nested))
    if eval_nested:
        commands.extend(_base64_literal_command_substitution_script_commands(eval_nested))
    if python_code:
        commands.extend(_python_inline_shell_commands(python_code))
    commands.extend(_find_exec_commands(tokens))
    commands.extend(_git_alias_shell_commands(tokens))
    commands.extend(_env_split_string_commands(tokens))
    commands.extend(cmd for cmd in _builtin_nested_commands(tokens) if cmd not in commands)
    commands.extend(cmd for cmd in _trap_commands(tokens) if cmd not in commands)
    commands.extend(cmd for cmd in _coproc_commands(tokens) if cmd not in commands)
    return commands


def _xargs_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "xargs":
        return []
    rest = list(tokens[1:])
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            index += 1
            break
        if token.startswith("--"):
            if token in XARGS_OPTIONS_WITH_VALUES and index + 1 < len(rest):
                index += 2
            else:
                index += 1
            continue
        if token.startswith("-") and token != "-":
            if (
                _xargs_option_takes_value(token)
                and token in XARGS_OPTIONS_WITH_VALUES
                and index + 1 < len(rest)
            ):
                index += 2
            else:
                index += 1
            continue
        break
    if index >= len(rest):
        return []
    payload = _join_find_exec_tokens(rest[index:])
    commands = [payload]
    try:
        payload_tokens = _split_tokens(payload)
    except ValueError:
        payload_tokens = []
    commands.extend(cmd for cmd in _nested_commands_from_tokens(payload_tokens) if cmd not in commands)
    return commands


def _nested_elevated_command(tokens: list[str]) -> str | None:
    if not tokens or _command_semantic_name(tokens[0]) not in {"sudo", "doas"}:
        return None
    rest = list(tokens[1:])
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            index += 1
            break
        if token in ELEVATION_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in ELEVATION_OPTIONS_WITH_VALUES if option.startswith("--")):
            index += 1
            continue
        if _elevation_cluster_consumes_next_value(token):
            index += 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        break
    if index >= len(rest):
        return None
    return _join_tokens(rest[index:])


def _elevation_cluster_consumes_next_value(token: str) -> bool:
    if not token.startswith("-") or token.startswith("--") or len(token) <= 2:
        return False
    cluster = token[1:]
    for position, option in enumerate(cluster):
        if option in ELEVATION_SHORT_OPTIONS_WITH_VALUES:
            return position == len(cluster) - 1
    return False


def _command_name(tokens: list[str]) -> str:
    _env, stripped = _strip_wrappers_and_collect_env(tokens)
    elevated = _nested_elevated_command(stripped)
    if elevated:
        stripped = _split_tokens(elevated)
        _env, stripped = _strip_wrappers_and_collect_env(stripped)
    return _command_semantic_name(stripped[0]) if stripped else ""


def _remote_script_pipe(command: str) -> tuple[str, str] | None:
    segments = _split_shell_segments_for_classification(command)
    for index, (segment, connector) in enumerate(segments[:-1]):
        if connector != "|":
            continue
        left_name = _command_name(_split_tokens(segment)).lower()
        right_name = _command_name(_split_tokens(segments[index + 1][0])).lower()
        if left_name not in REMOTE_FETCH_COMMANDS:
            continue
        matched = f"{segment} | {segments[index + 1][0]}"
        if right_name in SHELL_EVALUATORS:
            return matched, "remote script piped to shell"
        if right_name in SCRIPT_EVALUATORS:
            return matched, "remote script piped to evaluator"
    return None


def _is_base64_decode_command(tokens: list[str]) -> bool:
    if not tokens or _command_semantic_name(tokens[0]) != "base64":
        return False
    return any(token in {"-d", "-D", "--decode"} for token in tokens[1:])


def _decode_base64_literal_script(text: str) -> str | None:
    compact = re.sub(r"\s+", "", str(text or ""))
    if not compact:
        return None
    try:
        decoded = base64.b64decode(compact, validate=True)
    except Exception:
        return None
    try:
        return decoded.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None


def _base64_literal_pipe_script_commands(command: str) -> list[str]:
    segments = _split_shell_segments_for_classification(command)
    commands: list[str] = []
    for index in range(0, max(0, len(segments) - 2)):
        producer, first_connector = segments[index]
        decoder, second_connector = segments[index + 1]
        consumer = segments[index + 2][0]
        if first_connector != "|" or second_connector != "|":
            continue
        try:
            decoder_tokens = _split_tokens(decoder)
            consumer_name = _command_name(_split_tokens(consumer)).lower()
        except ValueError:
            continue
        if (
            consumer_name not in SHELL_EVALUATORS
            and consumer_name not in SOURCE_EVALUATORS
            and consumer_name not in SCRIPT_EVALUATORS
        ):
            continue
        if not _is_base64_decode_command(decoder_tokens):
            continue
        script = _decode_base64_literal_script(_literal_output_script(producer) or "")
        if script:
            commands.extend(_split_shell_script_lines(script))
    return commands


def _base64_literal_decode_pipeline_script_commands(command: str) -> list[str]:
    segments = _split_shell_segments_for_classification(command)
    commands: list[str] = []
    for index in range(0, max(0, len(segments) - 1)):
        producer, connector = segments[index]
        decoder = segments[index + 1][0]
        if connector != "|":
            continue
        try:
            decoder_tokens = _split_tokens(decoder)
        except ValueError:
            continue
        if not _is_base64_decode_command(decoder_tokens):
            continue
        script = _decode_base64_literal_script(_literal_output_script(producer) or "")
        if script:
            commands.extend(_split_shell_script_lines(script))
    return commands


def _base64_literal_command_substitution_script_commands(command: str) -> list[str]:
    commands: list[str] = []
    for substitution in _extract_command_substitutions(command):
        commands.extend(_base64_literal_decode_pipeline_script_commands(substitution))
    return commands


def _remote_script_process_substitution(command: str) -> tuple[str, str, list[str]] | None:
    for segment, _connector in _split_shell_segments_for_classification(command):
        substitutions = _extract_process_substitutions(segment)
        if not substitutions:
            continue
        name = _command_name(_split_tokens(segment)).lower()
        if name not in SHELL_EVALUATORS and name not in SOURCE_EVALUATORS:
            continue
        nested_commands: list[str] = []
        for operator, substitution in substitutions:
            substitution_commands = _split_shell_commands_for_classification(substitution)
            nested_commands.extend(substitution_commands)
            if operator != "<":
                continue
            for substitution_command in substitution_commands:
                inner_name = _command_name(_split_tokens(substitution_command)).lower()
                if inner_name in REMOTE_FETCH_COMMANDS:
                    reason = (
                        "remote script process substitution to shell"
                        if name in SHELL_EVALUATORS
                        else "remote script process substitution to evaluator"
                    )
                    return segment, reason, nested_commands
    return None


def _tokens_for_nested_evaluator_scan(tokens: list[str]) -> list[list[str]]:
    candidates = [tokens]
    elevated = _nested_elevated_command(tokens)
    if elevated:
        try:
            _env, stripped = _strip_wrappers_and_collect_env(_split_tokens(elevated))
            if stripped:
                candidates.append(stripped)
        except ValueError:
            pass
    return candidates


def _remote_fetch_substitution_commands(command_text: str) -> list[str]:
    commands: list[str] = []
    for substitution in _extract_command_substitutions(command_text):
        for substitution_command in _split_shell_commands_for_classification(substitution):
            try:
                name = _command_name(_split_tokens(substitution_command)).lower()
            except ValueError:
                continue
            if name in REMOTE_FETCH_COMMANDS:
                commands.append(substitution_command)
    return commands


def _remote_script_command_substitution(command: str) -> tuple[str, str, list[str]] | None:
    for segment, _connector in _split_shell_segments_for_classification(command):
        try:
            _env, stripped = _strip_wrappers_and_collect_env(_split_tokens(segment))
        except ValueError:
            continue
        for tokens in _tokens_for_nested_evaluator_scan(stripped):
            shell_nested = _nested_shell_command(tokens)
            if shell_nested:
                nested_commands = _remote_fetch_substitution_commands(shell_nested)
                if nested_commands:
                    return segment, "remote script command substitution to shell", nested_commands
            eval_nested = _nested_eval_command(tokens)
            if eval_nested:
                nested_commands = _remote_fetch_substitution_commands(eval_nested)
                if nested_commands:
                    return segment, "remote script command substitution to evaluator", nested_commands
    return None


def _has_shell_stdin_redirection(tokens: list[str]) -> bool:
    if not tokens or tokens[0].lower() not in SHELL_EVALUATORS:
        return False
    return any(token in {"<<", "<<<"} or token.startswith(("<<", "<<<")) for token in tokens[1:])


def _remote_script_stdin_redirection(command: str) -> tuple[str, str, list[str]] | None:
    for segment, _connector in _split_shell_segments_for_classification(command):
        try:
            _env, stripped = _strip_wrappers_and_collect_env(_split_tokens(segment))
        except ValueError:
            continue
        for tokens in _tokens_for_nested_evaluator_scan(stripped):
            if not _has_shell_stdin_redirection(tokens):
                continue
            nested_commands = _remote_fetch_substitution_commands(segment)
            if nested_commands:
                return segment, "remote script redirected to shell stdin", nested_commands
    return None


def _rm_has_recursive_force(flags: list[str]) -> bool:
    recursive = False
    force = False
    for flag in flags:
        if flag == "--force":
            force = True
            continue
        if flag == "--recursive":
            recursive = True
            continue
        if flag.startswith("--"):
            continue
        short_flags = flag.lstrip("-")
        recursive = recursive or any(char in short_flags for char in "rR")
        force = force or "f" in short_flags
    return recursive and force


def _has_recursive_flag(flags: list[str]) -> bool:
    for flag in flags:
        if flag == "--recursive":
            return True
        if flag.startswith("--"):
            continue
        if "R" in flag.lstrip("-"):
            return True
    return False


def _redirection_targets(tokens: list[str]) -> list[str]:
    targets: list[str] = []
    for index, token in enumerate(tokens):
        if token in REDIRECTION_OPERATORS and index + 1 < len(tokens):
            targets.append(tokens[index + 1])
            continue
        if re.fullmatch(r"(?:\d+|&)?(?:>>?|>\||<>)", token) and index + 1 < len(tokens):
            targets.append(tokens[index + 1])
            continue
        match = re.match(r"^(?:\d+|&)?(?:>>?|>\||<>)(.+)$", token)
        if match and match.group(1):
            targets.append(match.group(1))
    return targets


def _has_output_redirection(tokens: list[str]) -> bool:
    return any(target and not target.startswith("&") for target in _redirection_targets(tokens))


def _find_file_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "find":
        return []
    targets: list[str] = []
    for index, token in enumerate(tokens[:-1]):
        if token in FIND_FILE_OUTPUT_ACTIONS:
            targets.append(tokens[index + 1])
    return targets


def _is_device_redirection_target(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in DEVICE_REDIRECTION_PREFIXES)


def _is_filesystem_format_command(name: str) -> bool:
    return name in {"mkfs", "newfs"} or name.startswith(("mkfs.", "newfs_"))


def _diskutil_is_destructive(tokens: list[str]) -> bool:
    if not tokens or _command_semantic_name(tokens[0]) != "diskutil" or len(tokens) <= 1:
        return False
    subcommand = tokens[1].lower()
    if subcommand in DISKUTIL_DESTRUCTIVE_SUBCOMMANDS:
        return True
    nested = DISKUTIL_DESTRUCTIVE_GROUP_SUBCOMMANDS.get(subcommand)
    return bool(nested and len(tokens) > 2 and tokens[2].lower() in nested)


def _fdisk_is_destructive(tokens: list[str]) -> bool:
    if not tokens or _command_semantic_name(tokens[0]) != "fdisk":
        return False
    return any(token.startswith("-") and "i" in token[1:] for token in tokens[1:])


def _gpt_is_destructive(tokens: list[str]) -> bool:
    return bool(
        tokens
        and _command_semantic_name(tokens[0]) == "gpt"
        and len(tokens) > 1
        and tokens[1].lower() == "destroy"
    )


def _dd_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "dd":
        return []
    targets: list[str] = []
    for token in tokens[1:]:
        if not token.startswith("of="):
            continue
        target = token.split("=", 1)[1]
        if target:
            targets.append(target)
    return targets


def _tee_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "tee":
        return []
    targets: list[str] = []
    consume_options = True
    for token in tokens[1:]:
        if consume_options and token == "--":
            consume_options = False
            continue
        if consume_options and token.startswith("-"):
            continue
        targets.append(token)
    return targets


def _cp_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "cp":
        return []
    operands: list[str] = []
    index = 1
    consume_options = True
    while index < len(tokens):
        token = tokens[index]
        if consume_options and token == "--":
            consume_options = False
            index += 1
            continue
        if consume_options and token in {"-t", "--target-directory"} and index + 1 < len(tokens):
            return [tokens[index + 1]]
        if consume_options and token.startswith("--target-directory="):
            target = token.split("=", 1)[1]
            return [target] if target else []
        if consume_options and token.startswith("-") and token != "-":
            index += 1
            continue
        operands.append(token)
        index += 1
    return [operands[-1]] if len(operands) >= 2 else []


def _mv_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "mv":
        return []
    operands: list[str] = []
    index = 1
    consume_options = True
    while index < len(tokens):
        token = tokens[index]
        if consume_options and token == "--":
            consume_options = False
            index += 1
            continue
        if consume_options and token in {"-t", "--target-directory"} and index + 1 < len(tokens):
            return [tokens[index + 1]]
        if consume_options and token.startswith("--target-directory="):
            target = token.split("=", 1)[1]
            return [target] if target else []
        if consume_options and token.startswith("-") and token != "-":
            index += 1
            continue
        operands.append(token)
        index += 1
    return [operands[-1]] if len(operands) >= 2 else []


def _rsync_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "rsync":
        return []
    options_with_values = {
        "-B",
        "-e",
        "-M",
        "--block-size",
        "--bwlimit",
        "--checksum-seed",
        "--compress-choice",
        "--contimeout",
        "--files-from",
        "--log-file",
        "--max-delete",
        "--max-size",
        "--min-size",
        "--out-format",
        "--password-file",
        "--remote-option",
        "--rsync-path",
        "--suffix",
        "--temp-dir",
        "--timeout",
    }
    operands: list[str] = []
    index = 1
    consume_options = True
    while index < len(tokens):
        token = tokens[index]
        if consume_options and token == "--":
            consume_options = False
            index += 1
            continue
        if consume_options and token in options_with_values and index + 1 < len(tokens):
            index += 2
            continue
        if consume_options and any(token.startswith(option + "=") for option in options_with_values if option.startswith("--")):
            index += 1
            continue
        if consume_options and token.startswith("-") and token != "-":
            index += 1
            continue
        operands.append(token)
        index += 1
    return [operands[-1]] if len(operands) >= 2 else []


def _tar_archive_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "tar":
        return []
    writes_archive = False
    targets: list[str] = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            break
        if token in {"--create", "--append", "--update", "--delete", "--concatenate", "--catenate"}:
            writes_archive = True
            index += 1
            continue
        if token in {"--file", "-f"} and index + 1 < len(tokens):
            targets.append(tokens[index + 1])
            index += 2
            continue
        if token.startswith("--file="):
            target = token.split("=", 1)[1]
            if target:
                targets.append(target)
            index += 1
            continue
        if token.startswith("-") and not token.startswith("--"):
            flags = token[1:]
            if any(flag in flags for flag in "crudA"):
                writes_archive = True
            if "f" in flags:
                position = flags.index("f")
                target = flags[position + 1 :]
                if target:
                    targets.append(target)
                elif index + 1 < len(tokens):
                    targets.append(tokens[index + 1])
                    index += 1
        index += 1
    return targets if writes_archive else []


def _install_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "install":
        return []
    options_with_values = {
        "-g",
        "-m",
        "-o",
        "-S",
        "-t",
        "--group",
        "--mode",
        "--owner",
        "--suffix",
        "--target-directory",
    }
    operands: list[str] = []
    index = 1
    consume_options = True
    while index < len(tokens):
        token = tokens[index]
        if consume_options and token == "--":
            consume_options = False
            index += 1
            continue
        if consume_options and token in {"-d", "--directory"}:
            return []
        if consume_options and token in {"-t", "--target-directory"} and index + 1 < len(tokens):
            return [tokens[index + 1]]
        if consume_options and token.startswith("--target-directory="):
            target = token.split("=", 1)[1]
            return [target] if target else []
        if consume_options and token in options_with_values and index + 1 < len(tokens):
            index += 2
            continue
        if consume_options and any(token.startswith(option + "=") for option in options_with_values if option.startswith("--")):
            index += 1
            continue
        if consume_options and token.startswith("-") and token != "-":
            index += 1
            continue
        operands.append(token)
        index += 1
    return [operands[-1]] if len(operands) >= 2 else []


def _download_output_targets(tokens: list[str]) -> list[str]:
    if not tokens:
        return []
    name = _command_semantic_name(tokens[0])
    targets: list[str] = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            break
        target = None
        if name == "curl":
            if token in {"-o", "--output"} and index + 1 < len(tokens):
                target = tokens[index + 1]
                index += 1
            elif token.startswith("--output="):
                target = token.split("=", 1)[1]
            elif token.startswith("-o") and len(token) > 2:
                target = token[2:]
        elif name == "wget":
            if token in {"-O", "--output-document"} and index + 1 < len(tokens):
                target = tokens[index + 1]
                index += 1
            elif token.startswith("--output-document="):
                target = token.split("=", 1)[1]
            elif token.startswith("-O") and len(token) > 2:
                target = token[2:]
        if target and target != "-":
            targets.append(target)
        index += 1
    return targets


def _openssl_output_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "openssl":
        return []
    targets: list[str] = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        target = None
        if token == "-out" and index + 1 < len(tokens):
            target = tokens[index + 1]
            index += 1
        elif token.startswith("-out="):
            target = token.split("=", 1)[1]
        if target and target != "-":
            targets.append(target)
        index += 1
    return targets


def _git_subcommand_tokens(tokens: list[str]) -> list[str]:
    rest = list(tokens[1:])
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            return rest[index + 1 :]
        if token in GIT_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in GIT_OPTIONS_WITH_VALUES if option.startswith("--")):
            index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        return rest[index:]
    return []


def _git_alias_config(value: str) -> tuple[str, str] | None:
    key, sep, raw_command = value.partition("=")
    if not sep:
        return None
    key = key.strip().lower()
    if not key.startswith("alias."):
        return None
    alias_name = key.removeprefix("alias.").strip()
    command = raw_command.lstrip()
    if not alias_name or not command.startswith("!"):
        return None
    shell_command = command[1:].strip()
    if not shell_command:
        return None
    return alias_name, shell_command


def _git_alias_shell_commands(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "git":
        return []

    aliases: dict[str, str] = {}
    rest = list(tokens[1:])
    index = 0
    while index < len(rest):
        token = rest[index]
        if token == "--":
            break
        if token == "-c":
            if index + 1 >= len(rest):
                break
            alias = _git_alias_config(rest[index + 1])
            if alias:
                aliases[alias[0]] = alias[1]
            index += 2
            continue
        if token in GIT_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in GIT_OPTIONS_WITH_VALUES if option.startswith("--")):
            index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        break

    sub_tokens = _git_subcommand_tokens(tokens)
    if not sub_tokens:
        return []
    subcommand = sub_tokens[0].lower()
    if subcommand in GIT_BUILTIN_SUBCOMMANDS:
        return []
    shell_command = aliases.get(subcommand)
    if not shell_command:
        return []
    return _split_shell_commands_for_classification(shell_command)


def _git_clean_has_force(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--force", "-f"}:
            return True
        if flag.startswith("--"):
            continue
        if "f" in flag.lstrip("-"):
            return True
    return False


def _git_clean_is_dry_run(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--dry-run", "-n"}:
            return True
        if flag.startswith("--"):
            continue
        if "n" in flag.lstrip("-"):
            return True
    return False


def _git_branch_deletes_branch(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--delete", "--delete-force", "-d", "-D"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"d", "D"}):
            return True
    return False


def _git_branch_writes_branch(flags: list[str]) -> bool:
    for flag in flags:
        if flag in GIT_BRANCH_WRITE_FLAGS:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"c", "C", "m", "M", "u"}):
            return True
    return False


def _git_tag_deletes_tag(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--delete", "-d", "-D"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"d", "D"}):
            return True
    return False


def _git_update_ref_deletes_ref(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--delete", "-d", "-D"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"d", "D"}):
            return True
    return False


def _git_flag_deletes_ref(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--delete", "-d", "-D"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"d", "D"}):
            return True
    return False


def _git_notes_deletes_note(args: list[str]) -> bool:
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() in {"prune", "remove"}
    return False


def _git_has_force_flag(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--force", "-f", "-F"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and any(ch in short for ch in {"f", "F"}):
            return True
    return False


def _git_submodule_force_deinits(args: list[str], flags: list[str]) -> bool:
    if not _git_has_force_flag(flags):
        return False
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() == "deinit"
    return False


def _git_restore_has_pathspec(args: list[str]) -> bool:
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--":
            return index + 1 < len(args)
        if token in GIT_RESTORE_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if any(token.startswith(option + "=") for option in GIT_RESTORE_OPTIONS_WITH_VALUES if option.startswith("--")):
            index += 1
            continue
        if token.startswith("-s") and token != "-S" and len(token) > 2:
            index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        return True
    return False


def _git_restore_touches_worktree(flags: list[str]) -> bool:
    staged = False
    worktree = False
    for flag in flags:
        if flag == "--staged":
            staged = True
            continue
        if flag == "--worktree":
            worktree = True
            continue
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if "S" in short:
            staged = True
        if "W" in short:
            worktree = True
    return worktree or not staged


def _git_checkout_discards_changes(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"--discard-changes", "--force", "-f"}:
            return True
        if flag.startswith("--"):
            continue
        short = flag.lstrip("-")
        if short and "f" in short:
            return True
    return False


def _git_worktree_removes_worktree(args: list[str]) -> bool:
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() in {"remove"}
    return False


def _git_stash_deletes_stash(args: list[str]) -> bool:
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() in {"clear", "drop"}
    return False


def _git_reflog_deletes_history(args: list[str]) -> bool:
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() in {"delete", "expire"}
    return False


def _git_gc_prunes_objects(flags: list[str]) -> bool:
    for flag in flags:
        if flag == "--prune":
            return True
        if flag.startswith("--prune="):
            return True
    return False


def _git_remote_writes_state(args: list[str]) -> bool:
    for token in args:
        if token.startswith("-"):
            continue
        return token.lower() in GIT_REMOTE_WRITE_SUBCOMMANDS
    return False


def _sed_has_in_place_edit(flags: list[str]) -> bool:
    for flag in flags:
        if flag in {"-i", "--in-place"}:
            return True
        if flag.startswith("--in-place="):
            return True
        if flag.startswith("-i") and flag != "-":
            return True
    return False


def _find_unescaped_char(text: str, char: str, start: int = 0) -> int | None:
    escaped = False
    for index in range(start, len(text)):
        current = text[index]
        if escaped:
            escaped = False
            continue
        if current == "\\":
            escaped = True
            continue
        if current == char:
            return index
    return None


def _strip_sed_addresses(fragment: str) -> str:
    text = fragment.strip()
    for _ in range(2):
        text = text.lstrip()
        match = re.match(r"^(?:\d+|\$)", text)
        if match:
            text = text[match.end() :]
        elif text.startswith("/"):
            end = _find_unescaped_char(text, "/", 1)
            if end is None:
                break
            text = text[end + 1 :]
        else:
            break
        text = text.lstrip()
        if text.startswith(","):
            text = text[1:]
            continue
        break
    text = text.lstrip()
    if text.startswith("!"):
        text = text[1:].lstrip()
    return text


def _sed_substitute_writes_file(command: str) -> bool:
    if len(command) < 2 or command[0] != "s":
        return False
    delimiter = command[1]
    if delimiter.isspace() or delimiter.isalnum():
        return False
    first = _find_unescaped_char(command, delimiter, 2)
    if first is None:
        return False
    second = _find_unescaped_char(command, delimiter, first + 1)
    if second is None:
        return False
    flags = command[second + 1 :].strip()
    return bool(re.match(r"^[0-9gIpPeEM]*w\s+\S+", flags))


def _sed_script_writes_file(script: str) -> bool:
    for fragment in re.split(r"[;\n]", script):
        command = _strip_sed_addresses(fragment)
        if re.match(r"^w\s+\S+", command):
            return True
        if _sed_substitute_writes_file(command):
            return True
    return False


def _sed_script_fragments(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "sed":
        return []
    fragments: list[str] = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            if index + 1 < len(tokens):
                fragments.append(tokens[index + 1])
            break
        if token in {"-e", "--expression"} and index + 1 < len(tokens):
            fragments.append(tokens[index + 1])
            index += 2
            continue
        if token.startswith("--expression="):
            fragments.append(token.split("=", 1)[1])
            index += 1
            continue
        if token.startswith("-e") and len(token) > 2:
            fragments.append(token[2:])
            index += 1
            continue
        if token in {"-f", "--file"} and index + 1 < len(tokens):
            index += 2
            continue
        if token.startswith("--file="):
            index += 1
            continue
        if token.startswith("-") and token != "-":
            index += 1
            continue
        fragments.append(token)
        break
    return fragments


def _sed_uses_script_file(tokens: list[str]) -> bool:
    if not tokens or _command_semantic_name(tokens[0]) != "sed":
        return False
    for token in tokens[1:]:
        if token in {"-f", "--file"}:
            return True
        if token.startswith("--file="):
            return True
        if token.startswith("-f") and len(token) > 2:
            return True
    return False


def _sed_has_write_file_script(tokens: list[str]) -> bool:
    return any(_sed_script_writes_file(fragment) for fragment in _sed_script_fragments(tokens))


def _less_log_file_targets(tokens: list[str]) -> list[str]:
    if not tokens or _command_semantic_name(tokens[0]) != "less":
        return []
    targets: list[str] = []
    for index, token in enumerate(tokens[1:], start=1):
        if token in {"-o", "-O", "--log-file", "--LOG-FILE"}:
            if index + 1 < len(tokens):
                targets.append(tokens[index + 1])
            continue
        if token.startswith("--log-file=") or token.startswith("--LOG-FILE="):
            target = token.split("=", 1)[1]
            if target:
                targets.append(target)
            continue
        if token.startswith("-o") and len(token) > 2:
            targets.append(token[2:])
            continue
        if token.startswith("-O") and len(token) > 2:
            targets.append(token[2:])
            continue
    return targets


def _container_command_deletes_resource(tokens: list[str]) -> bool:
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    if name in CONTAINER_LEGACY_COMPOSE_COMMANDS:
        args = _strip_leading_options(tokens[1:], CONTAINER_COMPOSE_OPTIONS_WITH_VALUES)
        return bool(args and args[0].lower() in CONTAINER_COMPOSE_DELETE_SUBCOMMANDS)
    if name not in CONTAINER_RUNTIME_COMMANDS:
        return False
    args = _strip_leading_options(tokens[1:], CONTAINER_GLOBAL_OPTIONS_WITH_VALUES)
    if not args:
        return False
    subcommand = args[0].lower()
    if subcommand == "compose":
        compose_args = _strip_leading_options(args[1:], CONTAINER_COMPOSE_OPTIONS_WITH_VALUES)
        return bool(compose_args and compose_args[0].lower() in CONTAINER_COMPOSE_DELETE_SUBCOMMANDS)
    if subcommand in CONTAINER_DELETE_TOPLEVEL_SUBCOMMANDS:
        return True
    if len(args) < 2:
        return False
    grouped = CONTAINER_DELETE_GROUP_SUBCOMMANDS.get(subcommand)
    if not grouped:
        return False
    for token in args[1:]:
        if token.startswith("-"):
            continue
        return token.lower() in grouped
    return False


def _strip_leading_options(args: list[str], options_with_values: set[str]) -> list[str]:
    rest = list(args)
    while rest and rest[0].startswith("-"):
        option = rest.pop(0)
        if option == "--":
            break
        if option in options_with_values and rest:
            rest.pop(0)
            continue
        if any(option.startswith(prefix + "=") for prefix in options_with_values if prefix.startswith("--")):
            continue
    return rest


def _has_flag(tokens: list[str], names: set[str], short_chars: set[str] | None = None) -> bool:
    short_chars = short_chars or set()
    for token in tokens:
        if token in names:
            return True
        if token.startswith("--"):
            continue
        if token.startswith("-") and any(ch in token.lstrip("-") for ch in short_chars):
            return True
    return False


def _infrastructure_command_deletes_resource(tokens: list[str]) -> bool:
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    if name == "kubectl":
        args = _strip_leading_options(tokens[1:], KUBECTL_GLOBAL_OPTIONS_WITH_VALUES)
        return bool(args and args[0].lower() == "delete")
    if name == "helm":
        args = _strip_leading_options(tokens[1:], HELM_GLOBAL_OPTIONS_WITH_VALUES)
        return bool(args and args[0].lower() in {"delete", "uninstall"})
    if name in {"terraform", "tofu"}:
        args = _strip_leading_options(tokens[1:], TERRAFORM_GLOBAL_OPTIONS_WITH_VALUES)
        if not args:
            return False
        subcommand = args[0].lower()
        if subcommand == "destroy":
            return True
        if subcommand == "apply" and _has_flag(args[1:], {"--destroy", "-destroy"}):
            return True
    return False


def _argument_words_excluding_options(tokens: list[str], options_with_values: set[str]) -> list[str]:
    words: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            words.extend(tokens[index + 1 :])
            break
        if token.startswith("-"):
            index += 1
            if token in options_with_values and index < len(tokens):
                index += 1
                continue
            if any(token.startswith(prefix + "=") for prefix in options_with_values if prefix.startswith("--")):
                continue
            continue
        words.append(token)
        index += 1
    return words


def _aws_command_deletes_resource(tokens: list[str]) -> bool:
    args = _strip_leading_options(tokens[1:], AWS_GLOBAL_OPTIONS_WITH_VALUES)
    if len(args) < 2:
        return False
    service = args[0].lower()
    operation = args[1].lower()
    if service == "s3" and operation == "rm":
        return True
    return operation.startswith("delete-") or operation.startswith("terminate-")


def _cloud_command_deletes_resource(tokens: list[str]) -> bool:
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    if name == "aws":
        return _aws_command_deletes_resource(tokens)
    if name == "gcloud":
        args = _strip_leading_options(tokens[1:], GCLOUD_GLOBAL_OPTIONS_WITH_VALUES)
        return "delete" in _argument_words_excluding_options(args, GCLOUD_GLOBAL_OPTIONS_WITH_VALUES)
    if name == "az":
        args = _strip_leading_options(tokens[1:], AZ_GLOBAL_OPTIONS_WITH_VALUES)
        return "delete" in _argument_words_excluding_options(args, AZ_GLOBAL_OPTIONS_WITH_VALUES)
    return False


def _is_pip_command_name(name: str) -> bool:
    lowered = _command_semantic_name(name)
    return lowered in PYTHON_PACKAGE_COMMANDS or bool(re.fullmatch(r"pip\d(?:\.\d+)?", lowered))


def _package_command_removes_package(tokens: list[str]) -> bool:
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    raw_args = list(tokens[1:])
    if (
        _is_python_command(name)
        and len(raw_args) >= 3
        and raw_args[0] == "-m"
        and _is_pip_command_name(raw_args[1])
    ):
        return raw_args[2].lower() == "uninstall"
    args = _strip_leading_options(tokens[1:], PACKAGE_MANAGER_OPTIONS_WITH_VALUES)
    if name in APT_COMMANDS:
        return bool(args and args[0].lower() in {"autoremove", "purge", "remove"})
    if name in DNF_COMMANDS:
        return bool(args and args[0].lower() in {"autoremove", "erase", "remove"})
    if name == "brew":
        return bool(args and args[0].lower() in {"remove", "rm", "uninstall"})
    if _is_pip_command_name(name):
        return bool(args and args[0].lower() == "uninstall")
    if name in CONDA_COMMANDS:
        return bool(args and args[0].lower() in {"remove", "uninstall"})
    if name in NODE_PACKAGE_COMMANDS:
        return bool(args and args[0].lower() in {"remove", "rm", "uninstall", "unpublish"})
    if name == "cargo":
        return bool(args and args[0].lower() == "uninstall")
    if name == "gem":
        return bool(args and args[0].lower() == "uninstall")
    return False


def _sql_text_is_destructive(sql: str) -> bool:
    text = str(sql or "").lstrip().lower()
    return bool(re.match(r"^(?:drop\b|truncate\b|delete\s+from\b)", text))


def _database_command_deletes_data(tokens: list[str]) -> bool:
    if not tokens:
        return False
    name = _command_semantic_name(tokens[0])
    if name not in DATABASE_COMMANDS:
        return False
    if name == "sqlite3":
        args = _argument_words_excluding_options(tokens[1:], set())
        return any(_sql_text_is_destructive(arg) for arg in args[1:])
    sql_options = DATABASE_INLINE_SQL_OPTIONS.get(name, set())
    long_prefixes = DATABASE_INLINE_SQL_LONG_OPTION_PREFIXES.get(name, set())
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in sql_options and index + 1 < len(tokens):
            if _sql_text_is_destructive(tokens[index + 1]):
                return True
            index += 2
            continue
        if any(token.startswith(prefix + "=") for prefix in long_prefixes):
            if _sql_text_is_destructive(token.split("=", 1)[1]):
                return True
        index += 1
    return False


def _redis_command_deletes_data(tokens: list[str]) -> bool:
    if not tokens or _command_semantic_name(tokens[0]) not in REDIS_COMMANDS:
        return False
    args = _strip_leading_options(tokens[1:], REDIS_OPTIONS_WITH_VALUES)
    if not args:
        return False
    return args[0].lower() in REDIS_DESTRUCTIVE_COMMANDS


def _classify_git_command(tokens: list[str], text: str, env: dict[str, str]) -> tuple[RiskLevel, str, str, dict[str, str]]:
    sub_tokens = _git_subcommand_tokens(tokens)
    if not sub_tokens:
        return "readonly", "git read-only command", text, env
    subcommand = sub_tokens[0].lower()
    flags = [token for token in sub_tokens[1:] if token.startswith("-")]
    if subcommand == "reset" and "--hard" in sub_tokens:
        return "destructive", "git reset hard", text, env
    if subcommand == "clean" and _git_clean_is_dry_run(flags):
        return "readonly", "git clean dry run", text, env
    if subcommand == "clean" and _git_clean_has_force(flags):
        return "destructive", "git clean force delete", text, env
    if subcommand == "branch" and _git_branch_deletes_branch(flags):
        return "destructive", "git branch delete", text, env
    if subcommand == "branch" and _git_branch_writes_branch(flags):
        return "write", "git branch write", text, env
    if subcommand == "rm":
        return "destructive", "git rm delete", text, env
    if subcommand == "tag" and _git_tag_deletes_tag(flags):
        return "destructive", "git tag delete", text, env
    if subcommand == "update-ref" and _git_update_ref_deletes_ref(flags):
        return "destructive", "git ref delete", text, env
    if subcommand in {"replace", "symbolic-ref"} and _git_flag_deletes_ref(flags):
        return "destructive", "git ref delete", text, env
    if subcommand == "notes" and _git_notes_deletes_note(sub_tokens[1:]):
        return "destructive", "git ref delete", text, env
    if subcommand == "submodule" and _git_submodule_force_deinits(sub_tokens[1:], flags):
        return "destructive", "git submodule forced deinit", text, env
    if subcommand == "remote" and _git_remote_writes_state(sub_tokens[1:]):
        return "write", "git remote write", text, env
    if subcommand in {"checkout", "switch"} and _git_checkout_discards_changes(flags):
        return "destructive", "git forced working tree checkout", text, env
    if subcommand == "worktree" and _git_worktree_removes_worktree(sub_tokens[1:]):
        return "destructive", "git worktree remove", text, env
    if subcommand == "stash" and _git_stash_deletes_stash(sub_tokens[1:]):
        return "destructive", "git stash delete", text, env
    if subcommand == "reflog" and _git_reflog_deletes_history(sub_tokens[1:]):
        return "destructive", "git reflog delete", text, env
    if subcommand == "prune" or (subcommand == "gc" and _git_gc_prunes_objects(flags)):
        return "destructive", "git object prune", text, env
    if subcommand == "checkout" and any(token in {".", "--"} for token in sub_tokens[1:]):
        return "destructive", "git checkout working tree", text, env
    if subcommand == "restore" and _git_restore_has_pathspec(sub_tokens[1:]):
        if _git_restore_touches_worktree(flags):
            return "destructive", "git restore working tree", text, env
        return "write", "git restore index", text, env
    if subcommand == "push":
        return "write", "git remote write", text, env
    if subcommand in GIT_WRITE_SUBCOMMANDS:
        return "write", "git write command", text, env
    if subcommand in GIT_READONLY_SUBCOMMANDS:
        return "readonly", "git read-only command", text, env
    return "write", "git unknown subcommand", text, env


def _classify_simple_command(command: str) -> tuple[RiskLevel, str, str, dict[str, str]]:
    tokens = _split_tokens(command)
    time_output_targets = _time_wrapper_output_targets(tokens)
    env, tokens = _strip_wrappers_and_collect_env(tokens)
    if not tokens:
        return "readonly", "empty command", command, env

    text = _join_tokens(tokens)
    name = tokens[0]
    name_lower = _command_semantic_name(name)
    flags = [token for token in tokens[1:] if token.startswith("-")]

    if name_lower == "git":
        return _classify_git_command(tokens, text, env)
    if _container_command_deletes_resource(tokens):
        return "destructive", "container resource delete", text, env
    if _infrastructure_command_deletes_resource(tokens):
        return "destructive", "infrastructure resource delete", text, env
    if _cloud_command_deletes_resource(tokens):
        return "destructive", "cloud resource delete", text, env
    if _package_command_removes_package(tokens):
        return "destructive", "package removal command", text, env
    if _database_command_deletes_data(tokens) or _redis_command_deletes_data(tokens):
        return "destructive", "database destructive command", text, env
    python_code = _python_inline_code(tokens)
    if python_code is not None:
        if _python_inline_is_destructive(python_code):
            return "destructive", "python destructive file operation", text, env
        if _python_inline_device_write_operation(python_code):
            return "destructive", "python device write", text, env
        return "write", "python inline code", text, env
    node_code = _node_inline_code(tokens)
    if node_code is not None:
        if _node_inline_is_destructive(node_code):
            return "destructive", "node destructive file operation", text, env
        if _node_inline_writes_device(node_code):
            return "destructive", "node device write", text, env
        return "write", "node inline code", text, env
    if name_lower == "rm" and _rm_has_recursive_force(flags):
        return "destructive", "rm recursive force", text, env
    if name_lower == "find" and "-delete" in tokens:
        return "destructive", "find delete", text, env
    if name_lower == "truncate" and "-s" in tokens and "0" in tokens:
        return "destructive", "truncate zero", text, env
    dd_output_targets = _dd_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in dd_output_targets):
        return "destructive", "dd device output", text, env
    if dd_output_targets:
        return "write", "dd output file", text, env
    tee_output_targets = _tee_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in tee_output_targets):
        return "destructive", "tee device output", text, env
    if tee_output_targets:
        return "write", "tee output file", text, env
    cp_output_targets = _cp_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in cp_output_targets):
        return "destructive", "copy device output", text, env
    if cp_output_targets:
        return "write", "copy output file", text, env
    mv_output_targets = _mv_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in mv_output_targets):
        return "destructive", "move device target", text, env
    if mv_output_targets:
        return "write", "move target file", text, env
    rsync_output_targets = _rsync_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in rsync_output_targets):
        return "destructive", "rsync device target", text, env
    if rsync_output_targets:
        return "write", "rsync output target", text, env
    tar_output_targets = _tar_archive_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in tar_output_targets):
        return "destructive", "tar device output", text, env
    if tar_output_targets:
        return "write", "tar archive output", text, env
    install_output_targets = _install_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in install_output_targets):
        return "destructive", "install device output", text, env
    if install_output_targets:
        return "write", "install output file", text, env
    download_output_targets = _download_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in download_output_targets):
        return "destructive", "download device output", text, env
    if download_output_targets:
        return "write", "download output file", text, env
    openssl_output_targets = _openssl_output_targets(tokens)
    if any(_is_device_redirection_target(target) for target in openssl_output_targets):
        return "destructive", "openssl device output", text, env
    if openssl_output_targets:
        return "write", "openssl output file", text, env
    if name_lower == "xargs" and any(_command_semantic_name(token) == "rm" for token in tokens[1:]):
        return "destructive", "xargs rm", text, env
    if name_lower == "find" and "-print0" in tokens:
        return "destructive", "find delete pipeline", text, env
    if name_lower in PERMISSION_CHANGE_COMMANDS and _has_recursive_flag(flags):
        return "destructive", "recursive permission change", text, env
    if name_lower in OWNERSHIP_CHANGE_COMMANDS and _has_recursive_flag(flags):
        return "destructive", "recursive ownership change", text, env
    find_output_targets = _find_file_output_targets(tokens)
    less_output_targets = _less_log_file_targets(tokens)
    file_output_targets = _redirection_targets(tokens) + find_output_targets + time_output_targets + less_output_targets
    if any(_is_device_redirection_target(target) for target in file_output_targets):
        return "destructive", "device redirection", text, env
    if _has_output_redirection(tokens):
        return "write", "output redirection", text, env
    if time_output_targets:
        return "write", "time output file", text, env
    if find_output_targets:
        return "write", "find file output", text, env
    if _is_filesystem_format_command(name_lower):
        return "destructive", "filesystem format command", text, env
    if name_lower in FILE_DELETE_COMMANDS:
        return "destructive", "file delete command", text, env
    if name_lower in FILE_OVERWRITE_COMMANDS:
        return "destructive", "shred file overwrite", text, env
    if _diskutil_is_destructive(tokens):
        return "destructive", "diskutil destructive command", text, env
    if _fdisk_is_destructive(tokens) or _gpt_is_destructive(tokens):
        return "destructive", "partition table destructive command", text, env
    if name_lower in PROCESS_TERMINATION_COMMANDS:
        return "destructive", "process termination", text, env
    if name_lower in SYSTEM_DESTRUCTIVE_COMMANDS:
        return "destructive", "system destructive command", text, env
    if name_lower == "sed" and _sed_has_in_place_edit(flags):
        return "write", "sed in-place edit", text, env
    if name_lower == "sed" and _sed_uses_script_file(tokens):
        return "write", "sed script file", text, env
    if name_lower == "sed" and _sed_has_write_file_script(tokens):
        return "write", "sed write file", text, env
    if name_lower == "less" and less_output_targets:
        return "write", "less log file", text, env
    if name_lower in READONLY_COMMANDS:
        return "readonly", "read-only command", text, env
    return "write", "unknown command", text, env


def _unparseable_shell_report(command: str) -> ShellRiskReport:
    text = str(command or "")
    return ShellRiskReport("write", "unparseable command", text, [text] if text else [], {})


def _split_limit_shell_report(command: str) -> ShellRiskReport:
    text = str(command or "")
    return ShellRiskReport(
        "write",
        SHELL_COMMAND_SPLIT_LIMIT_REASON,
        text,
        split_shell_commands(text),
        {},
    )


def _classify_shell_command(command: str) -> ShellRiskReport:
    commands = _split_shell_commands_for_classification(command)
    for function_command in _called_shell_function_body_commands(command):
        if function_command not in commands:
            commands.append(function_command)
    heredoc_code = _python_heredoc_code(command)
    if heredoc_code:
        heredoc_python_command = f"python -c {shlex.quote(heredoc_code)}"
        if heredoc_python_command not in commands:
            commands.append(heredoc_python_command)
    for stdin_command in _shell_stdin_script_commands(command):
        if stdin_command not in commands:
            commands.append(stdin_command)
    for script_command in _process_substitution_literal_script_commands(command):
        if script_command not in commands:
            commands.append(script_command)
    for script_command in _base64_literal_pipe_script_commands(command):
        if script_command not in commands:
            commands.append(script_command)
    remote_pipe = _remote_script_pipe(command)
    if remote_pipe:
        matched_command, reason = remote_pipe
        return ShellRiskReport(
            "destructive",
            reason,
            matched_command,
            commands,
            {},
        )
    remote_process = _remote_script_process_substitution(command)
    if remote_process:
        matched_command, reason, nested_commands = remote_process
        commands.extend(cmd for cmd in nested_commands if cmd not in commands)
        return ShellRiskReport(
            "destructive",
            reason,
            matched_command,
            commands,
            {},
        )
    remote_command_substitution = _remote_script_command_substitution(command)
    if remote_command_substitution:
        matched_command, reason, nested_commands = remote_command_substitution
        commands.extend(cmd for cmd in nested_commands if cmd not in commands)
        return ShellRiskReport(
            "destructive",
            reason,
            matched_command,
            commands,
            {},
        )
    remote_stdin = _remote_script_stdin_redirection(command)
    if remote_stdin:
        matched_command, reason, nested_commands = remote_stdin
        commands.extend(cmd for cmd in nested_commands if cmd not in commands)
        return ShellRiskReport(
            "destructive",
            reason,
            matched_command,
            commands,
            {},
        )
    for substitution in _extract_command_substitutions(command):
        for nested_command in _split_shell_commands_for_classification(substitution):
            if nested_command not in commands:
                commands.append(nested_command)
    for _operator, substitution in _extract_process_substitutions(command):
        for nested_command in _split_shell_commands_for_classification(substitution):
            if nested_command not in commands:
                commands.append(nested_command)
    env_prefixes: dict[str, str] = {}
    best_level: RiskLevel = "readonly"
    best_reason = "read-only command"
    best_command = commands[0] if commands else ""

    for raw in commands:
        substitution_commands = []
        for substitution in _extract_command_substitutions(raw):
            substitution_commands.extend(_split_shell_commands_for_classification(substitution))
        process_substitution_commands = []
        for _operator, substitution in _extract_process_substitutions(raw):
            process_substitution_commands.extend(_split_shell_commands_for_classification(substitution))
        process_substitution_literal_commands = _process_substitution_literal_script_commands(raw)
        tokens = _split_tokens(raw)
        env, stripped = _strip_wrappers_and_collect_env(tokens)
        env_prefixes.update(env)
        raw_remote_process = _remote_script_process_substitution(raw)
        if raw_remote_process:
            matched_command, reason, nested_commands = raw_remote_process
            commands.extend(cmd for cmd in nested_commands if cmd not in commands)
            return ShellRiskReport(
                "destructive",
                reason,
                matched_command,
                commands,
                env_prefixes,
            )
        stripped_commands = [_join_tokens(stripped)] if stripped and stripped != tokens else []
        compound_commands = _compound_segment_commands(raw)
        nested = _nested_shell_command(stripped)
        eval_nested = _nested_eval_command(stripped)
        elevated_nested = _nested_elevated_command(stripped)
        powershell_nested = _nested_powershell_command(stripped)
        cmd_nested = _nested_cmd_command(stripped)
        nested_commands = _split_shell_commands_for_classification(nested) if nested else []
        eval_commands = _split_shell_commands_for_classification(eval_nested) if eval_nested else []
        literal_substitution_commands = []
        if nested:
            literal_substitution_commands.extend(_base64_literal_command_substitution_script_commands(nested))
        if eval_nested:
            literal_substitution_commands.extend(_base64_literal_command_substitution_script_commands(eval_nested))
        elevated_commands = _split_shell_commands_for_classification(elevated_nested) if elevated_nested else []
        powershell_commands = _split_shell_commands_for_classification(powershell_nested) if powershell_nested else []
        cmd_commands = _split_shell_commands_for_classification(cmd_nested) if cmd_nested else []
        python_code = _python_inline_code(stripped)
        python_inline_commands = _python_inline_shell_commands(python_code) if python_code else []
        find_exec_commands = _find_exec_commands(stripped)
        xargs_commands = _xargs_commands(stripped)
        git_alias_commands = _git_alias_shell_commands(stripped)
        env_split_commands = _env_split_string_commands(tokens)
        builtin_commands = _builtin_nested_commands_from_text(raw) or _builtin_nested_commands(stripped)
        trap_commands = _trap_commands(stripped)
        coproc_commands = _coproc_commands(stripped)
        nested_candidates = (
            nested_commands
            + eval_commands
            + elevated_commands
            + powershell_commands
            + cmd_commands
            + literal_substitution_commands
            + python_inline_commands
            + find_exec_commands
            + xargs_commands
            + git_alias_commands
            + env_split_commands
            + builtin_commands
            + trap_commands
            + coproc_commands
            + stripped_commands
            + compound_commands
            + process_substitution_literal_commands
            + substitution_commands
            + process_substitution_commands
        )
        candidates = [raw] + nested_candidates
        commands.extend(
            cmd
            for cmd in nested_candidates
            if cmd not in commands
        )
        for candidate_index, candidate in enumerate(candidates):
            level, reason, matched, candidate_env = _classify_simple_command(candidate)
            env_prefixes.update(candidate_env)
            if level == "destructive":
                if candidate in find_exec_commands and _command_name(_split_tokens(candidate)).lower() == "rm":
                    reason = "find exec rm"
                    matched = candidate
                return ShellRiskReport(level, reason, matched, commands, env_prefixes)
            if level == "write" and (
                best_level != "write"
                or (candidate_index > 0 and best_command == raw)
                or (best_reason == "unknown command" and reason != "unknown command")
            ):
                best_level, best_reason, best_command = level, reason, matched
            elif best_level == "readonly":
                best_reason, best_command = reason, matched

    return ShellRiskReport(best_level, best_reason, best_command, commands, env_prefixes)


def classify_shell_command(command: str) -> ShellRiskReport:
    try:
        return _classify_shell_command(command)
    except ShellCommandSplitLimitExceeded as exc:
        return _split_limit_shell_report(exc.command)
    except ValueError:
        return _unparseable_shell_report(command)


def classify_python_code(code: str) -> ShellRiskReport:
    text = str(code or "")
    commands = [text] if text else []
    try:
        shell_commands = _python_inline_shell_commands(text)
    except ShellCommandSplitLimitExceeded as exc:
        return _split_limit_shell_report(exc.command)
    commands.extend(command for command in shell_commands if command not in commands)

    best_level: RiskLevel = "write"
    best_reason = "python code"
    best_command = text

    for shell_command in shell_commands:
        report = classify_shell_command(shell_command)
        commands.extend(command for command in report.commands if command not in commands)
        if report.level == "destructive":
            return ShellRiskReport(report.level, report.reason, report.matched_command, commands, report.env_prefixes)
        if report.level == "write":
            best_level = "write"
            best_reason = report.reason
            best_command = report.matched_command

    destructive_file_operation = _python_inline_destructive_file_operation(text)
    if destructive_file_operation:
        if destructive_file_operation not in commands:
            commands.append(destructive_file_operation)
        return ShellRiskReport(
            "destructive",
            "python destructive file operation",
            destructive_file_operation,
            commands,
            {},
        )

    device_write_operation = _python_inline_device_write_operation(text)
    if device_write_operation:
        if device_write_operation not in commands:
            commands.append(device_write_operation)
        return ShellRiskReport(
            "destructive",
            "python device write",
            device_write_operation,
            commands,
            {},
        )

    return ShellRiskReport(best_level, best_reason, best_command, commands, {})
