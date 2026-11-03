# 上下文管理重构计划（复刻 Claude Code / cc-haha 机制）

> 2026-06-11 调研产出。参考项目：`<reference-root>/cc-haha`
> 症状：用户发一句话后 agent 就"忘记"已读文件、重新读取；长任务中早期上下文被掏空。

---

## 一、现状诊断（4 个根因，按嫌疑排序）

### 根因 1：`_read_file_state` 随每条用户消息重置 ⭐ 最直接原因
- `agentmain.py:558` — 每条用户消息都 `handler = SecHeurAgentHandler(...)` 新建 handler
- `secheur_core.py:538` — `self._read_file_state = {}` 挂在 handler 实例上，随之清空
- `secheur_core.py:622-624` — 编辑前强制校验 `if path not in self._read_file_state: "必须先读取文件再编辑"`
- **后果**：用户每发一句话，上一轮已读文件全部"失忆"，被强制重读。这正是用户抱怨的现象。

### 根因 2：trim 阈值按字符数且默认过小
- `llmcore.py:701` — `default_context_win = 30000`；`llmcore.py:255` — `cap = context_win * 3` = 9 万**字符** ≈ 2-3 万 token
- 对 200K/1M 上下文模型，相当于只用了 10-15% 窗口就开始破坏性压缩
- token 计量与真实 API usage 完全脱节（API 返回的 usage 只用于计费，`llmcore.py:16-58`）

### 根因 3：压缩是破坏性截断，不是摘要
- `llmcore.py:133-164` `compress_history_tags` — 每 5 次调用就把第 10 条之前消息的 tool_result/thinking 截到 800 字符 → 早先读的文件内容很快被掏空
- `llmcore.py:176` `microcompact_history_text(keep_recent=2)` — 触发时除最近 2 条外全部压到 160-500 字符，连原始用户需求都被压掉
- `llmcore.py:267-274` — 整条 pop 旧消息，只留 ≤900 字符 `<earlier_context>` 摘要

### 根因 4：压缩节流计数器是模块级全局变量
- `llmcore.py:135` — `compress_history_tags._cd` 是函数属性（模块级），多 session/子 agent 共享，压缩时机互相干扰、不可控

---

## 二、参考项目（cc-haha）的核心机制

四层防线，从"事前防膨胀"到"兜底截断"：

| 层 | 机制 | 关键点 |
|---|---|---|
| 1. 事前 | Read 去重 + 大结果落盘 | 同路径同 offset/limit 且 mtime 未变 → 返回 `FILE_UNCHANGED_STUB`（"内容未变，参考之前的读取结果"）；单工具结果 >50K 字符落盘，上下文只留 2000 字节 preview + 文件路径 |
| 2. 缓存冷时 | time-based microcompact | 距上次响应超时（prompt cache 已失效）→ 把旧 tool_result 清成 `[Old tool result content cleared]` 占位符，只保留最近 N 个 |
| 3. 接近阈值 | LLM 摘要式 autocompact | 阈值 = contextWindow − maxOutput − 13K **token**；用单独 LLM 调用生成 9 节结构化摘要（用户意图/技术概念/文件与代码/错误与修复/全部用户消息/待办/当前工作/下一步）；摘要后**重注入最近读过的最多 5 个文件**（预算 50K tok、单文件 5K） |
| 4. 兜底 | PTL 反应式截断 | 摘要请求自身超长时按 API round 从头丢弃重试，最多 3 次 |

支撑设施：
- **file-state 缓存**：LRU（100 条/25MB），entry = `{content, mtime, offset, limit}`，用于 Read 去重、先读后写校验、压缩后文件恢复。**会话级生命周期，不随用户消息重置**
- **token 计数**：上次 API usage（input+cache_read+cache_creation+output）+ 之后新消息的粗估（普通文本 `chars/4`，JSON 类 `chars/2`，图片固定 2000 tok）—— 比纯字符估算准得多且零成本
- **会话存储**：每会话一个 JSONL，消息带 uuid/parentUuid 链；compact boundary 记录保留段锚点，resume 时重建链
- **失败熔断**：compaction 连续 3 次失败就停止重试，避免死循环
- **prompt cache 友好**：所有动态注入（todo、plan、skill 提醒）统一包成 `<system-reminder>` user 消息追加在尾部，绝不改写历史字节，保证缓存命中

---

## 三、复刻计划（4 个阶段，每阶段可独立交付）

### P0 — 快速止血（半天，不动架构）⭐ 优先做

1. **`_read_file_state` 跨轮传递**
   - `agentmain.py:558` 附近，新建 handler 时从旧 handler 继承：
     `handler._read_file_state = dict(self.handler._read_file_state) if self.handler else {}`
   - 仿照现有 `key_info`/`passed_sessions` 的传递方式（`agentmain.py:563-567`）
   - 校验处（`secheur_core.py:622`）增加 mtime 检查：文件 mtime 比记录新才要求重读，防止基于旧内容编辑
2. **调大并修正 trim 阈值**
   - `llmcore.py:701` — `default_context_win` 按模型真实窗口设置，并支持在 `mykey.py` 按模型配置 `context_win`
   - `trim_messages_history` 的 `cost()` 从纯字符改为 token 粗估：`len(json.dumps)/4`（含大量中文时 `/2`），阈值单位统一为 token；cap 设为 `context_win - max_tokens - 安全余量`
3. **`_cd` 计数器移到 session 实例**
   - `llmcore.py:135` 的函数属性改为 `sess` 实例属性，由 `trim_messages_history` 传入，消除跨 session 干扰

**验收**：连续多轮对话编辑已读文件不再要求重读；`[Cut]`/`[Microcompact]` 日志在正常长度对话中不再出现。

### P1 — Read 去重 + 基于 usage 的 token 计数（1 天）

1. **Read 去重**（复刻 cc-haha `FileReadTool.ts:524-569`）
   - `do_file_read`（`secheur_core.py:1157`）入口：查 `_read_file_state`，若同路径同 offset/limit 且 `os.stat().st_mtime_ns` 未变 → 直接返回短 stub：`"文件自上次读取未变化，参考之前的读取结果"`
   - `_read_file_state` entry 扩展为 `{mtime_ns, offset, limit, size}`（不必存 content，history 里已有）
   - 给 `_read_file_state` 加 LRU 上限（如 100 条）防泄漏
2. **基于 API usage 的 token 计数**（复刻 `tokens.ts:244-279`）
   - `llmcore.py` 的 usage 记录（:16-58）已有数据，新增 `sess.last_usage_tokens`；每次响应后更新
   - 当前上下文 token ≈ `last_usage_tokens + estimate(新增消息)`；trim 决策全部改用此值
3. **大结果落盘对齐**：现有 `agent_loop.py:55-72`（>30000 字符落盘）保留，preview 从当前值调到 ~2000 字节 + 明确给出落盘路径提示

**验收**：重复让 agent 读同一文件，第二次返回 stub；日志显示的 token 数与 API usage 偏差 <15%。

### P2 — LLM 摘要式 compaction（2-3 天，核心改造）

替换 `trim_messages_history` 的破坏性截断链（`llmcore.py:254-275`）：

1. **触发**：`estimated_tokens > context_win - max_output - 缓冲(约13K)` 时触发 autocompact；保留手动 `/compact` 命令入口
2. **摘要生成**：
   - 用同一个 backend 发一次独立请求（不进 history），prompt 复刻 cc-haha 9 节结构：
     1) 用户主要意图与明确要求 2) 关键技术概念 3) 涉及的文件与代码片段 4) 错误与修复 5) 所有用户消息列表 6) 待办事项 7) 当前正在做的工作 8) 下一步（可选）
   - 摘要前把图片块替换为 `[image]` 占位
3. **拼回**：新 history = `[compact 边界系统提示, 摘要(user 消息, 标记 is_compact_summary), 最近 N 条原始消息]`
4. **文件重注入**：从 `_read_file_state` 按时间取最近 5 个文件，重读注入（预算 ~50K token、单文件 5K），随后清空 `_read_file_state`（内容已新鲜）
5. **熔断**：摘要连续 3 次失败 → 回退到现有 `microcompact + pop` 截断（保留旧代码作 fallback）
6. **保留** `compress_history_tags` 作为轻量层，但把 `keep_recent` 调大（如 20）、`max_len` 调大（如 3000），只在 token 压力 >70% 时才启用

**验收**：构造超长对话触发 compaction 后，agent 仍能答出最初的用户需求和已完成事项；压缩后立即编辑此前读过的文件不需重读。

### P3 — 结构化会话存储 + 可靠 resume（2 天，可选）

替换现有基于日志正则解析的 `session_resume.py`（任一条解析失败即全弃，:86-87）：

1. 每会话一个 JSONL：`temp/sessions/<session_id>.jsonl`，每条消息 append 一行 `{uuid, parent_uuid, role, content, timestamp, model}`
2. compaction 时写入 `{type: "compact_boundary", summary_uuid, kept_from_uuid}` 元数据行
3. `/resume`：读 JSONL 重建消息链，从最后一个 compact boundary 之后恢复（之前的用摘要替代）
4. 旧的日志解析 resume 保留为 fallback

**验收**：杀掉进程后 `/resume` 能恢复到压缩边界后的完整状态。

### P4 — 锦上添花（按需）

- **time-based microcompact**：距上次 API 响应 >5 分钟（prompt cache 已冷）时，把旧 tool_result 清成占位符——反正缓存要重建，不亏
- **SessionMemory**：会话内持续把关键信息写入记忆文件，compaction 时可直接丢弃更多旧消息（现有 `history_info`/`key_info` 机制已是雏形，可对齐）
- **`<system-reminder>` 注入规范化**：动态提醒统一追加在消息尾部而非改写历史，提升 prompt cache 命中率

---

## 四、实施顺序与风险

| 阶段 | 工作量 | 风险 | 依赖 |
|---|---|---|---|
| P0 | 半天 | 低（参数与传递修改） | 无 |
| P1 | 1 天 | 低 | P0 |
| P2 | 2-3 天 | 中（需充分测试摘要质量与熔断） | P1 的 token 计数 |
| P3 | 2 天 | 低 | 无（可与 P2 并行） |
| P4 | 按需 | 低 | P2 |

**只做 P0 就能消除用户当前抱怨的"发一句话就失忆重读文件"**；P1+P2 解决长任务中上下文被掏空的根本问题。
