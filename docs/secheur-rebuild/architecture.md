# SecHeur Agent 重构架构

## 不变量

- Pi 是唯一的 Agent loop、模型调用、上下文压缩和会话状态实现。
- 完整保留 Pi monorepo，SecHeur 只新增应用层，不复制或分叉 Pi 核心逻辑。
- 原 Agent 的基础功能必须在替换部署前逐项通过兼容测试。
- 服务器仅作为只读行为与配置基线，不从运行目录复制密钥、会话或 CTF 临时产物。

## 分层

1. `packages/agent`、`packages/ai`、`packages/coding-agent`：主 Agent 运行时。
2. `packages/tui`：终端交互。
3. `packages/protocol`、`packages/client`、`packages/server`：由 `secheur-server` 暴露 Unix socket 远程会话；CLI/Desktop 仍直接使用应用层。
4. `packages/telemetry`：`TelemetryContext` 注入 SecHeur runtime；runtime 创建、prompt 和 provider 请求保持父子 span 关系。
5. `packages/session-backends/sqlite-node`：保存远程会话 catalog、protocol transcript 和 model/thinking/revision 状态。
6. `packages/secheur-agent`：SecHeur 配置、权限、MCP、兼容工具和桌面 API。
7. `packages/repoaudit-pi-extension`：RepoAudit Pi 工具适配器；复用上游 doctor、文件锁、心跳、取消与结果解析。
8. `vendor/repoaudit/`：随 Docker 构建上下文版本化的 RepoAudit Python runtime。
9. `legacy/`：版本化 Python 工具兼容层。它不保存 LLM 对话，也不运行原 Agent loop。

## 调用路径

```text
CLI / Desktop UI -----------+
                            |
PiClient -> Unix PiServer -> SecHeur application layer
                            |
                  Pi AgentSession + extensions
                            |
             Pi model runtime / JSONL sessions
                            |
            native Pi tools | MCP | legacy host

             repoaudit_scan -> RepoAudit Python 3.13 runtime

PiServer -> SQLite catalog / protocol transcript / protocol state
```

## 远程会话持久化

- PiServer 分配的 session ID 原样传给 JSONL `SessionManager` 和 SQLite repository。
- JSONL 是 Pi Agent 上下文、分支和压缩的权威来源；SQLite 是远程会话发现、protocol transcript 和 protocol 状态的权威来源。
- 每个活跃 protocol runtime 持有独立 SQLite writer lease；断开或服务关闭时释放。catalog repository 只做长期列表读取。
- 重启后优先打开同 ID 的 JSONL；若 JSONL 尚未生成而 SQLite 已有兼容的线性 transcript，则恢复到 `SessionManager` 和 agent context，再继续写入同一 JSONL 会话。
- 包含 compaction 等非标准消息且两侧历史不一致时，不自动拼接原始 transcript，避免破坏 Pi 的压缩上下文语义。

## MCP 离线契约

MCP server 不参与 SecHeur runtime 的启动门槛。单个 HTTP/stdio server 连接失败只写入 diagnostics；Agent 继续启动，并保留 `mcp_refresh`。后台重连从 2 秒指数退避到最多 60 秒，tool 调用断线也会移除失效工具并触发重连。该行为覆盖服务器 `ctf-toolbox` 容器可能停止的部署状态。

## RepoAudit 插件契约

RepoAudit 作为内置 Pi extension factory 与 SecHeur extension 一起绑定，不依赖开发机源码绝对路径或 `.pi/settings.json` 中的本地路径。根构建先产出 `@repoaudit/typescript-adapter`，再把可发布的插件入口实际复制进 `@secheur/agent` 的 bundled dependency；生产安装和 Docker 安装都因此能够解析插件。runtime 创建后必须看到 `repoaudit_scan`，否则携带 extension loader diagnostics 抛出 `PLUGIN_NOT_LOADED`，不能静默降级。

插件的 `onUpdate` 事件沿 Pi `tool_execution_update` 进入 Bridge。RepoAudit 排队、锁等待和扫描期间的心跳都会刷新 `tool-stalled` watchdog；watchdog 触发时以明确的 `host_watchdog` reason 取消，使其与用户取消、插件自己的 30 分钟 timeout 以及 `LOCK_LEASE_LOST` 保持不同错误码。每次扫描仍由插件生成唯一 run ID 和 artifact 目录。

当前并发边界是单容器内的进程队列与原子文件锁。文件锁只保护共享同一文件系统的 RepoAudit 进程，不是多容器分布式锁；多副本必须在适配器外增加中央队列或共享 lease，再把任务路由到独占 worker。

## 迁移策略

每个原工具先通过兼容宿主接入，再按风险和维护成本逐个迁移到 TypeScript。只有新实现与原实现的契约测试一致后，才移除对应 Python 路径。这使重构可以持续交付，同时避免一次性重写导致功能回退。

远程协议、telemetry 与 SQLite 已通过独立入口接入，不改变 CLI/Desktop 的现有 API。后续迁移仍按“存在实际调用路径并有契约测试”判定，不能仅凭 workspace 依赖声明标记完成。
