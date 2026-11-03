# cc-haha → SecHeur Agent 迁移计划（全子系统对比）

> 2026-06-11 调研产出。参考项目：`<reference-root>/cc-haha`（TypeScript + Bun）
> 目标项目：`<project-root>/agent`（Python）
> 上下文管理部分见同目录 `context-management-rework.md`，本文不重复。

---

## 〇、差距总表

| 子系统 | cc-haha | SecHeur Agent 现状 | 差距 | 优先级 |
|---|---|---|---|---|
| 上下文管理 | 四层防线 + LLM 摘要 | 字符截断式破坏压缩 | 大 | ⭐⭐⭐ 见另一文档 |
| 工具结果协议 | 标准 tool_result 块 + id 配对 | 结果拼进下一条 user 文本 | 大 | ⭐⭐⭐ A1 |
| Prompt cache | 静态/动态边界 + 历史字节不变 | compress 改写历史 → 持续 cache miss | 大 | ⭐⭐⭐ A2 |
| Bash 权限分析 | AST 解析 + 子命令拆分 + LLM 分类器 | 23 条正则黑名单，默认 allow | 大（安全） | ⭐⭐⭐ B1 |
| 工具并发编排 | isConcurrencySafe 元属性 + 批次合并 | 4 个硬编码并行工具 | 中 | ⭐⭐ C1 |
| 子代理隔离 | 克隆上下文独立运行 + 并行 + 后台 | CLI 路径直接注入主对话 | 大 | ⭐⭐ C2 |
| 后台任务 | run_in_background + 输出落盘 | 无 | 中 | ⭐⭐ C3 |
| 进程组管理 | 持久 shell + 进程组 kill | kill 不杀孙进程 | 小 | ⭐⭐ C4 |
| Hooks | 25+ 事件、外部命令、可阻断/改写 | 进程内 Python 回调，异常被吞 | 中 | ⭐ D1 |
| Plan mode | ExitPlanMode + 用户审批 + 语义权限 | 正则数 checkbox 自动退出 | 中 | ⭐ D2 |
| API 重试 | 前台/后台差异化重试 | 较完整（指数退避+故障转移） | 小 | ⭐ D3 |
| Skills | fork 真隔离子代理 | fork 只是措辞包装 | 小 | ⭐ D4 |
| MCP | 完整生命周期 + 命名空间过滤 | 仅 stdio、15s 固定超时 | 小 | ⭐ D5 |
| 工具延迟加载 | shouldDefer | tool_registry deferred ✅ 已有 | 无 | 不需要 |
| 记忆系统 | memdir + SessionMemory | L0-L4 分层 ✅ 思路已对齐 | 小 | 不急 |

---

## A 级：直接影响日常体验和 API 成本（最先做）

### A1. 工具结果改为标准 tool_use / tool_result 协议

> **2026-06-11 复核修正**：native 路径已基本达标——`NativeToolClient.chat`（`llmcore.py:1100-1133`）会把 tool_results 构造成带 `tool_use_id` 的标准 `tool_result` 块，并为漏配对的 pending id 补空结果；`_fix_messages` 在发送前清理孤立配对；trim 弹出消息时 `_sanitize_leading_user_msg` 把边界上的孤立 tool_result 转为文本。纯文本 XML 协议仅是非原生模型的 fallback，属设计内。**A1 降级为低优先：仅剩"XML fallback 收敛到独立 adapter"一项可选清理。**

**cc-haha 做法**：assistant 消息含 `tool_use` 块（带 id），下一条 user 消息含 `tool_result` 块（`tool_use_id` 严格配对）。这是 API 原生协议，模型对此训练充分，遵循度远高于自定义 XML。

**现状**：`agent_loop.py:292` 把工具结果拼进下一条 user 消息文本；`llmcore.py:197` `_sanitize_leading_user_msg` 需要专门清理"孤立 tool_result"——说明配对不严格，trim 时经常把 tool_use 和 tool_result 拆散。

**迁移步骤**：
1. `NativeToolClient` 路径强制 `tool_use.id ↔ tool_result.tool_use_id` 配对，禁止展平为文本
2. trim/压缩时把 tool_use 与对应 tool_result 视为**原子对**，要删一起删（cc-haha compaction 按 API round 分组就是为此）
3. 非 Anthropic 模型保留 XML 文本协议，但收敛到独立 adapter 层，同一条 history 内不混两种格式

**工作量**：2 天。**风险**：中，需回归测试全部工具。

### A2. Prompt cache 稳定性：停止改写历史字节 💰

**cc-haha 做法**：
- 历史消息一旦发出**永不修改**；动态注入（todo 提醒、plan 状态等）统一作为 `<system-reminder>` 追加在尾部
- system prompt 用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分静态段/动态段，cache breakpoint 设在边界（`src/constants/prompts.ts:114`）
- 工具池排序稳定：内置在前、MCP 在后、组内定序（`src/tools.ts:346-368`），请求前缀字节恒定
- `promptCacheBreakDetection` 监测 cache_read 突降报警

**现状**：`compress_history_tags`（`llmcore.py:133`）每 5 次调用**原地改写老消息** → 前缀 cache 全失效，反复支付 cache_creation。这是隐形成本大头。`_get_anchor_prompt`（`secheur_core.py:1290`）注入的工作记忆若落在消息中部同样破坏缓存。

**迁移步骤**：
1. 砍掉周期性 `compress_history_tags`（仅保留为 compaction 时的一次性手段）——配合上下文计划 P2："要么不动历史，要动就一次性大动"
2. anchor/工作记忆/文件新鲜度提示等动态内容一律放进**最后一条 user 消息**，不碰历史
3. system prompt 拆静态段（sys_prompt.txt + 工具说明，放前面）和动态段（日期、记忆预取、skills 清单，放后面）；Anthropic 路径在静态段尾设 cache_control breakpoint
4. usage 记录（`llmcore.py:16-58`）加 cache_read 占比日志，验证命中率

**工作量**：1-2 天。**收益**：长对话 API 成本可降 50-90%，首 token 延迟显著下降。

---

## B 级：安全

### B1. Shell 命令权限分析：黑名单 → 解析式判定

**cc-haha 做法**（`src/tools/BashTool/bashPermissions.ts`）：
- tree-sitter 解析 bash AST（`src/utils/bash/ast.ts`），复合命令拆成子命令（`a && b | c` → 3 个），**每个子命令单独过规则**，拆分上限 50 防 DoS
- 规则语义：`Bash(git *)` 前缀通配（`shellRuleMatching.ts`）；allow/deny/ask 三类 × 6 来源分层（user/project/local/policy/cliArg/session）
- 环境变量劫持检测（`PATH=x cmd`）、wrapper 剥离（`time`/`nice` 套壳）
- 静态判不了的交给小模型分类（`bashClassifier.ts`）
- 工具默认 **fail-closed**：`buildTool()` 默认非只读、非并发安全（`src/Tool.ts:757-792`）

**现状**（`permission_guard.py`）：23 条正则黑名单（:25-49），`$(rm -rf /)`、`bash -c "..."`、多余空格均可绕过；无 shell 结构解析；**默认兜底 allow**（:251）；`inline_eval`（`secheur_core.py:664-670`）进程内 eval/exec 极危险。

**迁移步骤**：
1. 引入 `bashlex`（纯 Python bash 解析器；或先 `shlex` + 自写连接符拆分），把命令拆为子命令列表
2. 规则匹配改为命令级语义：settings.json 的 allow/deny/ask 作用对象从整串改为每个子命令，沿用 fnmatch
3. 检测 `VAR=x cmd` 前缀和 `bash -c`/`sh -c`/`xargs`/`eval` 嵌套（递归解析内层）
4. 默认兜底从 allow 改为 ask（dontAsk/bypass 模式除外）
5. `inline_eval` 默认禁用或归入最高权限档
6. （二期）静态判不了时调便宜模型单次分类

**工作量**：3 天（不含 LLM 分类器）。**风险**：中——建议先以 log-only 模式跑一周，对比新旧判定差异再启用。

---

## C 级：能力增强

### C1. 工具元属性 + 并发批次编排

**cc-haha**：每个工具声明 `isReadOnly/isConcurrencySafe/isDestructive`；编排器把**连续的**并发安全调用合并成批并行（上限 10），写操作严格串行（`src/services/tools/toolOrchestration.ts:91-116`）。

**现状**：`agent_loop.py:9` 硬编码 `PARALLEL_SAFE_TOOLS`（4 个），且要求一轮全部命中才并行（:243-254）。

**迁移步骤**：
1. 给 `do_*` 加元数据装饰器：`@tool_meta(read_only=True, concurrency_safe=True, destructive=False)`，未声明默认 fail-closed（都为 False）
2. dispatch 改为：按顺序扫描调用列表，连续 concurrency_safe 的合并为一批 ThreadPoolExecutor 并行，遇到写操作切回串行
3. 权限系统（B1）和 plan mode 直接复用 read_only 元数据判"只读工具放行"

**工作量**：1 天。

### C2. 子代理 CLI 路径真隔离

**cc-haha**：`AgentTool` 派发时 `createSubagentContext` + `cloneFileStateCache` 克隆父状态（`src/tools/AgentTool/runAgent.ts:46-54`），子代理独立消息历史、独立 token 预算，结果以单条 tool_result 回传；transcript 写 sidechain 文件；支持并行与后台派发。

**现状**：桌面端已有隔离实现（`frontends/desktop_bridge.py:365-481` `run_temporary_sub_agent`），但 **CLI 路径退化**：`secheur_core.py:780-789` 无 runner 时直接把子代理 prompt 注入主对话——上下文不隔离，子代理的全部中间过程涌进主 history（这也加剧上下文爆炸）。

**迁移步骤**：
1. 把 `run_temporary_sub_agent` 的核心逻辑从 desktop_bridge **下沉到核心层**（如 `agent_loop.py` 或新建 `subagent_runner.py`）：新建独立 `BaseSession`（不共享 history）+ 新 handler + 受限 allowed_tools
2. `_read_file_state` 克隆给子代理（对齐 cc-haha cloneFileStateCache）
3. 子代理只把**最终报告**作为 tool_result 回传主对话；完整过程写 `temp/model_responses/subagent-<id>.txt`
4. CLI 与桌面端共用该核心实现；删除"prompt 注入主对话"的退化路径
5. （二期）支持一轮派发多个子代理并行执行

**工作量**：2-3 天。**收益**：主上下文不再被子任务过程污染——对"失忆"问题也有间接帮助。

### C3. 后台任务（run_in_background）

**cc-haha**：`LocalShellTask` spawn 后台进程，输出 spill 到磁盘，完成时通知模型；前台长命令可转后台。

**现状**：`code_run` 只有同步等待（默认 60s 超时，`secheur_core.py:657`），跑 dev server / 长编译只能阻塞或超时失败。

**迁移步骤**：
1. `code_run` 加 `run_in_background` 参数：spawn 后立即返回 task_id + 输出文件路径（`temp/tasks/<id>.out`）
2. 新增 `task_output(task_id)`（读输出+状态）与 `task_stop(task_id)` 工具
3. 任务结束时通过现有 hook 点（`agent_loop.py` 的 turn 钩子）注入一条完成通知
4. 任务注册表存 handler.working 或模块级 dict（注意 handler 每轮重建——挂到 parent 上）

**工作量**：1-2 天。

### C4. 进程组管理（小修）

**现状**：`code_run` kill 不杀进程组，孙进程残留。
**迁移**：spawn 时 `start_new_session=True`（POSIX setsid），kill 用 `os.killpg(os.getpgid(pid), SIGTERM)`，超时升级 SIGKILL。**工作量**：半天。

---

## D 级：按需做

### D1. Hooks 外部命令化
**cc-haha**：25+ 事件（PreToolUse/PostToolUse/UserPromptSubmit/Stop/PreCompact/SessionStart…），settings.json 配置 shell 命令，exit code 2 = 阻断并把 stderr 给模型，JSON 输出可修改工具输入/追加上下文（`src/utils/hooks.ts:341-360`）。
**现状**：`plugins/hooks.py` 进程内 Python 回调，无阻断语义，异常被吞（:10-25）。
**迁移**：1) settings.json 增加 `hooks` 段（事件 → 命令列表）；2) 在现有 `_hook` 触发点同时执行外部命令，stdin 传 JSON 上下文；3) 实现 exit 2 阻断 + JSON 返回值合并；4) hook 异常打日志不再静默。先做 PreToolUse/PostToolUse/UserPromptSubmit/Stop 四个最有用的。**工作量**：2 天。

### D2. Plan mode 审批闭环
**cc-haha**：`ExitPlanModeTool` 由模型主动调用 → 用户审批 → 附带 `allowedPrompts` 语义权限（"run tests"之类随计划一起被批准，`ExitPlanModeV2Tool.ts:64-89`）。
**现状**：checkbox 清零自动退出（`secheur_core.py:1187-1190`），无用户确认。
**迁移**：1) 新增 `exit_plan_mode` 工具，触发 ask_user 审批；2) 批准后切 permission_mode 并把计划存档；3) 保留 checkbox 兜底但仅在用户开启 auto 模式时生效。**工作量**：1 天。

### D3. API 重试差异化
**cc-haha 亮点**：仅"用户在等"的前台请求重试 529，后台分类器/摘要请求直接放弃，防止过载放大（`src/services/api/withRetry.ts:61-88`）。
**迁移**：`_stream_with_retry`（`llmcore.py:530`）加 `priority` 参数，compaction/记忆更新等后台调用传低优先级、限 1 次重试。**工作量**：半天。

### D4. Skill fork 真隔离
依赖 C2 完成后，`do_skill`（`secheur_core.py:733-755`）的 `context: fork` 改为真正派发子代理。**工作量**：半天（C2 之后）。

### D5. MCP 增强
超时可配置（替换 15s 硬编码）、`mcp__server__tool` 命名空间纳入 deny 规则过滤、（远期）SSE/HTTP transport。**工作量**：1 天。

---

## 不建议迁移的部分

- **Ink/React 终端 UI**：前端形态完全不同（pywebview/HTML），无迁移价值
- **tree-sitter bash 解析**：Python 生态用 `bashlex` 即可，不必引入 tree-sitter 绑定
- **@anthropic-ai/sandbox-runtime**：macOS `sandbox-exec` 已废弃且复杂；权限系统（B1）做好已覆盖大部分风险，sandbox 留待远期
- **worktree 隔离**：使用频率低，等子代理（C2）稳定后再说
- **Todo 双轨（TodoWrite + Task v1/v2）**：现有 `update_working_checkpoint`/goal_plan 协议已够用，避免重复造轮子

---

## 实施路线图

```
第 1 周  A2 prompt cache 稳定（1-2d）→ A1 tool_result 协议（2d）→ C4 进程组（0.5d）
         （同周可并行开始 context-management-rework.md 的 P0/P1）
第 2 周  B1 权限重构 log-only 灰度（3d）→ C1 工具元属性与并发（1d）
第 3 周  C2 子代理隔离（2-3d）→ C3 后台任务（1-2d）
第 4 周  B1 正式启用 + 上下文计划 P2（摘要式 compaction）
按需     D1 hooks → D2 plan 审批 → D3/D4/D5
```

**依赖关系**：A1 是 A2 和上下文 P2 的基础（原子对删除依赖 id 配对）；C1 的元数据被 B1/D2 复用；C2 是 D4 的前置。

**度量指标**（改造前后对比）：
- cache_read tokens 占比（A2 目标 >70%）
- 单任务平均 API 成本
- "必须先读取文件再编辑"提示出现次数（应归零）
- 长任务（>30 轮）结束时模型能否复述最初需求
