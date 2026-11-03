"""Verb registry for the CTF verbs surface.

`get_specs()` aggregates handlers from the pwn, reverse, and session
modules so the runtime dispatcher sees a single flat namespace
(`pwn.inspect_binary`, `re.triage`, `pwn.open_session`, ...).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Tuple

from ._spec import VerbSpec
from .pwn import PWN_VERBS
from .reverse import REVERSE_VERBS
from .session import SESSION_VERBS


def get_specs() -> Dict[str, VerbSpec]:
    specs: Dict[str, VerbSpec] = {}
    for registry in (PWN_VERBS, REVERSE_VERBS, SESSION_VERBS):
        for name, spec in registry.items():
            specs[name] = spec
    return specs


__all__ = ["VerbSpec", "get_specs"]
