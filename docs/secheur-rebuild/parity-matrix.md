# 功能迁移矩阵

| 原能力 | Pi 承载方式 | 当前状态 | 验收证据 |
|---|---|---|---|
| Agent loop / streaming | `pi-agent-core` + `AgentSession` | 已接入，原 Agent loop 不再承载对话 | SecHeur runtime 与 bridge 测试 |
| 多模型与 thinking | `pi-ai` + Pi model runtime | 已接入；protocol model/thinking 状态可持久恢复 | 模型配置、mock provider、2026-08-10 MiniMax smoke 与 protocol 测试 |
| 会话、恢复、分支、压缩 | Pi `SessionManager` + protocol SQLite | JSONL 承载 Agent 上下文；SQLite 承载远程 catalog/transcript/state | bridge 恢复测试；Unix protocol 两次重启与 SQLite-ahead 恢复测试 |
| TUI / CLI | Pi coding-agent `main` | 已接入；`secheur` 注入 system prompt 与 extension 后委托 Pi CLI，兼容 `cli/launch/status/list/doctor/bridge`；`update` 有意改用 Pi package updater，不再对部署目录直接执行 `git pull + pip install -e .` | CLI 参数回归、真实子进程命令 smoke 与离线构建 smoke |
| 文件与 Shell | Pi `read/bash/edit/write` | 已接入，并保留旧工具别名 | 工具契约测试 |
| 权限模式 | Pi `tool_call` extension hook | 已接入 SecHeur extension | 各模式矩阵测试 |
| MCP | 动态 extension tools | 已接入；允许离线启动、显式刷新和退避重连；结构化结果不再被 Python Bridge 压成文本 | HTTP/stdio fixture、结构化证据链与进程生命周期测试；服务器只读审计 |
| RepoAudit | 内置 Pi extension + Python 3.13 runtime | 已接入 `repoaudit_scan`；生产包和 Docker 均包含插件，ready 前执行无模型 doctor，心跳刷新 Bridge watchdog | 上游 extension 全量测试、真实加载/Bridge 可见性、watchdog heartbeat、发布包和 Docker smoke |
| Skill | Pi Skills | 已接入状态目录、项目 `.agents/skills`、`skill/skills` 与 bundled Legacy；同名 Skill 按该顺序取首个 | 真实 Pi `loadSkills` 碰撞优先级测试 |
| 比赛平台交互 (slab-match) | Pi Skill (legacy bundle) | 已迁移:`legacy/.agents/skills/slab-match/SKILL.md` + `slab-match.sh`,随 release 打包进 Docker 镜像;通过 `X-Agent-AccessKey` 头调用 `/slab-match/api/v1/agent/*` 9 个端点 | `secheur self-test` 列出 skill;`slab-match info` 命中 |
| 整端点 LLM 网关改写 (dasctf-gateway) | Pi extension | 已迁移:`legacy/secheur-local-extensions/dasctf-gateway.ts` 通过 `globalThis.fetch` 包装把 `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/<id>/{chat/completions,responses}` 还原为裸网关 URL | 三个 provider 各跑一次 `--model <id> -p OK` 拿到 200 |
| 子 Agent | Pi subagent extension | 已接入 SecHeur 预置 Agent 定义 | 隔离与 abort 测试 |
| Plan Mode | SecHeur permission controller + Pi extension tool | 已接入 `plan` 权限、只读拦截与 `exit_plan_mode` 审批 | 只读/退出审批测试 |
| Task Tree / Program Plan Runtime | Pi lifecycle hooks + Python compatibility host | 每个 Pi 用户任务初始化；Pi 原生工具、TypeScript MCP 与 Legacy 工具结果统一进入证据链；工具轮恢复周期状态 | Python runtime-context 测试与 faux provider 完整 Pi loop 测试 |
| 记忆与 CTF 知识库 | Pi context hook + tool | Python 兼容宿主，后续原生迁移 | memory/attack-memory `38` 个测试 |
| CTF / Web verbs | extension tool | Python 兼容宿主 | 原 Python tests + TS 契约测试 |
| Browser / TMWebDriver | extension tool | Python 兼容宿主 | 服务器工具 smoke |
| Flag Oracle / 最终答案门禁 | extension tool + Pi `turn_end` follow-up | Python 兼容宿主；最终回复进入旧版 Flag/答案门禁，正式 CTF 的无工具回复受有界 continuation guard 约束 | mock oracle、runtime-context 与 faux provider 完整 Pi loop 测试 |
| Working Memory / 后台任务通知 | Legacy `turn_end_callback` 经 Pi turn hook 注入 | 工具轮恢复 checkpoint、Task Tree/Plan 周期状态与后台任务完成通知 | Legacy callback 测试与 Pi runtime-context 测试 |
| Progress Judge | Pi turn events | 已接入 SecHeur extension | Judge `25` 个 Python 测试与 TS 测试 |
| Desktop HTTP / WebSocket | SecHeur bridge + Pi session | 已接入自有 TypeScript bridge；首输出超时会释放 runtime，输出空闲超时会重建 runtime 并自动续作一次 | Desktop `281` 个 Python 契约测试、TypeScript watchdog 回归与 Playwright smoke |
| 远程协议 | `pi-protocol/client/server` | 已通过 `secheur-server` Unix socket 接入；CLI/Desktop API 保持原路径 | faux contract test 与真实 MiniMax-M3 protocol smoke |
| telemetry | `pi-telemetry` | 已注入 runtime create/prompt/provider 请求路径 | in-memory span 完成状态与 parent ID 断言 |
| SQLite session backend | `pi-session-backend-sqlite-node` | 已用于 protocol catalog、transcript 和状态；JSONL 仍承载 Pi 上下文 | writer lease、服务重启、repository 重开及无 JSONL 恢复测试 |
| 发布与部署 | npm tarball + bundled legacy runtime | 构建支持安全重复暂存；发布前校验 TypeScript 输出、3 个 bin、Desktop、CTF MCP、Skill、知识库和敏感文件排除 | distribution script 回归测试与 `docs/secheur-rebuild/deployment.md` |

## 原项目基线

GitHub 基线曾在本机 Python 3.11 环境出现 `13` 个失败、`4` 个错误。兼容层修复后，全量 `1034` 个 Python 测试现为 `1027` 个通过、`6` 个失败、`1` 个错误；剩余问题精确对应 `6` 个 macOS ARM/Mach-O 与 Linux ELF 假设冲突，以及 `1` 个 Flag Oracle stub response 耗尽。它们不与本次 TypeScript bridge、Judge、memory 或 Desktop 回归混算。
