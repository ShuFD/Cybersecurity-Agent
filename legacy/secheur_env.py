"""SecHeur Agent environment variable helpers."""
from __future__ import annotations

import os


def get_env(name: str, default: str = "") -> str:
    """Read a SecHeur environment variable."""
    return os.environ.get(name, default)


def ensure_env(name: str, default: str) -> str:
    """Set the environment variable when it is missing."""
    value = get_env(name, "")
    if value:
        return value
    os.environ[name] = default
    return default
