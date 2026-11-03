# 两套 Planning 引擎，共用 Pi 执行底座

## 基线与范围

本地基线：`48c3ef942b020086088e043ed42aa0eefdcca5c2`。本次只接入编排、Harness、会话复用与成果存储；没有修改原 progressive 的 Supervisor、Compiler、Scheduler、Result 或 Observer 规则。

迁移来源：`sxd-git1/cairnpilot`，固定提交 `b015733fa117aa35f2406b8b31fd1bbf84d3ec6e`，Apache-2.0。源码和适配说明见 `vendor/cairnpilot/NOTICE.md`，许可证见同目录 `LICENSE`。迁入 Graph/Reasoner/Scheduler/Intent 生命周期，不迁移其 UI、Docker 运行环境或独立模型运行时。

## 切换方式

在当前实例的 `stateDir/desktop-config.json` 中配置：

```json
{
  "executionMode": "plan_multi",
  "executionCapacity": 2,
  "planning": {
    "engine": "cairn",
    "mode": "active"
  }
}
```

`engine` 改成 `progressive` 即选回原引擎；旧配置未设置该字段时仍默认 progressive。`plan_single` 使用一槽，`plan_multi` 使用所配置槽位，DIRECT 绕过两套 Planning。

现有 builtin plugin 切换接口也支持 `progressive-planning` 和 `cairn-planning`：启用其中一个即选择它，关闭未选中的插件不会关闭另一套引擎。切换沿用现有 runtime invalidation 流程；正在运行的任务不会热换引擎，新 runtime 才使用新选择。

历史 `planning.mode=shadow` 保持旧 progressive 的预览/直接执行兼容路径，不会因选择 Cairn 而额外启动 Intent 执行器。

## 共用与独立的边界

| 层 | progressive | cairn |
| --- | --- | --- |
| 模型/Agent Loop/上下文压缩 | Pi | 同一 Pi 实现 |
| 执行入口 | `runPiCodingTask()` | 同一函数，可选顺序会话 owner |
| 进程级执行槽 | `sharedPlanningExecutorPool` | 同一个 pool |
| 每 session 容量 | `PlanningCapacityControl` | 同一容量控制 |
| 规划/调度 | 原 Supervisor/Compiler/Harness | GraphReasoner + Intent Scheduler |
| 状态 | 原 `planning.sqlite` | 独立 run 目录中的 `graph.sqlite`、`host.sqlite` |
| 成果工具 | `planning_commit_result` | `checkpoint_intent`、`conclude_intent` |

“共用执行器”指共用执行实现、工具宿主接入和资源池，不是让不同 run 同时使用一个可变 Pi 会话。Cairn Solver 只在同 run 内顺序复用自己的会话；不会借用 progressive Executor 的会话或状态。

## 实际控制流

```text
parent session.prompt
  ├─ DIRECT → 原 rawPrompt
  ├─ progressive → 原 Controller/Store/Harness
  └─ cairn → 新 run + 独立 Graph
       ├─ ReasonWorker：消费 Graph triggers → Reasoner → Proposal apply
       ├─ SchedulerWorker：读 open Intents + 容量 → claim → launch/reuse
       └─ Solver：同一 runPiCodingTask → 普通工具 → checkpoint/conclude
                    └─ 成果事件触发下一次 Reasoner，而其他 Solver 可继续运行
```

ReasonWorker 与 SchedulerWorker 独立运转，扫描间隔 500 ms。不等一批任务全部完成才重新规划；成果产生可触发规划，空出的槽位可启动下一 Intent。只有停机时才停止 Worker、等待当前扫描完成，再关闭 Solver 和 SQLite。

Scheduler 沿用 Cairn 的优先级、活跃 claim 检查、Fact 依赖、profile 匹配、失败启动补偿及 Solver 复用逻辑。当前适配器暴露一个 `current` profile，使用父会话选择的模型及工具；未实现 Cairn 原 UI 中的异构模型 profile 管理。该 profile 暂无声明的 capability tags，Reasoner 会收到这一说明。

## Solver 生命周期

1. Scheduler claim Intent，宿主取得共用 pool 槽位，绑定并 acknowledge lease。
2. 首次创建真实 Pi 会话；普通工具沿用父实例的 extension bundle。
3. `checkpoint_intent` 保存阶段成果并更新 lease version；`conclude_intent` 持久化结论并在工具**返回值**中设置 Pi 官方 `terminate: true`。
4. 没有交成果时复用现有 `recoverRequiredTool()`，最多两次补交，只开放 `conclude_intent`。
5. 正常结算后释放执行槽。可复用会话留在 Solver owner 中，下一 Intent 重新取得槽位并绑定新 lease。
6. 复用时 Graph 工具通过当前 attempt 的 handler 回写，不闭包绑定上一 Intent。新 prompt 带新的主 Intent 和 focused context。
7. 缩小容量不取消正在执行的任务；只回收多出的空闲 Solver。取消时等待 Pi/工具实际 settlement，再释放槽位和 bundle。

并发上限仍由原全局 pool 和本 session capacity 双重控制；没有增加第二套模型循环或独立线程调度器。

复审后的槽位处理：复用会话与新建会话都消耗本轮全局执行槽预算；Cairn 通过 `tryAcquire()` 即时取得槽位，不加入带 lease 的等待队列。若调度快照之后槽位被其他任务抢走，沿现有 Scheduler compensation 释放 claim，将 Intent 留给下次扫描。原 progressive 的 FIFO `acquire()` 保持原行为，Cairn 不抢占已有排队者或运行中的任务。

## 成果与 evidence

Graph 工具原语：`graph_get_context`、`fact_propose`、`intent_propose`、`fact_append_evidence`、`artifact_register`、`checkpoint_intent`、`conclude_intent`、`release_intent`。

普通工具输出由宿主完整写入 `host.sqlite`。目录工具 `graph_list_evidence` 默认每页 32 条，支持 1–100 条；`graph_read_evidence` 默认读取 16,000 字符，最多 65,536 字符，返回下一 offset，可按需读完同 run 的结果。目录查询与 Graph 协议工具本身不重复采集为普通 evidence。

Raw evidence 与 Executor 的 Graph 报告分开保存。Intent outcome 表示该子任务的成果，不自动表示整个任务已完成。原有最终完成判定保持原接口。

工具 evidence 身份包含 run、Intent、Solver、generation 和 toolCallId；同一次内容重放幂等，复用 Solver 后即使工具调用 ID 重复也不会覆盖上一 Intent。

Graph 写入的幂等键同样按 action、Solver、Intent、generation、sessionEpoch 与工具调用 ID 区分；不包含会随 checkpoint/heartbeat 改变的 lease version。相同 attempt 的同一请求仍重放原结果，冲突内容仍返回错误。

超时仍使用原 `taskTimeoutMs`：保存已经获得的 raw evidence；若当前 lease 仍有效，则写入失败边界成果，让 Reasoner 看见未完成状态。没有改超时、没有增加 finalize 阶段或新的审批流程。

## 参数与当前迁移范围

| 参数 | 当前行为 |
| --- | --- |
| `planning.engine` | 默认 `progressive`，可选 `cairn` |
| `executionCapacity` | 沿用原 PLAN_MULTI 容量，可通过原接口动态调整 |
| `planning.globalExecutorCapacity` | 沿用共用 pool，默认 7 |
| `planning.taskTimeoutSeconds` | 沿用原配置，默认 600 s |
| `planning.maxSteps` | Cairn 新 Reason 调用预算，默认 12；已启动 Solver 不因用完预算被取消 |
| `planning.maxTasks` | 停止新增 Reason 调用的 Intent 数阈值，默认 48；单次 Proposal 可含多 Intent |
| Intent lease | 沿用 Cairn 5–300 s 范围，按 lease/3 心跳，至少 1 s |
| Reason timeout/lease | 沿用 Cairn 60 s / 120 s |

Cairn 的 Reasoner 保留源项目的独立 JSON Proposal 协议、上下文裁剪和校验，不借用或修改 progressive parser。没有宣称该新协议已通过真实模型稳定性验证。

### Proposal 生成方式与 CairnPilot 对齐

本机 GitHub CLI 以 `sxd-git1` 身份核对了 `sxd-git1/cairnpilot` 默认分支 `graph-reasoner-stage-0-4`，HEAD 仍是迁移基线 `b015733fa117aa35f2406b8b31fd1bbf84d3ec6e`。原仓库没有 main 分支；不能用 main 的 404 推断无法访问。

该版本的 `packages/core/src/graph/reason-model.ts` 是文本 JSON 输出：Pi `completeSimple()` 单次生成 → 仅拼接 text blocks → `reasoner.ts` 检查空输出/字节上限 → `JSON.parse()` → Graph 语义校验 → Proposal 持久化与 apply。不是 `planning_submit_proposal`，没有 AgentSession 工具循环，也没有同会话 format correction。

迁入的 `reason-prompt.ts` 和 `reason-proposal.ts` 与原文件在移除导入、来源注释和格式差异后相同；Reasoner 保留原来 lease、trigger、context fingerprint、base event sequence、校验和 apply 路径。

原来未对齐的部分是 `engine.ts` 用 `runPiCodingTask()` 代替了源项目 `ConfigReasonModel`。现改为 `planning/proposal-model.ts`，直接复用源项目的 JSON-only system prompt、一个 user message、单次 Pi `completeSimple()`、text block 拼接和 error/aborted 处理。Cairn 3,000-token 预算通过 request `maxTokens` 传入，模型对象本身不再克隆/修改。实际模型/provider 元数据来自响应。

Progressive Supervisor 同时复用此生成入口，不创建 Planner coding session；Executor 仍使用现有 shared Pi AgentSession。没有新增 agent loop、tool output 协议或依赖。

必要适配与保留差异：

- Pi 0.84.1 使用 `ModelRuntime.completeSimple()` 管理现有 provider/auth，而不是复制原项目 `ConfigManager` 或旧版本兼容层的 apiKey 获取。
- 显式 model/thinking 优先；未显式提供时读取本项目 Pi settings 和可用模型。没有迁移原项目 model preference ID 配置体系。
- Graph Proposal 仍是 `rationaleSummary/proposedIntents/supersedeRecommendations`，Progressive 仍是 `decision/tasks/answerEvidenceRefs`，不互换 schema、ID 空间或 Store。
- Progressive 原有最多一次纠正保留，不新增纠正次数；这与 Cairn 原版不做同会话 correction 的行为不同。Progressive 的输出预算不强制改成 Cairn 的 3,000 tokens。
- 保留本项目 parent signal 权威与有界 Trace；原始 prompt/response/error 不通过新增生成事件导出。

因此这是对齐原项目的生成实现，**不是**声称两个 engine 的整个规划算法或成功率相同，也不是格式失败已被消灭。该轮未新增 Structured Output Tool。

验收：新增 6 项真实 Pi faux provider 生成测试，覆盖单 user/no tools、原版 system prompt、3,000-token request、text/thinking 分离、error/aborted、父取消、length 和不执行工具；新增 1 项不注入 ReasonModel 的完整 Graph apply/Solver 成果回写测试。既有 Progressive 真实 HTTP correction 与 evidence/checkpoint 全链路继续通过。Bridge 6/6 通过，生成事件只导出有界元数据、不导出 prompt/output。

最终扩大集合 39 个文件，370 项通过、1 项既有 Windows Unix socket `listen EACCES` 失败。源码类型检查、改动 TS 文件 Biome、`git diff --check` 通过；测试类型检查仍只有未修改的 `knowledge-coordinator.test.ts:500`。Windows 生产构建/dist 校验通过（100 模块、4 可执行文件、347 legacy 文件）。未提交、推送、部署；未调用真实模型或题目。

当前每次 parent prompt 创建独立 Cairn run，旧 run 保留为历史。Graph 持久化和重开已验证，**不等于**进程重启后自动恢复未结束的 Pi 会话；自动 resume、异构 profile、Cairn 外部 Observer 和 UI 均不属于本次迁移。

结束判断直接查询 Store 中是否存在 `pending` / `processing` trigger，包括尚未到 `notBefore` 的工作，不再用历史列表的前 100 条推断全部状态。已有 Reason 调用预算保持不变。

## 文件定位

- `config.ts`：引擎选择，旧配置默认值。
- `planning/session-controller.ts`：两套入口分流、容量与父会话生命周期。
- `planning/cairn/engine.ts`：连接 Worker、Reasoner、Scheduler 和 Solver；独立 run 路径。
- `planning/cairn/solver.ts`：共用 Pi、槽位、会话复用、Graph 工具接入和失败交接。
- `planning/cairn/service.ts` / `store.ts` / `schema.ts`：迁入的 Graph 事务和 SQLite 数据。
- `planning/cairn/reason-*.ts`：Graph 驱动的规划。
- `planning/cairn/scheduler*.ts`：Intent 选择、滚动执行和启动补偿。
- `planning/cairn/host-evidence.ts` / `trace.ts`：宿主工具输出和编排 Trace。
- `subagent.ts`：可选 Pi session owner 与成果完成谓词；旧调用不传这两项时行为不变。
- `plugin-catalog.ts` / `bridge.ts`：复用插件切换和 Trace 接口。

## 验证与发布状态

真实 Pi 集成使用本地 faux provider，不调用外部模型或题目。覆盖双 Solver 并发、成果触发重新规划、空槽滚动补位、同会话新 Intent 回写、缺失成果补交、取消 settlement、hard timeout 和独立 SQLite 重开。

离线验收记录：

- Planning、Cairn、execution-mode 与 subagent recovery 扩大集合：37 个文件，352 项通过、1 项失败。失败为原有 `bridge-planning-user-display.test.ts` 在 Windows 创建 Unix socket 时遇到 `listen EACCES`，未修改或跳过该断言。
- Cairn 新增及迁入集合：13 个文件、85 项通过；Bridge Trace 文件另行复跑 6/6 通过，包含真实 HTTP 插件切换和 Cairn Trace 分页。
- 生产源码 `tsgo --noEmit`、改动文件 Biome、相对导入检查及 `git diff --check` 通过。测试类型检查仍有未修改的 `knowledge-coordinator.test.ts:500` 既有错误。
- Windows `build:offline` 通过；最终 Agent workspace 生产构建和 dist 校验通过，检查 99 个编译模块、4 个可执行文件和 347 个 legacy runtime 文件，迁移许可证随构建复制。

双引擎初版已于 `00d31d18d6c3369df388653db4fe0fcb80f9fbe4` 推送至两个仓库 main；尚未部署。以上为初版检查记录。后续复审修复仍留在本地，新增回归覆盖全局槽位耗尽、快照后槽位争抢及补偿重试、超过 100 条历史 trigger 和重复工具调用 ID。

复审修复扩大验收：38 个测试文件，359 项通过、1 项失败；仍是上述 Windows Unix socket 用例。源码类型检查通过，测试类型检查仍只有 `knowledge-coordinator.test.ts:500` 既有错误。此次不改变模型参数、timeout、Prompt、Graph 语义或数据库结构。

加强真实 Pi 复用时重复 `conclude_intent` 调用 ID 的回归后，四个定点文件 33/33 通过；改动文件 Biome 和 `git diff --check` 通过。最终 Windows Agent workspace 生产构建与 dist 校验通过（99 个编译模块、4 个可执行文件、347 个 legacy runtime 文件）。

这些检查证明离线编排与共用 Pi 接入行为，不代表真实模型规划质量或线上性能。未执行 Ubuntu 构建、真实模型或题目测试；生产实例和历史评测数据未改动。

## Progressive 并发复审：确定缺口与待评估项

此次最小修复仅处理取消收尾的资源归属：`session.abort()` 拒绝时再等官方 `waitForIdle()`；Pi idle 后，取消会话和 extension bundle 在成功/拒绝两条路径都清理，Harness 在 pending settlement 两条路径都释放槽位。工具还没有结束时继续占槽，不通过无条件释放来掩盖 abort 故障。父取消和现有错误优先级不变。

新增回归使用延迟 idle barrier，确认调用方在 cleanup grace 后返回父取消，但 session、bundle、槽位仍保留；idle 后清理完成，原 abort 错误仍可观测。另覆盖 settlement 成功/拒绝后 slot 可再次申请。

stale Planner 定向用例确认：Supervisor 读取 B 为 running 的 snapshot，B 随后保存 tool evidence/result 且变为 done，plan revision 不变；旧 `create_tasks(C)` 在 fresh snapshot 下重新校验后仍追加并执行。这个用例刻画当前行为，不证明 C 在语义上无用，亦不代表 stale 决策已修。此次没有增加 evidence-only revision、自动废弃 Proposal 或模型重规划门禁。

Structured Output 不在当前 baseline 的原因是明确的 `5eb6c8f` / `c9fdb54` a33f742 回退，而非 Cairn 合并意外删除。此次没有将旧提交整块移回；Supervisor 仍用当前文本 Proposal 协议。后续若恢复 structured submission，须作为独立协议改动适配当前 task contract 与 PLAN_MULTI 多 task，并单独验收，不能声称此次 slot 修复已解决格式问题。

PLAN_MULTI capacity=1 保持支持：模式选择 rolling scheduling，capacity 只限制并发上限；不会自动改走 PLAN_SINGLE。跨进程 resume 和 shared filesystem mutation 控制没有新增。

本轮 7 个相关测试文件 107/107 通过；生产源码类型检查、5 个改动 TS 文件 Biome 和 diff 检查通过。测试类型检查仍只有既有 `knowledge-coordinator.test.ts:500`。Windows Agent 生产构建与 dist 校验通过（99 模块、4 可执行文件、347 legacy 文件）。上述修复未提交、推送、部署；没有真实模型或评测调用。
