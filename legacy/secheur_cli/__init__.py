"""
secheur_cli - SecHeur Agent CLI 命令包

作为包导入时，自动从根 secheur_core.py 加载核心类
以 python -m secheur_cli 运行时，进入 CLI 命令模式
"""
import importlib.util, sys, os

# ── 确保项目根在 sys.path（secheur_core.py 依赖 agent_loop 等）──
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# ── 从根 secheur_core.py 重新导出核心符号（agentmain.py 等依赖）──
_root_core = os.path.join(_PROJECT_ROOT, 'secheur_core.py')
if os.path.exists(_root_core):
    _spec = importlib.util.spec_from_file_location("_secheur_core", _root_core)
    _mod = importlib.util.module_from_spec(_spec)
    sys.modules['_secheur_core'] = _mod
    _spec.loader.exec_module(_mod)
    # 公开导出
    _EXPORT_NAMES = [
        'SecHeurAgentHandler', 'smart_format', 'get_global_memory',
        'format_error', 'consume_file', 'code_run', 'script_dir',
        'BaseHandler', 'StepOutcome',
    ]
    for _name in _EXPORT_NAMES:
        if hasattr(_mod, _name):
            globals()[_name] = getattr(_mod, _name)
    __all__ = [n for n in _EXPORT_NAMES if hasattr(_mod, n)]
