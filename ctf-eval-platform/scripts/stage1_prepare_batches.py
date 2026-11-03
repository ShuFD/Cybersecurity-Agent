#!/usr/bin/env python3
"""Create and verify the frozen Stage I deterministic target partitions.

This utility has no runtime or model dependencies.  It refuses to overwrite a
different existing batch file so a benchmark cannot silently change its
dataset after the freeze.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Iterable


TARGET_COUNT = 35
BATCH_SIZES = (12, 12, 11)
BATCH_NAMES = ("batch-01.txt", "batch-02.txt", "batch-03.txt")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_targets(path: Path) -> list[str]:
    raw_lines = path.read_text(encoding="utf-8").splitlines()
    targets = [line.strip() for line in raw_lines if line.strip() and not line.lstrip().startswith("#")]
    if len(targets) != TARGET_COUNT:
        raise ValueError(f"expected exactly {TARGET_COUNT} targets, found {len(targets)}")
    duplicates = sorted({target for target in targets if targets.count(target) > 1})
    if duplicates:
        raise ValueError(f"target list contains duplicates: {duplicates}")
    return targets


def batch_payloads(targets: list[str]) -> list[tuple[str, bytes]]:
    if len(targets) != sum(BATCH_SIZES):
        raise ValueError("target count does not match the frozen 12/12/11 partition")
    offset = 0
    payloads: list[tuple[str, bytes]] = []
    for name, size in zip(BATCH_NAMES, BATCH_SIZES):
        chunk = targets[offset:offset + size]
        offset += size
        payloads.append((name, "".join(f"{target}\n" for target in chunk).encode("utf-8")))
    return payloads


def write_if_frozen(path: Path, payload: bytes) -> None:
    if path.exists():
        existing = path.read_bytes()
        if existing != payload:
            raise RuntimeError(f"frozen batch differs from target list: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def prepare(targets_path: Path, output_dir: Path) -> dict[str, object]:
    targets_bytes = targets_path.read_bytes()
    targets = read_targets(targets_path)
    payloads = batch_payloads(targets)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in payloads:
        write_if_frozen(output_dir / name, payload)
    return {
        "targetCount": len(targets),
        "targetList": str(targets_path),
        "targetListSha256": sha256_bytes(targets_bytes),
        "batchSizes": list(BATCH_SIZES),
        "batches": [
            {
                "name": name,
                "count": len(payload.splitlines()),
                "sha256": sha256_bytes(payload),
                "path": str(output_dir / name),
            }
            for name, payload in payloads
        ],
    }


def build_parser() -> argparse.ArgumentParser:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", type=Path, default=root / "config" / "stage1-targets.txt")
    parser.add_argument("--output-dir", type=Path, default=root / "config" / "stage1-batches")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        print(json.dumps(prepare(args.targets, args.output_dir), ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"stage1 batch preparation failed: {exc}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
