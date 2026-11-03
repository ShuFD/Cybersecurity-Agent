# IRCopilot Pi Extension

面向 SecHeur Agent 的事件响应工作流插件。设计依据为 IRCopilot 论文（arXiv:2505.20945）及作者公开实现，但运行时复用 Pi Agent 核心，不创建独立 LLM 会话。

## 定位

IRCopilot 是事件响应控制面，负责 Detect、Respond、Recover 生命周期，Planner、Generator、Analyst、Reflector 职责，以及 IRT、授权、动作合同、证据、假设、时间线、反思与完成门禁。

SecHeur 的 CTF/Pi/MCP 能力是执行面，负责环境信息采集、日志/内存/进程/网络/恶意文件分析，以及 Shell、浏览器、CTF Toolbox 和安全知识 Skill 调用。

插件不注册第二套 Shell，不维护命令白名单，也不调用 `pi.exec`。因此 IRCopilot 工作流可复用 Linux、Windows、容器、网络和离线取证能力，而不与 CTF 层重复。

## 工作流

```text
init -> add_task / plan -> propose_action
     -> approve_action（仅高风险或目标变更动作）
     -> start_action -> 外部 CTF/Pi/MCP 工具
     -> record_observation -> analyze
     -> record_hypothesis / record_timeline
     -> reflect -> set_phase -> finish / report
```

`propose_action` 只登记步骤、预期证据、风险和建议工具。`start_action` 返回执行合同，不直接触碰目标。外部工具完成后，必须记录准确的工具调用和产物引用，再由 Analyst 转换为证据。

## 初始化与授权

```text
action=init
authorized=true
authority="SOC lead / asset owner"
assets=["web-01", "memory-image.raw"]
exclusions=["production database writes"]
rules=["preserve original evidence", "redact credentials"]
title="SSH brute-force investigation"
incidentType="credential attack"
osFamily="linux"
```

缺少授权确认、授权主体或资产范围时不能初始化。schema v1 旧会话会迁移为“需要重新授权”，调用 `set_scope` 后才能执行动作。

## IRT 与证据

任务分为 `objective` 和 `procedure`。目标任务不能标记为 `not_applicable`。每项任务可以声明 `requiredEvidence`；`analyze` 使用 `satisfies` 显式映射证据要求，缺项时不能完成任务。

Observation 只保存摘要、来源、外部工具引用和受保护产物引用。不要把凭据、令牌、私钥或大段原始日志写入摘要。含秘密信息时必须设置 `sensitivity=secret`。

## 动作与审批

动作类型为 `investigate`、`contain`、`eradicate`、`recover`、`validate`。目标变更动作以及 `high`/`critical` 风险动作需要 UI 人工审批，所有变更动作必须提供 `rollbackPlan`。暂停、急停、授权过期或未重新授权时会拒绝动作。

## Reflector 与完成门禁

`reflect` 检查已完成任务的证据、动作的 Observation、变更动作的回滚计划，以及假设结论的证据。发现问题时返回 `rollback_or_human_review`，由 Agent 补证、人工复核或回滚。

`finish` 要求处于 `recover` 阶段，没有未结任务、动作和开放假设，并提交执行摘要、范围与局限、时间线、影响、响应与恢复、残余风险和建议。

## 状态与加载

状态使用 Pi session entries：`ircopilot-state-v2`、兼容旧 `ircopilot-state`，重置标记为 `ircopilot-reset`。保留最近 12 个快照；回滚后的较新证据标记为 `invalidated`，不从审计记录中消失。

循环保护配置位于 `ircopilot.json`。`softMutationLimit` 只提示人工检查进度，`hardMutationLimit=0` 表示关闭插件级硬额度并让 Agent 运行时的全局预算作为主限制；设置为正整数才会启用插件兜底硬停。`repeatedErrorLimit` 只统计同一 action、同一错误指纹的连续重复，不统计 `status`、`report`、`export` 等只读调用。熔断原因和计数会出现在 `status` 中；人工复核后调用 `set_controls paused=false` 可清除熔断和错误连续计数。

```bash
pi -e ./packages/ircopilot-pi-extension/src/ircopilot.ts
```

项目级部署可将同一文件放入 `.pi/extensions/ircopilot.ts`。插件注册 Tool `ircopilot` 以及 `/ircopilot`、`/ircopilot-reset`。

## 参考

- X. Lin et al., "IRCopilot: Automated Incident Response with Large Language Models," arXiv:2505.20945.
- IRCopilot 作者公开 README、IRBench 和参考实现。

上游资料只作为设计依据。其独立多会话 Python 架构、Provider API 和交互式命令执行器没有复制到本插件。
