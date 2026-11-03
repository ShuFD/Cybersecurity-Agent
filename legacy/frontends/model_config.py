import ast
import shutil
from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MYKEY_PATH = PROJECT_ROOT / "mykey.py"

PROVIDER_DEFAULTS = {
    "native_oai": {
        "label": "OpenAI 兼容接口",
        "name": "gpt-native",
        "apibase": "https://api.openai.com/v1",
        "model": "gpt-5.4",
        "api_mode": "chat_completions",
    },
    "native_anthropic": {
        "label": "Anthropic 兼容接口",
        "name": "anthropic-native",
        "apibase": "https://api.anthropic.com",
        "model": "anthropic-model",
        "relay_compat_system_prompt": False,
        "thinking_type": "adaptive",
    },
}

FIELD_ORDER = [
    "name",
    "type",
    "apikey",
    "apibase",
    "model",
    "api_mode",
    "relay_compat_system_prompt",
    "thinking_type",
    "thinking_budget_tokens",
    "reasoning_effort",
    "max_tokens",
    "max_retries",
    "connect_timeout",
    "read_timeout",
    "temperature",
    "context_win",
    "input_cost_per_1m",
    "output_cost_per_1m",
    "cache_read_cost_per_1m",
    "cache_creation_cost_per_1m",
    "proxy",
    "user_agent",
    "stream",
]

CONFIG_VAR_BY_TYPE = {
    "native_oai": "native_oai_config",
    "native_anthropic": "native_anthropic_config",
}

TYPE_BY_CONFIG_VAR = {value: key for key, value in CONFIG_VAR_BY_TYPE.items()}


def normalize_config_type(cfg_type):
    return (cfg_type or "").strip()


def is_placeholder_key(value):
    value = (value or "").strip()
    if not value:
        return True
    lowered = value.lower()
    return any(token in lowered for token in ("<your", "your-", "your_", "示例", "example"))


def mask_secret(value):
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def _infer_type(var_name, cfg):
    if cfg.get("type"):
        cfg = dict(cfg)
        cfg["type"] = normalize_config_type(cfg.get("type"))
        return cfg
    cfg = dict(cfg)
    if "anthropic" in var_name and "native" in var_name:
        cfg["type"] = "native_anthropic"
    else:
        cfg["type"] = "native_oai"
    return cfg


def _config_var_name(cfg_type, index):
    base = CONFIG_VAR_BY_TYPE.get(cfg_type, "native_oai_config")
    return base if index == 0 else f"{base}_{index}"


def _read_configs_from_mykey(path=MYKEY_PATH):
    path = Path(path)
    if not path.exists():
        return [], []
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return [], []

    configs = []
    preferred_names = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                continue
            if target.id == "mixin_config" and isinstance(value, dict):
                preferred_names = list(value.get("llm_nos") or [])
                continue
            if not isinstance(value, dict):
                continue
            if target.id == "mixin_config":
                continue
            if not any(token in target.id for token in ("config", "api", "cookie")):
                continue
            cfg = _infer_type(target.id, value)
            if cfg.get("apikey") or cfg.get("apibase") or cfg.get("model"):
                configs.append({"varName": target.id, "config": cfg})
    return configs, preferred_names


def load_all_configs(path=MYKEY_PATH):
    configs, preferred_names = _read_configs_from_mykey(path)
    profiles = []
    for index, item in enumerate(configs):
        cfg = dict(item["config"])
        name = cfg.get("name") or cfg.get("model") or item["varName"]
        apikey = str(cfg.get("apikey") or "")
        safe = dict(cfg)
        safe["apikey"] = ""
        profiles.append({
            "id": name,
            "name": name,
            "varName": item["varName"],
            "type": cfg.get("type") or _infer_type(item["varName"], cfg).get("type") or "native_oai",
            "model": cfg.get("model") or "",
            "apibase": cfg.get("apibase") or "",
            "hasApiKey": bool(apikey),
            "maskedApiKey": mask_secret(apikey),
            "active": name in preferred_names or (not preferred_names and index == 0),
            "config": safe,
        })
    return {
        "profiles": profiles,
        "activeNames": preferred_names or ([profiles[0]["name"]] if profiles else []),
    }


def load_current_config(path=MYKEY_PATH):
    configs, preferred_names = _read_configs_from_mykey(path)

    if not configs:
        return {}
    for preferred in preferred_names:
        for item in configs:
            cfg = item["config"]
            if cfg.get("name") == preferred:
                return cfg
    return configs[0]["config"]


def find_config_by_name(path=MYKEY_PATH, name=""):
    name = str(name or "").strip()
    if not name:
        return None
    configs, _preferred_names = _read_configs_from_mykey(path)
    for item in configs:
        cfg = item["config"]
        candidates = {
            str(cfg.get("name") or "").strip(),
            str(cfg.get("model") or "").strip(),
            str(item.get("varName") or "").strip(),
        }
        if name in candidates:
            return cfg
    return None


def merge_model_config(form_config, existing_config=None):
    existing_config = existing_config or {}
    cfg_type = normalize_config_type(form_config.get("type") or existing_config.get("type") or "native_oai")
    defaults = PROVIDER_DEFAULTS.get(cfg_type, PROVIDER_DEFAULTS["native_oai"])
    merged = dict(defaults)
    merged.update({k: v for k, v in existing_config.items() if k in FIELD_ORDER})
    merged.update({k: v for k, v in form_config.items() if k in FIELD_ORDER})
    merged["type"] = cfg_type

    for key, value in list(merged.items()):
        if isinstance(value, str):
            merged[key] = value.strip()

    if not merged.get("apikey") and not is_placeholder_key(existing_config.get("apikey")):
        merged["apikey"] = existing_config.get("apikey", "").strip()

    if cfg_type == "native_oai":
        merged.pop("relay_compat_system_prompt", None)
        merged.pop("thinking_type", None)
        merged.setdefault("api_mode", "chat_completions")
    elif cfg_type == "native_anthropic":
        merged.pop("api_mode", None)
        merged.setdefault("relay_compat_system_prompt", False)
        merged.setdefault("thinking_type", "adaptive")

    if not merged.get("proxy"):
        merged.pop("proxy", None)
    return merged


def build_mykey_py(config, generated_at=None):
    return build_mykey_py_for_configs(
        [config],
        active_names=[config.get("name") or config.get("model")],
        generated_at=generated_at,
    )


def build_mykey_py_for_configs(configs, active_names=None, generated_at=None):
    generated_at = generated_at or datetime.now().strftime("%Y-%m-%d %H:%M")
    configs = [dict(cfg) for cfg in configs if isinstance(cfg, dict)]
    if not configs:
        configs = [dict(PROVIDER_DEFAULTS["native_oai"])]
    normalized = []
    type_counts = {}
    for cfg in configs:
        cfg_type = cfg.get("type", "native_oai")
        type_index = type_counts.get(cfg_type, 0)
        type_counts[cfg_type] = type_index + 1
        name = cfg.get("name") or cfg.get("model") or PROVIDER_DEFAULTS.get(cfg_type, PROVIDER_DEFAULTS["native_oai"])["name"]
        cfg["name"] = name
        normalized.append((_config_var_name(cfg_type, type_index), cfg))
    active_names = [name for name in (active_names or []) if name]
    if not active_names:
        active_names = [normalized[0][1]["name"]]

    lines = [
        "# ══════════════════════════════════════════════════════════════════════════════",
        f"#  SecHeur Agent — mykey.py（由配置界面生成 @ {generated_at}）",
        "# ══════════════════════════════════════════════════════════════════════════════",
        "",
        "_SETUP_DONE = 'desktop-config'",
        "",
        "mixin_config = {",
        f"    'llm_nos': {active_names!r},",
        "    'max_retries': 10,",
        "    'base_delay': 0.5,",
        "}",
    ]
    for var_name, config in normalized:
        lines += ["", f"{var_name} = {{"]
        for key in FIELD_ORDER:
            if key not in config:
                continue
            value = config[key]
            if value == "" or value is None:
                continue
            lines.append(f"    {key!r}: {value!r},")
        lines.append("}")
    lines += ["", "# 配置完成后可运行：python launch.pyw"]
    return "\n".join(lines) + "\n"


def write_model_config(config, path=MYKEY_PATH):
    return write_model_configs([config], path=path, active_names=[config.get("name") or config.get("model")])


def write_model_configs(configs, path=MYKEY_PATH, active_names=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_name("mykey.py.bak"))
    tmp_path = path.with_name("mykey.py.tmp")
    tmp_path.write_text(build_mykey_py_for_configs(configs, active_names=active_names), encoding="utf-8")
    tmp_path.replace(path)
    return path


def _configs_with_secrets(path):
    configs = []
    raw_configs, _ = _read_configs_from_mykey(path)
    by_var = {item["varName"]: item["config"] for item in raw_configs}
    for profile in load_all_configs(path)["profiles"]:
        cfg = dict(profile["config"])
        if profile["hasApiKey"]:
            cfg["apikey"] = by_var.get(profile["varName"], {}).get("apikey", "")
        configs.append(cfg)
    return configs


def delete_model_config(path, name):
    path = Path(path)
    name = str(name or "").strip()
    if not name:
        raise ValueError("API profile name is required")
    existing_bundle = load_all_configs(path)
    configs = _configs_with_secrets(path)
    target_index = next((index for index, cfg in enumerate(configs) if cfg.get("name") == name), -1)
    if target_index < 0:
        raise ValueError("API profile not found")
    removed = configs.pop(target_index)
    active_names = [item for item in existing_bundle.get("activeNames", []) if item != name]
    if configs:
        if not active_names:
            active_names = [configs[0].get("name") or configs[0].get("model")]
        write_model_configs(configs, path=path, active_names=active_names)
    else:
        if path.exists():
            shutil.copy2(path, path.with_name("mykey.py.bak"))
            path.unlink()
    return {"deletedName": name, "deleted": {k: v for k, v in removed.items() if k != "apikey"}}


def upsert_model_config(path, form_config):
    path = Path(path)
    existing_bundle = load_all_configs(path)
    existing_configs = _configs_with_secrets(path)

    target_name = (form_config.get("name") or "").strip()
    target_index = -1
    for index, cfg in enumerate(existing_configs):
        if cfg.get("name") == target_name and target_name:
            target_index = index
            break
    existing = existing_configs[target_index] if target_index >= 0 else {}
    merged = merge_model_config(form_config or {}, existing)
    missing = [key for key in ("name", "apibase", "model") if not merged.get(key)]
    if missing:
        raise ValueError("缺少必填字段：" + ", ".join(missing))
    if target_index >= 0:
        existing_configs[target_index] = merged
    else:
        existing_configs.append(merged)
    active_names = existing_bundle.get("activeNames") or []
    if not active_names or form_config.get("activate", True):
        active_names = [merged["name"]]
    write_model_configs(existing_configs, path=path, active_names=active_names)
    return load_all_configs(path)
