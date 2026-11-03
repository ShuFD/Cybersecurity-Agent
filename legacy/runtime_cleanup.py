import time
from pathlib import Path


def cleanup_old_runtime_files(directory, pattern, retention_days=30, now=None):
    if retention_days is None or retention_days <= 0:
        return 0
    root = Path(directory)
    if not root.exists():
        return 0
    cutoff = (time.time() if now is None else now) - retention_days * 24 * 60 * 60
    removed = 0
    for path in root.glob(pattern):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed
