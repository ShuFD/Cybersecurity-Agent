# 服务器只读审计基线

审计时间：2026-08-10。

## 部署状态

- 主机：受控部署主机（地址不写入源码）。
- 项目：`/path/to/secheur-agent`。
- 运行进程：`.venv/bin/python frontends/desktop_bridge.py`。
- 当前监听：`0.0.0.0:14168`。
- `/status` 返回 `ready: true`。
- `TMWebDriver`、Chrome CDP 和 CTF MCP 在审计时未监听，不能作为常驻依赖。
- 重构版本地默认仍为 `127.0.0.1`；部署替换时必须显式设置 `BRIDGE_HOST=0.0.0.0`，才能保持现有远程访问契约。

## MCP 与 Docker

- 唯一启用的 MCP server 是 `ctf-toolbox`。
- transport：`streamable-http`。
- endpoint：部署主机回环地址上的 MCP endpoint（具体地址由运行时配置提供）。
- 审计时 `ctf-mcp-http` 容器已停止。
- 服务器保留 `ctf-mcp:ubuntu24-http-tools` 与 `ctf-mcp:ubuntu24-core` 镜像，以及大量挑战镜像和本地 volume。
- HTTP 容器契约为宿主项目状态目录下的 `ctf-work` 绑定到容器 `/work`，并使用受控回环端口，restart policy 为 `unless-stopped`。
- 服务器原先通过 `ctf-mcp-hotfix/server.py` 维护额外工具能力。重构版已将其路径映射、参数别名、输出上限、`upload_image` 与扩展 allowlist 合入 canonical `ctf-mcp/server.py`；HTTP Dockerfile 只复制 canonical 文件，避免两份实现继续漂移。

重构后的 MCP 客户端必须允许服务离线启动、显式刷新和自动重连，不能因 `ctf-toolbox` 暂时不可用而阻止 Agent 启动。

## 源码差异

部署目录仅作为运行契约基线；源码分支不包含服务器运行目录中的配置、会话、Cookie 或挑战临时数据。

## 安全边界

审计未读取或复制 `mykey.py`、API Key、Cookie、浏览器 profile、会话正文或挑战临时文件。服务器上未执行写文件、启动/停止容器、重启服务或修改配置的命令。

## MiniMax 验收

验收使用临时注入的 OpenAI-compatible 模型配置完成：`/models`、Chat Completions、Desktop profile、主 Agent 与 Progress Judge 均成功。重构后的 `PiClient -> Unix PiServer -> SecHeurProtocolService` 路径也通过了会话一致性检查。真实凭据仅通过临时环境注入，未写入源码、文档、配置或发布包；临时会话目录和 smoke 脚本均已删除。

该 endpoint 使用明文 HTTP，Bearer Key 在传输层不受 TLS 保护，只适合当前受控验收；正式部署应改用 HTTPS、可信反向代理或受控私网。模型还会把 `<think>` 内容放在普通 assistant `content` 中，而不是独立 reasoning 字段；当前兼容层按普通文本保留，调用方不能把它误判为 Pi 原生 thinking channel。
