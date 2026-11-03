# SecHeur Agent mykey.py template
#
# Prefer using Settings -> API in the HTML desktop UI. Copy this file to
# mykey.py only when you need manual multi-profile, failover, or advanced fields.
#
# Naming rules:
# - native_oai_config: OpenAI-compatible endpoints.
# - native_anthropic_config: Anthropic-compatible Messages endpoints.
# - mixin_config.llm_nos references the name fields below in priority order.

_SETUP_DONE = 'manual-template'


mixin_config = {
    'llm_nos': ['gpt-native'],
    'max_retries': 10,
    'base_delay': 0.5,
}


native_oai_config = {
    'name': 'gpt-native',
    'apikey': 'sk-<your-api-key>',
    'apibase': 'https://api.openai.com/v1',
    'model': 'gpt-5.4',
    'api_mode': 'chat_completions',
    'reasoning_effort': 'high',
    'max_retries': 3,
    'connect_timeout': 10,
    'read_timeout': 120,
    'stream': True,
}


native_anthropic_config = {
    'name': 'anthropic-native',
    'apikey': 'sk-ant-<your-api-key>',
    'apibase': 'https://api.anthropic.com',
    'model': 'anthropic-model',
    'thinking_type': 'adaptive',
    'max_tokens': 32768,
    'max_retries': 3,
    'connect_timeout': 10,
    'read_timeout': 180,
    'stream': True,
    # Enable only when an Anthropic-compatible relay requires special headers.
    # 'relay_compat_system_prompt': True,
}
