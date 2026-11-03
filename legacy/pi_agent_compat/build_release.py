#!/usr/bin/env python3
"""Build a Pi-compatible SecHeur release with the latest planning kernel."""

from __future__ import annotations

import argparse
import hashlib
import json
import py_compile
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


OVERRIDE_DIRECTORIES = ("plan_runtime", "task_descriptor")
OVERRIDE_FILES = ("task_tree.py",)
ADJACENT_OVERRIDE_FILES = ("error_handler.py", "flag_oracle.py")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_overrides(
    source_root: Path,
    package_root: Path,
    bridge_path: Path,
    *,
    include_adjacent_modules: bool = False,
) -> list[Path]:
    legacy_root = package_root / "dist" / "legacy"
    if not legacy_root.is_dir():
        raise ValueError(f"Base archive has no dist/legacy directory: {package_root}")

    copied: list[Path] = []
    for name in OVERRIDE_DIRECTORIES:
        source = source_root / name
        target = legacy_root / name
        if not source.is_dir():
            raise FileNotFoundError(source)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        copied.extend(path for path in target.rglob("*.py") if path.is_file())

    override_files = OVERRIDE_FILES + (ADJACENT_OVERRIDE_FILES if include_adjacent_modules else ())
    for name in override_files:
        source = source_root / name
        target = legacy_root / name
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copy2(source, target)
        copied.append(target)

    bridge_target = legacy_root / "secheur_pi_bridge.py"
    shutil.copy2(bridge_path, bridge_target)
    copied.append(bridge_target)
    return sorted(set(copied))


def _compile_python(paths: list[Path]) -> None:
    for path in paths:
        py_compile.compile(str(path), doraise=True)
    for cache_dir in {path.parent / "__pycache__" for path in paths}:
        shutil.rmtree(cache_dir, ignore_errors=True)


def build_release(
    base_archive: Path,
    output_archive: Path,
    source_root: Path,
    bridge_path: Path,
    *,
    include_adjacent_modules: bool = False,
) -> dict:
    with tempfile.TemporaryDirectory(prefix="secheur-pi-migration-") as temporary:
        staging = Path(temporary)
        with tarfile.open(base_archive, "r:gz") as archive:
            archive.extractall(staging, filter="data")
        package_root = staging / "package"
        package_json = package_root / "package.json"
        if not package_json.is_file():
            raise ValueError("Base archive is not an @secheur/agent npm package")

        copied = _copy_overrides(
            source_root,
            package_root,
            bridge_path,
            include_adjacent_modules=include_adjacent_modules,
        )
        _compile_python(copied)
        legacy_root = package_root / "dist" / "legacy"
        manifest = {
            "schema_version": 1,
            "built_at": datetime.now(timezone.utc).isoformat(),
            "base_archive": base_archive.name,
            "strategy": "pi-native-loop-with-observational-legacy-planning-kernel",
            "pi_loop_replaced": False,
            "hard_progress_stop_default": False,
            "adjacent_modules_replaced": include_adjacent_modules,
            "files": {
                path.relative_to(legacy_root).as_posix(): _sha256(path)
                for path in copied
            },
        }
        manifest_path = legacy_root / "planning-migration-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        output_archive.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(output_archive, "w:gz") as archive:
            archive.add(package_root, arcname="package")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_archive", type=Path)
    parser.add_argument("output_archive", type=Path)
    parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--bridge",
        type=Path,
        help="bridge source; defaults to SOURCE_ROOT/secheur_pi_bridge.py",
    )
    parser.add_argument(
        "--include-adjacent-modules",
        action="store_true",
        help="also replace error_handler.py and flag_oracle.py from source-root",
    )
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    bridge_path = args.bridge.resolve() if args.bridge else source_root / "secheur_pi_bridge.py"
    manifest = build_release(
        args.base_archive.resolve(),
        args.output_archive.resolve(),
        source_root,
        bridge_path,
        include_adjacent_modules=args.include_adjacent_modules,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
