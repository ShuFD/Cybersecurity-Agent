import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
STATE_DIR_NAME = ".secheur-agent"
STATE_FILE_NAME = "settings.json"
REGISTRY_KEYS = ("mcpServers", "skills", "tools", "agents")


def state_path(root=None):
    return Path(root or PROJECT_ROOT) / STATE_DIR_NAME / STATE_FILE_NAME


def _read_json(path):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def load_registry_state(root=None):
    return _read_json(state_path(root))


def enabled_map(root=None, key="tools"):
    state = load_registry_state(root)
    value = state.get(key)
    return value if isinstance(value, dict) else {}


def coerce_enabled(value):
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", "disabled"}
    return bool(value)


def is_enabled(root, key, name, default=True):
    mapping = enabled_map(root, key)
    return coerce_enabled(mapping.get(str(name), default))


def disabled_names(root=None, key="tools"):
    return {str(name) for name, enabled in enabled_map(root, key).items() if not coerce_enabled(enabled)}


def save_registry_state(root, updates):
    path = state_path(root)
    state = load_registry_state(root)
    for key in REGISTRY_KEYS:
        incoming = updates.get(key) if isinstance(updates, dict) else None
        if not isinstance(incoming, dict):
            continue
        current = state.get(key)
        if not isinstance(current, dict):
            current = {}
        for name, enabled in incoming.items():
            current[str(name)] = coerce_enabled(enabled)
        state[key] = current
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return state


def clear_registry_enabled_state(root, key, name):
    if key not in REGISTRY_KEYS:
        return load_registry_state(root)
    path = state_path(root)
    state = load_registry_state(root)
    current = state.get(key)
    if not isinstance(current, dict):
        return state
    current.pop(str(name), None)
    if current:
        state[key] = current
    else:
        state.pop(key, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return state
