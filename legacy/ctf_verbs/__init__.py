"""Typed CTF verbs for pwn and reverse problems.

Mirrors the `web_verbs` package but targets binary analysis surfaces.
Atomic primitives emit JSON, the session recorder logs long transactions
into a per-run transcript that the experience layer can replay.
"""

from ._spec import VerbSpec
from .recommender import (
    build_ctf_verb_context,
    format_ctf_verb_prompt,
    record_success,
)
from .registry import get_specs
from .runtime import call_verb, list_verbs, trace_path_for

__all__ = [
    "VerbSpec",
    "build_ctf_verb_context",
    "call_verb",
    "format_ctf_verb_prompt",
    "get_specs",
    "list_verbs",
    "record_success",
    "trace_path_for",
]
