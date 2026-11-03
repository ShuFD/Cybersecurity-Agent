# 攻击知识检索（RAG）设计

本文介绍 SecHeur 攻击知识检索模块的设计思路与实现方式。它解决的问题是：解题 agent 在应对 CTF 题目时，需要与攻击类型匹配的参考知识（常用手法、利用原语、前置条件）。系统把这些资料预先检索出来，注入模型可见的上下文，供其解题时参考。

这里有一个贯穿始终的前提：**主模型不直接调用知识库**。检索的时机、查询内容、是否注入，都由独立的决策层统一控制，而不是交给模型自行判断。这样保证检索策略是确定性的、可审计的，也不会在检索路径上引入额外的大模型调用。

实现分为两层：

- 决策层位于 `packages/secheur-agent/src/knowledge-retrieval.ts`，核心是 `KnowledgeRetrievalCoordinator`。
- 检索层位于 `legacy/ctf_attack_memory/index.py`、`legacy/memory_search.py`，负责实际的索引查询。
- 两层通过 `extension.ts` 中的 Pi 生命周期 hooks 衔接。

## 工作流程

一次完整的循环如下：

1. 会话开始后先做任务识别，判断当前题目属于哪一类（比赛信封、任务描述、或一句话指令）。识别成功则绑定任务，并标记待执行的首次检索。
2. 首次检索（bootstrap）的结果直接拼入系统提示，为模型提供该类型题目的基础攻击面参考。
3. 模型执行工具时，决策层读取工具输出，从中提炼规范化证据——例如程序未开 PIE、libc 版本 2.31、出现堆溢出。flag、token、cookie 等敏感值先脱敏，不会进入证据。
4. 新证据出现后标记"待细化检索"，但不会立即执行，而是等当前回合结束后统一检索一次，使并行工具批次的结果合并为单次查询。
5. 候选结果经过质量筛选，按分数排序后取前若干条，注入下一轮推理的上下文。
6. 当进度裁判判定模型停滞时，额外触发一次"失败模式与替代路线"的检索。

## 任务识别

任务来源按优先级从高到低判断，命中即止：

- **比赛信封**（competition envelope）：最可信，直接采用其任务信息。
- **任务描述**（descriptor）：由 legacy 层预判为 CTF 题目或要求验证 flag。
- **显式意图**（explicit）：从用户输入中识别"攻击动作 + 具体技巧/领域"。例如"破解这个 SQL 注入"会命中；"修复 SQL 注入测试"不会（属于开发任务）。

泛化指令（"继续""换种思路"）沿用当前任务，不触发切换；仅当出现新任务 ID、新目标端点或明确重置时才重建任务。

类别（web/pwn/crypto/reverse）在此阶段尽量识别。无法识别类别时任务不绑定，后续不再触发检索。

## 检索触发时机

共三种触发，分别对应不同的检索目标和接受阈值：

- **bootstrap**：任务绑定后的首次强制检索。接受阈值较低（0.5），主要寻找该类题目的常见攻击面与基础前提。
- **evidence_refinement**：工具结果贡献了新证据。接受阈值较高（0.72），目标是当前线索匹配的利用路径，属于纵深检索。
- **stall_recovery**：进度裁判判定停滞。首次停滞即触发，此后每连续两次停滞复审一次；检索不重置裁判的停滞计数。

bootstrap 的结果注入系统提示；后两者以 user 消息形式注入，使模型在下次推理前可见。

## 检索与筛选

每次检索的执行路径是固定的：

```
根据任务与证据构建查询条件
  → 计算查询指纹，相同指纹不重复检索
  → 调用 Python 检索层，获取至多 20 条候选
  → 解析为统一结构
  → 质量筛选（硬性淘汰 + 加权打分）
  → 排序取前 3 条，总量限制在 1 万字以内
  → 记录已注入 ID，写入审计日志
```

存在一次性的确定性改写：当细化检索结果均不满足接受条件时，取最接近的候选，将其失败模式追加进查询条件重新检索一次。每个证据修订版本至多执行一次，不反复尝试。

Python 调用设置了 3 秒硬超时，超时视为无结果。底层调用不真正中断，仅丢弃晚到的结果——Python 侧是共享常驻进程，强行中断可能影响后续工具调用。

## 质量筛选

筛选分两级：

硬性淘汰，命中任一项即丢弃：
- 类别不匹配；
- 已注入过；
- 缺少攻击手法标签；
- 缺少来源 URL；
- 文本含乱码；
- 前置条件与当前证据冲突（如资料要求 PIE 而目标未开 PIE、glibc 版本不符）。

加权打分，综合以下维度：
- 与当前证据的匹配度（攻击手法、关键事实重合）——权重最高；
- 前置条件在已有证据中的满足比例；
- 来源可靠性；
- 相对次高分的领先幅度。

总分与阈值比较决定接受、进入"再查一次"候选、或拒绝。bootstrap 与停滞场景证据稀少，阈值放低（0.5）；细化检索阈值提高至 0.72。当前阈值为全局常量，按类别校准的工作尚未进行。

## 与模型的配合

- 普通模式：`attack_memory_search` 工具对模型可见，允许模型自行补充检索。
- 比赛任务（solve 模式）：工具从活动工具集移除，模型只能依赖注入结果，保证检索策略统一受控。设置环境变量 `SECHEUR_KNOWLEDGE_MANUAL_TOOL=1` 可重新暴露，供调试使用。

## 状态与审计

每个会话在 `<stateDir>/runtime/sessions/<会话ID>/` 下保存两个文件：

- `knowledge-state.json`：任务、证据、检索记录的规范化状态。只保存事实与哈希，不保存 prompt 与工具原文。
- `knowledge-retrieval.jsonl`：每次检索决策的审计日志，记录触发原因、查询指纹、候选数量、接受与拒绝情况等。

另有 shadow 模式（`SECHEUR_KNOWLEDGE_SHADOW=1`）：仅记录旧正则策略的判断结果用于对比，不实际注入。

## 配置项

- `knowledgeBaseEnabled`：总开关，由环境变量 `SECHEUR_KNOWLEDGE_BASE_ENABLED` 或桌面配置控制。
- `reloadKnowledgeBaseConfigBeforePrompt`：每次 prompt 前重读配置并同步工具可见性，默认开启。
- `SECHEUR_KNOWLEDGE_MANUAL_TOOL=1`：调试开关，用于 solve 模式重新暴露工具。

### 设置界面与运行时必须读同一个配置文件

`desktop-config.json` 同时被设置界面和运行时读取，两者的目录解析必须一致：

- `resolveSecHeurStateDir()`（`packages/secheur-agent/src/config.ts`）是唯一的解析入口，优先 `SECHEUR_CONFIG_DIR`，否则用 `<projectRoot>/.secheur-agent`。
- `packages/secheur-agent/src/desktop-config.ts` 的 `stateDir()` 调用同一函数，**不得**自行拼接 `join(root, ".secheur-agent")`。

一旦两边解析到不同目录，设置界面保存的 `knowledgeBaseEnabled` 只会写入运行时从不读取的文件：勾选状态看起来"保存了"，但检索始终以 `allowed=false` 运行。

保存设置走 `updateDesktopConfig()`（合并写入）而不是 `writeDesktopConfig()`（整体覆盖）：该文件还存放部署侧的 `executionMode`、`planning` 等键，设置界面提交的表单并不包含它们，整体覆盖会抹掉执行模式。

## 审计日志字段

`knowledge-retrieval.jsonl` 每行是一次检索决策。用于消融对比的字段：

| 字段 | 含义 |
| --- | --- |
| `allowed` / `knowledge_base_enabled` | 决策时开关的实际取值。`false` 表示"开关关闭"，与"检索了但没结果"含义相反，必须区分 |
| `trigger` | `task_bootstrap` / `evidence_refinement` / `stall_recovery` / `manual_tool` |
| `decision` | `injected` / `rejected_all` / `empty_result` / `skipped_not_allowed` / `model_initiated_retrieval` 等 |
| `candidate_count` | 检索返回的候选数 |
| `injected_card_ids` | 真正渲染进模型上下文的卡片 |
| `injected_characters` | 注入文本的字符数，即本次检索消耗的上下文预算 |
| `injected_into_context` | 本次决策是否改变了模型上下文 |
| `retrieval_latency_ms` | 纯检索耗时（不含门禁与注入） |
| `knowledge_base_snapshot` | 语料快照：`schema_version`、`record_count`、`card_fingerprint` |

`manual_tool` 触发来自模型主动调用 `attack_memory_search`。自动检索由 coordinator 自己记录；没有这条腿就无法区分"agent 从没主动用过知识库"和"它用了但全都返回空"。

### 汇总为逐题表

```bash
python3 scripts/kb_audit_summary.py <stateDir 或 artifact 目录> [--json]
```

输出每个会话一行（开关状态、检索次数、注入次数、卡片数、注入字符、检索耗时、语料指纹），并在 on 组跨越多个指纹时告警——指纹不一致说明这批结果不是固定快照，不能直接相减。

审计目录权限为 `0700`，需以 bridge 运行用户（`pi-eval`）读取。

## 发布包中的语料范围

`packages/secheur-agent/scripts/attack-memory-publish.mjs` 定义了哪些语料文件进入发布包，`stage-legacy.mjs`（拷贝）和 `verify-dist.mjs`（校验）共用同一份规则。**两者必须共享**：`stage-legacy` 少拷一个分类，运行时该分类就静默返回空，在审计日志里和"知识库没东西"完全一样。

规则：发布 `memory/attack_memory/<category>_v*/` 下的 `manifest.json`、`records.jsonl`、`embeddings.jsonl`，以及 `<category>/knowledge/cards.jsonl`；排除 `evidence/`（蒸馏中间产物，查询时从不读取）。新增分类目录无需改代码。

构建时会校验每个 `*_v*` 目录的 `manifest.json` 与 `records.jsonl` 都已落盘，缺任一即构建失败——分类缺失必须炸出来，不能悄悄缩小被评测的语料。

当前发布语料：10 个分类 / 7625 条（crypto_v1 6124、crypto_v2 250、pwn_v1 30、pwn_v2 83、pwn_v3 40、pwn_v4 334、reverse_v1 84、reverse_v2 185、web_v1 144、web_v2 351）。

检索路径按分类不同：**crypto** 只读 `knowledge/cards.jsonl`（卡片优先，`cards.jsonl` 存在时不再回退 `records.jsonl`）；**pwn / web / reverse** 读 `records.jsonl` + `embeddings.jsonl`。

`record_count` 会统计无 manifest 的分类（按卡片文件行数），因为 crypto 不带 manifest；否则快照会把语料规模严重低估。

### 已知语料问题

- **crypto 实际可检索面只有 11 张卡片**。`crypto_v1` + `crypto_v2` 共 6374 条记录，但因"卡片存在即不回退"的策略全部不可检索；两张卡片集覆盖的攻击族仅 11 个（RSA small-d/e、Coppersmith、Fermat、Hastad、common modulus、padding oracle、bit flipping、hash length extension、PRNG state recovery、keystream reuse）。crypto 之外的题目基本检索为空。
- **crypto_v1 与 crypto_v2 的 `knowledge/cards.jsonl` 内容完全相同**（md5 一致），检索时同一张卡片被返回两次，白白占用 top_k 配额。
- 证据提取规则表（`CRYPTO_RULES` 等）没有 PRNG / LCG / 线性同余 等条目，对应题目即使 agent 已观察到特征也提不出 technique，检索 query 缺少关键信号。

## 关键参数

- 每轮注入至多 3 张卡片，总长不超过 1 万字。
- 单次检索超时 3 秒，候选请求数 20。
- 证据容量：技巧至多 16 条、事实至多 40 条、失败路线至多 8 条。
- 任务目标截断至 400 字。

## 近期修复

- 证据提取中 `matchAll` 对非全局正则调用会抛错，导致证据长期收集失败。已改为对正则构造全局副本后再提取。
- solve 模式下工具隐藏逻辑早于任务绑定执行，工具始终未被移除。现于任务绑定后重新同步，并在比赛信封绑定后立即隐藏。
- 新证据覆盖了待执行的 bootstrap 标记，导致开题强制检索被跳过。现已避免覆盖。
- Python 侧非 crypto 卡片与 crypto 卡片使用不同标识，导致其跳过质量审查。现已统一进入同一套门禁。
- `desktop-config.ts` 忽略 `SECHEUR_CONFIG_DIR`，与 `config.ts` 解析到不同目录，设置界面的知识库开关从未生效。已统一为 `resolveSecHeurStateDir()`。
- 设置保存整体覆盖 `desktop-config.json`，会抹掉部署侧的 `executionMode` / `planning`。已改为 `updateDesktopConfig()` 合并写入。
- 审计日志缺少语料版本、是否进入模型上下文、注入体积和模型主动检索的记录。已补齐并新增 `scripts/kb_audit_summary.py`。

## 遗留问题

- 接受阈值为全局常量（0.5 / 0.72），未按类别校准。
- 证据提取规则表（攻击手法与事实的匹配正则）为手工维护，需随攻击技法演进补充。
- crypto 卡片集存在后不再回退原始 writeup，未覆盖主题可能无结果。
- 目前知识卡片以 crypto 为主；后续补充 pwn/web/reverse 卡片时，`memory_search` 的"卡片优先返回"逻辑需相应调整。
- 门禁只注入过阈值的卡片。缺少具体目标证据时（开题阶段、泛化描述）整轮检索会被全部拒绝，此时知识库等价于未开启。做消融时应按 `trigger` 分层统计，而不是只看整场平均值。
