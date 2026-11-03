# IRCopilot pi extension

本扩展将研究文档中描述的 IRCopilot 设计移植为 pi coding-agent 扩展。提供了一个小型、可审计的应急响应运行功能框架：

- 持久化的**安全任务树**，包含 `todo`、`running`、`completed`、`blocked`、`not_applicable` 五种状态；
- 明确的 **Planner / Generator / Executor / Analyst / Reflector** 五阶段流转；
- 原始观测与证据记录，通过任务 ID 与动作 ID 关联；
- **每条命令执行前必须人工审批**；
- **只读命令白名单**、30 秒超时、暂停与急停控制；
- 会话级快照与回滚；
- 提供 `/ircopilot`、`/ircopilot-reset` 两条斜杠命令，以及 `ircopilot` LLM 工具。

## 加载方式

在项目根目录下执行：

```
pi -e ./.pi/extensions/ircopilot.ts
```

如需**项目级自动发现**，请在受信项目（trusted project）中启动 pi。pi 会自动加载 `.pi/extensions/*.ts`。

本扩展依赖的包名：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`。

## 最小工作流

1. 调用 `ircopilot`，传入 `action=init`、一个 `title` 和一个 `target`。
2. 调用 `plan`，选中优先级最高的活动任务。
3. 调用 `propose_action`，传入任务 ID 以及**白名单内的只读可执行文件**及其参数。
4. 调用 `approve_action`；pi 会向人工发起确认。
5. 调用 `execute_action`，并检查返回的观测。
6. 调用 `analyze`，挂载证据并对任务进行评估。
7. 调用 `reflect`；若状态流转缺乏证据支持，则使用 `rollback` 回滚。

## 主要能力

- 注册单一 `ircopilot` Tool，保持调用边界清晰
- 实现 Planner / Generator / Analyst / Reflector 四角色工作流
- 通过 Security Task Tree 管理应急响应任务，包含依赖、优先级和 requiredEvidence
- 通过 `propose_action → approve_action → execute_action` 三步走执行只读命令
- 强制只读命令白名单；超出范围的命令在 propose 阶段即被拒绝
- 强制人类 UI 审批；无 UI 环境自动拒绝所有动作
- Reflector 在每次状态变更后自动审计，发现证据缺失或观测缺失即标记违规
- 支持 rollback 到历史快照，被覆盖的 evidence 自动 invalidate（不删除）
- 支持 paused / killSwitch 全局开关
- 状态自动持久化到 session entries，跨对话自动恢复

## 支持范围

IRCopilot 当前只服务于"应急响应辅助"这一类任务。Tool 接受的三类任务参数全部通过 `input.action` 区分：

| Action                                                 | 角色                         | 修改 State | 用途                     |
| :----------------------------------------------------- | :--------------------------- | :--------- | :----------------------- |
| `init`                                                 | —                            | ✅          | 初始化 incident          |
| `status` / `export`                                    | —                            | ❌          | 读                       |
| `set_controls`                                         | —                            | ✅          | 切换 paused / killSwitch |
| `add_task` / `plan`                                    | Planner                      | ✅          | 任务管理                 |
| `propose_action` / `approve_action` / `execute_action` | Generator / Human / Executor | ✅          | 命令生命周期             |
| `record_observation` / `analyze`                       | Analyst                      | ✅          | 证据闭环                 |
| `reflect`                                              | Reflector                    | ⚠️ 仅 audit | 不变量检查               |
| `rollback`                                             | —                            | ✅          | 回滚快照                 |

命令白名单（只读，20 个）：

```
<TEXT>
cat, find, findstr, git, grep, head, hostname, ip, ipconfig,
journalctl, ls, netstat, ps, pwd, sha256sum, ss, stat, tail,
uname, whoami
```

超出白名单的命令在 `propose_action` 阶段被标记为 `blocked`，永远无法执行。

该 Tool 不用于：网络攻击或渗透、提权或持久化驻留、文件或配置修改（白名单强制只读）、跨进程 IPC、第三方 API 调用（除白名单命令外）、依赖或 CVE 扫描、二进制逆向、通用代码审查或任何超出应急响应辅助的任务。

## 目录结构

| 路径             | 内容                                                         |
| :--------------- | :----------------------------------------------------------- |
| `ircopilot.ts`   | 单一扩展源文件，包含 Tool 注册、状态机、审计、Reflector、持久化 |
| （可选）`tests/` | 单元测试与 smoke test                                        |

## 快速开始

### 环境要求

- Node.js ≥ 22.19.0
- Pi Agent：`@earendil-works/pi-coding-agent@0.84.1`
- IRCopilot 不依赖任何 Python runtime、数据库或外部服务

### 1. 加载扩展

```
<BASH>
pi -e ./ircopilot.ts
```

Windows PowerShell：

```
<POWERSHELL>
pi.cmd -e ".\ircopilot.ts"
```

加载成功后，Pi Agent 中应出现 `ircopilot` Tool。

### 2. 发起应急响应

可以直接使用自然语言：

```
<TEXT>
请使用 IRCopilot 帮我处理一起 SSH 爆破事件，目标主机是 web-01。
```

LLM 会按以下顺序自动调用：

```
<TEXT>
init → add_task → plan → propose_action → approve_action →
execute_action → analyze → reflect
```

模型会自动填入 action 参数；只有 Tool 的 13 个 action 是稳定的对外接口。

## 运行时配置

IRCopilot 不需要任何环境变量；所有运行时开关都在 incident state 内，由 `set_controls` 修改。

源码内常量（修改属于工程改动，不属于运行时配置）：

| 常量               | 默认值                                                | 含义                            |
| :----------------- | :---------------------------------------------------- | :------------------------------ |
| `MAX_OUTPUT`       | `32_000`                                              | 单条 stdout / stderr 截断字符数 |
| `MAX_SNAPSHOTS`    | `12`                                                  | 历史快照最大保留数              |
| `MAX_AUDIT_EVENTS` | `200`                                                 | 审计日志最大保留条数            |
| `phases`           | `detect / respond / recover`                          | 应急响应阶段枚举                |
| `actionStatuses`   | `proposed / approved / executed / rejected / blocked` | 动作状态枚举                    |
| 命令超时           | `30_000` ms                                           | `execute_action` 单次执行上限   |
| 命令白名单         | 20 个只读命令                                         | 见"支持范围"                    |

## 结果语义

### Reflector 决策

| decision                   | 含义                                                         |
| :------------------------- | :----------------------------------------------------------- |
| `approve`                  | 不变量检查全部通过                                           |
| `rollback_or_human_review` | 至少一条违规：任务 `completed` 但证据缺失，或动作 `executed` 但 observation 缺失 |

### Action 返回 `isError`

| 情况                                                         | `isError` |
| :----------------------------------------------------------- | :-------- |
| 操作成功                                                     | `false`   |
| 前置条件不满足、白名单拒绝、UI 拒绝、超时、取消、状态校验失败 | `true`    |

### 三态语义

| 状态             | 含义                                                         |
| :--------------- | :----------------------------------------------------------- |
| `approved`       | Reflector 决策为 approve                                     |
| `needs_rollback` | Reflector 决策为 rollback_or_human_review；Agent 应主动调用 rollback |
| `tool_error`     | Action 自身返回 isError=true；Agent 应读取错误并修正参数     |

> ⚠️ reflect 只报告，不修复。看到 `isError=true` 的 reflect 响应后，Agent 必须显式调用 `rollback`。

## 运行产物

IRCopilot 不向待审计系统或目标主机写入任何文件。

| 产物                 | 路径                                                 |
| :------------------- | :--------------------------------------------------- |
| 会话级状态快照       | Pi session entries（customType = `ircopilot-state`） |
| 重置标记             | Pi session entries（customType = `ircopilot-reset`） |
| 命令 stdout / stderr | IRCopilot 内存 `state.observations`；不落盘          |

跨会话恢复：只要 session 文件未删除，state 会自动从最后一个 `ircopilot-state` entry 恢复。

显式重置：

```
<TEXT>
/ircopilot-reset
```

弹窗确认后，session 会写入一条 `ircopilot-reset` 标记，下次启动时该标记之后的 state 会被清空。
