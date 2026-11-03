from __future__ import annotations

import json
import uuid


def to_responses_input(messages):
    result, pending = [], []
    for msg in messages:
        role = str(msg.get("role", "user")).lower()
        if role == "tool":
            cid = msg.get("tool_call_id") or (pending.pop(0) if pending else f"call_{uuid.uuid4().hex[:8]}")
            result.append({"type": "function_call_output", "call_id": cid, "output": msg.get("content", "")})
            continue
        if role not in ["user", "assistant", "system", "developer"]:
            role = "user"
        if role == "system":
            role = "developer"
        content = msg.get("content", "")
        text_type = "output_text" if role == "assistant" else "input_text"
        parts = []
        if isinstance(content, str):
            if content:
                parts.append({"type": text_type, "text": content})
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                ptype = part.get("type")
                if ptype == "text":
                    text = part.get("text", "")
                    if text:
                        parts.append({"type": text_type, "text": text})
                elif ptype == "image_url":
                    image_url = part.get("image_url") or {}
                    url = image_url.get("url", "") if isinstance(image_url, dict) else str(image_url or "")
                    if url and role != "assistant":
                        parts.append({"type": "input_image", "image_url": url})
                elif ptype == "image":
                    source = part.get("source") or {}
                    if role != "assistant" and source.get("type") == "base64" and source.get("data"):
                        parts.append({
                            "type": "input_image",
                            "image_url": f"data:{source.get('media_type', 'image/png')};base64,{source.get('data', '')}",
                        })
                elif ptype == "input_image" and role != "assistant":
                    url = part.get("image_url") or part.get("url") or ""
                    if url:
                        parts.append({"type": "input_image", "image_url": url})
        if len(parts) == 0:
            parts = [{"type": text_type, "text": str(content) if not isinstance(content, list) else "[empty]"}]
        result.append({"role": role, "content": parts})
        pending = []
        for tc in msg.get("tool_calls") or []:
            f = tc.get("function", {})
            cid = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
            pending.append(cid)
            result.append({
                "type": "function_call",
                "call_id": cid,
                "name": f.get("name", ""),
                "arguments": f.get("arguments", ""),
            })
    return result


def msgs_anthropic_to_oai(messages):
    result = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
        if role == "assistant":
            text_parts, tool_calls, reasoning = [], [], ""
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "thinking" and block.get("thinking"):
                    reasoning = block["thinking"]
                elif block.get("type") == "text" and block.get("text"):
                    text_parts.append({"type": "text", "text": block.get("text", "")})
                elif block.get("type") == "tool_use":
                    tool_calls.append({
                        "id": block.get("id") or "",
                        "type": "function",
                        "function": {
                            "name": block.get("name", ""),
                            "arguments": json.dumps(block.get("input", {}), ensure_ascii=False),
                        },
                    })
            message = {"role": "assistant"}
            if reasoning:
                message["reasoning_content"] = reasoning
            if text_parts:
                message["content"] = text_parts
            elif not tool_calls:
                message["content"] = "."
            if tool_calls:
                message["tool_calls"] = tool_calls
            result.append(message)
        elif role == "user":
            text_parts = []
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_result":
                    if text_parts:
                        result.append({"role": "user", "content": text_parts})
                        text_parts = []
                    tool_result = block.get("content", "")
                    if isinstance(tool_result, list):
                        tool_result = "\n".join(
                            item.get("text", "")
                            for item in tool_result
                            if isinstance(item, dict) and item.get("type") == "text"
                        )
                    result.append({
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id") or "",
                        "content": tool_result if isinstance(tool_result, str) else str(tool_result),
                    })
                elif block.get("type") == "image":
                    source = block.get("source") or {}
                    if source.get("type") == "base64" and source.get("data"):
                        text_parts.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{source.get('media_type', 'image/png')};base64,{source.get('data', '')}",
                            },
                        })
                elif block.get("type") == "image_url":
                    text_parts.append(block)
                elif block.get("type") == "text" and block.get("text"):
                    text_parts.append({"type": "text", "text": block.get("text", "")})
            if text_parts:
                result.append({"role": "user", "content": text_parts})
        else:
            result.append(msg)
    return result
