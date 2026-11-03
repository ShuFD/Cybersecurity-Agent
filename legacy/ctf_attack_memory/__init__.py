"""Runtime-safe API for the curated CTF attack-memory knowledge base.

Corpus ingestion, crawling and distillation are intentionally local build tooling
and are not imported here.  A clean checkout only needs these exports plus the
published knowledge-card artifact to serve crypto retrieval.
"""

from .filter import classify_crypto
from .index import (
    HybridAttackMemoryIndex,
    attack_hits_for_memory_search,
    search_attack_memory,
    search_knowledge_cards,
)
from .knowledge import (
    AtomicClaim,
    CardFilterReport,
    EvidenceSpan,
    KnowledgeCard,
    filter_publishable_cards,
    load_cards,
    save_cards,
)
from .sanitize import is_prompt_injection, sanitize_untrusted_text
from .schema import (
    AttackMemoryRecord,
    CTFtimeLink,
    CTFtimeWriteupEntry,
    FetchedDocument,
)

_LAZY_EXPORTS = {
    "AttackMemoryPipeline": (".pipeline", "AttackMemoryPipeline"),
    "BulkCTFtimeBuilder": (".bulk", "BulkCTFtimeBuilder"),
    "BulkConfig": (".bulk", "BulkConfig"),
    "BulkReport": (".bulk", "BulkReport"),
    "PipelineConfig": (".pipeline", "PipelineConfig"),
    "PipelineReport": (".pipeline", "PipelineReport"),
}


def __getattr__(name):
    target = _LAZY_EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    module_name, attribute_name = target
    value = getattr(import_module(module_name, __name__), attribute_name)
    globals()[name] = value
    return value

__all__ = [
    "AttackMemoryRecord",
    "AtomicClaim",
    "CTFtimeLink",
    "CTFtimeWriteupEntry",
    "CardFilterReport",
    "EvidenceSpan",
    "FetchedDocument",
    "HybridAttackMemoryIndex",
    "KnowledgeCard",
    "attack_hits_for_memory_search",
    "classify_crypto",
    "filter_publishable_cards",
    "is_prompt_injection",
    "load_cards",
    "sanitize_untrusted_text",
    "save_cards",
    "search_attack_memory",
    "search_knowledge_cards",
]
