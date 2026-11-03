from llm_protocols import msgs_anthropic_to_oai, to_responses_input


def test_to_responses_input_converts_image_url_to_input_image():
    result = to_responses_input([
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}},
            ],
        }
    ])

    assert result[0]["role"] == "user"
    assert result[0]["content"][0] == {"type": "input_text", "text": "describe"}
    assert result[0]["content"][1] == {
        "type": "input_image",
        "image_url": "data:image/png;base64,aGVsbG8=",
    }


def test_to_responses_input_converts_tool_output_and_function_call():
    result = to_responses_input([
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "calling"}],
            "tool_calls": [
                {
                    "id": "call_1",
                    "function": {"name": "file_read", "arguments": '{"path":"README.md"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "file content"},
    ])

    assert result[0]["role"] == "assistant"
    assert result[1] == {
        "type": "function_call",
        "call_id": "call_1",
        "name": "file_read",
        "arguments": '{"path":"README.md"}',
    }
    assert result[2] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "file content",
    }


def test_msgs_anthropic_to_oai_converts_base64_image_block():
    result = msgs_anthropic_to_oai([
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
    ])

    assert result[0]["content"][0]["text"] == "describe"
    assert result[0]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,aGVsbG8="},
    }


def test_msgs_anthropic_to_oai_splits_tool_results_from_user_blocks():
    result = msgs_anthropic_to_oai([
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "before"},
                {"type": "tool_result", "tool_use_id": "tool_1", "content": "result"},
                {"type": "text", "text": "after"},
            ],
        }
    ])

    assert result == [
        {"role": "user", "content": [{"type": "text", "text": "before"}]},
        {"role": "tool", "tool_call_id": "tool_1", "content": "result"},
        {"role": "user", "content": [{"type": "text", "text": "after"}]},
    ]
