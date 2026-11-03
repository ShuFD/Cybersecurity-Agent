"""
secheur_cli/cli.py - SecHeur Agent 命令行分发系统

通过 python -m secheur_cli <命令> 或 secheur <命令> 调用
"""
import os, sys, subprocess, argparse, textwrap
import json
import urllib.error
import urllib.request

# Windows GBK 终端兼容
if sys.platform == "win32" and sys.stdout.encoding and sys.stdout.encoding.lower() in ("gbk", "gb2312"):
    sys.stdout.reconfigure(errors="replace") if hasattr(sys.stdout, "reconfigure") else None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)


def launch_frontend(cmd_parts, args=None):
    """启动前端/工具进程"""
    full_cmd = []
    for part in cmd_parts:
        part = part.replace("{PROJECT_DIR}", PROJECT_DIR)
        full_cmd.append(part)

    # 插入额外参数
    if args:
        full_cmd.extend(args)

    print(f"🚀 {' '.join(full_cmd)}")
    sys.stdout.flush()
    os.chdir(PROJECT_DIR)
    proc = subprocess.Popen(full_cmd)
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        sys.exit(0)


COMMANDS = {
    "cli": {
        "help": "启动 CLI 对话 (agentmain)",
        "desc": "启动命令行交互对话模式，最轻量的使用方式",
        "cmd": ["python", "{PROJECT_DIR}/agentmain.py"],
    },
    "launch": {
        "help": "启动 HTML 桌面界面 (launch.pyw)",
        "desc": "以原生窗口形式包装 HTML 桌面界面（基于 pywebview + desktop_bridge）",
        "cmd": ["python", "{PROJECT_DIR}/launch.pyw"],
    },
    "status": {
        "help": "检查运行状态",
        "desc": "检查当前是否已有 SecHeur Agent 进程在运行",
        "cmd": None,
        "internal": True,
    },
    "update": {
        "help": "更新项目 (git pull + pip install)",
        "desc": "从 Git 拉取最新代码并更新依赖",
        "cmd": None,
        "internal": True,
    },
    "list": {
        "help": "列出所有可用前端/服务",
        "desc": "显示所有注册的命令",
        "cmd": None,
        "internal": True,
    },
}


def cmd_list():
    """展示所有可用命令"""
    print()
    frontend_cmds = [(k, v) for k, v in sorted(COMMANDS.items()) if v["cmd"] is not None]
    internal_cmds = [(k, v) for k, v in sorted(COMMANDS.items()) if v["cmd"] is None]

    print(f"  {'命令':20s}  {'说明'}")
    print(f"  {'━'*20}  {'━'*40}")
    for name, info in frontend_cmds:
        print(f"  {name:20s}  {info.get('help', info['desc'][:40])}")
    print()
    for name, info in internal_cmds:
        print(f"  {name:20s}  {info.get('help', info['desc'][:40])}")
    print()


def get_bridge_status(url="http://127.0.0.1:14168/status", timeout=1.0):
    """读取本地 HTML bridge 状态。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def get_agent_processes():
    """返回可识别的 agentmain 进程；未安装 psutil 时返回 None。"""
    try:
        import psutil
    except ModuleNotFoundError:
        return None
    return [
        p for p in psutil.process_iter(["pid", "name", "cmdline"])
        if p.info["cmdline"] and any("agentmain" in c for c in p.info["cmdline"])
    ]


def cmd_status():
    """检查进程状态"""
    status_url = os.environ.get("SECHEUR_STATUS_URL", "http://127.0.0.1:14168/status")
    bridge = get_bridge_status(status_url)
    running = get_agent_processes()
    if bridge and bridge.get("ok"):
        ready = "ready" if bridge.get("ready") else "starting"
        print(f"🟢 Bridge 运行中: {ready} · {bridge.get('projectRoot', PROJECT_DIR)}")
    if running:
        print(f"🟢 CLI Agent 运行中: {len(running)} 个进程")
        for p in running:
            print(f"   PID {p.info['pid']} — {' '.join(p.info['cmdline'][:3])}")
    elif running is None:
        print("ℹ️  未安装 psutil，已跳过 CLI 进程扫描。")
    if not bridge and not running:
        print("⚫ SecHeur Agent 进程未运行")


def cmd_update():
    """git pull + pip install"""
    os.chdir(PROJECT_DIR)
    print("🔄 git pull...")
    r = subprocess.run(["git", "pull"], capture_output=True, text=True)
    print(r.stdout)
    if r.returncode != 0:
        print(r.stderr)
    print("📦 pip install...")
    r2 = subprocess.run([sys.executable, "-m", "pip", "install", "-e", "."],
                        capture_output=True, text=True)
    print(r2.stdout[-500:] if r2.stdout else "")
    if r2.returncode != 0:
        print(r2.stderr[-500:])


def main():
    parser = argparse.ArgumentParser(
        prog="secheur",
        description="SecHeur Agent 全局命令入口",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            示例:
              secheur launch            启动 HTML 桌面界面
              secheur cli               启动命令行对话
              secheur list              列出所有命令
        """),
    )
    parser.add_argument("command", nargs="?", help="命令名")
    parser.add_argument("args", nargs="*", help="子命令参数")
    parser.add_argument("-v", "--version", action="store_true", help="显示版本")

    args, unknown = parser.parse_known_args()

    if args.version:
        print("SecHeur Agent v0.1.0")
        return

    cmd = args.command

    if not cmd or cmd == "help":
        parser.print_help()
        print("\n--- 命令列表 ---")
        cmd_list()
        return

    if cmd == "list":
        cmd_list()
        return

    if cmd == "status":
        cmd_status()
        return

    if cmd == "update":
        cmd_update()
        return

    if cmd not in COMMANDS:
        print(f"❌ 未知命令: {cmd}")
        print(f"   使用 'secheur list' 查看可用命令")
        sys.exit(1)

    info = COMMANDS[cmd]

    # 内置命令走内部逻辑
    if info.get("internal"):
        print(f"❌ 命令 {cmd} 没有配置启动命令")
        sys.exit(1)

    extra = list(args.args) + unknown

    # === 处理命令特有 flags ===
    cmd_parts = list(info["cmd"])

    # 处理 flags (如 --native)
    flags = info.get("flags", {})
    for flag_name, flag_info in flags.items():
        if flag_name in extra:
            cmd_parts = list(flag_info["cmd"])
            extra.remove(flag_name)
            break

    launch_frontend(cmd_parts, extra if extra else None)


if __name__ == "__main__":
    main()
