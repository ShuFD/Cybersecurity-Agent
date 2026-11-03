import os, sys, threading, queue, time, json, re, random, locale, subprocess, platform, base64, mimetypes
from secheur_env import ensure_env, get_env

ensure_env('SECHEUR_LANG', 'zh' if any(k in (locale.getlocale()[0] or '').lower() for k in ('zh', 'chinese')) else 'en')
if sys.stdout is None: sys.stdout = open(os.devnull, "w")
elif hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(errors='replace')
if sys.stderr is None: sys.stderr = open(os.devnull, "w")
elif hasattr(sys.stderr, 'reconfigure'): sys.stderr.reconfigure(errors='replace')
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from llmcore import (
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    compact_messages_history,
    reload_mykeys,
    ToolClient,
    MixinSession,
    NativeToolClient,
    NativeAnthropicSession,
    NativeOAISession,
    resolve_client,
)
from llm_usage import estimate_usage_cost, format_usage_summary, get_usage_stats, reset_usage_stats
from agent_loop import _as_system_reminder, agent_runner_loop, build_ctf_task_context
from agent_registry import build_agent_descriptions
from skill_registry import build_skill_descriptions, project_skill_dirs
from tool_registry import get_active_tool_schema
from prompt_rules import load_project_prompt_extensions
from permission_guard import PERMISSION_MODES
from session_resume import SessionResumeError, format_resume_list, restore_history_from_log, restore_latest_history
from memory_search import search_memory
from temporary_sub_agent_runner import configure_temporary_sub_agent, run_temporary_sub_agent_dialog
from tool_experience import (
    build_tool_experience_context,
    format_tool_experience_prompt,
    heuristic_tool_reuse_enabled,
)
from web_verbs import (
    build_web_verb_context,
    format_web_verb_prompt,
)
from ctf_verbs import (
    build_ctf_verb_context,
    format_ctf_verb_prompt,
)
from task_tree import (
    bind_tree_to_parent,
    format_task_tree_prompt,
    initialize_task_tree,
    task_tree_enabled,
)
from plan_runtime import PLAN_CONTROL_TOOLS, PlanRuntime, bind_runtime_to_parent
try:
    from plugins.hooks import HookBlocked, discover_and_load, trigger as _hook
    discover_and_load()
except Exception:
    class HookBlocked(Exception):
        event = ""
        message = ""
        data = {}
    _hook = lambda _event, ctx: ctx
import secheur_core
SecHeurAgentHandler = secheur_core.SecHeurAgentHandler
smart_format = secheur_core.smart_format
get_global_memory = secheur_core.get_global_memory
format_error = secheur_core.format_error


def restore_backend_history(backend, history):
    backend.history = list(history)
    for attr in ("_usage_tokens", "_usage_history_len"):
        if hasattr(backend, attr):
            delattr(backend, attr)


def clear_resume_read_state(agent):
    handler = getattr(agent, "handler", None)
    for attr in ("_read_file_state", "_read_call_state"):
        state = getattr(handler, attr, None)
        if isinstance(state, dict):
            state.clear()
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    if backend is not None:
        backend.compact_read_file_state = {}
        backend.compact_read_call_state = {}
consume_file = secheur_core.consume_file

script_dir = os.path.dirname(os.path.abspath(__file__))
THINKING_MODES = {"adaptive", "enabled", "disabled"}

_temp_dir_cache = None

def _get_temp_dir():
    """Return a writable ``temp/`` directory for agent runtime data.

    Prefers ``script_dir/temp`` but silently falls back to
    ``~/.secheur-agent/temp`` when the current user cannot write to the shared
    code directory (e.g. team-owned dir with restrictive ACLs).
    """
    global _temp_dir_cache
    if _temp_dir_cache is not None:
        return _temp_dir_cache
    candidate = os.path.join(script_dir, "temp")
    try:
        os.makedirs(candidate, exist_ok=True)
        probe = os.path.join(candidate, ".write_test")
        open(probe, "w").close()
        os.remove(probe)
        _temp_dir_cache = candidate
    except (PermissionError, OSError):
        _temp_dir_cache = os.path.join(os.path.expanduser("~"), ".secheur-agent", "temp")
        os.makedirs(_temp_dir_cache, exist_ok=True)
    return _temp_dir_cache


def apply_thinking_settings(agent, mode, budget=None):
    mode = (mode or "").strip()
    if mode not in THINKING_MODES:
        raise ValueError("Invalid thinking mode")
    if mode == "enabled" and budget is None:
        budget = 4096
    if budget is not None:
        budget = int(budget)
        if budget <= 0:
            raise ValueError("Invalid thinking budget")
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    if backend is None:
        raise ValueError("No active backend")
    backend.thinking_type = mode
    backend.thinking_budget_tokens = budget if mode == "enabled" else None
    return backend


def load_tool_schema(suffix=''):
    with open(os.path.join(script_dir, f'assets/tools_schema{suffix}.json'), 'r', encoding='utf-8') as f:
        TS = f.read()
    schema = json.loads(TS if os.name == 'nt' else TS.replace('powershell', 'bash'))
    return _dedupe_schema_enums(schema)


def _dedupe_schema_enums(value):
    if isinstance(value, dict):
        enum_values = value.get("enum")
        if isinstance(enum_values, list):
            value["enum"] = list(dict.fromkeys(enum_values))
        for child in value.values():
            _dedupe_schema_enums(child)
    elif isinstance(value, list):
        for item in value:
            _dedupe_schema_enums(item)
    return value


TOOLS_SCHEMA = load_tool_schema()


def desktop_config_paths(project_root=None):
    """desktop-config.json candidates, most specific first.

    SECHEUR_CONFIG_DIR is the deployment's authoritative SecHeur state
    directory; the project-local `.secheur-agent` copy is only a fallback for
    setups that never set the variable.
    """
    paths = []
    config_dir = get_env("SECHEUR_CONFIG_DIR", "").strip()
    if config_dir:
        paths.append(os.path.join(config_dir, "desktop-config.json"))
    paths.append(os.path.join(project_root or script_dir, ".secheur-agent", "desktop-config.json"))
    return paths


def load_project_permission_mode(project_root=None):
    env_mode = get_env("SECHEUR_PERMISSION_MODE", "")
    if env_mode in PERMISSION_MODES:
        return env_mode
    for path in desktop_config_paths(project_root):
        try:
            with open(path, "r", encoding="utf-8") as f:
                mode = json.load(f).get("permissionMode")
            if mode in PERMISSION_MODES:
                return mode
        except Exception:
            pass
    return "default"

lang_suffix = '_en' if get_env('SECHEUR_LANG') == 'en' else ''
mem_dir = os.path.join(script_dir, 'memory')
if not os.path.exists(mem_dir): os.makedirs(mem_dir)
mem_txt = os.path.join(mem_dir, 'global_mem.txt')
if not os.path.exists(mem_txt): open(mem_txt, 'w', encoding='utf-8').write('# [Global Memory - L2]\n')
mem_insight = os.path.join(mem_dir, 'global_mem_insight.txt')
if not os.path.exists(mem_insight):
    t = os.path.join(script_dir, f'assets/global_mem_insight_template{lang_suffix}.txt')
    open(mem_insight, 'w', encoding='utf-8').write(open(t, encoding='utf-8').read() if os.path.exists(t) else '')
cdp_cfg = os.path.join(script_dir, 'assets/tmwd_cdp_bridge/config.js')
if not os.path.exists(cdp_cfg):
    try:
        os.makedirs(os.path.dirname(cdp_cfg), exist_ok=True)
        open(cdp_cfg, 'w', encoding='utf-8').write(f"const TID = '__ljq_{hex(random.randint(0, 99999999))[2:8]}';")
    except Exception as e: print(f'[WARN] CDP config init failed: {e} — advanced web features (tmwebdriver) will be unavailable.')

def get_system_prompt(extra_skill_dirs=None, project_root=None):
    root = project_root or script_dir
    with open(os.path.join(script_dir, f'assets/sys_prompt{lang_suffix}.txt'), 'r', encoding='utf-8') as f: prompt = f.read()
    if rules := load_project_prompt_extensions(project_root=root):
        prompt += "\n" + rules + "\n"
    if skills := build_skill_descriptions(project_root=root, extra_skill_dirs=extra_skill_dirs):
        prompt += "\n" + skills + "\n"
    if agents := build_agent_descriptions(project_root=root):
        prompt += "\n" + agents + "\n"
    prompt += SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    prompt += f"\nToday: {time.strftime('%Y-%m-%d %a')}\n"
    prompt += get_global_memory(root)
    return prompt


def _limit_prefetch_text(text, max_chars):
    if max_chars is None or len(text) <= max_chars:
        return text
    marker = "\n[truncated]"
    if max_chars <= len(marker):
        return marker[:max_chars]
    return text[: max_chars - len(marker)] + marker


def build_memory_prefetch(query, memory_dir=None, limit=3, max_chars=2000):
    matches = search_memory(query, memory_dir=memory_dir or mem_dir, limit=limit)
    if not matches:
        return ""
    lines = [
        "# Memory Prefetch",
        "Relevant local memory snippets. Use file_read on the path if the complete memory is needed.",
        "",
    ]
    for item in matches:
        lines.append(f"- {item['path']} (score={item['score']}): {item['snippet']}")
    return _limit_prefetch_text("\n".join(lines), max_chars)


_IMAGE_TAG_RE = re.compile(r"\[image:([^\]\r\n]+)\]")
IMAGE_VISION_SKILL_NAME = "image-vision"


def _image_paths_from_inputs(prompt="", images=None):
    paths = []
    seen = set()

    def add_path(value):
        path = str(value or "").strip()
        if not path or path.startswith("data:") or path in seen:
            return
        seen.add(path)
        paths.append(path)

    for image in images or []:
        if isinstance(image, dict):
            add_path(image.get("path") or image.get("file"))
        elif isinstance(image, str):
            add_path(image)

    for match in _IMAGE_TAG_RE.finditer(str(prompt or "")):
        add_path(match.group(1))

    return paths


def build_image_vision_skill_reminder(prompt="", images=None):
    image_paths = _image_paths_from_inputs(prompt, images)
    if not image_paths and not images:
        return ""
    path_hint = "\n".join(f"- {path}" for path in image_paths) if image_paths else "- 图片已作为本轮消息附件传入，请从当前消息的图片块或附件上下文定位文件。"
    return (
        f"本轮用户发送或引用了图片。请优先调用 skill 工具执行 `{IMAGE_VISION_SKILL_NAME}`，"
        "再根据该 skill 的说明使用本地视觉模型识别图片内容、OCR 文本或界面/图表信息。\n"
        f"可用图片路径：\n{path_hint}"
    )


def _image_media_type_from_path(path):
    media_type, _ = mimetypes.guess_type(path)
    return media_type if media_type and media_type.startswith("image/") else "image/png"


def _image_block_from_file(path):
    path = str(path or "").strip()
    if not path:
        return None, None
    try:
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
    except OSError as e:
        print(f"[WARN] Failed to attach image {path!r}: {e}")
        return None, None
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": _image_media_type_from_path(path),
            "data": data,
        },
    }, ("path", os.path.abspath(path))


def _image_block_from_data_url(data_url):
    data_url = str(data_url or "").strip()
    if not data_url.startswith("data:") or "," not in data_url:
        return None, None
    header, data = data_url.split(",", 1)
    media_type = header[5:].split(";", 1)[0] or "image/png"
    if not media_type.startswith("image/"):
        return None, None
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": data,
        },
    }, ("data", data)


def _image_block_from_task_image(image):
    if isinstance(image, dict):
        block, key = _image_block_from_data_url(image.get("dataUrl") or image.get("data_url") or "")
        if block:
            return block, key
        return _image_block_from_file(image.get("path") or image.get("file") or "")
    if isinstance(image, str):
        block, key = _image_block_from_data_url(image)
        if block:
            return block, key
        return _image_block_from_file(image)
    return None, None


def build_initial_user_content(user_text, images=None, image_tag_text=None, attach_image_blocks=True):
    if attach_image_blocks:
        content = [{"type": "text", "text": str(user_text or "")}]
        seen = set()

        def add_image(block, key):
            if not block:
                return
            if key in seen:
                return
            seen.add(key)
            content.append(block)

        for image in images or []:
            add_image(*_image_block_from_task_image(image))

        for match in _IMAGE_TAG_RE.finditer(str(image_tag_text if image_tag_text is not None else user_text or "")):
            add_image(*_image_block_from_file(match.group(1)))

        return content if len(content) > 1 else None

    source_text = str(image_tag_text if image_tag_text is not None else user_text or "")
    image_paths = _image_paths_from_inputs(source_text, images)
    if not image_paths and not images:
        return None

    text = str(user_text or "")
    existing_paths = set(_image_paths_from_inputs(text, []))
    missing_paths = [path for path in image_paths if path not in existing_paths]
    if missing_paths:
        text += "\n" + "\n".join(f"[image:{path}]" for path in missing_paths)
    elif images and not image_paths:
        text += "\n[image attachment present, but no local file path was provided]"
    return [{"type": "text", "text": text}]


class MemoryPrefetchHandle:
    def __init__(self, query, memory_dir=None):
        self._done = threading.Event()
        self._value = ""
        self._error = None
        self._thread = threading.Thread(target=self._run, args=(query, memory_dir), daemon=True)
        self._thread.start()

    def _run(self, query, memory_dir):
        try:
            self._value = build_memory_prefetch(query, memory_dir=memory_dir)
        except Exception as e:
            self._error = e
            self._value = ""
        finally:
            self._done.set()

    def result(self, timeout=None):
        self._done.wait(timeout)
        return self._value if self._done.is_set() else ""


def start_memory_prefetch(query, memory_dir=None):
    return MemoryPrefetchHandle(query, memory_dir=memory_dir)


HARNESS_THINKING_PROTOCOL = """

# Harness 思维

- 模型负责判断，harness 负责提供工具、上下文和边界；不要用硬编码流程替代模型判断。
- 保持一个核心 agent loop：观察状态、决定下一步、调用工具、吸收结果、继续迭代；工具、权限、hooks、记忆、skill、MCP 都挂在 loop 周围。
- 知识按需加载：先列出可用 skill / memory / 规则，需要时再读取正文，避免一次性塞满上下文。
- 子 Agent 使用干净上下文，只交付结论、证据和必要引用；不要把无关历史传给子 Agent。
- 权限边界先于自由行动；不可逆、破坏性或外部传输动作必须先经过权限判断。
- 错误是恢复入口：读错误、补观察、换路径或重试；禁止无新信息地重复失败动作。
- 长任务、定时任务和并行任务要有可见状态、完成报告和可恢复的任务记录。
"""


SLASH_COMMAND_PROTOCOL = """

# 会话恢复指令

当用户询问如何恢复、继续上次任务、查看历史会话，或上下文看起来丢失时，直接提示这些指令：

- `/resume-list`：查看最近可恢复会话。
- `/resume`：恢复最新可用会话。
- `/resume <path>`：恢复指定会话日志路径。
"""


GOAL_PLAN_PROTOCOL = """

# 目标执行协议

当用户给出需要多步完成的复杂任务时，先拆成 2-8 个按顺序执行的目标项，并在回复开头输出一个机器可读的进度块：

<goal_plan>
<item status="running">当前正在执行的第一步</item>
<item status="pending">后续步骤</item>
</goal_plan>

执行过程中，每完成一步都要重新输出完整的 <goal_plan>，把已完成项标记为 <item status="done">，当前步骤标记为 <item status="running">。如果卡住，使用 <item status="blocked">；如果失败，使用 <item status="failed">。

简单任务不要拆分，也不要输出 <goal_plan>。简单任务包括：问候、单个事实回答、单条命令、无需跨文件修改或验证的小请求。
"""


def join_prompt_sections(*sections):
    parts = [str(section).strip() for section in sections if str(section or "").strip()]
    return "\n\n".join(parts) + ("\n" if parts else "")


def append_static_prompt_sections(prompt, *sections):
    stable = join_prompt_sections(*sections)
    if not stable:
        return prompt
    prompt = str(prompt or "")
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in prompt:
        return join_prompt_sections(prompt, stable)
    static_part, dynamic_part = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
    static_part = join_prompt_sections(static_part, stable)
    return static_part.rstrip() + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_part.lstrip()


def build_task_system_prompt(query, extra_sys_prompt="", memory_dir=None, prefetched_memory=None, extra_skill_dirs=None, project_root=None):
    prompt = append_static_prompt_sections(
        get_system_prompt(extra_skill_dirs=extra_skill_dirs, project_root=project_root),
        HARNESS_THINKING_PROTOCOL,
        SLASH_COMMAND_PROTOCOL,
        GOAL_PLAN_PROTOCOL,
        extra_sys_prompt,
    )
    if prefetched_memory is None:
        prefetched_memory = build_memory_prefetch(query, memory_dir=memory_dir)
    if prefetch := prefetched_memory:
        prompt += "\n" + prefetch + "\n"
    return prompt


def resolve_plan_path(raw_path=None, project_root=None):
    root = os.path.abspath(project_root or script_dir)
    path = (raw_path or "").strip() or os.path.join("temp", "plan.md")
    if os.path.isabs(path):
        return os.path.abspath(path)
    return os.path.abspath(os.path.join(root, path))


def should_use_cache_first_tools(agent):
    backend = getattr(getattr(agent, "llmclient", None), "backend", None)
    model = str(getattr(backend, "model", "") or "").lower()
    api_base = str(getattr(backend, "api_base", "") or "").lower()
    return "deepseek" in model or "deepseek" in api_base


class SecHeurAgent:
    def __init__(self):
        _get_temp_dir()  # ensure writable temp dir (with ACL fallback)
        self.task_dir = None
        self.history = []; self.handler = None; 
        self.task_queue = queue.Queue() 
        self.is_running = False; self.stop_sig = False; self.llm_no = 0;  
        self.inc_out = False; self.verbose = True; self.show_mode = 'text'
        self.peer_hint = True
        self.force_non_stream = False
        self.max_turns = 80
        self.max_cost = None
        self.memory_reference_enabled = True
        self.attempt_dedup_enabled = False
        self.web_verbs_enabled = False
        self.web_verb_context = None
        self.web_verbs_used = []
        self.ctf_verbs_enabled = False
        self.ctf_verb_context = None
        self.ctf_verbs_used = []
        self.ctf_sessions_open = []
        self.ctf_sessions_used = []  
        self.task_tree_enabled = True
        self.task_tree_state = None
        self.task_tree_path = None
        self.task_tree_events_path = None
        self.plan_runtime_state = None
        self.plan_runtime_path = None
        self.plan_runtime_events_path = None
        self.error_handler_enabled = True
        self.error_handler_state = None
        self.error_log_path = None
        self.error_summary_path = None
        self.project_root = script_dir
        self.permission_mode = load_project_permission_mode(self.project_root)
        self.plan_file_path = None
        self.auto_exit_plan_mode = False
        self.approved_plan_allowed_prompts = []
        self._session_start_hook_fired = False
        self._slash_plan_mode_active = False
        self._slash_plan_previous_permission_mode = None
        self.base_tools_schema = TOOLS_SCHEMA
        self.activated_tools = set()
        self.mcp_manager = None
        self.mcp_tool_schemas = []
        self.log_path = os.path.join(_get_temp_dir(), f'model_responses/model_responses_{int(time.time()*1e6)%1000000:06d}.txt')
        self.load_llm_sessions()

    def get_tools_schema(self):
        return get_active_tool_schema(
            self.base_tools_schema,
            self.activated_tools,
            extra_tools=self.mcp_tool_schemas,
            project_root=getattr(self, "project_root", script_dir),
            cache_first=should_use_cache_first_tools(self),
        )

    def current_cost(self):
        return estimate_usage_cost(get_usage_stats(), getattr(self.llmclient, "backend", None))

    def _make_temporary_sub_agent(self):
        child = SecHeurAgent()
        child.inc_out = True
        child.verbose = False
        child.single_task = True
        child.project_root = getattr(self, "project_root", script_dir)
        child.permission_mode = getattr(self, "permission_mode", "default")
        child.memory_reference_enabled = getattr(self, "memory_reference_enabled", True)
        child.attempt_dedup_enabled = getattr(self, "attempt_dedup_enabled", False)
        child.force_non_stream = getattr(self, "force_non_stream", False)
        child.max_turns = getattr(self, "max_turns", 80)
        child.max_cost = getattr(self, "max_cost", None)
        child.peer_hint = getattr(self, "peer_hint", True)
        child.custom_skill_dirs = getattr(self, "custom_skill_dirs", None)
        if getattr(self, "llm_no", 0) and hasattr(child, "next_llm"):
            child.next_llm(self.llm_no)
        return child

    def run_temporary_sub_agent(self, payload):
        child = configure_temporary_sub_agent(self._make_temporary_sub_agent(), dict(payload or {}))
        return (yield from run_temporary_sub_agent_dialog(
            payload,
            child,
            cancel_requested=lambda: bool(getattr(self, "stop_sig", False)),
            transcript_root=getattr(self, "project_root", script_dir),
        ))

    def _restore_session_from_slash(self, raw_query, display_queue):
        arg = raw_query.strip()[len("/resume"):].strip()
        try:
            if not arg or arg == "latest":
                restored = restore_latest_history()
                resume_path, resume_history = restored.path, restored.history
            else:
                resume_path, resume_history = arg, restore_history_from_log(arg)
            restore_backend_history(self.llmclient.backend, resume_history)
            clear_resume_read_state(self)
            display_queue.put({
                'done': f"[Resume] restored {len(resume_history)} messages from {resume_path}",
                'source': 'system',
            })
        except SessionResumeError as e:
            display_queue.put({'done': f"[Resume] {e}", 'source': 'system'})
        return None

    def load_llm_sessions(self):
        mykeys, changed = reload_mykeys()
        if not changed and hasattr(self, 'llmclients'): return
        try: oldhistory = self.llmclient.backend.history
        except Exception: oldhistory = None
        llm_sessions, load_errors = [], []
        for k, cfg in mykeys.items():
            if not any(x in k for x in ['api', 'config', 'cookie']): continue
            try:
                if 'mixin' in k: llm_sessions += [{'mixin_cfg': cfg}]
                elif c := resolve_client(k): llm_sessions += [c]
            except Exception as e:
                load_errors.append(f'{k}: {e}')
                print(f'[ERROR] Failed to init LLM client from {k!r}: {e}')
        for i, s in enumerate(llm_sessions):
            if isinstance(s, dict) and 'mixin_cfg' in s:
                try:
                    mixin = MixinSession(llm_sessions, s['mixin_cfg'])
                    if isinstance(mixin._sessions[0], (NativeAnthropicSession, NativeOAISession)): llm_sessions[i] = NativeToolClient(mixin)
                    else: llm_sessions[i] = ToolClient(mixin)
                except Exception as e: print(f'\n\n\n[ERROR] Failed to init MixinSession with cfg {s["mixin_cfg"]}: {e}!!!\n\n')
        self.llmclients = llm_sessions
        if not self.llmclients:
            detail = '\n  '.join(load_errors) if load_errors else 'no api/config/cookie entries found in mykey'
            raise RuntimeError(f'[ERROR] No usable LLM client. Check your mykey.py / mykey.json:\n  {detail}')
        self.llmclient = self.llmclients[self.llm_no%len(self.llmclients)]
        if oldhistory: self.llmclient.backend.history = oldhistory
    
    def next_llm(self, n=-1):
        self.load_llm_sessions()
        self.llm_no = ((self.llm_no + 1) if n < 0 else n) % len(self.llmclients)
        lastc = self.llmclient
        self.llmclient = self.llmclients[self.llm_no]
        try: self.llmclient.backend.history = lastc.backend.history
        except Exception: raise Exception('[ERROR] BAD Mixin config: Check your mykey.py')
        self.llmclient.last_tools = ''
        name = self.get_llm_name(model=True)
        suffix = '_cn' if 'glm' in name or 'minimax' in name or 'kimi' in name else ''
        self.base_tools_schema = load_tool_schema(suffix)
    def list_llms(self): 
        self.load_llm_sessions()
        return [(i, self.get_llm_name(b), i == self.llm_no) for i, b in enumerate(self.llmclients)]
    def get_llm_name(self, b=None, model=False):
        b = self.llmclient if b is None else b
        if isinstance(b, dict): return 'BADCONFIG_MIXIN'
        if model: return b.backend.model.lower()
        return f"{type(b.backend).__name__}/{b.backend.name}"

    def abort(self):
        if not self.is_running: return
        print('Abort current task...')
        self.stop_sig = True
        if self.handler is not None: self.handler.code_stop_signal.append(1)
            
    def put_task(self, query, source="user", images=None, web_verbs_enabled=False, ctf_verbs_enabled=False):
        display_queue = queue.Queue()
        memory_prefetch = None
        if getattr(self, "memory_reference_enabled", True) and isinstance(query, str) and not query.startswith('/'):
            memory_prefetch = start_memory_prefetch(query, memory_dir=getattr(self, "memory_dir", None))
        self.task_queue.put({
            "query": query,
            "source": source,
            "images": images or [],
            "output": display_queue,
            "memory_prefetch": memory_prefetch,
            "web_verbs_enabled": bool(web_verbs_enabled),
            "ctf_verbs_enabled": bool(ctf_verbs_enabled),
        })
        return display_queue

    # i know it is dangerous, but raw_query is dangerous enough it doesn't enlarge
    def _handle_slash_cmd(self, raw_query, display_queue):
        if not raw_query.startswith('/'): return raw_query
        if _sm := re.match(r'/session\.(\w+)=(.*)', raw_query.strip()):
            k, v = _sm.group(1), _sm.group(2)
            vfile = os.path.join(_get_temp_dir(), v)
            if os.path.isfile(vfile): v = open(vfile, encoding='utf-8').read().strip()
            try: v = json.loads(v)  # cover number parsing
            except (json.JSONDecodeError, ValueError): pass
            setattr(self.llmclient.backend, k, v)
            display_queue.put({'done': smart_format(f"✅ session.{k} = {repr(v)}", max_str_len=500), 'source': 'system'})
            return None
        if raw_query.strip() == '/resume-list':
            display_queue.put({'done': format_resume_list(), 'source': 'system'})
            return None
        if raw_query.strip() == '/resume' or raw_query.strip().startswith('/resume '):
            return self._restore_session_from_slash(raw_query, display_queue)
        if raw_query.strip() == '/compact':
            backend = getattr(getattr(self, "llmclient", None), "backend", None)
            history = getattr(backend, "history", None)
            if not isinstance(history, list) or not history:
                display_queue.put({'done': '[Compact] 当前没有可压缩的会话历史。', 'source': 'system'})
                return None
            before = len(history)
            if hasattr(self, "log_path"):
                backend.log_path = self.log_path
            compacted = compact_messages_history(history, backend, force=True)
            if compacted:
                display_queue.put({'done': f"[Compact] compacted history: {before} -> {len(history)} messages", 'source': 'system'})
            else:
                display_queue.put({'done': '[Compact] 无法生成摘要，历史保持不变。', 'source': 'system'})
            return None
        if _mt := re.match(r'/max-?turns(?:\s+|=)(\S+)\s*$', raw_query.strip()):
            try:
                n = int(_mt.group(1))
            except ValueError:
                display_queue.put({'done': '用法：/max-turns N，其中 N 是 1-200 的整数。', 'source': 'system'})
                return None
            self.max_turns = max(1, min(n, 200))
            display_queue.put({'done': f"✅ agent.max_turns = {self.max_turns}", 'source': 'system'})
            return None
        if _mc := re.match(r'/max-?cost(?:\s+|=)(\S+)\s*$', raw_query.strip()):
            try:
                value = float(_mc.group(1).lstrip("$"))
                if value <= 0:
                    raise ValueError
            except ValueError:
                display_queue.put({'done': '用法：/max-cost N，其中 N 是美元金额，例如 /max-cost 1.25。', 'source': 'system'})
                return None
            self.max_cost = value
            display_queue.put({'done': f"✅ agent.max_cost = ${self.max_cost:.4f}", 'source': 'system'})
            return None
        if raw_query.strip() in {"/usage", "/cost"}:
            stats = get_usage_stats()
            cost = estimate_usage_cost(stats, getattr(self.llmclient, "backend", None))
            display_queue.put({'done': format_usage_summary(stats, cost), 'source': 'system'})
            return None
        if _pm := re.match(r'/permission-?mode(?:\s+|=)(\S+)\s*$', raw_query.strip()):
            mode = _pm.group(1).strip()
            if mode not in PERMISSION_MODES:
                display_queue.put({'done': '用法：/permission-mode MODE。可选：' + ', '.join(sorted(PERMISSION_MODES)), 'source': 'system'})
                return None
            self.permission_mode = mode
            display_queue.put({'done': f"✅ agent.permission_mode = {self.permission_mode}", 'source': 'system'})
            return None
        if _pae := re.match(r'/plan-auto-exit(?:\s+|=)(\S+)\s*$', raw_query.strip()):
            value = _pae.group(1).strip().lower()
            if value in {"on", "true", "1", "yes", "y", "enable", "enabled", "开启"}:
                self.auto_exit_plan_mode = True
                state = "开启"
            elif value in {"off", "false", "0", "no", "n", "disable", "disabled", "关闭"}:
                self.auto_exit_plan_mode = False
                state = "关闭"
            else:
                display_queue.put({'done': '用法：/plan-auto-exit on|off', 'source': 'system'})
                return None
            display_queue.put({'done': f"✅ Plan Mode checkbox 自动退出已{state}", 'source': 'system'})
            return None
        if _pl := re.match(r'/plan(?:\s+(.+?))?\s*$', raw_query.strip()):
            plan_path = resolve_plan_path(_pl.group(1), project_root=getattr(self, "project_root", script_dir))
            os.makedirs(os.path.dirname(plan_path), exist_ok=True)
            if not os.path.exists(plan_path):
                with open(plan_path, 'w', encoding='utf-8') as f:
                    f.write("# Plan\n\n- [ ] Define the implementation steps.\n")
            self.plan_file_path = plan_path
            self.approved_plan_allowed_prompts = []
            if self.permission_mode != "plan":
                self._slash_plan_previous_permission_mode = self.permission_mode
            self.permission_mode = "plan"
            self._slash_plan_mode_active = True
            if getattr(self, "handler", None) is not None:
                self.handler.enter_plan_mode(plan_path)
            display_queue.put({'done': f"✅ Plan Mode enabled: {plan_path}", 'source': 'system'})
            return None
        if raw_query.strip() in {"/exit-plan", "/plan-exit"}:
            self.plan_file_path = None
            self.approved_plan_allowed_prompts = []
            if getattr(self, "handler", None) is not None:
                self.handler._exit_plan_mode()
            if getattr(self, "_slash_plan_mode_active", False):
                self.permission_mode = getattr(self, "_slash_plan_previous_permission_mode", None) or "default"
            self._slash_plan_mode_active = False
            self._slash_plan_previous_permission_mode = None
            display_queue.put({'done': "✅ 已退出 Plan Mode", 'source': 'system'})
            return None
        if _th := re.match(r'/thinking(?:\s+|=)(\S+)(?:\s+(\d+))?\s*$', raw_query.strip()):
            mode, budget = _th.group(1).strip(), _th.group(2)
            if mode not in THINKING_MODES:
                display_queue.put({'done': '用法：/thinking MODE [BUDGET]。可选：' + ', '.join(sorted(THINKING_MODES)), 'source': 'system'})
                return None
            try:
                apply_thinking_settings(self, mode, int(budget) if budget else None)
            except ValueError:
                display_queue.put({'done': '用法：/thinking enabled BUDGET，其中 BUDGET 必须是正整数。', 'source': 'system'})
                return None
            suffix = f" budget={budget}" if mode == "enabled" and budget else ""
            display_queue.put({'done': f"✅ agent.thinking = {mode}{suffix}", 'source': 'system'})
            return None
        return raw_query

    def _apply_user_prompt_hook(self, raw_query, source, task_images):
        ctx = _hook("user_prompt_submit", {
            "self": self,
            "prompt": raw_query,
            "source": source,
            "images": task_images,
        }) or {}
        prompt = str(ctx.get("prompt") if ctx.get("prompt") is not None else raw_query)
        extra_parts = []
        image_skill_reminder = build_image_vision_skill_reminder(prompt, task_images)
        if image_skill_reminder:
            extra_parts.append(image_skill_reminder)
        extra = ctx.get("additional_context")
        if extra:
            extra_parts.append(str(extra))
        if extra_parts:
            prompt += "\n\n" + _as_system_reminder("\n\n".join(extra_parts))
        return prompt

    def _apply_session_start_hook(self, raw_query, source, task_images):
        if getattr(self, "_session_start_hook_fired", False):
            return raw_query
        ctx = _hook("session_start", {
            "self": self,
            "prompt": raw_query,
            "source": source,
            "images": task_images,
        }) or {}
        self._session_start_hook_fired = True
        prompt = str(ctx.get("prompt") if ctx.get("prompt") is not None else raw_query)
        extra = ctx.get("additional_context")
        if extra:
            prompt += "\n\n" + _as_system_reminder(extra)
        return prompt

    def _trigger_stop_hook(self, source, prompt, stop_reason):
        try:
            _hook("stop", {
                "self": self,
                "source": source,
                "prompt": prompt,
                "stop_reason": stop_reason,
            })
        except HookBlocked as e:
            print(f"[hooks] Stop hook blocked after task end: {getattr(e, 'message', str(e))}")

    def run(self):
        while True:
            task = self.task_queue.get()
            raw_query, source, display_queue = task["query"], task["source"], task["output"]
            task_images = task.get("images") or []
            memory_prefetch = task.get("memory_prefetch")
            raw_query = self._handle_slash_cmd(raw_query, display_queue)
            if raw_query is None:
                self.task_queue.task_done(); continue
            try:
                raw_query = self._apply_session_start_hook(raw_query, source, task_images)
                raw_query = self._apply_user_prompt_hook(raw_query, source, task_images)
            except HookBlocked as e:
                msg = getattr(e, "message", str(e))
                display_queue.put({'done': f"[Hook] {msg}", 'source': source})
                self.task_queue.task_done()
                continue

            # ── 会话保护 / 空输入过滤（修复 pcapin/Yaar_Haar/lost_mind 等问题）──
            # 检测无效输入：空输入、仅空白、或模型"卡住"的占位回答
            _raw_stripped = (raw_query or "").strip()
            _stuck_patterns = [
                "系统上下文已加载",
                "系统已就绪",
                "等待用户指令",
                "等待您的任务",
                "我已就绪",
                "I am ready",
                "System ready",
            ]
            _is_stuck = any(p in _raw_stripped for p in _stuck_patterns) and len(_raw_stripped) < 100
            _is_empty = len(_raw_stripped) == 0 or _raw_stripped in {"", ".", "..", "...", "！", "？", "?", "!"}

            if _is_empty or _is_stuck:
                _has_active_task = getattr(self.handler, 'working', None) and self.handler.working.get('key_info')
                if _has_active_task:
                    _existing_task = self.handler.working.get('key_info', '')[:200]
                    display_queue.put({
                        'done': (
                            f"[会话保护] 检测到空输入/无效触发词，当前有进行中的分析任务，已拦截。\n"
                            f"当前任务摘要: {_existing_task}...\n"
                            f"如需继续之前的任务，请发送具体指令；如需开启新任务，请先调用 update_working_checkpoint 清理工作记忆。"
                        ),
                        'source': source
                    })
                    self.task_queue.task_done()
                    continue
                elif _is_stuck:
                    display_queue.put({
                        'done': (
                            f"[会话保护] 检测到模型'卡住'的占位响应（'{_raw_stripped[:80]}...'），已拦截。"
                            f"这通常是会话执行/保存管线未正确启动的信号。请使用 /resume 检查会话状态。"
                        ),
                        'source': source
                    })
                    self.task_queue.task_done()
                    continue
                # 纯空输入（没有任何任务上下文），静默忽略
                if _is_empty:
                    display_queue.put({
                        'done': "[会话保护] 检测到空输入，已自动忽略。请发送具体任务描述。",
                        'source': source
                    })
                    self.task_queue.task_done()
                    continue
            # ── 会话保护结束 ──
            self.is_running = True
            reset_usage_stats()
            prefetch_query = raw_query
            ctf_context = build_ctf_task_context(prefetch_query)
            task_web_verbs_enabled = bool(task.get("web_verbs_enabled"))
            self.tool_experience_prompt = prefetch_query
            self.tool_experience_enabled = heuristic_tool_reuse_enabled(prefetch_query)
            self.tool_experience_context = None
            self.web_verbs_enabled = task_web_verbs_enabled
            self.web_verb_context = None
            self.web_verbs_used = []
            self.ctf_verbs_enabled = bool(task.get("ctf_verbs_enabled"))
            self.ctf_verb_context = None
            self.ctf_verbs_used = []
            self.ctf_sessions_open = []
            self.ctf_sessions_used = []  
            self.task_tree_state = None
            self.task_tree_path = None
            self.task_tree_events_path = None
            self.plan_runtime_state = None
            self.plan_runtime_path = None
            self.plan_runtime_events_path = None
            self.activated_tools.difference_update(PLAN_CONTROL_TOOLS)
            self.error_handler_state = None
            self.error_log_path = None
            self.error_summary_path = None
            if len(raw_query) > 1500:
                task_file = os.path.join(_get_temp_dir(), f'user_prompt_{int(time.time())}.md')
                with open(task_file, 'w', encoding='utf-8') as f: f.write(raw_query)
                raw_query = f'Long user prompt saved to {task_file}. Read and execute.'
            initial_user_content = build_initial_user_content(raw_query, images=task_images, image_tag_text=prefetch_query)
            rquery = smart_format(raw_query.replace('\n', ' '), max_str_len=200)
            self.history.append(f"[USER]: {rquery}")

            project_root = getattr(self, "project_root", script_dir)
            sys_prompt = build_task_system_prompt(
                prefetch_query,
                extra_sys_prompt=getattr(self.llmclient.backend, 'extra_sys_prompt', ''),
                memory_dir=getattr(self, "memory_dir", None),
                prefetched_memory=memory_prefetch.result() if memory_prefetch is not None else None,
                extra_skill_dirs=getattr(self, "custom_skill_dirs", None),
                project_root=project_root,
            )
            if self.tool_experience_enabled:
                try:
                    self.tool_experience_context = build_tool_experience_context(
                        prefetch_query,
                        project_root=project_root,
                        task_dir=getattr(self, "task_dir", None),
                    )
                    tool_experience_prompt = format_tool_experience_prompt(self.tool_experience_context)
                    if tool_experience_prompt:
                        sys_prompt += "\n\n" + tool_experience_prompt
                except Exception as e:
                    self.tool_experience_context = {"error": format_error(e)}
                    sys_prompt += (
                        "\n\n[Heuristic Tool Experience Reuse]\n"
                        f"Tool experience reuse failed to initialize: {format_error(e)}\n"
                        "Continue with the normal heuristic-learning workflow."
                    )
            if self.web_verbs_enabled:
                try:
                    self.web_verb_context = build_web_verb_context(
                        prefetch_query,
                        project_root=project_root,
                        task_dir=getattr(self, "task_dir", None),
                        enabled=True,
                    )
                    web_verb_prompt = format_web_verb_prompt(self.web_verb_context)
                    if web_verb_prompt:
                        sys_prompt += "\n\n" + web_verb_prompt
                except Exception as e:
                    self.web_verb_context = {"error": format_error(e)}
                    sys_prompt += (
                        "\n\n[Web Verb Typed Actions]\n"
                        f"Web Verb initialization failed: {format_error(e)}\n"
                        "Continue with normal web tools."
                    )
            if self.ctf_verbs_enabled:
                try:
                    self.ctf_verb_context = build_ctf_verb_context(
                        prefetch_query,
                        project_root=project_root,
                        task_dir=getattr(self, "task_dir", None),
                        enabled=True,
                    )
                    ctf_verb_prompt = format_ctf_verb_prompt(self.ctf_verb_context)
                    if ctf_verb_prompt:
                        sys_prompt += "\n\n" + ctf_verb_prompt
                except Exception as e:
                    self.ctf_verb_context = {"error": format_error(e)}
                    sys_prompt += (
                        "\n\n[CTF Typed Verbs]\n"
                        f"CTF Verb initialization failed: {format_error(e)}\n"
                        "Continue with normal shell tools."
                    )
            if task_tree_enabled(self):
                try:
                    tree_run_dir = getattr(self, "task_dir", None)
                    if not tree_run_dir:
                        tree_run_dir = os.path.join(
                            _get_temp_dir(),
                            "task_trees",
                            f"run_{int(time.time() * 1000)}_{random.randint(1000, 9999)}",
                        )
                    task_tree_state = initialize_task_tree(
                        prefetch_query,
                        run_dir=tree_run_dir,
                        project_root=project_root,
                        tool_experience_context=self.tool_experience_context,
                        web_verb_context=self.web_verb_context,
                        enabled=True,
                    )
                    bind_tree_to_parent(self, task_tree_state)
                    task_tree_prompt = format_task_tree_prompt(task_tree_state)
                    if task_tree_prompt:
                        sys_prompt += "\n\n" + task_tree_prompt
                except Exception as e:
                    self.task_tree_state = None
                    self.task_tree_path = None
                    self.task_tree_events_path = None
                    sys_prompt += (
                        "\n\n[Structured Evidence Task Tree]\n"
                        f"Task tree initialization failed: {format_error(e)}\n"
                        "Continue with the normal plan and evidence workflow."
                    )
            if task_tree_enabled(self):
                try:
                    runtime_run_dir = getattr(self, "task_dir", None)
                    if not runtime_run_dir:
                        runtime_run_dir = os.path.join(
                            _get_temp_dir(),
                            "plan_runtimes",
                            f"run_{int(time.time() * 1000)}_{random.randint(1000, 9999)}",
                        )
                    plan_runtime = PlanRuntime.initialize(
                        prefetch_query,
                        run_dir=runtime_run_dir,
                        project_root=project_root,
                        enabled=True,
                    )
                    bind_runtime_to_parent(self, plan_runtime)
                    self.activated_tools.update(PLAN_CONTROL_TOOLS)
                    self.activated_tools.update(plan_runtime.required_tools())
                    runtime_prompt = plan_runtime.format_prompt()
                    if runtime_prompt:
                        sys_prompt += "\n\n" + runtime_prompt
                except Exception as e:
                    self.plan_runtime_state = None
                    self.plan_runtime_path = None
                    self.plan_runtime_events_path = None
                    sys_prompt += (
                        "\n\n[Evidence-Grounded Program Plan]\n"
                        f"Program-plan runtime failed to initialize: {format_error(e)}\n"
                        "Continue with the existing task-tree workflow."
                    )
            if self.peer_hint: sys_prompt += f"\n[Peer] 用户提及其他会话/后台任务状态时: temp/model_responses/ (只找近期修改的文件尾部)\n"
            project_root = getattr(self, "project_root", script_dir)
            handler = SecHeurAgentHandler(self, self.history, project_root)
            if self.handler:
                # 跨用户轮继承已读文件签名与去重状态，避免每轮强制重读；文件被外部修改时签名校验仍会要求重读
                handler._read_file_state = dict(getattr(self.handler, '_read_file_state', None) or {})
                handler._read_call_state = dict(getattr(self.handler, '_read_call_state', None) or {})
            handler.project_root = project_root
            handler.project_skill_dir = project_skill_dirs(project_root, extra_skill_dirs=getattr(self, "custom_skill_dirs", None))
            if getattr(self, "plan_file_path", None):
                handler.enter_plan_mode(self.plan_file_path)
            if self.handler and 'key_info' in self.handler.working: 
                ki = re.sub(r'\n\[SYSTEM\] 此为.*?工作记忆[。\n]*', '', self.handler.working['key_info'])  # 去旧
                handler.working['key_info'] = ki
                handler.working['passed_sessions'] = ps = self.handler.working.get('passed_sessions', 0) + 1
                if ps > 0: handler.working['key_info'] += f'\n[SYSTEM] 此为 {ps} 个对话前设置的key_info，若已在新任务，先更新或清除工作记忆。\n'
            self.handler = handler  # although new handler, the **full** history is in llmclient, so it is full history!
            self.llmclient.log_path = self.log_path
            self.llmclient.backend.compact_read_file_state = handler._read_file_state
            self.llmclient.backend.compact_read_call_state = handler._read_call_state
            if self.force_non_stream:
                self.llmclient.backend.stream = False
                self.llmclient.backend.read_timeout = max(self.llmclient.backend.read_timeout, 1200)
            gen = agent_runner_loop(self.llmclient, sys_prompt, raw_query, handler, self.get_tools_schema,
                                    max_turns=self.max_turns, max_cost=self.max_cost, cost_provider=self.current_cost,
                                    verbose=self.verbose, yield_info=True, initial_user_content=initial_user_content,
                                    allowed_tools=getattr(self, "allowed_tools", None), ctf_context=ctf_context)
            try:
                full_resp = ""; last_pos = 0; curr_turn = 0; turn_resps = []
                for chunk in gen:
                    if consume_file(self.task_dir, '_stop'): self.abort() 
                    if self.stop_sig: break
                    if isinstance(chunk, dict) and 'turn' in chunk: 
                        curr_turn = chunk['turn']; turn_resps.append(''); continue
                    full_resp += chunk;  turn_resps[-1] += chunk
                    if len(full_resp) - last_pos > 30 or 'LLM Running' in chunk:
                        display_queue.put({'next': full_resp[last_pos:] if self.inc_out else full_resp, 
                                           'source': source, 'turn': curr_turn, 'outputs': turn_resps[-2:]})
                        last_pos = len(full_resp)
                if self.inc_out and last_pos < len(full_resp): display_queue.put({'next': full_resp[last_pos:], 'source': source, 
                                                                                  'turn': curr_turn, 'outputs': turn_resps[-2:]})
                #if '</summary>' in full_resp: full_resp = full_resp.replace('</summary>', '</summary>\n\n')
                #if '</file_content>' in full_resp: full_resp = re.sub(r'<file_content>\s*(.*?)\s*</file_content>', r'\n````\n<file_content>\n\1\n</file_content>\n````', full_resp, flags=re.DOTALL)                
                display_queue.put({'done': full_resp, 'source': source, 'turn': curr_turn, 'outputs': turn_resps.copy()})
                self.history = handler.history_info
            except Exception as e:
                print(f"Backend Error: {format_error(e)}")
                display_queue.put({'done': full_resp + f'\n```\n{format_error(e)}\n```', 'source': source, 'turn': curr_turn, 'outputs': turn_resps.copy()})
            finally:
                stop_reason = "aborted" if self.stop_sig else "completed"
                self._trigger_stop_hook(source, prefetch_query, stop_reason)
                if self.stop_sig: print('User aborted the task.')
                self.is_running = self.stop_sig = False
                self.task_queue.task_done()
                if self.handler is not None: self.handler.code_stop_signal.append(1)
                if getattr(self, "single_task", False):
                    break


def launch_background_task(task_name, argv):
    cmd = [sys.executable, os.path.abspath(__file__)] + list(argv) + ['--nobg']
    d = os.path.join(_get_temp_dir(), f'{task_name}')
    os.makedirs(d, exist_ok=True)
    stdout_handle = open(os.path.join(d, 'stdout.log'), 'w', encoding='utf-8')
    stderr_handle = open(os.path.join(d, 'stderr.log'), 'w', encoding='utf-8')
    try:
        p = subprocess.Popen(
            cmd,
            cwd=script_dir,
            creationflags=0x08000000 if platform.system() == 'Windows' else 0,
            stdout=stdout_handle,
            stderr=stderr_handle,
        )
        return p.pid
    finally:
        stdout_handle.close()
        stderr_handle.close()


if __name__ == '__main__':
    import argparse
    from datetime import datetime
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', metavar='IODIR', help='一次性任务模式(文件IO)')
    parser.add_argument('--reflect', metavar='SCRIPT', help='反射模式：加载监控脚本，check()触发时发任务')
    parser.add_argument('--input', help='prompt')
    parser.add_argument('--llm_no', type=int, default=0)
    parser.add_argument('--max_turns', '--max-turns', dest='max_turns', type=int, default=80)
    parser.add_argument('--max_cost', '--max-cost', dest='max_cost', type=float)
    parser.add_argument('--attempt-dedup', dest='attempt_dedup', action='store_true', help='block identical attempts while observable state is unchanged')
    parser.add_argument('--permission_mode', '--permission-mode', dest='permission_mode', choices=sorted(PERMISSION_MODES))
    parser.add_argument('--resume', nargs='?', const='latest', help='恢复最近会话；也可传 model_responses 日志路径')
    parser.add_argument('--thinking', choices=sorted(THINKING_MODES), help='Anthropic extended thinking 模式')
    parser.add_argument('--thinking_budget', '--thinking-budget', dest='thinking_budget', type=int, help='thinking=enabled 时的 token budget')
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--nobg', action='store_true')
    args, _unknown = parser.parse_known_args()
    _reflect_args = dict(zip([k.lstrip('-') for k in _unknown[::2]], _unknown[1::2])) if _unknown else {}

    if args.task and not args.nobg:
        print('PID:', launch_background_task(args.task, sys.argv[1:])); sys.exit(0)

    agent = SecHeurAgent()
    agent.next_llm(args.llm_no)
    if args.resume:
        try:
            if args.resume == 'latest':
                restored = restore_latest_history()
                resume_path, resume_history = restored.path, restored.history
            else:
                resume_path, resume_history = args.resume, restore_history_from_log(args.resume)
            restore_backend_history(agent.llmclient.backend, resume_history)
            print(f"[Resume] restored {len(resume_history)} messages from {resume_path}")
        except SessionResumeError as e:
            print(f"[Resume] {e}", file=sys.stderr)
            sys.exit(2)
    agent.max_turns = max(1, min(args.max_turns, 200))
    agent.max_cost = args.max_cost if args.max_cost and args.max_cost > 0 else None
    agent.attempt_dedup_enabled = bool(args.attempt_dedup)
    if args.permission_mode:
        agent.permission_mode = args.permission_mode
    if args.thinking:
        try:
            apply_thinking_settings(agent, args.thinking, args.thinking_budget)
        except ValueError as e:
            print(f"[Thinking] {e}", file=sys.stderr)
            sys.exit(2)
    agent.verbose = args.verbose
    threading.Thread(target=agent.run, daemon=True).start()

    if args.task:
        agent.peer_hint = False
        agent.force_non_stream = True
        agent.task_dir = d = os.path.join(_get_temp_dir(), f'{args.task}'); nround = ''
        infile = os.path.join(d, 'input.txt')
        if args.input:
            os.makedirs(d, exist_ok=True)
            import glob; [os.remove(f) for f in glob.glob(os.path.join(d, 'output*.txt'))]
            with open(infile, 'w', encoding='utf-8') as f: f.write(args.input)
        if (fh := consume_file(d, '_history.json')): agent.llmclient.backend.history = json.loads(fh)
        with open(infile, encoding='utf-8') as f: raw = f.read()
        while True:
            dq = agent.put_task(raw, source='task')
            while 'done' not in (item := dq.get(timeout=1200)): 
                if 'next' in item and random.random() < 0.95:  # 概率写一次中间结果
                    with open(f'{d}/output{nround}.txt', 'w', encoding='utf-8') as f: f.write(item.get('next', ''))
            with open(f'{d}/output{nround}.txt', 'w', encoding='utf-8') as f: f.write(item['done'] + '\n\n[ROUND END]\n')
            consume_file(d, '_stop')  # 已经成功停下来了，避免打断下次reply
            for _ in range(300):  # 等reply.txt，10分钟超时
                time.sleep(2)
                if (raw := consume_file(d, 'reply.txt')): break
            else: break
            nround = nround + 1 if isinstance(nround, int) else 1
    elif args.reflect:
        agent.peer_hint = False
        agent.force_non_stream = True
        import importlib.util
        spec = importlib.util.spec_from_file_location('reflect_script', args.reflect)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        if hasattr(mod, 'init'): mod.init(_reflect_args)
        _mt = os.path.getmtime(args.reflect)
        print(f'[Reflect] loaded {args.reflect}' + (f' args={_reflect_args}' if _reflect_args else ''))
        while True:
            if os.path.getmtime(args.reflect) != _mt:
                try:
                    spec.loader.exec_module(mod); _mt = os.path.getmtime(args.reflect)
                    if hasattr(mod, 'init'): mod.init(_reflect_args)
                    print('[Reflect] reloaded')
                except Exception as e: print(f'[Reflect] reload error: {e}')
            try: task = mod.check()
            except Exception as e: 
                print(f'[Reflect] check() error: {e}'); task = None
            if task and task == '/exit': break
            if not task:
                time.sleep(getattr(mod, 'INTERVAL', 5)); continue
            print(f'[Reflect] triggered: {task[:80]}')
            dq = agent.put_task(task, source='reflect')
            try:
                while 'done' not in (item := dq.get(timeout=1200)): pass
                result = item['done']
                print(result)
            except Exception as e:
                if getattr(mod, 'ONCE', False): raise
                print(f'[Reflect] drain error: {e}'); result = f'[ERROR] {e}'
            log_dir = os.path.join(_get_temp_dir(), 'reflect_logs'); os.makedirs(log_dir, exist_ok=True)
            script_name = os.path.splitext(os.path.basename(args.reflect))[0]
            open(os.path.join(log_dir, f'{script_name}_{datetime.now():%Y-%m-%d}.log'), 'a', encoding='utf-8').write(f'[{datetime.now():%m-%d %H:%M}]\n{result}\n\n')
            if (on_done := getattr(mod, 'on_done', None)):
                try: on_done(result)
                except Exception as e: print(f'[Reflect] on_done error: {e}')
            if getattr(mod, 'ONCE', False): print('[Reflect] ONCE=True, exiting.'); break
    else:
        try: import readline
        except Exception: pass
        agent.inc_out = True
        if sys.stdout.isatty():
            try: model = agent.get_llm_name(model=True) or '?'
            except Exception: model = '?'
            try:
                sys.stdout.write(f'\x1b[92m✦\x1b[0m \x1b[1mSecHeur Agent\x1b[0m '
                                 f'\x1b[90m· cli · model:\x1b[0m {model}\n')
                sys.stdout.flush()
            except Exception: pass
        while True:
            q = input('> ').strip()
            if not q: continue
            try:
                dq = agent.put_task(q, source='user')
                while True:
                    item = dq.get()
                    if 'next' in item: print(item['next'], end='', flush=True)
                    if 'done' in item: print(); break
            except KeyboardInterrupt:
                agent.abort()
                print('\n[Interrupted]')
