import os, json, re, time, requests, sys, threading, urllib3, base64, importlib, uuid, random, hashlib, copy, html, inspect
from datetime import datetime
from secheur_env import get_env
from runtime_cleanup import cleanup_old_runtime_files
from runtime_session_log import (
    SessionCompactBoundary,
    SessionLogEvent,
    append_session_event,
    read_recoverable_session_records,
    read_session_records,
    session_log_sidecar_path,
)
from llm_protocols import (
    msgs_anthropic_to_oai as _msgs_anthropic2oai,
    to_responses_input as _to_responses_input,
)
from llm_usage import capture_prefix_shape, compare_prefix_shape, estimate_usage_cost, get_last_context_tokens, get_usage_revision, get_usage_stats, normalize_usage_delta, record_usage_totals, reset_usage_stats
try:
    from plugins.hooks import HookBlocked, trigger as _hook
except ImportError:
    class HookBlocked(Exception):
        event = ""
        message = ""
        data = {}
    _hook = lambda *a, **k: {}
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
_RESP_CACHE_KEY = str(uuid.uuid4())
SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n\n<SYSTEM_PROMPT_DYNAMIC_BOUNDARY>\n\n"
_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path: sys.path.append(_ROOT)

def _load_mykeys():
    global _mykey_path
    try:
        import mykey; importlib.reload(mykey); _mykey_path = mykey.__file__
        return {k: v for k, v in vars(mykey).items() if not k.startswith('_')}
    except ImportError as e:
        if getattr(e, 'name', None) != 'mykey':
            raise Exception(f'[ERROR] mykey.py found but failed to import: {e}') from e
    except SyntaxError as e:
        raise Exception(f'[ERROR] mykey.py has syntax error: {e}') from e
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mykey.json')
    if not os.path.exists(p): raise Exception('[ERROR] mykey.py not found in sys.path and mykey.json not found. Copy mykey_template.py to mykey.py or configure API profiles in the desktop settings.')
    with open(_mykey_path := p, encoding='utf-8') as f: return json.load(f)

_mykey_path = _mykey_mtime = None
def reload_mykeys():
    global _mykey_mtime
    try:
        mt = os.stat(_mykey_path).st_mtime_ns if _mykey_path else -1
        if mt == _mykey_mtime: return globals().get('mykeys', {}), False
        mk = _load_mykeys(); _mykey_mtime = os.stat(_mykey_path).st_mtime_ns
        print(f'[Info] Load mykeys from {_mykey_path}')
        globals().update(mykeys=mk)
        return mk, True
    except Exception as e:
        print(f'[ERROR] reload_mykeys failed, keep using previous keys: {e}')
        return globals().get('mykeys', {}), False

def __getattr__(name):  # once guard in PEP 562
    if name == 'mykeys': return reload_mykeys()[0]
    raise AttributeError(f"module 'llmcore' has no attribute {name}")

def compress_history_tags(messages, keep_recent=10, max_len=800):
    """Compress <thinking>/<tool_use>/<tool_result> tags in older messages to save tokens.
    会原地改写历史（破坏 prompt cache 前缀），只应在超过上下文 cap 时调用。"""
    _before = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
    _pats = {tag: re.compile(rf'(<{tag}>)([\s\S]*?)(</{tag}>)') for tag in ('thinking', 'think', 'tool_use', 'tool_result')}
    _hist_pat = re.compile(r'<(history|key_info|earlier_context)>[\s\S]*?</\1>')
    def _trunc_str(s): return s[:max_len//2] + '\n...[Truncated]...\n' + s[-max_len//2:] if isinstance(s, str) and len(s) > max_len else s
    def _trunc(text):
        text = _hist_pat.sub(lambda m: f'<{m.group(1)}>[...]</{m.group(1)}>', text)
        for pat in _pats.values(): text = pat.sub(lambda m: m.group(1) + _trunc_str(m.group(2)) + m.group(3), text)
        return text
    for i, msg in enumerate(messages):
        if i >= len(messages) - keep_recent: break
        c = msg['content']
        if isinstance(c, str): msg['content'] = _trunc(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict): continue
                t = b.get('type')
                if t == 'text' and isinstance(b.get('text'), str): b['text'] = _trunc(b['text'])
                elif t == 'tool_result':
                    tc = b.get('content')
                    if isinstance(tc, str): b['content'] = _trunc_str(tc)
                    elif isinstance(tc, list):
                        for sub in tc:
                            if isinstance(sub, dict) and sub.get('type') == 'text': sub['text'] = _trunc_str(sub.get('text'))
                elif t == 'tool_use' and isinstance(b.get('input'), dict):
                    for k, v in b['input'].items(): b['input'][k] = _trunc_str(v)
    print(f"[Cut] {_before} -> {sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)}")
    return messages

def _microcompact_text(text, max_len):
    if not isinstance(text, str) or len(text) <= max_len:
        return text
    marker = f"\n...[Microcompact] {len(text) - max_len} chars omitted...\n"
    if max_len <= len(marker) + 20:
        return text[:max(0, max_len - len(marker))] + marker
    head = max(1, (max_len - len(marker)) // 2)
    tail = max(1, max_len - len(marker) - head)
    return text[:head] + marker + text[-tail:]

def microcompact_history_text(messages, keep_recent=2, max_len=240):
    """Shrink older ordinary text blocks before dropping whole messages."""
    if not messages:
        return messages
    _before = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
    cutoff = max(0, len(messages) - keep_recent)
    for msg in messages[:cutoff]:
        content = msg.get('content')
        if isinstance(content, str):
            msg['content'] = _microcompact_text(content, max_len)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'text':
                    text = block.get('text')
                    if isinstance(text, str) and '<earlier_context>' not in text:
                        block['text'] = _microcompact_text(text, max_len)
    after = sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
    if after < _before:
        print(f"[Microcompact] {_before} -> {after}")
    return messages


OLD_TOOL_RESULT_CLEARED = "[Old tool result content cleared]"


def _tool_result_blocks(messages):
    blocks = []
    for msg in messages:
        content = msg.get('content')
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_result':
                    blocks.append(block)
        tool_results = msg.get('tool_results')
        if isinstance(tool_results, list):
            for block in tool_results:
                if isinstance(block, dict):
                    blocks.append(block)
    return blocks


def clear_cold_tool_results(messages, sess, now=None):
    last_response_ts = getattr(sess, '_last_response_ts', None)
    if not last_response_ts:
        return False
    cold_seconds = float(getattr(sess, 'prompt_cache_cold_seconds', 300))
    now = time.time() if now is None else float(now)
    if now - float(last_response_ts) < cold_seconds:
        return False
    keep_recent = max(0, int(getattr(sess, 'cold_tool_result_keep_recent', 2)))
    blocks = _tool_result_blocks(messages)
    if keep_recent:
        blocks = blocks[:-keep_recent]
    changed = False
    for block in blocks:
        if block.get('content') != OLD_TOOL_RESULT_CLEARED:
            block['content'] = OLD_TOOL_RESULT_CLEARED
            changed = True
    if changed:
        print(f"[ColdCompact] Cleared old tool_result content, kept recent {keep_recent}.")
    return changed

def _sanitize_leading_user_msg(msg):
    """把 user 消息里的 tool_result 块改写成纯文本，避免孤立引用。
    history 统一使用 content-block 格式：content 是 list of blocks。"""
    msg = dict(msg)  # 浅拷贝外层 dict
    content = msg.get('content')
    if not isinstance(content, list): return msg
    texts = []
    for block in content:
        if not isinstance(block, dict): continue
        if block.get('type') == 'tool_result':
            c = block.get('content', '')
            if isinstance(c, list):  # content 本身也可能是 list[{type:text,text:...}]
                texts.extend(b.get('text', '') for b in c if isinstance(b, dict))
            else: texts.append(str(c))
        elif block.get('type') == 'text': texts.append(block.get('text', ''))
    msg['content'] = [{"type": "text", "text": '\n'.join(t for t in texts if t)}]
    return msg

def _message_text(msg, max_chars=180):
    content = (msg or {}).get('content')
    texts = []
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
    for block in blocks:
        if not isinstance(block, dict): continue
        if block.get('type') == 'text':
            texts.append(str(block.get('text', '')))
        elif block.get('type') == 'tool_result':
            texts.append(str(block.get('content', '')))
        elif block.get('type') == 'tool_use':
            texts.append(json.dumps({"tool": block.get("name"), "input": block.get("input")}, ensure_ascii=False))
    text = re.sub(r'\s+', ' ', ' '.join(t for t in texts if t)).strip()
    return text[:max_chars] + ('...' if len(text) > max_chars else '')

def _make_stale_snip(removed_messages, max_chars=900):
    if not removed_messages:
        return None
    lines = [f"<earlier_context>{len(removed_messages)} earlier messages were removed during context trimming."]
    for i, msg in enumerate(removed_messages[:6], 1):
        role = msg.get('role', 'unknown')
        text = _message_text(msg)
        if text:
            lines.append(f"{i}. {role}: {text}")
    if len(removed_messages) > 6:
        lines.append(f"... {len(removed_messages) - 6} more removed messages omitted.")
    lines.append("</earlier_context>")
    text = "\n".join(lines)
    if len(text) > max_chars:
        suffix = "\n...[stale snip truncated]\n</earlier_context>"
        text = text[: max(0, max_chars - len(suffix))].rstrip() + suffix
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _compact_safe_messages(messages):
    safe = []
    image_types = {"image", "image_url", "input_image"}
    for msg in messages:
        content = msg.get("content", [])
        blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
        safe_blocks = []
        for block in blocks:
            if not isinstance(block, dict):
                safe_blocks.append({"type": "text", "text": str(block)})
                continue
            if block.get("type") in image_types:
                safe_blocks.append({"type": "text", "text": "[image]"})
            else:
                safe_blocks.append(json.loads(json.dumps(block, ensure_ascii=False)))
        safe.append({"role": msg.get("role", "user"), "content": safe_blocks})
    return safe


_SUMMARY_TOOL_RESULT_MAX_CHARS = 2000


def _content_blocks_for_summary(content):
    return content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]


def _text_from_summary_blocks(blocks):
    parts = []
    for block in blocks:
        if not isinstance(block, dict):
            parts.append(str(block))
            continue
        if block.get("type") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("type") == "tool_result":
            content = block.get("content", "")
            if isinstance(content, list):
                parts.extend(
                    str(item.get("text", ""))
                    for item in content
                    if isinstance(item, dict) and item.get("type") == "text"
                )
            else:
                parts.append(str(content))
        elif block.get("type") in _IMAGE_BLOCK_TYPES:
            parts.append("[image]")
    return "\n".join(part for part in parts if part)


def _truncate_for_summary(text, max_chars=_SUMMARY_TOOL_RESULT_MAX_CHARS):
    text = str(text or "")
    if len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return text[:max_chars].rstrip() + f"\n\n[... {omitted} more characters truncated]"


def _serialize_messages_for_summary(messages):
    safe_messages = _compact_safe_messages(messages)
    parts = []
    for msg in safe_messages:
        role = str(msg.get("role") or "user")
        blocks = _content_blocks_for_summary(msg.get("content"))
        if role == "user":
            tool_results = []
            ordinary = []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_results.append(_truncate_for_summary(_text_from_summary_blocks([block])))
                else:
                    ordinary.append(block)
            user_text = _text_from_summary_blocks(ordinary)
            if user_text:
                parts.append(f"[User]: {user_text}")
            for result in tool_results:
                if result:
                    parts.append(f"[Tool result]: {result}")
            for result in msg.get("tool_results") or []:
                if isinstance(result, dict):
                    parts.append(f"[Tool result]: {_truncate_for_summary(result.get('content', ''))}")
        elif role == "assistant":
            assistant_text = []
            tool_calls = []
            for block in blocks:
                if not isinstance(block, dict):
                    assistant_text.append(str(block))
                    continue
                block_type = block.get("type")
                if block_type == "text":
                    assistant_text.append(str(block.get("text", "")))
                elif block_type in ("thinking", "think"):
                    thinking = block.get("thinking", block.get("text", ""))
                    if thinking:
                        parts.append(f"[Assistant thinking]: {thinking}")
                elif block_type in ("tool_use", "tool_call"):
                    name = block.get("name", "")
                    args = block.get("input", block.get("arguments", {}))
                    tool_calls.append(f"{name}({json.dumps(args, ensure_ascii=False, separators=(',', ':'))})")
            text = "\n".join(part for part in assistant_text if part)
            if text:
                parts.append(f"[Assistant]: {text}")
            if tool_calls:
                parts.append(f"[Assistant tool calls]: {'; '.join(tool_calls)}")
        else:
            text = _text_from_summary_blocks(blocks)
            if text:
                parts.append(f"[{role}]: {text}")
    return "\n\n".join(parts)


def _build_compact_summary_prompt(messages, previous_summary=None, prompt_kind="history"):
    conversation = _serialize_messages_for_summary(messages)
    previous_summary = str(previous_summary or "").strip()
    if prompt_kind == "turn_prefix":
        instructions = (
            "上面的内容是一轮对话中被压缩掉的前缀，后缀会原样保留。"
            "请只总结理解后缀所需的上下文。\n\n"
            "必须覆盖这些小节：\n"
            "1. 原始请求\n"
            "2. 前缀阶段已完成的关键进展\n"
            "3. 理解后缀所需的上下文\n"
            "4. 仍需注意的风险或待办\n\n"
            "保持简洁，保留精确文件路径、函数名和错误信息。"
        )
    elif previous_summary:
        instructions = (
            "上面的内容是上次压缩后新增的对话片段，下面的 <previous-summary> 是既有结构化摘要。"
            "请把新增信息合并进既有摘要。\n\n"
            "规则：\n"
            "- 保留 previous-summary 中仍然有效的事实、约束、决策和待办\n"
            "- 添加新增进展、错误、修复、文件路径和验证结果\n"
            "- 已完成事项从待办移动到进展，不再相关的内容可以删除\n"
            "- 不要编造，不要回答对话里的问题，只输出更新后的摘要\n\n"
            "必须覆盖这些小节：\n"
            "1. 用户主要意图与明确要求\n"
            "2. 关键技术概念\n"
            "3. 涉及的文件与代码片段\n"
            "4. 错误与修复\n"
            "5. 所有用户消息列表\n"
            "6. 待办事项\n"
            "7. 当前正在做的工作\n"
            "8. 下一步\n"
            "9. 验证状态与残余风险"
        )
    else:
        instructions = (
            "请把上面的对话历史压缩为可继续执行任务的结构化摘要。"
            "保留事实，不要编造，不要遗漏明确用户要求。\n\n"
            "必须覆盖这些小节：\n"
            "1. 用户主要意图与明确要求\n"
            "2. 关键技术概念\n"
            "3. 涉及的文件与代码片段\n"
            "4. 错误与修复\n"
            "5. 所有用户消息列表\n"
            "6. 待办事项\n"
            "7. 当前正在做的工作\n"
            "8. 下一步\n"
            "9. 验证状态与残余风险"
        )
    prompt = f"<conversation>\n{conversation}\n</conversation>\n\n"
    if previous_summary:
        prompt += f"<previous-summary>\n{previous_summary}\n</previous-summary>\n\n"
    return prompt + instructions


def _is_context_length_error(text):
    lower = str(text or "").lower()
    return any(
        marker in lower
        for marker in (
            "context_length_exceeded",
            "context length",
            "maximum context",
            "prompt too long",
            "request too large",
            "payload too large",
            "too many tokens",
        )
    )


def _drop_oldest_api_round(messages):
    messages = list(messages or [])
    if len(messages) <= 1:
        return messages
    trimmed = messages[1:]
    while len(trimmed) > 1 and trimmed[0].get("role") != "user":
        trimmed = trimmed[1:]
    while len(trimmed) > 1 and _is_tool_result_user_message(trimmed[0]):
        trimmed = trimmed[1:]
        while len(trimmed) > 1 and trimmed[0].get("role") != "user":
            trimmed = trimmed[1:]
    return trimmed or messages[-1:]


def _recent_messages_at_api_boundary(history, keep_recent):
    start = max(0, len(history) - keep_recent)
    recent = list(history[start:])
    while recent and recent[0].get("role") != "user":
        start += 1
        recent = recent[1:]
    while recent and _is_tool_result_user_message(recent[0]):
        start += 1
        recent = recent[1:]
        while recent and recent[0].get("role") != "user":
            start += 1
            recent = recent[1:]
    kept_from_turn_id = start + 1 if recent else len(history) + 1
    return recent, kept_from_turn_id


def _compact_summary_text(summary_content):
    blocks = summary_content if isinstance(summary_content, list) else [{"type": "text", "text": str(summary_content or "")}]
    return "\n".join(
        str(block.get("text", ""))
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()


def _compact_prefix_info(history):
    if not history:
        return "", 0
    previous_summary = ""
    index = 0
    if history[0].get("is_compact_boundary"):
        index = 1
        if index < len(history) and history[index].get("is_compact_summary"):
            previous_summary = _compact_summary_text(history[index].get("content"))
            index += 1
        while index < len(history) and (
            history[index].get("is_file_reinjection")
            or history[index].get("is_hook_context")
        ):
            index += 1
    elif history[0].get("is_compact_summary"):
        previous_summary = _compact_summary_text(history[0].get("content"))
        index = 1
    return previous_summary, index


def _is_tool_result_user_message(msg):
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False
    content = msg.get("content")
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content or "")}]
    return any(isinstance(block, dict) and block.get("type") == "tool_result" for block in blocks)


def _is_regular_user_message(msg):
    return isinstance(msg, dict) and msg.get("role") == "user" and not _is_tool_result_user_message(msg)


def _is_cut_point_message(msg):
    if not isinstance(msg, dict):
        return False
    if msg.get("role") == "assistant":
        return True
    return _is_regular_user_message(msg)


def _is_turn_start_message(msg):
    return _is_regular_user_message(msg)


def _find_turn_start_index(history, entry_index, start_index):
    for i in range(entry_index, start_index - 1, -1):
        if _is_turn_start_message(history[i]):
            return i
    return -1


def _find_valid_cut_points(history, start_index, end_index):
    return [
        i
        for i in range(start_index, end_index)
        if _is_cut_point_message(history[i])
    ]


def _find_compact_cut_point(history, start_index, end_index, keep_recent_tokens):
    cut_points = _find_valid_cut_points(history, start_index, end_index)
    if not cut_points:
        return {
            "first_kept_index": start_index,
            "turn_start_index": -1,
            "is_split_turn": False,
        }
    accumulated = 0
    cut_index = cut_points[0]
    for i in range(end_index - 1, start_index - 1, -1):
        message_tokens = _history_token_estimate([history[i]])
        if message_tokens <= 0:
            continue
        accumulated += message_tokens
        if accumulated >= keep_recent_tokens:
            chosen = None
            for candidate in cut_points:
                if candidate >= i:
                    chosen = candidate
                    break
            if chosen is None:
                for candidate in reversed(cut_points):
                    if candidate < i:
                        chosen = candidate
                        break
            cut_index = chosen if chosen is not None else cut_index
            break
    while cut_index > start_index:
        prev = history[cut_index - 1]
        if prev.get("is_compact_boundary") or _is_cut_point_message(prev) or _is_tool_result_user_message(prev):
            break
        cut_index -= 1
    starts_turn = _is_turn_start_message(history[cut_index])
    turn_start_index = -1 if starts_turn else _find_turn_start_index(history, cut_index, start_index)
    return {
        "first_kept_index": cut_index,
        "turn_start_index": turn_start_index,
        "is_split_turn": bool(not starts_turn and turn_start_index != -1),
    }


def _normalize_summary_content(summary):
    if not summary:
        return None
    if isinstance(summary, str):
        text = summary.strip()
        return [{"type": "text", "text": text}] if text else None
    if isinstance(summary, list):
        blocks = [
            {"type": "text", "text": str(b.get("text", ""))}
            for b in summary
            if isinstance(b, dict) and b.get("type") == "text" and str(b.get("text", "")).strip()
        ]
        return blocks or None
    return [{"type": "text", "text": str(summary)}]


def _summary_fn_accepts(summary_fn, name):
    try:
        sig = inspect.signature(summary_fn)
    except (TypeError, ValueError):
        return False
    return (
        name in sig.parameters
        or any(param.kind == inspect.Parameter.VAR_KEYWORD for param in sig.parameters.values())
    )


def _call_compact_history_summary(sess, messages, previous_summary=None, prompt_kind="history"):
    summary_fn = getattr(sess, "compact_history_summary", None)
    if not callable(summary_fn):
        return None
    kwargs = {}
    if _summary_fn_accepts(summary_fn, "previous_summary"):
        kwargs["previous_summary"] = previous_summary
    if _summary_fn_accepts(summary_fn, "prompt_kind"):
        kwargs["prompt_kind"] = prompt_kind
    return summary_fn(messages, **kwargs)


def _extract_file_operation_tags(summary_text):
    read_files, modified_files = set(), set()
    for tag, target in (("read-files", read_files), ("modified-files", modified_files)):
        for match in re.finditer(rf"<{tag}>\s*([\s\S]*?)\s*</{tag}>", summary_text or "", re.IGNORECASE):
            for line in match.group(1).splitlines():
                path = line.strip()
                if path:
                    target.add(path)
    return read_files, modified_files


def _strip_file_operation_tags(summary_text):
    text = re.sub(r"\n*<read-files>\s*[\s\S]*?\s*</read-files>\n*", "\n", summary_text or "", flags=re.IGNORECASE)
    text = re.sub(r"\n*<modified-files>\s*[\s\S]*?\s*</modified-files>\n*", "\n", text, flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _assistant_tool_blocks(message):
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return []
    blocks = _content_blocks_for_summary(message.get("content"))
    return [
        block for block in blocks
        if isinstance(block, dict) and block.get("type") in ("tool_use", "tool_call")
    ]


def _extract_file_operations_from_messages(messages, previous_summary=None):
    read_files, modified_files = _extract_file_operation_tags(previous_summary or "")
    for msg in messages:
        for block in _assistant_tool_blocks(msg):
            args = block.get("input", block.get("arguments", {}))
            if not isinstance(args, dict):
                continue
            path = args.get("path")
            if not isinstance(path, str) or not path.strip():
                continue
            tool_name = str(block.get("name") or "")
            if tool_name == "file_read":
                read_files.add(path)
            elif tool_name in ("file_write", "file_patch"):
                modified_files.add(path)
    read_only = sorted(path for path in read_files if path not in modified_files)
    modified = sorted(modified_files)
    return read_only, modified


def _format_file_operations(read_files, modified_files):
    sections = []
    if read_files:
        sections.append("<read-files>\n" + "\n".join(read_files) + "\n</read-files>")
    if modified_files:
        sections.append("<modified-files>\n" + "\n".join(modified_files) + "\n</modified-files>")
    return "\n\n".join(sections)


def _append_file_operations_to_summary(summary_content, read_files, modified_files):
    summary_text = _strip_file_operation_tags(_compact_summary_text(summary_content))
    file_section = _format_file_operations(read_files, modified_files)
    if file_section:
        summary_text = (summary_text.rstrip() + "\n\n" + file_section).strip()
    return [{"type": "text", "text": summary_text}] if summary_text else summary_content


def _file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_file_signature_matches(path, remembered):
    if not os.path.isfile(path):
        return False
    if not isinstance(remembered, tuple) or len(remembered) < 3 or not remembered[2]:
        return False
    try:
        stat = os.stat(path)
    except OSError:
        return False
    if (stat.st_mtime_ns, stat.st_size) != remembered[:2]:
        return False
    if _file_digest(path) != remembered[2]:
        return False
    return True


def _estimate_text_tokens(text):
    return max(1, len(str(text)) // 4)


_IMAGE_BLOCK_TYPES = {"image", "image_url", "input_image"}
_IMAGE_TOKEN_ESTIMATE = 2000


def _json_token_estimate(value):
    return max(1, len(json.dumps(value, ensure_ascii=False)) // 2)


def _normalize_images_for_token_estimate(value):
    if isinstance(value, dict):
        if value.get("type") in _IMAGE_BLOCK_TYPES:
            return {"type": value.get("type"), "text": "[image]"}, 1
        normalized = {}
        image_count = 0
        for key, item in value.items():
            normalized_item, nested_count = _normalize_images_for_token_estimate(item)
            normalized[key] = normalized_item
            image_count += nested_count
        return normalized, image_count
    if isinstance(value, list):
        normalized_items = []
        image_count = 0
        for item in value:
            normalized_item, nested_count = _normalize_images_for_token_estimate(item)
            normalized_items.append(normalized_item)
            image_count += nested_count
        return normalized_items, image_count
    return value, 0


def _markdown_code_fence_for(text):
    longest = max((len(match) for match in re.findall(r"`+", text or "")), default=0)
    return "`" * max(3, longest + 1)


def _build_recent_file_reinjection(sess):
    state = getattr(sess, "compact_read_file_state", None) or getattr(sess, "_read_file_state", None) or {}
    if not isinstance(state, dict) or not state:
        return None
    max_files = max(0, int(getattr(sess, "compact_reinject_max_files", 5)))
    if max_files <= 0:
        return None
    total_budget = max(0, int(getattr(sess, "compact_reinject_total_tokens", 50000)))
    per_file_budget = max(1, int(getattr(sess, "compact_reinject_file_tokens", 5000)))
    remaining = total_budget
    selected_sections = []
    for raw_path, remembered in reversed(list(state.items())):
        if len(selected_sections) >= max_files:
            break
        if remaining <= 0:
            break
        path = os.path.abspath(str(raw_path))
        if not _read_file_signature_matches(path, remembered):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        file_budget = min(per_file_budget, remaining)
        max_chars = max(200, file_budget * 3)
        omitted = len(text) - max_chars
        if omitted > 0:
            text = text[:max_chars].rstrip() + f"\n...[{omitted} chars omitted from reinjected file]..."
        text = text.replace("<system-reminder>", "&lt;system-reminder&gt;")
        text = text.replace("</system-reminder>", "&lt;/system-reminder&gt;")
        used = _estimate_text_tokens(text)
        remaining -= used
        safe_path = path.replace("<system-reminder>", "&lt;system-reminder&gt;")
        safe_path = safe_path.replace("</system-reminder>", "&lt;/system-reminder&gt;")
        fence = _markdown_code_fence_for(text)
        selected_sections.append(
            f"### {safe_path}\n"
            f"{fence}text\n{text}\n{fence}"
        )
    sections = list(reversed(selected_sections))
    if not sections:
        return None
    text = (
        "<system-reminder>\n"
        "Recent files that were read before compaction are re-injected here so the next step can continue without rereading.\n\n"
        + "\n\n".join(sections)
        + "\n</system-reminder>"
    )
    return {"role": "user", "content": [{"type": "text", "text": text}], "is_file_reinjection": True}


def _clear_compact_read_call_state(sess):
    state = getattr(sess, "compact_read_call_state", None)
    if isinstance(state, dict):
        state.clear()


def _clear_compact_read_file_state(sess):
    for attr in ("compact_read_file_state", "_read_file_state"):
        state = getattr(sess, attr, None)
        if isinstance(state, dict):
            state.clear()


def _build_compact_boundary_message():
    text = (
        "<system-reminder>\n"
        "compact boundary: use the next compact summary for earlier conversation history.\n"
        "</system-reminder>"
    )
    return {
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "is_compact_boundary": True,
    }


def _build_compact_hook_context_message(additional_context):
    text = str(additional_context or "").strip()
    if not text:
        return None
    open_tag = "<system-reminder>"
    close_tag = "</system-reminder>"
    if text.startswith(open_tag):
        text = text[len(open_tag):].lstrip()
        if close_tag in text:
            before, after = text.split(close_tag, 1)
            text = "\n".join(part.strip() for part in (before, after) if part.strip())
    text = text.replace(open_tag, "&lt;system-reminder&gt;")
    text = text.replace(close_tag, "&lt;/system-reminder&gt;")
    text = f"<system-reminder>\n{text}\n</system-reminder>"
    return {
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "is_hook_context": True,
    }


def _precompact_messages(history, sess, cap, cost):
    messages = _compact_safe_messages(history)
    ctx = {
        "self": sess,
        "messages": messages,
        "estimated_tokens": cost(),
        "cap": cap,
        "history_len": len(history),
    }
    try:
        hook_ctx = _hook("precompact", ctx) or {}
    except HookBlocked as e:
        print(f"[hooks] PreCompact blocked summary compaction: {getattr(e, 'message', str(e))}")
        return None
    if isinstance(hook_ctx, dict):
        patched_messages = hook_ctx.get("messages")
        if isinstance(patched_messages, list) and all(isinstance(m, dict) for m in patched_messages):
            messages = patched_messages
        hook_message = _build_compact_hook_context_message(hook_ctx.get("additional_context"))
        if hook_message:
            messages = list(messages) + [hook_message]
    return messages


def _compact_keep_recent_token_budget(sess, current_cost, force=False):
    raw_budget = getattr(sess, "compact_keep_recent_tokens", None)
    if raw_budget is None:
        return None
    try:
        budget = max(1, int(raw_budget))
    except (TypeError, ValueError):
        return None
    if force:
        budget = min(budget, max(1, int(current_cost * 0.35)))
    return budget


def _prepare_summary_compaction(history, sess, cap, cost, force=False):
    previous_summary, boundary_start = _compact_prefix_info(history)
    if len(history) <= boundary_start + 1:
        return None
    token_budget = _compact_keep_recent_token_budget(sess, cost(), force=force)
    if token_budget is None:
        keep_recent = max(1, int(getattr(sess, "compact_summary_keep_recent", 6)))
        recent_messages, kept_from_turn_id = _recent_messages_at_api_boundary(history[boundary_start:], keep_recent)
        first_kept_index = boundary_start + (kept_from_turn_id - 1 if recent_messages else len(history) - boundary_start)
        turn_start_index = -1
        is_split_turn = False
    else:
        cut = _find_compact_cut_point(history, boundary_start, len(history), token_budget)
        first_kept_index = cut["first_kept_index"]
        turn_start_index = cut["turn_start_index"]
        is_split_turn = cut["is_split_turn"]
    history_end = turn_start_index if is_split_turn else first_kept_index
    messages_to_summarize = history[boundary_start:history_end]
    turn_prefix_messages = history[turn_start_index:first_kept_index] if is_split_turn else []
    if not messages_to_summarize and not turn_prefix_messages:
        return None
    return {
        "previous_summary": previous_summary,
        "first_kept_index": first_kept_index,
        "kept_from_turn_id": first_kept_index + 1,
        "messages_to_summarize": messages_to_summarize,
        "turn_prefix_messages": turn_prefix_messages,
        "is_split_turn": is_split_turn,
        "file_source_messages": messages_to_summarize + turn_prefix_messages,
    }


def _next_session_log_turn_id(log_path):
    turn_id = 0
    for record in read_recoverable_session_records(session_log_sidecar_path(log_path)):
        turn_id = max(turn_id, int(record.get("turn_id") or 0))
    return turn_id + 1


def _session_id_from_log_path(log_path):
    return session_log_sidecar_path(log_path).stem


def _last_session_record_uuid(log_path):
    last_uuid = ""
    for record in read_recoverable_session_records(session_log_sidecar_path(log_path)):
        record_uuid = str(record.get("uuid") or "")
        if record_uuid:
            last_uuid = record_uuid
    return last_uuid


def _session_record_uuid_at_or_after_turn(log_path, turn_id):
    try:
        target_turn_id = int(turn_id)
    except (TypeError, ValueError):
        return ""
    for record in read_recoverable_session_records(session_log_sidecar_path(log_path)):
        if (record.get("type") or "message") != "message":
            continue
        record_uuid = str(record.get("uuid") or "")
        if record_uuid and int(record.get("turn_id") or 0) >= target_turn_id:
            return record_uuid
    return ""


def _append_compact_boundary_log(sess, summary_content, kept_from_turn_id):
    log_path = getattr(sess, 'log_path', None)
    if not log_path:
        return
    try:
        boundary_uuid = str(uuid.uuid4())
        append_session_event(
            session_log_sidecar_path(log_path),
            SessionCompactBoundary(
                session_id=_session_id_from_log_path(log_path),
                turn_id=_next_session_log_turn_id(log_path),
                summary_content=list(summary_content or []),
                kept_from_turn_id=int(kept_from_turn_id),
                source="trim_messages_history",
                ts=time.time(),
                uuid=boundary_uuid,
                parent_uuid=_last_session_record_uuid(log_path),
                summary_uuid=boundary_uuid,
                kept_from_uuid=_session_record_uuid_at_or_after_turn(log_path, kept_from_turn_id),
            ),
        )
    except Exception as e:
        print(f"[WARN] Failed to write compact boundary log: {e}")


def _mark_prefix_rewrite(sess):
    try:
        sess._prefix_rewrite_version = int(getattr(sess, "_prefix_rewrite_version", 0) or 0) + 1
    except Exception:
        pass


def _try_summary_compact_history(history, sess, cap, cost, force=False):
    if getattr(sess, "_compact_summary_failures", 0) >= 3:
        return False
    if not callable(getattr(sess, "compact_history_summary", None)):
        return False
    plan = _prepare_summary_compaction(history, sess, cap, cost, force=force)
    if not plan:
        return False
    compact_messages = _precompact_messages(plan["messages_to_summarize"], sess, cap, cost)
    if compact_messages is None:
        return False
    try:
        summary_content = _normalize_summary_content(_call_compact_history_summary(
            sess,
            compact_messages,
            previous_summary=plan["previous_summary"],
            prompt_kind="history",
        ))
        if not summary_content:
            raise ValueError("empty compact summary")
        if plan["is_split_turn"] and plan["turn_prefix_messages"]:
            turn_prefix_messages = _precompact_messages(plan["turn_prefix_messages"], sess, cap, cost)
            if turn_prefix_messages is None:
                raise ValueError("empty turn prefix compact input")
            turn_prefix_content = _normalize_summary_content(_call_compact_history_summary(
                sess,
                turn_prefix_messages,
                previous_summary=None,
                prompt_kind="turn_prefix",
            ))
            if not turn_prefix_content:
                raise ValueError("empty turn prefix compact summary")
            summary_text = _compact_summary_text(summary_content)
            turn_prefix_text = _compact_summary_text(turn_prefix_content)
            merged_text = (
                f"{summary_text}\n\n---\n\n"
                "**Turn Context (split turn):**\n\n"
                f"{turn_prefix_text}"
            ).strip()
            summary_content = [{"type": "text", "text": merged_text}]
    except Exception as e:
        sess._compact_summary_failures = getattr(sess, "_compact_summary_failures", 0) + 1
        print(f"[WARN] Summary compaction failed ({sess._compact_summary_failures}/3): {e}")
        return False
    read_files, modified_files = _extract_file_operations_from_messages(
        plan["file_source_messages"],
        previous_summary=plan["previous_summary"],
    )
    summary_content = _append_file_operations_to_summary(summary_content, read_files, modified_files)
    previous = list(history)
    summary_message = {
        "role": "user",
        "content": summary_content,
        "is_compact_summary": True,
    }
    compact_prefix = [_build_compact_boundary_message(), summary_message]
    file_reinjection = _build_recent_file_reinjection(sess)
    recent_messages = history[plan["first_kept_index"]:]
    history[:] = compact_prefix + ([file_reinjection] if file_reinjection else []) + recent_messages
    file_reinjection_kept = bool(file_reinjection)
    if file_reinjection and cost() > cap:
        history[:] = compact_prefix + recent_messages
        file_reinjection_kept = False
    if cost() > cap:
        history[:] = previous
        sess._compact_summary_failures = getattr(sess, "_compact_summary_failures", 0) + 1
        print("[WARN] Summary compaction result still exceeds context cap; falling back to trimming.")
        return False
    sess._compact_summary_failures = 0
    _clear_compact_read_call_state(sess)
    if not file_reinjection_kept:
        _clear_compact_read_file_state(sess)
    _append_compact_boundary_log(sess, summary_content, plan["kept_from_turn_id"])
    _mark_prefix_rewrite(sess)
    print(f"[Compact] Summary compaction kept {len(history)} messages.")
    return True

def _context_cap(sess):
    max_out = max(0, int(getattr(sess, 'max_tokens', None) or 4096))
    safety_buffer = max(0, int(getattr(sess, 'compact_safety_buffer_tokens', 13000)))
    reserve_tokens = max(0, int(getattr(sess, 'compact_reserve_tokens', 0) or 0))
    safety_buffer = max(safety_buffer, reserve_tokens)
    return max(sess.context_win // 2, sess.context_win - max_out - safety_buffer)


def _history_token_estimate(messages):
    total = 0
    for message in messages:
        normalized, image_count = _normalize_images_for_token_estimate(message)
        total += _json_token_estimate(normalized) + (image_count * _IMAGE_TOKEN_ESTIMATE)
    return total


def compact_messages_history(history, sess, force=False):
    cap = _context_cap(sess)
    def cost():
        known, klen = getattr(sess, '_usage_tokens', 0), getattr(sess, '_usage_history_len', 0)
        if known and 0 < klen <= len(history):
            return known + _history_token_estimate(history[klen:])
        return _history_token_estimate(history)
    if not force and cost() <= cap:
        return False
    sess._usage_tokens = 0
    effective_cap = max(cap, cost()) if force else cap
    return _try_summary_compact_history(history, sess, effective_cap, cost, force=force)

_oldprint = print
def safeprint(*argv):
    try: _oldprint(*argv)
    except OSError: pass
print = safeprint

def trim_messages_history(history, sess, now=None):
    # cap/target 单位为粗估 token：纯文本按 chars/4，JSON 类消息按 chars/2，图片按固定预算。
    cap = _context_cap(sess)
    target = int(cap * getattr(sess, 'trim_keep_rate', 0.6))
    def cost():
        # 有上次 API usage 时以其为权威基准，仅粗估之后新增的消息
        known, klen = getattr(sess, '_usage_tokens', 0), getattr(sess, '_usage_history_len', 0)
        if known and 0 < klen <= len(history): return known + _history_token_estimate(history[klen:])
        return _history_token_estimate(history)
    print(f'[Debug] Current context: ~{cost()} tokens (cap {cap}), {len(history)} messages.')
    if clear_cold_tool_results(history, sess, now=now):
        sess._usage_tokens = 0
        _mark_prefix_rewrite(sess)
    # 低于 cap 时绝不改写历史：原地修改老消息会使 prompt cache 前缀全部失效
    if cost() <= cap: return
    sess._usage_tokens = 0  # 即将改写历史，usage 基准失效，退回纯粗估
    if _try_summary_compact_history(history, sess, cap, cost):
        return
    tag_keep_recent = int(getattr(sess, 'tag_compress_keep_recent', 20))
    tag_max_len = int(getattr(sess, 'tag_compress_max_len', 3000))
    compress_history_tags(history, keep_recent=tag_keep_recent, max_len=tag_max_len)
    if cost() <= target: return
    micro_len = max(160, min(500, target // max(1, len(history) * 2)))
    microcompact_history_text(history, keep_recent=getattr(sess, 'microcompact_keep_recent', 2), max_len=micro_len)
    if cost() <= target: return
    removed_messages = []
    while len(history) > 9 and cost() > target:
        removed_messages.append(history.pop(0))
        while history and history[0].get('role') != 'user':
            removed_messages.append(history.pop(0))
        while history and _is_tool_result_user_message(history[0]):
            removed_messages.append(history.pop(0))
            while history and history[0].get('role') != 'user':
                removed_messages.append(history.pop(0))
        if history and history[0].get('role') == 'user': history[0] = _sanitize_leading_user_msg(history[0])
    if removed_messages and history:
        snip_budget = max(240, min(900, target // 4))
        stale_snip = _make_stale_snip(removed_messages, max_chars=snip_budget)
        history.insert(0, stale_snip)
        _append_compact_boundary_log(sess, stale_snip.get("content"), len(removed_messages) + 1)
        _mark_prefix_rewrite(sess)
    print(f'[Debug] Trimmed context, current: {cost()} chars, {len(history)} messages.')

def auto_make_url(base, path):
    b, p = base.rstrip('/'), path.strip('/')
    if b.endswith('$'): return b[:-1].rstrip('/')
    if b.endswith(p): return b
    return f"{b}/{p}" if re.search(r'/v\d+(/|$)', b) else f"{b}/v1/{p}"

def _parse_anthropic_json(data):
    content_blocks = data.get("content", [])
    _record_usage(data.get("usage", {}), "messages")
    for b in content_blocks:
        if b.get("type") == "text": yield b.get("text", "")
        elif b.get("type") == "thinking": yield ""
    return content_blocks

def _parse_anthropic_sse(resp_lines):
    """Parse Anthropic SSE stream. Yields text chunks, returns list[content_block]."""
    content_blocks = []; current_block = None; tool_json_buf = ""
    stop_reason = None; got_message_stop = False; warn = None
    for line in resp_lines:
        if not line: continue
        line = line.decode('utf-8') if isinstance(line, bytes) else line
        if not line.startswith("data:"): continue
        data_str = line[5:].lstrip()
        if data_str == "[DONE]": break
        try: evt = json.loads(data_str)
        except Exception as e:
            print(f"[SSE] JSON parse error: {e}, line: {data_str[:200]}")
            continue
        evt_type = evt.get("type", "")
        if evt_type == "message_start":
            usage = evt.get("message", {}).get("usage", {})
            _record_usage(usage, "messages")
        elif evt_type == "content_block_start":
            block = evt.get("content_block", {})
            if block.get("type") == "text": current_block = {"type": "text", "text": ""}
            elif block.get("type") == "thinking": current_block = {"type": "thinking", "thinking": "", "signature": ""}
            elif block.get("type") == "tool_use":
                current_block = {"type": "tool_use", "id": block.get("id", ""), "name": block.get("name", ""), "input": {}}
                tool_json_buf = ""
        elif evt_type == "content_block_delta":
            delta = evt.get("delta", {})
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if current_block and current_block.get("type") == "text": current_block["text"] += text
                if text: yield text
            elif delta.get("type") == "thinking_delta":
                if current_block and current_block.get("type") == "thinking": current_block["thinking"] += delta.get("thinking", "")
            elif delta.get("type") == "signature_delta":
                if current_block and current_block.get("type") == "thinking":
                    current_block["signature"] = current_block.get("signature", "") + delta.get("signature", "")
            elif delta.get("type") == "input_json_delta": tool_json_buf += delta.get("partial_json", "")
        elif evt_type == "content_block_stop":
            if current_block:
                if current_block["type"] == "tool_use":
                    try: current_block["input"] = json.loads(tool_json_buf) if tool_json_buf else {}
                    except Exception: current_block["input"] = {"_raw": tool_json_buf}
                content_blocks.append(current_block)
                current_block = None
        elif evt_type == "message_delta":
            delta = evt.get("delta", {})
            stop_reason = delta.get("stop_reason", stop_reason)
            out_usage = evt.get("usage", {})
            out_tokens = out_usage.get("output_tokens", 0)
            if out_tokens:
                record_usage_totals(out_usage, "messages")
                print(f"[Output] tokens={out_tokens} stop_reason={stop_reason}")
        elif evt_type == "message_stop": got_message_stop = True
        elif evt_type == "error":
            err = evt.get("error", {})
            emsg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            warn = f"\n\n!!!Error: SSE {emsg}"; break
    if not warn:
        if not got_message_stop and not stop_reason: warn = "\n\n[!!! 流异常中断，未收到完整响应 !!!]"
        elif stop_reason == "max_tokens": warn = "\n\n[!!! Response truncated: max_tokens !!!]"
    if current_block:
        if current_block["type"] == "tool_use":
            try: current_block["input"] = json.loads(tool_json_buf) if tool_json_buf else {}
            except Exception: current_block["input"] = {"_raw": tool_json_buf}
        content_blocks.append(current_block); current_block = None
    if warn:
        print(f"[WARN] {warn.strip()}")
        content_blocks.append({"type": "text", "text": warn}); yield warn
    return content_blocks

def _try_parse_tool_args(raw):
    """Parse tool args string; split concatenated JSON objects like {..}{..} if needed.
    Returns list of parsed dicts."""
    if not raw: return [{}]
    try: return [json.loads(raw)]
    except json.JSONDecodeError: pass
    parts = re.split(r'(?<=\})(?=\{)', raw)
    if len(parts) > 1:
        parsed = []
        for p in parts:
            try: parsed.append(json.loads(p))
            except json.JSONDecodeError: return [{"_raw": raw}]
        return parsed
    return [{"_raw": raw}]

def _parse_openai_sse(resp_lines, api_mode="chat_completions"):
    """Parse OpenAI SSE stream (chat_completions or responses API).
    Yields text chunks, returns list[content_block].
    content_block: {type:'text', text:str} | {type:'tool_use', id:str, name:str, input:dict}
    """
    content_text = ""
    if api_mode == "responses":
        seen_delta = False; fc_buf = {}; current_fc_idx = None
        for line in resp_lines:
            if not line: continue
            line = line.decode('utf-8', errors='replace') if isinstance(line, bytes) else line
            if not line.startswith("data:"): continue
            data_str = line[5:].lstrip()
            if data_str == "[DONE]": break
            try: evt = json.loads(data_str)
            except Exception: continue
            etype = evt.get("type", "")
            if etype == "response.output_text.delta":
                delta = evt.get("delta", "")
                if delta: seen_delta = True; content_text += delta; yield delta
            elif etype == "response.output_text.done" and not seen_delta:
                text = evt.get("text", "")
                if text: content_text += text; yield text
            elif etype == "response.output_item.added":
                item = evt.get("item", {})
                if item.get("type") == "function_call":
                    idx = evt.get("output_index", 0)
                    fc_buf[idx] = {"id": item.get("call_id", item.get("id", "")), "name": item.get("name", ""), "args": ""}
                    current_fc_idx = idx
            elif etype == "response.function_call_arguments.delta":
                idx = evt.get("output_index", current_fc_idx or 0)
                if idx in fc_buf: fc_buf[idx]["args"] += evt.get("delta", "")
            elif etype == "response.function_call_arguments.done":
                idx = evt.get("output_index", current_fc_idx or 0)
                if idx in fc_buf: fc_buf[idx]["args"] = evt.get("arguments", fc_buf[idx]["args"])
            elif etype == "error":
                err = evt.get("error", {})
                emsg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                if emsg: content_text += f"!!!Error: {emsg}"; yield f"!!!Error: {emsg}"
                break
            elif etype == "response.completed":
                usage = evt.get("response", {}).get("usage", {})
                _record_usage(usage, api_mode)
                break
        blocks = []
        if content_text: blocks.append({"type": "text", "text": content_text})
        for idx in sorted(fc_buf):
            fc = fc_buf[idx]
            inps = _try_parse_tool_args(fc["args"])
            for i, inp in enumerate(inps):
                bid = fc["id"] or ''
                if len(inps) > 1: bid = f"{bid}_{i}" if bid else f"split_{i}"
                blocks.append({"type": "tool_use", "id": bid, "name": fc["name"], "input": inp})
        return blocks
    else:
        tc_buf = {}  # index -> {id, name, args}
        reasoning_text = ""
        for line in resp_lines:
            if not line: continue
            line = line.decode('utf-8', errors='replace') if isinstance(line, bytes) else line
            if not line.startswith("data:"): continue
            data_str = line[5:].lstrip()
            if data_str == "[DONE]": break
            try: evt = json.loads(data_str)
            except Exception: continue
            ch = (evt.get("choices") or [{}])[0]
            delta = ch.get("delta") or {}
            if delta.get("reasoning_content"):
                reasoning_text += delta["reasoning_content"]
            if delta.get("content"):
                text = delta["content"]; content_text += text; yield text
            for tc in (delta.get("tool_calls") or []):
                idx = tc.get("index", 0)
                has_name = bool(tc.get("function", {}).get("name"))
                if idx not in tc_buf:
                    if has_name or not tc_buf: tc_buf[idx] = {"id": tc.get("id") or '', "name": "", "args": ""}
                    else: idx = max(tc_buf)
                if has_name: tc_buf[idx]["name"] = tc["function"]["name"]
                if tc.get("function", {}).get("arguments"): tc_buf[idx]["args"] += tc["function"]["arguments"]
                if tc.get("id") and not tc_buf[idx]["id"]: tc_buf[idx]["id"] = tc["id"]
            usage = evt.get("usage")
            if usage: _record_usage(usage, api_mode)
        blocks = []
        if reasoning_text: blocks.append({"type": "thinking", "thinking": reasoning_text})
        if content_text: blocks.append({"type": "text", "text": content_text})
        for idx in sorted(tc_buf):
            tc = tc_buf[idx]
            inps = _try_parse_tool_args(tc["args"])
            for i, inp in enumerate(inps):
                bid = tc["id"] or ''
                if len(inps) > 1: bid = f"{bid}_{i}" if bid else f"split_{i}"
                blocks.append({"type": "tool_use", "id": bid, "name": tc["name"], "input": inp})
        return blocks

def _record_usage(usage, api_mode):
    if not usage: return
    before_warnings = int(get_usage_stats().get("cache_break_warnings", 0) or 0)
    delta = normalize_usage_delta(usage, api_mode)
    stats = record_usage_totals(usage, api_mode)
    after_warnings = int(stats.get("cache_break_warnings", 0) or 0)
    if api_mode == 'responses':
        cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
        inp = usage.get("input_tokens", 0); out = usage.get("output_tokens", 0)
        print(f"[Cache] input={inp} cached={cached}")
        if out: print(f"[Output] tokens={out}")
    elif api_mode == 'chat_completions':
        inp = usage.get("prompt_tokens", 0); out = usage.get("completion_tokens", 0)
        print(f"[Cache] input={inp} cached={delta['cache_read_tokens']} fresh={delta['input_tokens']}")
        if out: print(f"[Output] tokens={out}")
    elif api_mode == 'messages':
        ci, cr, inp = usage.get("cache_creation_input_tokens", 0), usage.get("cache_read_input_tokens", 0), usage.get("input_tokens", 0)
        print(f"[Cache] input={inp} creation={ci} read={cr}")
    if after_warnings > before_warnings:
        details = _latest_prefix_change_details()
        suffix = f" cache prefix changed: {details}" if details else " prompt cache prefix may have changed."
        print(f"[CacheBreak] cache_read ratio dropped sharply;{suffix}")
    
def _parse_openai_json(data, api_mode="chat_completions"):
    blocks = []
    if api_mode == "responses":
        _record_usage(data.get("usage") or {}, api_mode)
        for item in (data.get("output") or []):
            if item.get("type") == "message":
                for p in (item.get("content") or []):
                    if p.get("type") in ("output_text", "text") and p.get("text"):
                        blocks.append({"type": "text", "text": p["text"]}); yield p["text"]
            elif item.get("type") == "function_call":
                try: args = json.loads(item.get("arguments", "")) if item.get("arguments") else {}
                except Exception: args = {"_raw": item.get("arguments", "")}
                blocks.append({"type": "tool_use", "id": item.get("call_id", item.get("id", "")),
                               "name": item.get("name", ""), "input": args})
    else:
        _record_usage(data.get("usage") or {}, api_mode)
        msg = (data.get("choices") or [{}])[0].get("message", {})
        reasoning = msg.get("reasoning_content", "")
        if reasoning:
            blocks.append({"type": "thinking", "thinking": reasoning})
        content = msg.get("content", "")
        if content:
            blocks.append({"type": "text", "text": content}); yield content
        for tc in (msg.get("tool_calls") or []):
            fn = tc.get("function", {})
            try: args = json.loads(fn.get("arguments", "")) if fn.get("arguments") else {}
            except Exception: args = {"_raw": fn.get("arguments", "")}
            blocks.append({"type": "tool_use", "id": tc.get("id", ""), "name": fn.get("name", ""), "input": args})
    return blocks

def _stamp_oai_cache_markers(messages, model):
    """Add cache_control to last 2 user messages for Anthropic models via OAI-compatible relay."""
    ml = model.lower()
    if not any(marker in ml for marker in ("anthropic", "claude")): return
    user_idxs = [i for i, m in enumerate(messages) if m.get('role') == 'user']
    for idx in user_idxs[-2:]:
        c = messages[idx].get('content')
        if isinstance(c, str):
            messages[idx] = {**messages[idx], 'content': [{'type': 'text', 'text': c, 'cache_control': {'type': 'ephemeral'}}]}
        elif isinstance(c, list) and c:
            c = list(c); c[-1] = dict(c[-1], cache_control={'type': 'ephemeral'})
            messages[idx] = {**messages[idx], 'content': c}

def _plain_system_prompt(system_text, fallback=None):
    text = str(system_text or "")
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in text:
        return text if text.strip() else fallback
    parts = [part.strip() for part in text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) if part.strip()]
    collapsed = "\n\n".join(parts)
    return collapsed if collapsed else fallback


def _split_system_prompt(system_text, fallback=None):
    text = str(system_text or "")
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in text:
        stable = text.strip()
        return (stable if stable else fallback), ""
    stable, dynamic = text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
    stable = stable.strip()
    dynamic = dynamic.strip()
    return (stable if stable else fallback), dynamic


def _prepend_dynamic_context_to_chat_messages(messages, dynamic_text):
    dynamic_text = str(dynamic_text or "").strip()
    if not dynamic_text:
        return messages
    context_block = {"type": "text", "text": "[System Context]\n" + dynamic_text}
    out = []
    inserted = False
    for message in messages:
        if not inserted and isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content", "")
            if isinstance(content, list):
                content = [context_block, *content]
            else:
                content = [context_block, {"type": "text", "text": str(content)}]
            out.append({**message, "content": content})
            inserted = True
        else:
            out.append(message)
    if inserted:
        return out
    return [{"role": "user", "content": [context_block]}, *out]


def _prepend_dynamic_context_to_responses_input(items, dynamic_text):
    dynamic_text = str(dynamic_text or "").strip()
    if not dynamic_text:
        return items
    context_block = {"type": "input_text", "text": "[System Context]\n" + dynamic_text}
    out = []
    inserted = False
    for item in items:
        if not inserted and isinstance(item, dict) and item.get("role") == "user":
            content = item.get("content")
            if isinstance(content, list):
                out.append({**item, "content": [context_block, *content]})
            else:
                out.append({**item, "content": [context_block]})
            inserted = True
        else:
            out.append(item)
    if inserted:
        return out
    return [{"role": "user", "content": [context_block]}, *out]


_usage_prefix_state = threading.local()


def _capture_session_prefix_shape(sess, system_prompt=None, tools=None):
    current = capture_prefix_shape(
        system_prompt if system_prompt is not None else getattr(sess, "system", ""),
        tools if tools is not None else getattr(sess, "tools", None),
        getattr(sess, "_prefix_rewrite_version", 0),
    )
    previous = getattr(sess, "_prefix_shape", None)
    diagnostics = compare_prefix_shape(previous, current) if previous else compare_prefix_shape({}, current)
    sess._prefix_shape = current
    sess._prefix_diagnostics = diagnostics
    _usage_prefix_state.last_diagnostics = diagnostics
    return diagnostics


def _latest_prefix_change_details():
    diagnostics = getattr(_usage_prefix_state, "last_diagnostics", None) or {}
    reasons = diagnostics.get("prefix_change_reasons") or []
    return "+".join(reasons)


def _oai_prefix_parts(payload):
    if "instructions" in payload:
        return payload.get("instructions") or "", payload.get("tools")
    for message in payload.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "system":
            return message.get("content") or "", payload.get("tools")
    return "", payload.get("tools")

def _retry_delay(resp, attempt, base_delay=1.5, max_delay=30.0, jitter_fn=None):
    try:
        ra = float((resp.headers or {}).get("retry-after")) if resp is not None else None
    except Exception:
        ra = None
    if ra is not None:
        return max(0.5, ra)
    jitter = (jitter_fn or random.random)()
    jitter_factor = 0.8 + float(jitter) * 0.4
    delay = min(float(max_delay), float(base_delay) * (2 ** int(attempt)))
    return round(max(0.5, delay * jitter_factor), 3)

def _effective_max_retries(sess, priority="foreground"):
    max_retries = max(0, int(getattr(sess, "max_retries", 0) or 0))
    if str(priority or "foreground").lower() in {"background", "low"}:
        return 0
    return max_retries


def _stream_with_retry(sess, url, headers, payload, parse_fn, priority="foreground"):
    _RETRYABLE = {408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529}
    max_retries = _effective_max_retries(sess, priority)
    for attempt in range(max_retries + 1):
        streamed = False
        try:
            with requests.post(url, headers=headers, json=payload, stream=sess.stream, 
                               timeout=(sess.connect_timeout, sess.read_timeout), proxies=sess.proxies, verify=sess.verify) as r:
                if r.status_code >= 400:
                    if r.status_code in _RETRYABLE and attempt < max_retries:
                        d = _retry_delay(r, attempt)
                        print(f"[LLM Retry] HTTP {r.status_code}, retry in {d:.1f}s ({attempt+1}/{max_retries+1})")
                        time.sleep(d); continue
                    try: body = r.text.strip()[:500]
                    except Exception: body = ""
                    err = f"!!!Error: HTTP {r.status_code}" + (f": {body}" if body else "")
                    yield err; return [{"type": "text", "text": err}]
                gen = parse_fn(r)
                try:
                    while True: streamed = True; yield next(gen)
                except StopIteration as e:
                    if not e.value and not streamed: raise requests.ConnectionError("empty response")
                    return e.value or []
        except (requests.Timeout, requests.ConnectionError) as e:
            err = f"!!!Error: {type(e).__name__}"
            if attempt < max_retries:
                d = _retry_delay(None, attempt)
                print(f"[LLM Retry] {type(e).__name__}, retry in {d:.1f}s ({attempt+1}/{max_retries+1})")
                yield err; time.sleep(d); continue
            yield err; return [{"type": "text", "text": err}]
        except Exception as e:
            err = f"\n\n[!!! 流异常中断 {type(e).__name__}: {e} !!!]" if streamed else f"!!!Error: {type(e).__name__}: {e}"
            yield err; return [{"type": "text", "text": err}]

def _openai_stream(sess, messages, priority="foreground"):
    model, api_mode = sess.model, sess.api_mode
    ml = model.lower()
    temperature = sess.temperature
    if 'kimi' in ml or 'moonshot' in ml: temperature = 1
    elif 'minimax' in ml: temperature = max(0.01, min(temperature, 1.0))  # MiniMax requires temp in (0, 1]
    headers = {"Authorization": f"Bearer {sess.api_key}", "Content-Type": "application/json", "Accept": "text/event-stream"}
    if api_mode == "responses":
        url = auto_make_url(sess.api_base, "responses")
        stable_system, dynamic_system = _split_system_prompt(sess.system, "You are an Omnipotent Executor.")
        response_input = _prepend_dynamic_context_to_responses_input(_to_responses_input(messages), dynamic_system)
        payload = {"model": model, "input": response_input, "stream": sess.stream,
                   "prompt_cache_key": _RESP_CACHE_KEY,
                   "instructions": stable_system}
        if sess.reasoning_effort: payload["reasoning"] = {"effort": sess.reasoning_effort}
        if sess.max_tokens: payload["max_output_tokens"] = sess.max_tokens
    else:
        url = auto_make_url(sess.api_base, "chat/completions")
        system_prompt, dynamic_system = _split_system_prompt(sess.system)
        messages = _prepend_dynamic_context_to_chat_messages(messages, dynamic_system)
        if system_prompt: messages = [{"role": "system", "content": system_prompt}] + messages
        _stamp_oai_cache_markers(messages, model)
        payload = {"model": model, "messages": messages, "stream": sess.stream}
        if sess.stream: payload["stream_options"] = {"include_usage": True}
        if temperature != 1: payload["temperature"] = temperature
        if sess.max_tokens: payload["max_completion_tokens" if ml.startswith(("gpt-5", "o1", "o2", "o3", "o4")) else "max_tokens"] = sess.max_tokens
        if sess.reasoning_effort: payload["reasoning_effort"] = sess.reasoning_effort
    tools = getattr(sess, 'tools', None)
    if tools: payload["tools"] = _prepare_oai_tools(tools, api_mode)
    prefix_system, prefix_tools = _oai_prefix_parts(payload)
    _capture_session_prefix_shape(sess, prefix_system, prefix_tools)
    if sess.service_tier: payload["service_tier"] = sess.service_tier
    parse_fn = (lambda r: _parse_openai_sse(r.iter_lines(), api_mode)) if sess.stream else (lambda r: _parse_openai_json(r.json(), api_mode))
    return (yield from _stream_with_retry(sess, url, headers, payload, parse_fn, priority=priority))
        
def _prepare_oai_tools(tools, api_mode="chat_completions"):
    if api_mode == "responses":
        resp_tools = []
        for t in tools:
            if t.get("type") == "function" and "function" in t:
                rt = {"type": "function"}; rt.update(t["function"])
                resp_tools.append(rt)
            else: resp_tools.append(t)
        return resp_tools
    return tools

class BaseSession:
    def __init__(self, cfg):
        self.api_key = cfg['apikey']
        self.api_base = cfg['apibase'].rstrip('/')
        self.model = cfg.get('model', '')
        default_context_win = 30000
        ml = self.model.lower()
        if 'deepseek' in ml:
            default_context_win = 70000; self.trim_keep_rate = 0.3
        elif any(k in ml for k in ('claude', 'gpt-4.1', 'gpt-5', 'gemini', 'kimi', 'qwen3', 'glm-4.6', 'grok-4')):
            # 大窗口模型默认 200K token，可在 mykey.py 用 context_win 覆盖
            default_context_win = 200000
        self.context_win = cfg.get('context_win', default_context_win)
        self.history = []; self.lock = threading.Lock(); self.system = ""
        self.name = cfg.get('name', self.model)
        proxy = cfg.get('proxy'); 
        self.proxies = {"http": proxy, "https": proxy} if proxy else None
        self.max_retries = max(0, int(cfg.get('max_retries', 3)))
        self.input_cost_per_1m = cfg.get("input_cost_per_1m", cfg.get("input_price_per_1m"))
        self.output_cost_per_1m = cfg.get("output_cost_per_1m", cfg.get("output_price_per_1m"))
        self.cache_read_cost_per_1m = cfg.get("cache_read_cost_per_1m", cfg.get("cache_read_price_per_1m"))
        self.cache_creation_cost_per_1m = cfg.get("cache_creation_cost_per_1m", cfg.get("cache_creation_price_per_1m"))
        self.verify = cfg.get('verify', True)
        self.stream = cfg.get('stream', True)
        default_ct, default_rt = (5, 30) if self.stream else (10, 240)
        self.connect_timeout = max(1, int(cfg.get('timeout', default_ct)))
        self.read_timeout = max(5, int(cfg.get('read_timeout', default_rt)))
        def _enum(key, valid):
            v = cfg.get(key); v = None if v is None else str(v).strip().lower()
            return v if not v or v in valid else print(f"[WARN] Invalid {key} {v!r}, ignored.")
        self.reasoning_effort = _enum('reasoning_effort', {'none', 'minimal', 'low', 'medium', 'high', 'xhigh'})
        self.service_tier = _enum('service_tier', {'auto', 'default', 'priority', 'flex'})
        self.thinking_type = _enum('thinking_type', {'adaptive', 'enabled', 'disabled'})
        self.thinking_budget_tokens = cfg.get('thinking_budget_tokens')
        mode = str(cfg.get('api_mode', 'chat_completions')).strip().lower().replace('-', '_')
        self.api_mode = 'responses' if mode in ('responses', 'response') else 'chat_completions'
        self.temperature = cfg.get('temperature', 1)
        self.max_tokens = cfg.get('max_tokens')
        self.log_path = None
        self.compact_summary_enabled = cfg.get('compact_summary_enabled', True)
        self.compact_summary_keep_recent = int(cfg.get('compact_summary_keep_recent', 6))
        self.compact_keep_recent_tokens = int(cfg.get('compact_keep_recent_tokens', 20000))
        self.compact_reserve_tokens = int(cfg.get('compact_reserve_tokens', 16384))
    def _apply_anthropic_thinking(self, payload):
        if self.thinking_type:
            thinking = {"type": self.thinking_type}
            if self.thinking_type == 'enabled':
                if self.thinking_budget_tokens is None: print("[WARN] thinking_type='enabled' requires thinking_budget_tokens, ignored.")
                else:
                    thinking["budget_tokens"] = self.thinking_budget_tokens; payload["thinking"] = thinking
            else: payload["thinking"] = thinking
        if self.reasoning_effort:
            effort = {'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'max'}.get(self.reasoning_effort)
            if effort: payload["output_config"] = {"effort": effort}
            else: print(f"[WARN] reasoning_effort {self.reasoning_effort!r} is unsupported for Anthropic output_config.effort, ignored.")
    def compact_history_summary(self, messages, previous_summary=None, prompt_kind="history"):
        if not self.compact_summary_enabled:
            return None
        saved_tools = getattr(self, 'tools', None)
        had_tools = hasattr(self, 'tools')
        saved_suppress = getattr(self, '_suppress_missing_tools_warning', False)
        self._suppress_missing_tools_warning = True
        if had_tools:
            self.tools = None
        try:
            attempts = max(1, int(getattr(self, "compact_summary_prompt_retries", 3)))
            current_messages = list(messages or [])
            for attempt in range(attempts):
                prompt = _build_compact_summary_prompt(
                    current_messages,
                    previous_summary=previous_summary,
                    prompt_kind=prompt_kind,
                )
                chunks = []
                content_blocks = []
                gen = self.raw_ask(
                    [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                    priority="background",
                )
                try:
                    while True:
                        chunk = next(gen)
                        if isinstance(chunk, str):
                            chunks.append(chunk)
                except StopIteration as e:
                    content_blocks = e.value or []
                text = "".join(chunks).strip()
                if not text and content_blocks:
                    text = "\n".join(str(b.get("text", "")) for b in content_blocks if isinstance(b, dict) and b.get("type") == "text").strip()
                if text and not text.startswith(("!!!Error:", "[Error:")):
                    return [{"type": "text", "text": text}]
                if not _is_context_length_error(text) or attempt >= attempts - 1:
                    return None
                next_messages = _drop_oldest_api_round(current_messages)
                if len(next_messages) >= len(current_messages):
                    return None
                current_messages = next_messages
        finally:
            if had_tools:
                self.tools = saved_tools
            self._suppress_missing_tools_warning = saved_suppress
        return None
    def ask(self, prompt):
        def _ask_gen():
            with self.lock:
                self.history.append({"role": "user", "content": [{"type": "text", "text": prompt}]})
                trim_messages_history(self.history, self)
                messages = self.make_messages(self.history)
                content_blocks = None; content = ''
                usage_revision = get_usage_revision()
                gen = self.raw_ask(messages)
                try:
                    while True: chunk = next(gen); content += chunk; yield chunk
                except StopIteration as e: content_blocks = e.value or []
                if len(content_blocks) > 1: print(f"[DEBUG BaseSession.ask] content_blocks: {content_blocks}")
                for block in (content_blocks or []):
                    if block.get('type', '') == 'tool_use':
                        tu = {'name': block.get('name', ''), 'arguments': block.get('input', {})}
                        yield f'<tool_use>{json.dumps(tu, ensure_ascii=False)}</tool_use>'
                if content.strip() and not content.startswith("!!!Error:"): self.history.append({"role": "assistant", "content": [{"type": "text", "text": content}]})
                self._last_response_ts = time.time()
                if get_usage_revision() != usage_revision and (t := get_last_context_tokens()):
                    self._usage_tokens, self._usage_history_len = t, len(self.history)
        return _ask_gen()

def _keep_anthropic_block(b): return not isinstance(b, dict) or b.get("type") != "thinking" or b.get("signature")
def _drop_unsigned_thinking(messages):
    for m in messages:
        c = m.get("content")
        if isinstance(c, list): m["content"] = [b for b in c if _keep_anthropic_block(b)]
    return messages

def _ensure_thinking_blocks(messages, model):
    """deepseek needs thinking in history!"""
    if 'deepseek' not in model.lower(): return messages
    for m in messages:
        if m.get("role") != "assistant": continue
        c = m.get("content")
        if not isinstance(c, list): continue
        has_thinking = any(isinstance(b, dict) and b.get("type") == "thinking" for b in c)
        if not has_thinking: m["content"] = [{"type": "thinking", "thinking": "...", "signature": "placeholder"}, *c]
    return messages


def _append_static_system_section(system_text, section):
    system_text = str(system_text or "")
    section = str(section or "").strip()
    if not section:
        return system_text
    if not system_text.strip():
        return section
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in system_text:
        return f"{system_text.rstrip()}\n\n{section}"
    static_text, dynamic_text = system_text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
    static_text = "\n\n".join(part for part in (static_text.strip(), section) if part)
    return static_text + SYSTEM_PROMPT_DYNAMIC_BOUNDARY + dynamic_text.lstrip()


def _anthropic_system_blocks(system_text, fallback_text=None):
    fallback_text = fallback_text or "You are SecHeur Agent."
    system_text = str(system_text or "")
    if not system_text.strip():
        return [{"type": "text", "text": fallback_text, "cache_control": {"type": "ephemeral"}}]
    if SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in system_text:
        return [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
    static_text, dynamic_text = system_text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 1)
    blocks = []
    if static_text.strip():
        blocks.append({"type": "text", "text": static_text.strip(), "cache_control": {"type": "ephemeral"}})
    if dynamic_text.strip():
        blocks.append({"type": "text", "text": dynamic_text.strip()})
    return blocks or [{"type": "text", "text": fallback_text, "cache_control": {"type": "ephemeral"}}]

class AnthropicTextSession(BaseSession):
    def raw_ask(self, messages, priority="foreground"):
        messages = _fix_messages(messages)
        if self.max_tokens is None: self.max_tokens = 8192
        headers = {"x-api-key": self.api_key, "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31"}
        payload = {"model": self.model, "messages": messages, "max_tokens": self.max_tokens, "stream": self.stream}
        if self.temperature != 1: payload["temperature"] = self.temperature
        self._apply_anthropic_thinking(payload)
        if self.system: payload["system"] = _anthropic_system_blocks(self.system)
        url = auto_make_url(self.api_base, "messages")
        parse_fn = (lambda r: _parse_anthropic_sse(r.iter_lines())) if self.stream else (lambda r: _parse_anthropic_json(r.json()))
        return (yield from _stream_with_retry(self, url, headers, payload, parse_fn, priority=priority))
    def make_messages(self, raw_list):
        msgs = _drop_unsigned_thinking([{"role": m['role'], "content": list(m['content'])} for m in raw_list])
        user_idxs = [i for i, m in enumerate(msgs) if m['role'] == 'user']
        for idx in user_idxs[-2:]:
            msgs[idx]["content"][-1] = dict(msgs[idx]["content"][-1], cache_control={"type": "ephemeral"})
        return msgs

class LLMSession(BaseSession):
    def raw_ask(self, messages, priority="foreground"): return (yield from _openai_stream(self, messages, priority=priority))
    def make_messages(self, raw_list): return _msgs_anthropic2oai(_fix_messages(raw_list))

def _fix_messages(messages):
    if not messages: return messages
    W = lambda c: c if isinstance(c, list) else [{"type": "text", "text": str(c)}]
    merged = []
    for m in messages:
        if m.get('role') not in ('user', 'assistant'): continue
        blocks = W(m.get('content', []))
        if merged and m['role'] == merged[-1]['role']:
            merged[-1]['content'] += [{"type": "text", "text": "\n"}] + blocks
        else:
            merged.append({"role": m['role'], "content": list(blocks)})
    while merged and merged[0]['role'] != 'user': merged.pop(0)
    if not merged: return []
    prev_uses = []
    for m in merged:
        c = m['content']
        if m['role'] == 'assistant':
            seen, out = set(), []
            for b in c:
                uid = b.get('id') if isinstance(b, dict) and b.get('type') == 'tool_use' else None
                if uid and uid in seen: continue
                if uid: seen.add(uid)
                out.append(b)
            m['content'] = out
            prev_uses = [b.get('id') for b in out if isinstance(b, dict) and b.get('type') == 'tool_use']
        else:
            got, rest = {}, []
            for b in c:
                tid = b.get('tool_use_id') if isinstance(b, dict) and b.get('type') == 'tool_result' else None
                if tid and tid in prev_uses and tid not in got: got[tid] = b
                elif isinstance(b, dict) and b.get('type') == 'tool_result': rest.append({"type": "text", "text": str(b.get('content', ''))})
                else: rest.append(b)
            m['content'] = [got.get(u) or {"type": "tool_result", "tool_use_id": u, "content": "(error)"} for u in prev_uses] + rest
            prev_uses = []
    return merged

class NativeAnthropicSession(BaseSession):
    def __init__(self, cfg):
        super().__init__(cfg)
        self.relay_compat_system_prompt = cfg.get("relay_compat_system_prompt", False)
        self.user_agent = cfg.get("user_agent", "SecHeurAgent/1.0")
        self._session_id = str(uuid.uuid4())
        self._account_uuid = str(uuid.uuid4())
        self._device_id = uuid.uuid4().hex + uuid.uuid4().hex[:32]
        self.tools = None
    def raw_ask(self, messages, priority="foreground"):
        if self.max_tokens is None: self.max_tokens = 8192
        model = self.model
        messages = _fix_messages(messages)
        messages = _drop_unsigned_thinking(messages)
        messages = _ensure_thinking_blocks(messages, self.model)
        beta_parts = ["interleaved-thinking-2025-05-14", "redact-thinking-2026-02-12", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "effort-2025-11-24"]
        if "[1m]" in model.lower():
            beta_parts.insert(1, "context-1m-2025-08-07"); model = model.replace("[1m]", "").replace("[1M]", "")
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01",
            "anthropic-beta": ",".join(beta_parts), "anthropic-dangerous-direct-browser-access": "true",
            "user-agent": self.user_agent, "x-app": "secheur-agent"}
        headers.update({"Accept": "application/json"})
        if self.api_key.startswith("sk-ant-"): headers["x-api-key"] = self.api_key
        else: headers["authorization"] = f"Bearer {self.api_key}"
        payload = {"model": model, "messages": messages, "max_tokens": self.max_tokens, "stream": self.stream}
        if self.relay_compat_system_prompt: payload["max_tokens"] = 64000
        if self.temperature != 1: payload["temperature"] = self.temperature
        self._apply_anthropic_thinking(payload)
        payload["context_management"] = {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]}; 
        if self.relay_compat_system_prompt:
            if 'thinking' not in payload: payload["thinking"] = {"type": "adaptive"}
            if 'output_config' not in payload: payload["output_config"] = {"effort": "medium"}
        payload["metadata"] = {"user_id": json.dumps({"device_id": self._device_id, "account_uuid": "", "session_id": self._session_id}, separators=(',', ':'))}
        if self.tools:
            anthropic_tools = openai_tools_to_anthropic(self.tools)
            tools = [dict(t) for t in anthropic_tools]; tools[-1]["cache_control"] = {"type": "ephemeral"}
            payload["tools"] = tools
        elif not getattr(self, '_suppress_missing_tools_warning', False):
            print("[ERROR] No tools provided for this session.")
        payload['system'] = [{"type": "text", "text": "You are SecHeur Agent.", "cache_control": {"type": "ephemeral"}}]
        if self.system:
            system_blocks = _anthropic_system_blocks(self.system)
            if self.relay_compat_system_prompt: payload["system"].extend(system_blocks)
            else: payload["system"] = system_blocks
        user_idxs = [i for i, m in enumerate(messages) if m['role'] == 'user']
        for idx in user_idxs[-2:]:
            messages[idx] = {**messages[idx], "content": list(messages[idx]["content"])}
            messages[idx]["content"][-1] = dict(messages[idx]["content"][-1], cache_control={"type": "ephemeral"})
        url = auto_make_url(self.api_base, "messages") + '?beta=true'
        parse_fn = (lambda r: _parse_anthropic_sse(r.iter_lines())) if self.stream else (lambda r: _parse_anthropic_json(r.json()))
        return (yield from _stream_with_retry(self, url, headers, payload, parse_fn, priority=priority))

    def ask(self, msg):
        assert type(msg) is dict
        with self.lock:
            self.history.append(msg)
            trim_messages_history(self.history, self)
            messages = [{"role": m["role"], "content": list(m["content"])} for m in self.history]
            content_blocks = None
            usage_revision = get_usage_revision()
            gen = self.raw_ask(messages)
            try:
                while True: yield next(gen)
            except StopIteration as e: content_blocks = e.value or []
            if content_blocks and (_injected := _ensure_text_block(content_blocks)): yield _injected
            if content_blocks and not (len(content_blocks) == 1 and content_blocks[0].get("text", "").startswith("!!!Error:")):
                self.history.append({"role": "assistant", "content": content_blocks})
            self._last_response_ts = time.time()
            if get_usage_revision() != usage_revision and (t := get_last_context_tokens()):
                self._usage_tokens, self._usage_history_len = t, len(self.history)
            text_parts = [b["text"] for b in content_blocks if b.get("type") == "text"]
            content = "\n".join(text_parts).strip()
            tool_calls = [MockToolCall(b["name"], b.get("input", {}), id=b.get("id", "")) for b in content_blocks if b.get("type") == "tool_use"]
            thinking_parts = [b["thinking"] for b in content_blocks if b.get("type") == "thinking"]
            thinking = "\n".join(thinking_parts).strip()
            if not thinking:
                think_pattern = r"<think(?:ing)?>(.*?)</think(?:ing)?>"
                think_match = re.search(think_pattern, content, re.DOTALL)
                if think_match:
                    thinking = think_match.group(1).strip()
                    content = re.sub(think_pattern, "", content, flags=re.DOTALL)
            return MockResponse(thinking, content, tool_calls, str(content_blocks))

class NativeOAISession(NativeAnthropicSession):
    def raw_ask(self, messages, priority="foreground"):
        messages = _fix_messages(messages)
        messages = _ensure_thinking_blocks(messages, self.model)
        return (yield from _openai_stream(self, _msgs_anthropic2oai(messages), priority=priority))

def openai_tools_to_anthropic(tools):
    """[{type:'function', function:{name,description,parameters}}] → [{name,description,input_schema}]."""
    result = []
    for t in tools:
        if 'input_schema' in t: result.append(t); continue
        fn = t.get('function', t)
        result.append({'name': fn['name'], 'description': fn.get('description', ''),
            'input_schema': fn.get('parameters', {'type': 'object', 'properties': {}})})
    return result

class MockFunction:
    def __init__(self, name, arguments): self.name, self.arguments = name, arguments  
         
class MockToolCall:
    def __init__(self, name, args, id=''):
        arg_str = json.dumps(args, ensure_ascii=False) if isinstance(args, (dict, list)) else (args or '{}')
        self.function = MockFunction(name, arg_str); self.id = id

class MockResponse:
    def __init__(self, thinking, content, tool_calls, raw, stop_reason='end_turn'):
        self.thinking = thinking; self.content = content          
        self.tool_calls = tool_calls; self.raw = raw
        self.stop_reason = 'tool_use' if tool_calls else stop_reason
    def __repr__(self):    
        return f"<MockResponse thinking={bool(self.thinking)}, content='{self.content}', tools={bool(self.tool_calls)}>"


_FALLBACK_PROTOCOL_TAG_RE = re.compile(
    r"<\s*/?\s*(?:tool_use|tool_call|tool_result|thinking|think|summary)\b[^>]*>",
    re.IGNORECASE,
)

def _escape_fallback_protocol_tags(text):
    return _FALLBACK_PROTOCOL_TAG_RE.sub(lambda match: html.escape(match.group(0), quote=False), str(text))


def _fallback_content_text(content):
    if isinstance(content, str):
        return _escape_fallback_protocol_tags(content)
    if content is None:
        return ""
    if not isinstance(content, list):
        return _escape_fallback_protocol_tags(content)

    rendered = []
    for block in content:
        if not isinstance(block, dict):
            rendered.append(_escape_fallback_protocol_tags(block))
            continue
        block_type = block.get("type")
        if block_type == "text":
            rendered.append(_escape_fallback_protocol_tags(block.get("text", "")))
        elif block_type in {"image", "image_url", "input_image"}:
            rendered.append("[image]")
        elif block_type == "tool_result":
            rendered.append("Tool result: " + _fallback_content_text(block.get("content", "")))
        elif block_type == "tool_use":
            tool_payload = {
                "name": block.get("name", ""),
                "input": block.get("input", {}),
            }
            rendered.append("Tool use: " + _escape_fallback_protocol_tags(json.dumps(tool_payload, ensure_ascii=False)))
        else:
            rendered.append(_escape_fallback_protocol_tags(json.dumps(block, ensure_ascii=False, default=str)))
    return "\n".join(part for part in rendered if part)


class TextToolProtocolAdapter:
    """Owns the XML/text fallback protocol for non-native tool sessions."""

    def __init__(self, auto_save_tokens=True):
        self.auto_save_tokens = auto_save_tokens
        self.last_tools = ''
        self.total_cd_tokens = 0

    def prepare_tools(self, tools):
        tools = json.loads(json.dumps(tools, ensure_ascii=False)) if tools else tools
        for t in tools or []:
            f = t.get('function', {})
            if f.get('name') == 'file_write':
                props = f.get('parameters', {}).get('properties', {})
                props.pop('content', None)
                extra = '. Content must be placed in <file_content> tags in reply body, not in args'
                if extra not in f.get('description', ''): f['description'] = f.get('description', '') + extra
                break
        return tools

    def _prepare_tool_instruction(self, tools):
        tool_instruction = ""
        if not tools: return tool_instruction
        tools_json = _escape_fallback_protocol_tags(json.dumps(tools, ensure_ascii=False, separators=(',', ':')))
        _en = get_env('SECHEUR_LANG') == 'en'
        if _en:
            tool_instruction = f"""
### Interaction Protocol (must follow strictly, always in effect)
Follow these steps to think and act:
1. **Think**: Analyze the current situation and strategy inside `<thinking>` tags.
2. **Summarize**: Output a minimal one-line (<30 words) physical snapshot in `<summary>`: new info from last tool result + current tool call intent. This goes into long-term working memory. Must contain real information, no filler.
3. **Act**: If you need to call tools, output one or more **<tool_use> blocks** after your reply, then stop.
"""
        else:
            tool_instruction = f"""
### 交互协议 (必须严格遵守，持续有效)
请按照以下步骤思考并行动：
1. **思考**: 在 `<thinking>` 标签中先进行思考，分析现状和策略。
2. **总结**: 在 `<summary>` 中输出*极为简短*的高度概括的单行（<30字）物理快照，包括上次工具调用结果产生的新信息+本次工具调用意图。此内容将进入长期工作记忆，记录关键信息，严禁输出无实际信息增量的描述。
3. **行动**: 如需调用工具，请在回复正文之后输出一个（或多个）**<tool_use>块**，然后结束。
"""
        tool_instruction += f'\nFormat: ```<tool_use>{{"name": "tool_name", "arguments": {{...}}}}</tool_use>```\n\n### Tools (mounted, always in effect):\n{tools_json}\n'
        if self.auto_save_tokens and self.last_tools == tools_json:
            tool_instruction = "\n### Tools: still active, **ready to call**. Protocol unchanged.\n" if _en else "\n### 工具库状态：持续有效（code_run/file_read等），**可正常调用**。调用协议沿用。\n"
        else: self.total_cd_tokens = 0
        self.last_tools = tools_json
        return tool_instruction

    def build_prompt(self, messages, tools):
        system_content = next((m['content'] for m in messages if m['role'].lower() == 'system'), "")
        history_msgs = [m for m in messages if m['role'].lower() != 'system']
        tool_instruction = self._prepare_tool_instruction(self.prepare_tools(tools))
        system = ""; user = ""
        if system_content: system += f"{_fallback_content_text(system_content)}\n"
        system += f"{tool_instruction}"
        for m in history_msgs:
            role = "USER" if m['role'] == 'user' else "ASSISTANT"
            user += f"=== {role} ===\n"
            for tr in m.get('tool_results', []):
                content = html.escape(str(tr.get("content", "")), quote=False)
                user += f'<tool_result>{content}</tool_result>\n'
            user += _fallback_content_text(m['content']) + "\n"
            self.total_cd_tokens += len(user) // 3
        if self.total_cd_tokens > 9000: self.last_tools = ''
        user += "=== ASSISTANT ===\n"
        return system + user

    def parse_response(self, text):
        remaining_text = text; thinking = ''
        think_match = re.search(r"<think(?:ing)?>(.*?)</think(?:ing)?>", text, re.DOTALL)
        if think_match:
            thinking = think_match.group(1).strip()
            remaining_text = re.sub(r"<think(?:ing)?>(.*?)</think(?:ing)?>", "", remaining_text, flags=re.DOTALL)
        tool_calls, remaining_text = _parse_text_tool_calls(remaining_text)
        if not tool_calls:
            json_strs = []; errors = []
            if '<tool_use>' in remaining_text:
                weaktoolstr = remaining_text.split('<tool_use>')[-1].strip().strip('><')
                json_str = weaktoolstr if weaktoolstr.endswith('}') else ''
                if json_str == '' and '```' in weaktoolstr and weaktoolstr.split('```')[0].strip().endswith('}'):
                    json_str = weaktoolstr.split('```')[0].strip()
                if json_str: json_strs.append(json_str)
                remaining_text = remaining_text.replace('<tool_use>'+weaktoolstr, "")
            elif '"name":' in remaining_text and '"arguments":' in remaining_text:
                json_match = re.search(r'\{.*"name":.*\}', remaining_text, re.DOTALL)
                if json_match:
                    json_strs.append(json_match.group(0).strip())
                    remaining_text = remaining_text.replace(json_match.group(0), "").strip()
            for json_str in json_strs:
                try:
                    data = tryparse(json_str)
                    func_name = data.get('name') or data.get('function') or data.get('tool')
                    args = data.get('arguments') or data.get('args') or data.get('params') or data.get('parameters')
                    if args is None: args = data
                    if func_name: tool_calls.append(MockToolCall(func_name, args))
                except json.JSONDecodeError:
                    errors.append(f'Failed to parse tool_use JSON: {json_str[:200]}')
                    self.last_tools = ''
                except Exception: pass
            if not tool_calls:
                for e in errors:
                    print(f"[Warn] {e}"); tool_calls.append(MockToolCall('bad_json', {'msg': e}))
        return MockResponse(thinking, remaining_text.strip(), tool_calls, text)


class ToolClient:
    def __init__(self, backend, auto_save_tokens=True):
        self.backend = backend
        self.protocol_adapter = TextToolProtocolAdapter(auto_save_tokens=auto_save_tokens)
        self.name = self.backend.name
        self.log_path = None

    @property
    def auto_save_tokens(self):
        return self.protocol_adapter.auto_save_tokens

    @auto_save_tokens.setter
    def auto_save_tokens(self, value):
        self.protocol_adapter.auto_save_tokens = value

    @property
    def last_tools(self):
        return self.protocol_adapter.last_tools

    @last_tools.setter
    def last_tools(self, value):
        self.protocol_adapter.last_tools = value

    @property
    def total_cd_tokens(self):
        return self.protocol_adapter.total_cd_tokens

    @total_cd_tokens.setter
    def total_cd_tokens(self, value):
        self.protocol_adapter.total_cd_tokens = value

    def chat(self, messages, tools=None):
        full_prompt = self._build_protocol_prompt(messages, tools)
        print("Full prompt length:", len(full_prompt), 'chars')
        setattr(self.backend, 'log_path', self.log_path)
        gen = self.backend.ask(full_prompt)
        _write_llm_log(
            'Prompt',
            full_prompt,
            self.log_path,
            model=getattr(self.backend, 'model', ''),
            structured_content={"role": "user", "content": [{"type": "text", "text": full_prompt}]},
        )
        raw_text = ''
        for chunk in gen:
            raw_text += chunk; yield chunk
        _write_llm_log(
            'Response',
            raw_text,
            self.log_path,
            model=getattr(self.backend, 'model', ''),
            structured_content=[{"type": "text", "text": raw_text}],
        )
        return self._parse_mixed_response(raw_text)

    def _prepare_tool_instruction(self, tools):
        return self.protocol_adapter._prepare_tool_instruction(tools)

    def _build_protocol_prompt(self, messages, tools):
        return self.protocol_adapter.build_prompt(messages, tools)

    def _parse_mixed_response(self, text):
        return self.protocol_adapter.parse_response(text)

def _parse_text_tool_calls(content):
    """Fallback: extract tool calls from text when model doesn't use native tool_use blocks."""
    tcs = []
    # try JSON array: [{"type":"tool_use", "name":..., "input":...}]
    _jp = next((p for p in ['[{"type":"tool_use"', '[{"type": "tool_use"'] if p in content), None)
    if _jp and content.endswith('}]'):
        try:
            idx = content.index(_jp); raw = json.loads(content[idx:])
            tcs = [MockToolCall(b["name"], b.get("input", {}), id=b.get("id", "")) for b in raw if b.get("type") == "tool_use"]
            return tcs, content[:idx].strip()
        except Exception: pass
    # try XML tags: <tool_call>{"name":..., "arguments":...}</tool_call>
    _xp = r"<(?:tool_use|tool_call)>((?:(?!<(?:tool_use|tool_call)>).){15,}?)</(?:tool_use|tool_call)>"
    for s in re.findall(_xp, content, re.DOTALL):
        try:
            d = tryparse(s.strip()); name = d.get('name')
            args = d.get('arguments') or d.get('args') or d.get('input') or {}
            if name: tcs.append(MockToolCall(name, args))
        except Exception: pass
    if tcs: content = re.sub(_xp, "", content, flags=re.DOTALL).strip()
    return tcs, content

def _ensure_text_block(blocks):
    """If response has thinking but no text block, inject a synthetic summary from thinking's first line."""
    if any(b.get("type") == "text" for b in blocks): return None
    th = next((b.get("thinking", "") for b in blocks if b.get("type") == "thinking"), "")
    if not th: return None
    line = th.strip().split('\n', 1)[0]
    txt = "<summary>" + (line[:60] + '...' if len(line) > 60 else line) + "</summary>"
    blocks.insert(1, {"type": "text", "text": txt})
    return txt

def _session_event_from_llm_log(label, content):
    if label == "Prompt":
        prompt = content
        if isinstance(prompt, str):
            try:
                prompt = json.loads(prompt)
            except json.JSONDecodeError:
                return None
        if not isinstance(prompt, dict) or prompt.get("role") != "user":
            return None
        blocks = prompt.get("content")
        if isinstance(blocks, str):
            blocks = [{"type": "text", "text": blocks}]
        if not isinstance(blocks, list):
            return None
        return "user", blocks
    if label == "Response":
        blocks = content
        if isinstance(blocks, str):
            try:
                blocks = json.loads(blocks)
            except json.JSONDecodeError:
                return None
        if not isinstance(blocks, list):
            return None
        return "assistant", blocks
    return None


def _append_structured_llm_log(label, content, log_path, model=None):
    event_data = _session_event_from_llm_log(label, content)
    if event_data is None:
        return
    role, blocks = event_data
    try:
        append_session_event(
            session_log_sidecar_path(log_path),
            SessionLogEvent(
                session_id=_session_id_from_log_path(log_path),
                turn_id=_next_session_log_turn_id(log_path),
                role=role,
                content=blocks,
                source="llm",
                ts=time.time(),
                parent_uuid=_last_session_record_uuid(log_path),
                model=str(model or ""),
            ),
        )
    except Exception as e:
        print(f"[WARN] Failed to write structured session log: {e}")


def _write_llm_log(label, content, log_path=None, model=None, structured_content=None):
    if not log_path:
        log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'temp/model_responses/model_responses_{os.getpid()}.txt')
    log_dir = os.path.dirname(os.path.abspath(log_path))
    os.makedirs(log_dir, exist_ok=True)
    cleanup_old_runtime_files(log_dir, "model_responses_*.txt")
    _append_structured_llm_log(label, structured_content if structured_content is not None else content, log_path, model=model)
    if isinstance(content, (dict, list)):
        content = json.dumps(content, ensure_ascii=False, indent=2)
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with open(log_path, 'a', encoding='utf-8', errors='replace') as f:
        f.write(f"=== {label} === {ts}\n{content}\n\n")

def tryparse(json_str):
    try: return json.loads(json_str)
    except Exception: pass
    json_str = json_str.strip().strip('`').replace('json\n', '', 1).strip()
    try: return json.loads(json_str)
    except Exception: pass
    try: return json.loads(json_str[:-1])
    except Exception: pass
    if '}' in json_str: json_str = json_str[:json_str.rfind('}') + 1]
    return json.loads(json_str)

class MixinSession:
    """Multi-session fallback with spring-back to primary."""
    def __init__(self, all_sessions, cfg):
        self._retries, self._base_delay = cfg.get('max_retries', 3), cfg.get('base_delay', 1.5)
        self._spring_sec = cfg.get('spring_back', 300)
        self._sessions = [all_sessions[i].backend if isinstance(i, int) else 
                          next(s.backend for s in all_sessions if type(s) is not dict and s.backend.name == i) for i in cfg.get('llm_nos', [])]
        is_native = lambda s: 'Native' in s.__class__.__name__
        groups = {is_native(s) for s in self._sessions}
        assert len(groups) == 1, f"MixinSession: sessions must be in same group (Native or non-Native), got {[type(s).__name__ for s in self._sessions]}"
        self.name = '|'.join(s.name for s in self._sessions)
        self._sessions = [copy.copy(s) for s in self._sessions]
        for s in self._sessions:
            if hasattr(s, "history"):
                s.history = copy.deepcopy(s.history)
        for s in self._sessions: s.max_retries = 0
        self._orig_raw_asks = [s.raw_ask for s in self._sessions]
        self._sessions[0].raw_ask = self._raw_ask
        self._cur_idx, self._switched_at = 0, 0.0
    def __getattr__(self, name): return getattr(self._sessions[0], name)
    _BROADCAST_ATTRS = frozenset({
        'system', 'tools', 'temperature', 'max_tokens', 'reasoning_effort',
        'thinking_type', 'thinking_budget_tokens', 'history', 'stream', 'read_timeout',
        'log_path',
    })
    def __setattr__(self, name, value):
        if name in self._BROADCAST_ATTRS:
            for s in self._sessions:
                v = openai_tools_to_anthropic(value) if name == 'tools' and type(s) is NativeAnthropicSession else value
                if name == 'history':
                    v = copy.deepcopy(value)
                setattr(s, name, v)
        else: object.__setattr__(self, name, value)
    @property
    def primary(self): return self._sessions[0]
    @property
    def model(self): return getattr(self._sessions[self._cur_idx], 'model', None)
    def _pick(self):
        if self._cur_idx and time.time() - self._switched_at > self._spring_sec: self._cur_idx = 0
        return self._cur_idx
    def _raw_ask(self, *args, **kwargs):
        base, n = self._pick(), len(self._sessions)
        test_error = lambda x: isinstance(x, str) and x.lstrip().startswith(('!!!Error:', '[Error:'))
        for attempt in range(self._retries + 1):
            idx = (base + attempt) % n
            gen = self._orig_raw_asks[idx](*args, **kwargs)
            print(f'[MixinSession] Using session ({self._sessions[idx].name})')
            last_chunk, return_val, yielded = None, [], False
            try:
                while True:
                    chunk = next(gen); last_chunk = chunk
                    if not yielded and test_error(chunk): continue
                    yield chunk; yielded = True
            except StopIteration as e: return_val = e.value or []
            is_err = test_error(last_chunk)
            if not is_err:
                if attempt > 0: self._cur_idx = idx; self._switched_at = time.time()
                elif isinstance(last_chunk, str) and '[!!! 流异常中断' in last_chunk and n > 1:
                    self._cur_idx = (idx + 1) % n; self._switched_at = time.time()
                    print(f'[MixinSession] Partial failure, next call → s{self._cur_idx} ({self._sessions[self._cur_idx].name})')
                return return_val
            if attempt >= self._retries:
                yield last_chunk; return return_val
            nxt = (base + attempt + 1) % n
            if nxt == base:  # full round failed, delay before next
                rnd = (attempt + 1) // n
                delay = min(30, self._base_delay * (1.5 ** rnd))
                print(f'[MixinSession] {last_chunk[:80]}, round {rnd} exhausted, retry in {delay:.1f}s')
                time.sleep(delay)
            else: print(f'[MixinSession] {last_chunk[:80]}, retry {attempt+1}/{self._retries} (s{idx}→s{nxt})')

THINKING_PROMPT_ZH = """
### 行动规范（持续有效）
每次回复（含工具调用轮）都先在回复文字中包含一个<summary></summary> 中输出极简单行（<30字）物理快照：上次结果新信息+本次意图。此内容进入长期工作记忆。
\n**若用户需求未完成，必须进行工具调用！**
""".strip()
THINKING_PROMPT_EN = """
### Action Protocol (always in effect)
The reply body should first include a minimal one-line (<30 words) physical snapshot in <summary></summary>: new info from last result + current intent. This goes into long-term working memory.
\n**If the user's request is not yet complete, tool calls are required!**
""".strip()

class NativeToolClient:
    @staticmethod
    def _thinking_prompt(): return THINKING_PROMPT_EN if get_env('SECHEUR_LANG') == 'en' else THINKING_PROMPT_ZH
    def __init__(self, backend):
        self.backend = backend
        self.backend.system = self._thinking_prompt()
        self.name = self.backend.name
        self._pending_tool_ids = []
        self.log_path = None
    def set_system(self, extra_system):
        combined = _append_static_system_section(extra_system, self._thinking_prompt()) if extra_system else self._thinking_prompt()
        if combined != self.backend.system: print(f"[Debug] Updated system prompt, length {len(combined)} chars.")
        self.backend.system = combined
    def chat(self, messages, tools=None):
        if tools: self.backend.tools = tools
        if not self.backend.history: self._pending_tool_ids = []
        combined_content = []; resp = None; tool_results = []
        for msg in messages:
            c = msg.get('content', '')
            if msg['role'] == 'system': 
                self.set_system(c); continue
            if isinstance(c, str): combined_content.append({"type": "text", "text": c})
            elif isinstance(c, list): combined_content.extend(c)
            if msg['role'] == 'user' and msg.get('tool_results'): tool_results.extend(msg['tool_results'])
        tr_id_set = set();  tool_result_blocks = []
        for tr in tool_results:
            tool_use_id, content = tr.get("tool_use_id", ""), tr.get("content", "")
            tr_id_set.add(tool_use_id)
            if tool_use_id: tool_result_blocks.append({"type": "tool_result", "tool_use_id": tool_use_id, "content": tr.get("content", "")})
            else: combined_content = [{"type": "text", "text": f'<tool_result>{content}</tool_result>'}] + combined_content
        for tid in self._pending_tool_ids:
            if tid not in tr_id_set: tool_result_blocks.append({"type": "tool_result", "tool_use_id": tid, "content": ""})
        self._pending_tool_ids = []
        # Filter whitespace-only text blocks that cause 400 on strict API proxies
        filtered_content = [c for c in combined_content if c.get("type") != "text" or c.get("text", "").strip()]
        final_content = tool_result_blocks + filtered_content
        if not final_content: final_content = [{"type": "text", "text": "."}]
        merged = {"role": "user", "content": final_content}
        setattr(self.backend, 'log_path', self.log_path)
        gen = self.backend.ask(merged)
        prompt_logged = False
        try:
            while True:
                chunk = next(gen)
                if not prompt_logged:
                    _write_llm_log('Prompt', json.dumps(merged, ensure_ascii=False, indent=2), self.log_path, model=getattr(self.backend, 'model', ''))
                    prompt_logged = True
                yield chunk
        except StopIteration as e: resp = e.value
        if not prompt_logged:
            _write_llm_log('Prompt', json.dumps(merged, ensure_ascii=False, indent=2), self.log_path, model=getattr(self.backend, 'model', ''))
        if resp: _write_llm_log('Response', resp.raw, self.log_path, model=getattr(self.backend, 'model', ''))
        if resp and hasattr(resp, 'tool_calls') and resp.tool_calls: self._pending_tool_ids = [tc.id for tc in resp.tool_calls]
        return resp

def resolve_session(cfg_name):
    cfg = reload_mykeys()[0].get(cfg_name)
    if not cfg: raise ValueError(f"Config '{cfg_name}' not in mykey")
    if 'native' in cfg_name: return (NativeAnthropicSession if 'anthropic' in cfg_name else NativeOAISession)(cfg=cfg)
    if 'anthropic' in cfg_name: return AnthropicTextSession(cfg=cfg)
    return LLMSession(cfg=cfg) if 'oai' in cfg_name else None

def resolve_client(cfg_name):
    s = resolve_session(cfg_name)
    return (NativeToolClient(s) if isinstance(s, (NativeAnthropicSession, NativeOAISession)) else ToolClient(s)) if s else None

def fast_ask(prompt, cfg_name):
    sess = resolve_session(cfg_name)
    if not sess: raise ValueError(f"fast_ask: '{cfg_name}' unsupported")
    return "".join(sess.raw_ask([{"role": "user", "content": prompt}]))
