from types import SimpleNamespace

from llmcore import (
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    AnthropicTextSession,
    LLMSession,
    NativeToolClient,
    _anthropic_system_blocks,
)


class RecordingBackend:
    name = "recording"
    system = ""
    history = []

    def __init__(self):
        self.seen_message = None

    def ask(self, message):
        self.seen_message = message
        if False:
            yield ""
        return SimpleNamespace(raw="", tool_calls=[])


def exhaust(generator):
    try:
        while True:
            next(generator)
    except StopIteration as done:
        return done.value


def test_native_tool_client_preserves_image_blocks():
    backend = RecordingBackend()
    client = NativeToolClient(backend)

    exhaust(client.chat(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "aGVsbG8=",
                        },
                    },
                ],
            }
        ],
        tools=[],
    ))

    assert backend.seen_message["content"][0]["type"] == "text"
    assert backend.seen_message["content"][1]["type"] == "image"


def test_native_tool_client_places_thinking_prompt_in_static_system_segment():
    backend = RecordingBackend()
    client = NativeToolClient(backend)

    client.set_system(f"stable{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic")
    blocks = _anthropic_system_blocks(backend.system)

    assert blocks[0]["text"].startswith("stable")
    assert "<summary>" in blocks[0]["text"]
    assert blocks[0]["cache_control"] == {"type": "ephemeral"}
    assert blocks[1]["text"] == "dynamic"
    assert "<summary>" not in blocks[1]["text"]


def test_anthropic_system_blocks_cache_only_static_prompt_segment():
    blocks = _anthropic_system_blocks(
        f"static instructions{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}today and memory"
    )

    assert blocks == [
        {
            "type": "text",
            "text": "static instructions",
            "cache_control": {"type": "ephemeral"},
        },
        {"type": "text", "text": "today and memory"},
    ]


def test_anthropic_text_session_uses_system_prompt_cache_boundary(monkeypatch):
    captured = {}

    def fake_stream(_sess, _url, _headers, payload, _parse_fn, priority="foreground"):
        captured["payload"] = payload
        captured["priority"] = priority
        if False:
            yield ""
        return []

    monkeypatch.setattr("llmcore._stream_with_retry", fake_stream)
    session = AnthropicTextSession({
        "apikey": "sk-test",
        "apibase": "https://api.example.test",
        "model": "claude-test",
        "stream": False,
    })
    session.system = f"stable{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic"

    exhaust(session.raw_ask([{"role": "user", "content": [{"type": "text", "text": "hi"}]}]))

    assert captured["payload"]["system"] == [
        {"type": "text", "text": "stable", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "dynamic"},
    ]
    assert captured["priority"] == "foreground"


def test_openai_chat_places_dynamic_system_segment_in_user_context(monkeypatch):
    captured = {}

    def fake_stream(_sess, _url, _headers, payload, _parse_fn, priority="foreground"):
        captured["payload"] = payload
        if False:
            yield ""
        return []

    monkeypatch.setattr("llmcore._stream_with_retry", fake_stream)
    session = LLMSession({
        "apikey": "sk-test",
        "apibase": "https://api.example.test",
        "model": "gpt-test",
        "stream": False,
    })
    session.system = f"stable{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic"

    exhaust(session.raw_ask([{"role": "user", "content": [{"type": "text", "text": "hi"}]}]))

    assert captured["payload"]["messages"][0] == {
        "role": "system",
        "content": "stable",
    }
    assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in captured["payload"]["messages"][0]["content"]
    assert captured["payload"]["messages"][1]["role"] == "user"
    assert captured["payload"]["messages"][1]["content"][0]["text"].startswith("[System Context]\ndynamic")
    assert captured["payload"]["messages"][1]["content"][1] == {"type": "text", "text": "hi"}


def test_openai_responses_places_dynamic_system_segment_in_input_context(monkeypatch):
    captured = {}

    def fake_stream(_sess, _url, _headers, payload, _parse_fn, priority="foreground"):
        captured["payload"] = payload
        if False:
            yield ""
        return []

    monkeypatch.setattr("llmcore._stream_with_retry", fake_stream)
    session = LLMSession({
        "apikey": "sk-test",
        "apibase": "https://api.example.test",
        "model": "gpt-test",
        "api_mode": "responses",
        "stream": False,
    })
    session.system = f"stable{SYSTEM_PROMPT_DYNAMIC_BOUNDARY}dynamic"

    exhaust(session.raw_ask([{"role": "user", "content": [{"type": "text", "text": "hi"}]}]))

    assert captured["payload"]["instructions"] == "stable"
    assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in captured["payload"]["instructions"]
    assert captured["payload"]["input"][0]["content"][0] == {
        "type": "input_text",
        "text": "[System Context]\ndynamic",
    }


def test_openai_responses_converts_native_image_blocks_to_input_image(monkeypatch):
    captured = {}

    def fake_stream(_sess, _url, _headers, payload, _parse_fn, priority="foreground"):
        captured["payload"] = payload
        if False:
            yield ""
        return []

    monkeypatch.setattr("llmcore._stream_with_retry", fake_stream)
    session = LLMSession({
        "apikey": "sk-test",
        "apibase": "https://api.example.test",
        "model": "gpt-vision-test",
        "api_mode": "responses",
        "stream": False,
    })

    exhaust(session.raw_ask([{
        "role": "user",
        "content": [
            {"type": "text", "text": "describe"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": "aGVsbG8=",
                },
            },
        ],
    }]))

    content = captured["payload"]["input"][0]["content"]

    assert content[0] == {"type": "input_text", "text": "describe"}
    assert content[1] == {
        "type": "input_image",
        "image_url": "data:image/jpeg;base64,aGVsbG8=",
    }


def test_openai_chat_claude_relay_marks_recent_user_messages_for_cache(monkeypatch):
    captured = {}

    def fake_stream(_sess, _url, _headers, payload, _parse_fn, priority="foreground"):
        captured["payload"] = payload
        if False:
            yield ""
        return []

    monkeypatch.setattr("llmcore._stream_with_retry", fake_stream)
    session = LLMSession({
        "apikey": "sk-test",
        "apibase": "https://api.example.test",
        "model": "claude-3-5-sonnet-latest",
        "stream": False,
    })

    exhaust(session.raw_ask([
        {"role": "user", "content": [{"type": "text", "text": "first"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "first answer"}]},
        {"role": "user", "content": [{"type": "text", "text": "second"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "second answer"}]},
        {"role": "user", "content": [{"type": "text", "text": "third"}]},
    ]))

    user_messages = [m for m in captured["payload"]["messages"] if m["role"] == "user"]

    assert "cache_control" not in user_messages[0]["content"][-1]
    assert user_messages[1]["content"][-1]["cache_control"] == {"type": "ephemeral"}
    assert user_messages[2]["content"][-1]["cache_control"] == {"type": "ephemeral"}
