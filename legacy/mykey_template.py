# SecHeur Agent mykey.py 模板
#
# 推荐直接在 HTML 桌面端的“设置 → API”里添加或更新配置。只有在需要手动
# 管理多个 profile、故障转移或高级字段时，才需要复制本文件为 mykey.py。
#
# 变量命名规则：
# - native_oai_config：OpenAI 兼容接口，适用于 /v1/chat/completions 或 Responses 形态。
# - native_anthropic_config：Anthropic 兼容接口，适用于 Anthropic Messages 形态。
# - mixin_config.llm_nos：按优先级引用下面配置里的 name 字段。

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
    # Anthropic 兼容中转需要特殊请求头时再开启。
    # 'relay_compat_system_prompt': True,
}
