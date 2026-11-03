from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Union

from .models import TaskDescriptor


def save_task_descriptor(descriptor: TaskDescriptor, path: Union[str, Path]) -> str:
    target = Path(path).expanduser().resolve(strict=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(descriptor.to_dict(), stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, target)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    return str(target)


def load_task_descriptor(path: Union[str, Path]) -> TaskDescriptor:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Task descriptor must be a JSON object")
    return TaskDescriptor.from_dict(data)
