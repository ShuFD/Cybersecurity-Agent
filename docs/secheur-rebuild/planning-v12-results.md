# Planning V1.2 结果与交接协议

## 2026-09-27 流程简化（当前行为）

新建任务只需描述 `objective`、`doneWhen` 及确有必要的依赖或成果输入。`workContract` 和逐条验收标准仍可读取旧数据，但新任务不必填写。任务 DAG、作用域及来源校验继续由运行时执行。Executor 用简短的 `summary` 说明工作和结果；finding、artifact、未解决事项按实际需要填写。身份、时间、ID 与文件 hash 由运行时确定。模型文字只是声明，不能替代 evidence、文件或可信 Flag 验证。

`planning_commit_result` 将成果写入 SQLite 后返回 durable receipt；task 按 Executor 自述 outcome 结算，submission 的历史 `reviewStatus=pending` 保持原样。Planner 随即做下一次正常决策，不需要独立 review。旧 pending submission 在恢复时作为已保存、未经语义确认的成果提供，不能被伪造成 `accepted`。失败任务的部分成果同样可读取；`done`、durable 和 `verified_true` 是不同状态。

运行时规范化可选数组和已知引用、解析 lease 作用域内的相对文件路径、重算文件 hash，并在每次变换后复核。不可修复的格式或可选引用错误通过同一 Pi 工具返回字段、原因、修正提示和剩余机会；首次提交后最多两次模型修正。第三次对可降级的 finding、artifact 或引用逐项处理，保留有效内容并记录 `warnings` 和原输入摘要。非空 summary 本身可作为未经证实的进展交接；缺少 summary 则失败。第三次仍无法保存时立即结束 Pi 恢复，并由 Harness 封存失败进展。确认跨 run、身份冲突、取消及持久化错误立即终止。工具成功回执只在持久化后产生，同 lease 重试返回同一回执。

Planner 默认看到近期成果、未解决事项和必要引用；Executor 优先看到显式绑定及确定性依赖的成果与最近失败进展。`planning_read_result` 返回受提交上限约束的完整 summary，并列出该 submission 直接登记的文件，即使没有 finding 引用。关键成果先按原文进入上下文；总预算不足时才缩短正文，保留完整引用 ID 和文件路径，低相关历史随后压缩。上下文未装下全部正文时，保留省略诊断并让 Executor 按结果 ID 读取，不因此阻止执行。Trace 记录规范化字段、修正轮次、部分保留警告、durable submission 与终态；Bridge 白名单导出这些有界字段，不记录工具原文或候选 Flag。Bridge 和 Python Controller 的可信 proof 消费规则未改。

本轮对照阅读 Vercel AI SDK 提交 [`0c9ab5a7226dd13d642489271bfbe3db657c733c`](https://github.com/vercel/ai/tree/0c9ab5a7226dd13d642489271bfbe3db657c733c) 的 [`parse-and-validate-object-result.ts`](https://github.com/vercel/ai/blob/0c9ab5a7226dd13d642489271bfbe3db657c733c/packages/ai/src/generate-object/parse-and-validate-object-result.ts) 与 [`generate-object.test.ts`](https://github.com/vercel/ai/blob/0c9ab5a7226dd13d642489271bfbe3db657c733c/packages/ai/src/generate-object/generate-object.test.ts)，许可证为 [Apache-2.0，Copyright 2023 Vercel](https://github.com/vercel/ai/blob/0c9ab5a7226dd13d642489271bfbe3db657c733c/LICENSE)。其解析、校验、修复后重校验的边界可供比照；本项目采用已有 Pi 工具错误反馈与 TypeBox 能力，并在本地 Store 重校验，没有复制上游源码或模型循环。

本轮离线检查：Planning 集合通过；生产源码类型检查与改动 TypeScript 文件 Biome 通过。Windows 的普通 Bridge socket 测试因 `competition.sock` / Pi Unix socket `listen EACCES` 无法在此宿主验证；`runtime-e2e` 仍有已知 `agentCallCount` 预期 3、实际 2 的失败。Ubuntu 隔离目录 `/home/seu/planning-v12-review-20260927/source` 已用本次源码覆盖并完成 `build:offline` 和 `verify:dist`，验证 73 个编译模块、4 个可执行文件及 344 个 legacy 文件。Ubuntu Bridge/恢复集合 78 通过，`bridge-persisted-session-refresh` 中“discovered sessions 使用环境 knowledge-base 覆盖”一项在单独复跑时仍返回空 session 列表；该测试和对应实现未由本轮改动。未部署或运行真实模型。

本次交接补充复核：移除上下文容量的执行门槛后，Planning 集合顺序执行 24 个文件、222 项通过、1 项跳过。新增长 summary、直接附件、坏引用逐项清理、按 ID 读取超出上下文的成果等回归均通过。生产源码类型检查、相关 Biome 检查和 Ubuntu 隔离构建通过。未提交、推送、部署或运行真实评测。

以下为此前审核门槛版本的历史记录，仅用于解释旧数据和旧复审结果。

## 契约选择

新建 run 由 Controller 显式写入 `contractVersion: "v1.2"`。旧 run 的数据库迁移默认写入 `legacy`，且不把旧结果推断为已审核或已验证。Store、Executor、上下文和 Supervisor 根据 run 标记选择兼容行为；不能通过缺失字段猜测新契约。

V1.2 task 用 `workContract` 定义问题、交付物、稳定的 `criterionId` 验收条目、停止条件和方法边界。`inputEvidenceRefs` 引用精确原始 evidence ID；`inputResultRefs` 引用本 run 已持久化的 `submissionId`，可选限定到一个 `findingId`。每项直接依赖同时声明 `accepted_result` 或 `task_done`。历史 run 继续使用原依赖和工具证据语义。

结果中的 finding 记录问题、方法、观察、结论、disposition、证据与产物引用以及 remaining work。finding ID、submission/task/run/lease 身份、时间和 hash 由宿主分配；finding 是探索结论，不是 CTF 验证证明。省略 `evidenceRefs` 时只从 findings 的显式引用推导并集；显式 `[]` 保持为空。V1.2 不会退回引用全部工具记录。

## 状态与事务

```text
ready → leased → running → submitted → reviewed outcome
                                  ↘ durable receipt (reviewStatus=pending)
```

`planning_commit_result` 先调用 Harness 提供的 `submitResult`。SQLite 事务校验活动 lease、run revision、evidence 与 artifact 来源，写入 submission 和 V1.2 结果 evidence，把 task 置为 `submitted` 并封存 lease，最后返回 `{submissionId, durable: true, reviewStatus: "pending"}`。同 lease 同内容重试返回同一回执；不同内容被拒绝。Pi 收到 durable 回执后结束该次执行并阻止后续工具调用；Harness 只核对已保存回执，不再二次提交。提交后的会话退出故障不会删除 submission。

下一次 Supervisor proposal 必须对唯一 pending submission 提供逐项 criterion review。Store 在同一事务中校验 review、更新 submission/task 状态、投影已接受成果，并提交该 proposal 中的新 task。`accept` 保留结果的 `done`、`disproved`、`blocked` 或 `failed` outcome；`needs_revision` 将 task 结算为 `blocked` 并保留缺口，后续修订 task 必须引用原 submission。review 标记为 `model_review`；目前没有注册 `host_check` 规则，Supervisor 无法把它声明成确定性宿主检查。planning submission 与 review 都不能写入 Flag verifier 的成功状态。

旧库按列增量迁移：run 增加 `contract_version`（默认 `legacy`）；task 增加 work contract、结果输入和依赖要求字段；新建 `planning_submissions` 与 `planning_reviews` 表。已有任务、evidence、事件、结果不重写。Checkpoint 可保存 finding 草稿，并固定 `draft_unreviewed` 状态，不参与已接受结果投影。

## 上下文与读取

Supervisor 获取全局进展和待审核队列；Executor 只接收当前 task 的直接证据和声明的结果输入。Host evidence receipt 提供真实 `evidenceId`，不会从 Pi `toolCallId` 推导。`planning_read_result` 只读同 run 的 submission，可分页读取摘要/findings；大段工具原文仍用 `planning_read_evidence`。读取结果不会再次登记成工具 evidence。

应用注入上下文以 262,144 字节为上限。必须的结果引用或指定 finding 放不进上下文时，Harness 在启动 Executor 前以 `context_fit` 失败并留下缺失 ID 和省略原因；工具读取用于按需获取详情。Trace 记录输入呈现、截断/省略、submission/review 与路由 ID 和计数，Bridge 只导出白名单诊断字段，不导出完整工具正文或 Flag。

## 事件阅读

- `planning_submission_durable` 表示 Store 已提交结果，不能解读为验收通过。
- `planning_submission_rejected` 与 `planning_review_rejected` 带字段、原因和错误码，说明输入或决策被拒。
- `planning_review_saved` 带 criterion ID/status、判定来源、submission/task/lease 身份及最终 task 状态。
- `planning_context_rendered`、`planning_context_fit_rejected` 和 result/evidence read 事件可核对实际输入集合、缺失原因与查询范围。
- `planning_submission_session_exit` 表示持久化已完成后 Pi 会话仍以失败退出；此时 submission 仍可供后续 Supervisor 审核。

## 2026-09-26 五阶段复审收尾

### R1–R9 状态与证据

| 项目 | 状态 | 实际修改 | 验收证据 | 剩余限制 |
|---|---|---|---|---|
| R1 必需契约预算 | DONE | `resultReferenceContext()` 为每个 finding 交付问题、观察、结论和局限；目录引用与实质内容分开计数，缺项会在 Executor 启动前 `context_fit` | 12 个大 submission、97 个 findings、needs_revision 缺口全部呈现；4,096 B 下目录仍在但核心内容缺失时拒绝 Executor | 保持 262,144 B 上限，无法完整呈现时拒绝启动 |
| R2 触顶后审核 | DONE | `runPlanningHarness()` 对 pending review 调用失败返回具名可恢复暂停；Controller 仅对该明确类型保留 paused | 真实 SQLite、Harness、Controller 连续执行两次；第一次暂停且 pending，第二次审核成功；取消和持久化错误仍走既有终态 | 无合法 Supervisor 调用预算时保持 pending 并暂停 |
| R3 checkpoint 草稿 | DONE | `recordCheckpoint()`、compact context 草稿摘要、同 run `planning_read_checkpoint` 完整读取工具 | 真实 parser/SQLite/timeout seal；9 条草稿全部呈现；长第九条通过读取工具恢复完整；跨 run ID 拒绝 | 草稿保留 `draft_unreviewed`，不进入 accepted 当前事实 |
| R4 修订缺口 | DONE | `resultReferenceContext()`、`readResult()`、`validatePlanningReview()` | A→needs_revision→B 的真实 Pi 输入及读取；中英文空泛 gap 拒绝，具体 gap 接受 | 审核仍为 `model_review` |
| R5 durable 收尾 | DONE | `runPlanningHarness()` 先核对 Store receipt，V1.2 不重放 evidence；退出异常分类 | 缺失/错配 receipt、会话退出、封存 lease、legacy 回归 | durable 只表示入库，不表示审核通过 |
| R6 重复任务 | DONE | `compilePlanningProposal()` 在依赖解析、引用规范化和自动绑定后计算签名 | 自动/显式绑定等价、换 key、引用排序、实质变化、一次 correction | 不尝试判断自然语言语义等价 |
| R7 artifact 来源 | DONE | `validatePlanningResult()` 使用来源 lease scope/hash；`readResult()` 解析跨 submission 元数据并独立分页 | 分离 scope、越界/hash 变化、A→B→C、17 项分页、缺失/变更状态 | 文件内容正确性仍由审核判断 |
| R8 校正分类 | DONE | `parsePlanningPlanProposal()` 将合法 JSON 的 review schema 错误包装为 proposal validation | 非法 JSON、非法 task、非法 review、校正后合法/仍非法及两次调用上限 | format/validation 共用一次 correction |
| R9 当前成果视图 | DONE | `reduceExecutionFrame()` 将 facts、rejectedDirections、openQuestions 投影到同一 accepted finding 关系状态，并把已接受的 `resolvedQuestionIds` 累计保存在 frame | supersedes/冲突关系回归；A→B 关闭→C 无关成果→重复投影及 SQLite reload 不复活旧问题；pending/needs_revision 不改变 accepted frame | 原 submission/finding/review 保持不可变 |

### 五阶段验收

| 阶段 | 状态 | 覆盖 |
|---|---|---|
| 1 必需上下文与审核预算 | DONE | R1、R2；Executor 启动门禁与 pending review 配额分离 |
| 2 checkpoint 与修订交接 | DONE | R3、R4；草稿来源校验、恢复上下文、review gap 读取 |
| 3 持久提交与重复判断 | DONE | R5、R6；receipt/lease 收尾与规范化签名 |
| 4 artifact、校正、当前视图 | DONE | R7、R8、R9；来源 scope、错误分类、关系投影 |
| 5 跨层、迁移、Trace、构建 | DONE | Store/Bridge API Trace、迁移、源码类型检查、Python `PlanningTraceExport` → `RunArtifact` → 删除 session 后复读，以及 Ubuntu offline 生产构建与 dist 校验均完成 |

### 真实链路与检查

- 真实执行组件：`PlanningStore` SQLite、Harness、`PiPlanningSupervisor`、`PiPlanningExecutor`、Pi `AgentSession`、checkpoint/read/commit 扩展、Controller、Bridge HTTP Trace/导出与会话删除。模型响应和外部 fixture 工具为显式本地 Mock；未调用真实模型、Oracle、Verifier、CTF 或 Benchmark。
- 五阶段实现期间记录的 Planning/恢复/Bridge 集合为 23 个测试文件、208 项通过；这是既有基线结果，不是本次复审复跑。覆盖持久提交→逐 criterion 审核→修订 Executor、Pi AgentSession 生命周期、完整迁移夹具重复打开及 Bridge Trace API 导出。
- `runtime-e2e.test.ts`：10 项中 9 通过，保留既有 `agentCallCount` expected 3 / actual 2 失败。
- 源码类型检查：`tsgo -p packages/secheur-agent/tsconfig.build.json --noEmit` 通过。测试类型检查只剩既有 `knowledge-coordinator.test.ts:499` 的 `sessionAllowsRetrieval` 字段错误。
- 目标 TypeScript 文件 Biome 检查与 `git diff --check` 通过。

### 构建与源码绑定

- 官方 `@earendil-works/pi-ai@0.84.1` npm 包作为已验证模型数据快照：版本与源码一致，39 个 provider 集合一致，`kimi-coding.json` SHA-256 为 `ba42a26a69e5cb2122c0b384ba572efae93f42239ad86f26c2b7320a14aa75a1`，仓库 `check:model-data` 通过。
- 本地只为测试依赖运行 `pi-ai build:offline` 及 Pi/RepoAudit 工作区构建，均通过；未把 Windows 构建冒充生产构建。
- 本轮 Ubuntu 验收使用当前工作树的 2,193 个 Git 跟踪/非忽略文件归档，SHA-256 为 `679f49da955eaf06992f562147ece43dbf25f4342aa8bb4d6f23b554bbf567e7`；格式检查后同步的最终源码覆盖归档 SHA-256 为 `adce9bd3becd3d29e668323477eabfcac29d634b3a91a44cc7a8738ce3d160e9`。被忽略的模型目录元数据另行传入并校验 SHA-256 `15e9bd84720e440c1fc94e9099fd6f02b6c21f414541859a3795976722961e7c`。归档未含 `.git`、`node_modules` 或 `dist`。
- 2026-09-27 通过 Tailscale SSH 以 `seu` 登录，核验主机 `OMEN`。Ubuntu 为 Node `v22.22.1`、npm `9.2.0`、Python `3.14.4`。`npm ci --ignore-scripts`、`npm run build:offline` 和 `npm run verify:dist --workspace=@secheur/agent` 均成功；Node 22 不内置 `.ts` 直接执行支持，因此构建命令设置 `NODE_OPTIONS=--import=tsx`。格式化后的最终源码同步后重新完成构建与 exporter 测试；`secheur-agent/dist` 文件树 SHA-256 为 `8fb1ea9ffbb0e42e44caf7611366eac10b4870737325db902e2d4e29550dc49a`。隔离构建目录为 `/home/seu/planning-v12-review-20260927`，未触及共享部署目录。

### 2026-09-27 独立复审及定点复查

- 用户提供的 7 文件复跑结果为 73 项通过、1 项跳过，覆盖 R1 大型结果上下文、R2 Controller 恢复、R3 checkpoint 草稿读取、R9 关系投影以及 tool_result 去重等路径。
- 本轮新增的三项相关回归共 15 项通过：真实 `PiPlanningExecutor` 完成 observer 中连续读取 checkpoint 两次后 evidence/blob 计数不增加、没有 Host receipt 且保留 `planning_checkpoint_read` 审计；普通外部工具仍采集；接受的关闭状态经 C 无关投影和 SQLite reload 后不复活；pending 与 needs_revision 声明不会提前关闭 accepted frame 中的问题。
- Python POSIX 集成在 Ubuntu 实际执行，1 项通过、同文件其他 5 项按名称过滤跳过。实际 `PlanningTraceExport` 读取 Bridge，`RunArtifact` 生成 `planning-events.jsonl`、`manifest.json`、`result.json`、`session-export.json`，删除 session 后仍能读取归档事件。
- 源码 `tsgo -p packages/secheur-agent/tsconfig.build.json --noEmit` 通过，`git diff --check` 通过。全量测试类型检查只报告既有 `knowledge-coordinator.test.ts:499` 的 `sessionAllowsRetrieval` TS2353。
- Ubuntu `npm ci --ignore-scripts`、`npm run build:offline`、`verify:dist` 均通过，生产 dist 文件树 hash 见上文。构建只在隔离目录完成；未部署、未提交、未推送或运行真实评测。

### 工作树与边界

固定 HEAD 为 `9dd70fe89cf200edc49d586b7038acc8789f757f`。改动只在现有 V1.2 实现、测试和本结果文档；未引入 V2、秘密、原始会话、数据库、`node_modules` 或 `dist`。未提交、未推送、未部署、未启动真实评测。
