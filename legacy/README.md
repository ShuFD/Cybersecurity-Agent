# SecHeur Agent

SecHeur Agent 是一个以本地桌面使用为主的 Agent 项目。它把对话、工具调用、文件编辑、Shell、MCP、Skill、子 Agent 和权限控制集中到一个 HTML 桌面界面里，适合在自己的电脑上做代码开发、自动化操作和长期任务管理。

当前仓库是 SecHeur Agent 的私有开发镜像，默认以中文界面和项目内配置目录为主。

## 主要能力

- Agent 循环：自动调用工具、读取结果并继续迭代，直到任务完成或达到预算限制。
- 工具系统：内置文件读写编辑、搜索、Shell、Web fetch、ToolSearch、Skill、子 Agent、Plan Mode 等能力。
- 桌面 UI：HTML 前端，支持多会话、模型选择、权限模式选择、主题切换、设置管理和权限申请。
- 权限控制：支持默认权限、自动审查、完全访问权限和 Plan Mode；项目规则保存在 `.secheur-agent/` 下。
- Skill 管理：默认读取项目内 `skill/`、`skills/` 和 `.secheur-agent/skills/`，可在设置里启用、关闭和运行。
- MCP 管理：支持项目内 MCP 配置，设置页可查看、添加、刷新和删除 MCP server。
- 记忆与上下文：支持本地记忆、上下文压缩、大结果落盘和会话恢复。
- 多后端模型：支持 OpenAI-compatible / Anthropic-compatible 风格配置，API 信息可在设置页维护。
- 进度监督：每 N 轮自动评估解题进展，发现偏离时注入纠偏提示，避免思路走偏。

## 快速启动

推荐使用 Python 3.11 或 3.12。

```bash
git clone https://github.com/yg2224/SecHeur-Agent.git
cd SecHeur-Agent
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[ui]"
cp mykey_template.py mykey.py
python launch.pyw
```

Windows PowerShell：

```powershell
git clone https://github.com/yg2224/SecHeur-Agent.git
cd SecHeur-Agent
py -m venv .venv
.venv\Scripts\python -m pip install -e ".[ui]"
copy mykey_template.py mykey.py
.venv\Scripts\python launch.pyw
```

`.[ui]` 安装 HTML desktop shell 依赖。

## 启动入口

HTML 桌面端：

```bash
python launch.pyw
```

命令行对话：

```bash
python agentmain.py
```

命令行入口：

```bash
./secheur list
```

Windows 也可以先运行：

```powershell
secheur_cli\secheur-cli-install.cmd
```

然后在新终端里执行：

```powershell
secheur list
```

## 配置

常用配置文件：

- `mykey.py`：模型 API 配置。
- `.secheur-agent/desktop-config.json`：桌面端默认权限、模型、预算等运行配置。
- `.secheur-agent/settings.json`：工具、Skill、Agent 开关状态。
- `.secheur-agent/mcp.json`：项目 MCP server 配置。
- `skill/`、`skills/`、`.secheur-agent/skills/`：项目 Skill 目录。
- `.secheur-agent/agents/`：项目自定义子 Agent 目录。

桌面端设置页可以直接维护 API、MCP、Skill、Agent、工具开关、运行预算和主题，不需要手动改大部分配置文件。

## 权限模式

常见模式：

- `default`：危险操作需要确认。
- `acceptEdits`：接受文件编辑类操作，危险 Shell 仍按规则处理。
- `dontAsk`：不主动询问，危险操作自动拒绝。
- `bypassPermissions`：完全访问权限，跳过项目 allow / deny 规则和内置确认。
- `plan`：计划模式，只允许规划和受限写入。

可以在 UI 输入条直接切换权限模式，也可以通过环境变量启动：

```bash
SECHEUR_PERMISSION_MODE=bypassPermissions python launch.pyw
```

## 项目结构

```text
agent_loop.py                    Agent 主循环
secheur_core.py                  内置工具 handler
permission_guard.py              权限规则
tool_registry.py                 工具注册与开关
skill_registry.py                Skill 加载
agent_registry.py                子 Agent 注册
frontends/desktop_bridge.py      HTML 桌面端后端 bridge
frontends/desktop/static/        HTML/CSS/JS 前端
frontends/desktop_settings.py    桌面端配置管理
frontends/model_config.py        API/model profile 管理
tests/                           单元测试
```

## 开发与验证

运行全局检查：

```bash
.venv/bin/python scripts/verify_global.py
```

这个检查会覆盖单元测试、Python 语法编译、仓库旧标识残留扫描、桌面端 JavaScript 语法、CLI 入口、调度资源清理、HTML bridge 的核心 HTTP smoke，以及从 `git archive HEAD` 导出的干净目录自检。默认会启动临时 bridge 端口，避免误测到旧的常驻进程；如需复用已有服务，可设置 `SECHEUR_VERIFY_BRIDGE=http://127.0.0.1:${BRIDGE_PORT:-14168}`。调试时可用 `--skip-clean-archive` 暂时跳过干净导出自检。

运行测试：

```bash
.venv/bin/python -m unittest discover tests
```

检查单个测试文件：

```bash
.venv/bin/python -m unittest tests.test_desktop_bridge_root
```

启动后检查 bridge：

```bash
curl http://127.0.0.1:${BRIDGE_PORT:-14168}/status
```

如果端口被占用，`launch.pyw` 会自动选择其它本地端口。

## 许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
