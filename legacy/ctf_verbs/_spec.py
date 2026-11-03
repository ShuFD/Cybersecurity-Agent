"""Verb spec dataclass shared by builtin.py and per-category modules.

Separated to avoid a circular import between the registry (`builtin.py`)
and the handler implementations (`pwn.py`, `reverse.py`, `session.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Tuple


@dataclass(frozen=True)
class VerbSpec:
    name: str
    description: str
    policy_tags: Tuple[str, ...]
    required_args: Tuple[str, ...]
    handler: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]
    category: str = "ctf"
