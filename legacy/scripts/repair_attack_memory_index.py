"""Repair and normalize a local attack-memory index directory.

Fixes the defects that drift when a shard is assembled outside the repo:

* duplicate record ``id`` values (re-derived deterministically, no record dropped)
* a missing or stale ``embeddings.jsonl`` (rebuilt with the project hasher)
* a ``manifest.json`` whose ``record_count`` no longer matches the shard
* CRLF line endings (the canonical on-disk format is LF)

Usage:
    python legacy/scripts/repair_attack_memory_index.py --check
    python legacy/scripts/repair_attack_memory_index.py
    python legacy/scripts/repair_attack_memory_index.py --dirs crypto_v1
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LEGACY_DIR = REPO_ROOT / "legacy"
if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))

from ctf_attack_memory.index import (  # noqa: E402
    VECTOR_DIM,
    _hash_embedding,
    _record_search_text,
    tokenize,
)
from ctf_attack_memory.schema import AttackMemoryRecord, stable_id  # noqa: E402

DEFAULT_ROOT = LEGACY_DIR / "memory" / "attack_memory"
RECORDS_FILE = "records.jsonl"
EMBEDDINGS_FILE = "embeddings.jsonl"
MANIFEST_FILE = "manifest.json"


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _record_salt_parts(row: dict) -> tuple:
    patterns = row.get("attack_pattern") or []
    if isinstance(patterns, str):
        patterns = [patterns]
    return (
        str(row.get("event") or ""),
        str(row.get("challenge") or ""),
        ",".join(str(item) for item in patterns),
        str(row.get("source_url") or ""),
        str(row.get("text_chunk") or "")[:512],
    )


def assign_unique_ids(rows: list[dict]) -> tuple[list[dict], list[tuple[str, str]]]:
    """Re-derive ids only for colliding rows; the first owner keeps its id."""

    used: set[str] = set()
    renamed: list[tuple[str, str]] = []
    for row in rows:
        record_id = str(row.get("id") or "").strip()
        if record_id and record_id not in used:
            used.add(record_id)
            row["id"] = record_id
            continue
        parts = _record_salt_parts(row)
        salt = 1
        candidate = stable_id(*parts, f"duplicate-{salt}")
        while candidate in used:
            salt += 1
            candidate = stable_id(*parts, f"duplicate-{salt}")
        used.add(candidate)
        renamed.append((record_id or "<empty>", candidate))
        row["id"] = candidate
    return rows, renamed


def serialize_rows(rows: list[dict]) -> bytes:
    payload = "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    )
    return payload.encode("utf-8")


def build_embeddings(rows: list[dict], vector_dim: int) -> bytes:
    lines: list[str] = []
    for row in rows:
        record = AttackMemoryRecord.from_dict(row)
        tokens = tokenize(_record_search_text(record))
        vector = _hash_embedding(tokens, dim=vector_dim)
        lines.append(
            json.dumps({"id": record.id, "vector": sorted(vector.items())}, ensure_ascii=False)
        )
    return ("\n".join(lines) + "\n").encode("utf-8")


def build_manifest(existing: dict, record_count: int, vector_dim: int) -> bytes:
    manifest = dict(existing)
    manifest.setdefault("schema_version", "attack-memory-index.v1")
    manifest["record_count"] = record_count
    manifest["vector_dim"] = int(manifest.get("vector_dim") or vector_dim)
    manifest["records_file"] = RECORDS_FILE
    manifest["embeddings_file"] = EMBEDDINGS_FILE
    manifest.setdefault(
        "retrieval",
        {"keyword": "BM25", "vector": "hashing-embedding", "rerank": "attack-pattern-field-boost"},
    )
    # Existing manifests carry no trailing newline; keep byte-for-byte parity.
    return json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")


def write_bytes(path: Path, payload: bytes) -> bool:
    current = path.read_bytes() if path.is_file() else b""
    if current == payload:
        return False
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(path)
    return True


def has_crlf(path: Path) -> bool:
    return path.is_file() and b"\r\n" in path.read_bytes()


def embeddings_need_rebuild(path: Path, rows: list[dict]) -> bool:
    """Rebuild only when the artifact is missing, CRLF, or misaligned with records."""

    if not path.is_file() or has_crlf(path):
        return True
    entries = read_jsonl(path)
    if len(entries) != len(rows):
        return True
    return any(str(entry.get("id")) != str(row.get("id")) for entry, row in zip(entries, rows))


def repair_dir(index_dir: Path, *, check: bool) -> dict[str, object]:
    records_path = index_dir / RECORDS_FILE
    if not records_path.is_file():
        return {"index": index_dir.name, "status": "no-records"}

    rows = read_jsonl(records_path)
    manifest_path = index_dir / MANIFEST_FILE
    existing_manifest = (
        json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    )
    vector_dim = int(existing_manifest.get("vector_dim") or VECTOR_DIM)

    rows, renamed = assign_unique_ids(rows)
    planned: dict[str, bytes] = {}
    if renamed or has_crlf(records_path):
        planned[RECORDS_FILE] = serialize_rows(rows)
    embeddings_path = index_dir / EMBEDDINGS_FILE
    if embeddings_need_rebuild(embeddings_path, rows):
        planned[EMBEDDINGS_FILE] = build_embeddings(rows, vector_dim)
    manifest_bytes = build_manifest(existing_manifest, len(rows), vector_dim)
    if (
        not manifest_path.is_file()
        or has_crlf(manifest_path)
        or manifest_path.read_bytes() != manifest_bytes
    ):
        planned[MANIFEST_FILE] = manifest_bytes

    changed = sorted(planned)
    if not check:
        for name, payload in planned.items():
            write_bytes(index_dir / name, payload)

    return {
        "index": index_dir.name,
        "status": "checked" if check else "repaired",
        "records": len(rows),
        "renamed_ids": len(renamed),
        "renamed_sample": renamed[:5],
        "files_changed": changed,
        "had_embeddings": embeddings_path.is_file(),
        "old_manifest_count": existing_manifest.get("record_count"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="attack_memory root")
    parser.add_argument("--dirs", nargs="+", default=None, help="index dir names (default: all)")
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    if args.dirs:
        index_dirs = [root / name for name in args.dirs]
    else:
        index_dirs = sorted(path for path in root.glob("*_v*") if path.is_dir())

    results = [repair_dir(path, check=args.check) for path in index_dirs]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    pending = sum(1 for item in results if item.get("files_changed"))
    print(
        f"\n{'would change' if args.check else 'changed'} {pending}/{len(results)} index dirs",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
