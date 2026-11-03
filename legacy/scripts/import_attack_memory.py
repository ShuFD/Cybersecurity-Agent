"""Import an externally built attack-memory export into the local index tree.

The importer keeps the on-disk contract of ``legacy/memory/attack_memory``:
one directory per ``<category>_v<N>`` holding ``records.jsonl``,
``embeddings.jsonl`` and ``manifest.json``.  Records are re-serialized through
``AttackMemoryRecord`` and vectors are rebuilt by ``HybridAttackMemoryIndex`` so
an imported shard is byte-compatible with locally built shards.

Usage:
    python legacy/scripts/import_attack_memory.py --source C:/work/pwn/build/attack_memory
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LEGACY_DIR = REPO_ROOT / "legacy"
if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))

from ctf_attack_memory.index import HybridAttackMemoryIndex  # noqa: E402
from ctf_attack_memory.schema import AttackMemoryRecord  # noqa: E402

DEFAULT_DEST = LEGACY_DIR / "memory" / "attack_memory"
CATEGORIES = ("pwn", "reverse", "crypto", "web")
VERSION_RE = re.compile(r"^(?P<category>[a-z]+)_v(?P<version>\d+)$")


def next_version(dest_root: Path, category: str) -> int:
    versions = [
        int(match.group("version"))
        for path in dest_root.glob(f"{category}_v*")
        if path.is_dir()
        for match in [VERSION_RE.match(path.name)]
        if match
    ]
    return max(versions, default=0) + 1


def resolve_source_dir(source_root: Path, category: str) -> Path | None:
    candidates = sorted(
        path
        for path in source_root.glob(f"{category}_v*")
        if path.is_dir() and (path / "records.jsonl").is_file()
    )
    return candidates[-1] if candidates else None


CURATED_DIRS = ("knowledge", "evidence")


def carry_forward_curated(dest_root: Path, category: str, dest_dir: Path) -> list[str]:
    """Copy the curated layer from the newest existing shard into ``dest_dir``.

    ``HybridAttackMemoryIndex.load`` merges ``knowledge/cards.jsonl`` from the
    directory it is given, and the runtime picks the highest ``<category>_v<N>``
    per category. A records-only import therefore removes the curated cards
    from the active index unless it is carried over.
    """
    previous = sorted(
        (
            (int(match.group("version")), path)
            for path in dest_root.glob(f"{category}_v*")
            if path.is_dir() and path != dest_dir
            for match in [VERSION_RE.match(path.name)]
            if match
        ),
        reverse=True,
    )
    carried: list[str] = []
    for _version, source in previous:
        present = [name for name in CURATED_DIRS if (source / name).is_dir()]
        if not present:
            continue
        for name in present:
            shutil.copytree(source / name, dest_dir / name, dirs_exist_ok=True)
            carried.append(f"{source.name}/{name}")
        return carried
    return carried


def load_records(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_provenance(provenance_dir: Path, category: str) -> dict[str, list[dict]]:
    """Map ``knowledge_id`` -> provenance entries from the upstream RAG export."""

    path = provenance_dir / f"ctf_rag_kb.{category}.jsonl"
    if not path.is_file():
        return {}
    mapping: dict[str, list[dict]] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = str(row.get("knowledge_id") or "").strip()
            provenance = row.get("provenance")
            if key and isinstance(provenance, list):
                mapping[key] = [item for item in provenance if isinstance(item, dict)]
    return mapping


def to_record(row: dict, category: str, provenance: dict[str, list[dict]]) -> AttackMemoryRecord | None:
    record = AttackMemoryRecord.from_dict(row)
    if not record.event.strip() or not record.challenge.strip() or not record.text_chunk.strip():
        return None
    if record.category.strip().lower() != category:
        record.category = category
    entries = provenance.get(record.id, [])
    urls = [
        str(item.get("source_url") or "").strip()
        for item in entries
        if str(item.get("source_url") or "").strip()
    ]
    if not record.source_url and urls:
        record.source_url = urls[0]
    if not record.ctftime_url:
        ctftime = [url for url in urls if "ctftime.org" in url]
        if ctftime:
            record.ctftime_url = ctftime[0]
    if not record.source_title.strip():
        titles = [str(item.get("source_title") or "").strip() for item in entries]
        record.source_title = next((title for title in titles if title), record.challenge)
    if not record.tags:
        record.tags = ["ctf", category, "writeup"]
    return record


def fingerprint(record: AttackMemoryRecord) -> str:
    payload = "\x1f".join(
        [record.event, record.challenge, record.text_chunk, record.code_snippet]
    )
    return hashlib.sha1(payload.encode("utf-8", "ignore")).hexdigest()


def import_category(
    source_root: Path,
    dest_root: Path,
    provenance_dir: Path,
    category: str,
    force: bool,
) -> dict[str, object]:
    source_dir = resolve_source_dir(source_root, category)
    if source_dir is None:
        return {"category": category, "status": "missing-source"}

    rows = load_records(source_dir / "records.jsonl")
    provenance = load_provenance(provenance_dir, category)
    records: list[AttackMemoryRecord] = []
    seen_ids: set[str] = set()
    seen_fingerprints: set[str] = set()
    dropped = 0
    duplicated = 0
    for row in rows:
        record = to_record(row, category, provenance)
        if record is None:
            dropped += 1
            continue
        if record.id in seen_ids:
            record.id = ""
            record = AttackMemoryRecord.from_dict(record.to_dict())
        digest = fingerprint(record)
        if digest in seen_fingerprints:
            duplicated += 1
            continue
        seen_ids.add(record.id)
        seen_fingerprints.add(digest)
        records.append(record)

    version = next_version(dest_root, category)
    dest_dir = dest_root / f"{category}_v{version}"
    if dest_dir.exists() and not force:
        raise SystemExit(f"destination already exists: {dest_dir} (use --force to overwrite)")

    HybridAttackMemoryIndex(records).save(dest_dir)

    # The curated layer (knowledge/cards.jsonl, evidence/) is not part of the
    # export. Because the loader reads it from the *selected latest version*
    # directory, publishing a new records-only version would silently drop the
    # hand-curated cards. Carry the previous version's layer forward.
    carried = carry_forward_curated(dest_root, category, dest_dir)

    manifest = json.loads((dest_dir / "manifest.json").read_text(encoding="utf-8"))
    if int(manifest["record_count"]) != len(records):
        raise SystemExit(f"manifest count mismatch in {dest_dir}")
    embedding_lines = sum(
        1 for line in (dest_dir / "embeddings.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()
    )
    if embedding_lines != len(records):
        raise SystemExit(f"embedding count mismatch in {dest_dir}")

    return {
        "category": category,
        "status": "imported",
        "source": str(source_dir),
        "destination": str(dest_dir),
        "source_records": len(rows),
        "imported_records": len(records),
        "dropped_invalid": dropped,
        "dropped_duplicate": duplicated,
        "with_source_url": sum(1 for record in records if record.source_url),
        "curated_layer_carried_from": carried,
        "manifest": manifest,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="export root containing <category>_v<N> dirs")
    parser.add_argument("--dest", default=str(DEFAULT_DEST), help="target attack_memory root")
    parser.add_argument("--provenance-dir", default=None, help="dir holding ctf_rag_kb.<category>.jsonl")
    parser.add_argument("--categories", nargs="+", default=list(CATEGORIES), choices=list(CATEGORIES))
    parser.add_argument("--force", action="store_true", help="overwrite an existing destination version")
    args = parser.parse_args(argv)

    source_root = Path(args.source).expanduser().resolve()
    dest_root = Path(args.dest).expanduser().resolve()
    provenance_dir = (
        Path(args.provenance_dir).expanduser().resolve()
        if args.provenance_dir
        else source_root.parent
    )
    if not source_root.is_dir():
        raise SystemExit(f"source not found: {source_root}")

    results = [
        import_category(source_root, dest_root, provenance_dir, category, args.force)
        for category in args.categories
    ]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
