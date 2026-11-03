"""Curated, challenge-bound pwn seed cards from project-local CTF references.

These are deliberately candidates: source notes describe the challenge and
technique, but no binary or remote service has been reproduced by this pipeline.
"""

from __future__ import annotations

from .pwn_cards import PwnCandidateCard
from .schema import stable_id


def local_pwn_seed_candidates() -> list[PwnCandidateCard]:
    return [
        _card(
            event="0xFun CTF 2026",
            challenge="House of Apple 2",
            family="tcache poisoning with FSOP",
            primitives=["use-after-free", "tcache freelist corruption"],
            glibc=["glibc 2.34+"],
            steps=[
                "Use the UAF to obtain libc and heap-base information needed for allocator pointer encoding.",
                "Encode the target freelist pointer according to the allocator's safe-linking rule and redirect a tcache allocation.",
                "Construct a controlled FILE and wide-data state, then invoke the documented exit-time I/O path.",
            ],
            source="file://.agents/skills/ctf-pwn/heap-techniques.md#house-of-apple-2",
        ),
        _card(
            event="0xFun CTF 2026",
            challenge="House of Einherjar",
            family="heap overlap via backward consolidation",
            primitives=["off-by-one null byte", "heap metadata corruption"],
            glibc=["glibc 2.34+"],
            steps=[
                "Use the off-by-one null byte to clear the adjacent chunk's PREV_INUSE bit while preserving consistent size metadata.",
                "Prepare a self-consistent fake chunk so unlink validation accepts the backward consolidation.",
                "Free the victim to create an overlap, then validate that a reallocation controls the intended live region.",
            ],
            source="file://.agents/skills/ctf-pwn/heap-techniques.md#house-of-einherjar",
        ),
        _card(
            event="FireShell CTF 2019",
            challenge="babyheap",
            family="tcache poisoning",
            primitives=["use-after-free", "tcache freelist corruption"],
            glibc=["glibc 2.26+"],
            steps=[
                "Identify the undocumented allocation path that removes the normal allocation budget.",
                "Use the freed small chunk to control the tcache next pointer for the matching size class.",
                "Allocate twice and verify that the second allocation resolves to the intended writable target.",
            ],
            source="file://.agents/skills/ctf-pwn/heap-techniques-2.md#hidden-menu-option-1337-for-tcache-poisoning",
        ),
    ]


def _card(*, event: str, challenge: str, family: str, primitives: list[str], glibc: list[str], steps: list[str], source: str) -> PwnCandidateCard:
    return PwnCandidateCard(
        id=stable_id("pwn-seed", event, challenge, family),
        event=event,
        challenge=challenge,
        source_url=source,
        attack_family=family,
        vulnerability_primitives=primitives,
        glibc_versions=glibc,
        exploit_steps=steps,
        validation=[
            "Confirm the challenge binary's glibc version and mitigations before applying this method.",
            "Validate the intermediate heap primitive locally before relying on the final control-flow trigger.",
        ],
        source_record_ids=[],
        review_status="candidate",
    )
