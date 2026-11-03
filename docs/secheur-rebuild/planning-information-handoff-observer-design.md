# Planning 信息交接、Observer 与任务颗粒度

## 基线与范围

- 基线仓库：`sxd-git1/SecHeur-Agent-pro`，分支 `main`，SHA `12bdea81a6a209bbe1a41afd5f8067dea8601d57`。
- 实现工作树：`planning-handoff-review-fix-worktree`，分支 `feat/planning-evidence-observer-granularity-20261003`；实现仍是未提交的本地改动。
- 原信息交接阶段保持单 Executor，未改 Verifier/Oracle、Flag 判定、Planning Store schema 或任务 hard timeout。本分支实际基线没有 60 秒强制 finalize reserve；Observer 的 540 秒提醒只是建议，不是停止探索或强制提交窗口。

## 设计与有效默认值

配置解析同时接受 camelCase 和 snake_case。缺失字段或无效 Observer 值退回关闭状态。

| 设置 | 默认值 | 关闭或开启行为 |
| --- | --- | --- |
| `planning.evidenceCatalogEnabled` | `false` | 关闭时不注册目录工具、不在 Executor prompt 声称可枚举全 run evidence；开启时按页列出同 run evidence，仍通过 `planning_read_evidence` 按 ID 读取原文。 |
| `planning.observerMode` | `"off"` | `off` 不创建 Observer、不触发 Observer 模型调用或报告；`report` 保存独立观察记录，不 steer Executor；`guidance` 在 report 行为上增加有界提醒。 |
| `planning.taskGranularityPromptEnabled` | `false` | 开启时只为 Supervisor 增加 CTF 任务大小指导，不改变 proposal 校验、最大任务数或调度规则。 |
| `planning.executorContextBytes` | `maxEvidenceBytes` 的有效值（默认 16,384 字节） | 独立限制 Executor 上下文预算；开关不改变此值。可单独配置 48 KiB 做后续对照。 |

证据目录每页默认 25 条、最多 50 条；使用有界快照 rowid 游标，按最新优先稳定分页，返回总数与 `hasMore`，可按 task、lease、工具、成功/错误及 metadata/summary/excerpt 关键词筛选。持续新增 evidence 不会让已有游标重复或漏掉快照中的记录。搜索不到 excerpt 不代表原文不存在。目录包含失败 attempt；没有跨 run 查询入口。工具名和原 excerpt 作为发现线索呈现，不把自动生成的 `success: bash` 包装成语义结论。目录查询与原文读取都不会制造普通工具 evidence。

Executor 的初始证据视图是按显式引用、依赖成果和近期失败进展排序的有限证据地图，保留完整 ID 和列表完整性标记；正文按字节预算裁剪，不将全部 evidence 塞入 prompt。Executor 可在目录开关打开时继续枚举并按 ID 读取原文。Supervisor 从下一份 durable Store snapshot 读取已保存 Executor 结果、facts、rejectedDirections、openQuestions、artifacts、Observer 判断和可信 Verifier proof；各角色在渲染中明确标为声明、原始工具观察、Observer 判断或 Verifier proof。

Observer 从工具开始/结束、工具错误、已保存 evidence ID、checkpoint、commit 回执和子会话恢复生命周期持续更新有界时间线，不因每个事件调用模型。初始触发条件是新增至少 6 条工具 evidence，或工具持续运行／重复失败路径受阻约 120 秒；两次语义观察至少间隔 120 秒，hard deadline 前 120 秒内不启动新的普通观察，每 attempt 最多 2 次模型观察。约 180 秒和 420 秒仍作为兜底检查点，且仅在有新 evidence 时观察。上述阈值是待定向轨迹校准的起始值，不是任务执行门禁。

报告中的引用会通过同 run 原文读取路径核验；这只证明引用可读取，不证明文字结论成立。报告以 `kind: observation` 独立持久化，Planner 上下文将其标成 Observer 判断，没有任务完成或 Verifier 权限。guidance 在有可定位错误或受阻依据时，通过当前 Pi `AgentSession.steer()` 在安全回合边界发送建议；只有 steer Promise 成功 resolve 后才计入最多两条提醒并记录 sent Trace。540 秒收尾建议沿用该通道，不强制停止或提交。

模型失败、报告解析失败、引用不可读或观察未能及时完成时，Executor 继续执行；attempt 结束时只要存在 durable 工具 evidence、checkpoint 或 commit 记录，就在 lease 仍有效且 Harness 结算前保存包含时间线、完整 evidence ID、checkpoint、Executor 声明、commit 工具状态与 `semanticReportGenerated: false` 的 runtime fallback handoff。没有进展不制造空报告；若已有语义报告，则只补运行时结尾视图，不重新调用 Observer，也不把它标为 fallback。handoff 明确标注 Store 结果仍待 Harness commit/seal，Planner 必须以之后的 durable snapshot 判断结算。不可读引用转成未核实内容。Observer 普通模型失败不阻断 Executor；Observation 持久化失败沿既有持久化错误路径传播。已提交结果、Observer 记录与恢复 evidence 分开保留。

## 修改文件

- 核心实现：`packages/secheur-agent/src/config.ts`、`src/bridge.ts`、`src/index.ts`、`src/subagent.ts`、`src/planning/{context,contracts,controller,harness,index,observer,pi-adapters,result-tool,session-controller,store}.ts`。
- 回归测试：`packages/secheur-agent/test/planning-config.test.ts`、`planning-context.test.ts`、`planning-observer.test.ts`、`planning-pi-adapters-executor.test.ts`、`planning-pi-adapters.test.ts`、`planning-pi-session-integration.test.ts`、`planning-result-tool.test.ts`、`planning-store.test.ts`、`progress-judge.test.ts`、`subagent-recovery-lifecycle.test.ts`。
- 批次追溯：`ctf-eval-platform/eval-runner/stage1_run_batch.py` 与 `test_stage1_benchmark_tools.py` 将有效开关、上下文/evidence 字节预算、task timeout、Observer 检查点与提醒上限、目录分页大小写入 manifest。

## 离线验收与未验证项

- Planning、恢复、Observer、目录、Pi adapter 与 Bridge Trace 离线集合：21 个测试文件，207 项通过；定点 Observer/Context/Pi Executor/目录/分页回归也包含在内。
- `tsgo -p packages/secheur-agent/tsconfig.build.json --noEmit` 通过；改动 TypeScript 文件 Biome 检查（关闭全仓 import assist）及 `git diff --check` 通过。
- `py -3 -m unittest -v test_stage1_benchmark_tools`：14 项通过。
- Ubuntu 独立验证目录 `/home/seu/planning-observer-closure-final-20261003/source`：PlanningTrace exporter/session-cleanup 集成 1 项通过；`NODE_OPTIONS=--import=tsx npm run build:offline` 通过；`npm run verify:dist --workspace=@secheur/agent` 通过，核验 73 个编译模块、4 个可执行文件与 346 个 legacy runtime 文件。此目录没有触碰服务器 release。
- `bridge-planning-user-display.test.ts` 在 Windows 因 socket `listen EACCES` 不能通过本机验证；该文件未包含在 21 个通过的离线集合中。全量 test tsconfig 未在本次重跑；既往报告的未修改 `test/knowledge-coordinator.test.ts:500` `sessionAllowsRetrieval` 类型错误仍未核验是否已消失。
- 600/60 秒时序、180/420 秒检查点、最多两条提醒、25/50 页大小和 16 KiB 默认上下文预算均是待固定题集真实评测确认的本项目起始值；48 KiB 只作为独立预算对照，不代表通用最佳值。未跑真实题目。

本轮使用隔离 Ubuntu 主机完成的是本地实现快照验证，不是正式部署。未提交、推送、部署或运行真实题目/固定题集消融。GitHub main 与本地分支差异留待后续合并前单独核对。

## 2026-10-03：PLAN_MULTI 本地扩展

以下是追加开发记录，不改写上面的单 Executor 历史验收。开发基线为 `192597b77361550ce46fe4127995f78f48dc7617`，工作树为 `unify-main-20261003-worktree`。默认 execution mode 和已有三个开关不变；必须显式选择 `plan_multi` 才使用并发路径。

### 执行与交接

- 一个 Supervisor、每题默认两个 Executor。Supervisor 可提出小批任务；1–3 个是提示建议，不是新的格式门禁。依赖沿用 `dependsOn`，既可引用同一 Proposal 中的 key，也可引用已保存 taskId。只要有可执行任务，空槽立即补位；有空槽但没有 ready task 时，Supervisor 可在兄弟任务继续运行期间读取 durable snapshot 并追加任务，不再等整批结束。一次只运行一个 Supervisor 调用；其等待期间仍处理 Executor 完成事件。
- 进程内共享 Executor pool 默认上限 7，FIFO、可取消。等待 pool 时不领取 lease、不启动 Executor 时钟。`maximumSteps` 按真正领取的 attempt 计数，不按并发波次计数。该 pool 不是跨进程、跨主机资源调度器，也不限制 Observer 的模型请求。
- PlanningStore 将 active lease 唯一索引从 run 改为 `(run_id, task_id)`，迁移事务化且重复打开幂等。默认 lease capacity 仍为 1；PLAN_MULTI 显式传入 capacity。PLAN_MULTI 可在活动 lease 存在时以事务追加新任务并推进 plan revision，不改写旧任务或 lease；旧 attempt 仍用自身 lease revision 提交成果。其他模式保留活动 lease 期间不可修改 plan 的规则。结果和 Frame 通过现有 SQLite 事务逐个合并，不使用模型合并器。
- 每个 attempt 使用独立 Pi session、extension/legacy host、Observer，以及 `<cwd>/.planning-attempts/<lease-hash>` scratch 目录。共享题目输入用绝对路径引用。这只是本地 scratch 隔离，不是复制目标 Docker，也不是完整文件系统沙箱；同一远端目标或文件的破坏性修改应通过依赖串行安排。
- 失败 attempt 仍按原路径封存；普通失败不取消健康兄弟。下次规划能看到最多 8 个近期失败的归属和状态。用户取消、非可恢复故障及可信终态都停止并等待 child 回调退出，然后由 Controller/Store 回收全部活动 lease；此前 durable evidence 不删除。
- 复用 evidence 目录和按 ID 读取。开启目录后可检索同 run 任意已保存 evidence，包括兄弟任务和失败 attempt；不把全 run 原文塞进初始 prompt。成果提交可显式引用同 run 兄弟 evidence，未指定引用时仍只默认绑定自己采集的 evidence。跨 run 边界不放宽。
- Frame 对相同 fact key、否定方向、artifact path 保留各自 task 来源；重复的本地问题标签（如 Q1）映射为 task-owned 稳定 ID。关闭本地 Q1 不会误关闭兄弟问题；要关闭兄弟问题，引用 Frame 暴露的完整 ID。保留矛盾声明，不自动宣布哪一方正确。
- 多 Executor 的原生 Verifier 共享同 run 请求队列、pending candidate 与拒绝候选缓存，实际 Oracle 请求串行且重复拒绝候选去重。不同 run 仍独立。请求排队不延长 hard timeout；可信成功仍必须由原有 trusted verifier evidence 判定，Observer 和普通 result 不具备该权限。

### 最小配置示例

```json
{
  "executionMode": { "mode": "plan_multi", "capacity": 2 },
  "planning": {
    "globalExecutorCapacity": 7,
    "evidenceCatalogEnabled": true,
    "observerMode": "report",
    "taskGranularityPromptEnabled": true
  }
}
```

这些是已有配置文件中的设置，不是已经部署的服务器配置。Observer 可保持 `off`；`guidance` 仍只有建议，不增加审批门禁。上下文预算、任务 timeout、Proposal 输出协议、Result 校验及可信成功判定均未因 PLAN_MULTI 放宽或延长。当前 Supervisor 仍为 `allowedTools: []`、finalText JSON 提取及 correction，未迁入 structured proposal tool；也没有强制 finalize window。PLAN_SINGLE 保留每次一个任务及原 cwd，DIRECT 保留原路由。

### 并发复审修复

- 同 run 已持久化的可信 Verifier 成功优先于兄弟 attempt 的 quota exhaustion；仍使用既有可信 proof 校验，不覆盖持久化故障或外部取消。
- 取消后等待 Pi 官方 `abort()` 的 idle settlement，最多 5 秒清理等待（不增加模型执行预算）。若未完成，`coding_task_end.settled=false`，停止该 run 后续调度；未完成工具的 session、extension bundle 和 host slot 延迟到实际 idle 才释放。拒绝 settlement 时保留占用，不宣称已收尾。该过程不再向 Store 写晚到事件。
- 多任务分析成果可用显式同 run sibling 工具证据结算任务；unknown/cross-run、工具错误和 observation 不能充当有效完成依据，任务 done 仍不代表可信整题成功。

本轮本地验证：Planning、模式路由、runtime context 与 subagent recovery 共 24 个文件、254 项通过（新增 11 项，包含真实 Pi session 取消收尾）；源码类型检查、改动文件 Biome、`git diff --check`、Windows 离线全量构建和 `verify:dist` 通过。测试类型检查仍仅报未修改的 `test/knowledge-coordinator.test.ts:500` 既有选项类型错误。未执行 Ubuntu 构建、真实模型/题目测试、提交、推送或部署。

### 滚动规划与运行中调节槽位

- 默认每题 2、进程共享 7 个 Executor 槽位不变。PLAN_MULTI 的每题容量允许降到 1，不因此切换成 PLAN_SINGLE。共享上限仅在进程初始化时读取配置，新 run 不会覆盖已经调整的共享容量。
- 有 ready task 优先执行；没有 ready task、有空槽且共享池有容量时才请求追加规划。不强迫 Planner 填满槽位。它看到当前任务状态、已有成果，以及 `capacity / occupied / available`。`blocked` 在兄弟任务仍运行时表示暂时等待，不终止它们；新成果或容量变化后可重新规划。没有状态变化不重复请求 Planner。
- Planner 返回期间完成的 Executor 仍及时处理；追加任务前使用最新 Store snapshot 校验。任务已追加但依赖尚未完成时，不为这段等待循环调用 Planner。共享池被其他题占满时等待释放，不误判本题 blocked。
- 增容唤醒调度，优先补现有任务；缩容不取消运行中 Executor，只撤销尚未启动的超额排队。等待共享槽位时仍不领取 lease、不启动 Executor timeout。没有增加模型重试次数、任务预算或新完成门禁。

Bridge 复用现有 HTTP 服务的运行时接口（不是新增端口）：

| 接口 | POST 参数 | 作用 |
| --- | --- | --- |
| `GET/POST /planning/capacity` | `{"globalExecutorCapacity": 7}` | 查询/调整进程共享槽位；返回 capacity、active、waiting |
| `GET/POST /session/<sessionId>/planning/capacity` | `{"executionCapacity": 3}` | 查询/调整已连接的本地 PLAN_MULTI session 每题槽位 |

POST 接受 1–64 的整数，错误参数返回 400；非 PLAN_MULTI 或 managed session 不通过此接口改变模式，返回 409。操作无需重启或重建 session；返回 `persistent=false`，只影响当前进程/session，不写配置文件。需要重启后仍保留的默认值应修改原配置中的 `executionMode.capacity` 和 `planning.globalExecutorCapacity`；`/config` 写入默认配置不替代这里的实时调整接口。

本轮离线验证：24 个 Planning、模式路由、runtime context 与 subagent recovery 测试文件共 267 项通过；实际 Bridge HTTP 容量调整用例另 1 项通过（该文件其他 7 项按名称过滤，未计为通过）。生产源码类型检查、改动 TS 文件 Biome、`git diff --check`、Windows `build:offline` 与 `verify:dist` 通过。测试类型检查仍仅报未修改的 `knowledge-coordinator.test.ts:500` 既有选项类型错误；原 Windows Unix socket 用例受 `EACCES` 限制。本次新增 HTTP 用例在 Windows 使用命名管道，不修改旧断言。未执行 Ubuntu 构建、真实模型/题目测试、提交、推送或部署，不能据此声称实际并发解题速度或成功率已经提高。

### 滚动调度复审修复（2026-10-03）

- 已复现：A 交接后，补位 Supervisor 的解析/校验失败原来会取消仍正常运行的 B。现在只把明确可恢复的 Proposal 错误暂存；已有执行/排队工作继续，没有状态变化不即时重试。任务交接或容量变化后才按正常调度再次规划；没有已有工作时原错误仍直接返回。现有 Proposal 语义校验和 correction 次数不放宽。
- 已复现：A 已保存可信 proof，B 同时或在内部取消收尾期间报告持久化故障，原来会被 completed 分支忽略。现在 child 记录首个 typed `planning_persistence_error`，终态和异常路径均等待 Executor/Planner 回调收尾并检查它；对外报告故障，不删除已有 proof。原始 parent/user cancellation 仍优先。不得以这次修复把 quota 错误重新升级成可信成功失效。
- 回归覆盖：三类补位错误、append 时才发现的重复任务、无任务时的初始 Planner 错误、与 proof 同时发生/收尾期间发生的 Store 故障，以及 parent cancellation 优先级。共新增 8 项；最新相关集合为 24 个文件、275 项通过。容量调整的实际 HTTP 回归另 1 项通过；源码类型检查、改动文件 Biome、`git diff --check`、Windows 离线构建及 dist 校验通过。测试类型检查仅剩未修改的 `knowledge-coordinator.test.ts:500` 基线错误。
- 部署连接检查：OMEN 的 Tailscale peer 返回 `Online=false`，`seu@100.112.105.109:22` 连接超时；未认证、未修改服务器服务/配置/session。Ubuntu 验收和真实并发收益仍未确认。

### 模块与借鉴边界（实现来源）

`execution-pool.ts` 管槽位；`harness.ts` 补位和 child drain；`store.ts` 管 lease 迁移和原子结算；`scheduler.ts` 枚举 ready tasks；`controller.ts` / `session-controller.ts` 接入 mode；`pi-adapters.ts` 管 task 提示、独立 session/cwd；`context.ts` / `result-tool.ts` / `frame-reducer.ts` 处理有来源的交接；`runtime.ts` / `extension.ts` 共享原生 Verifier 请求状态。

参考用户仓库 [CairnPilot 固定提交](https://github.com/sxd-git1/cairnpilot/tree/b015733fa117aa35f2406b8b31fd1bbf84d3ec6e) 的有界 worker、空槽补位及失败局部化思路（Apache-2.0）；没有移植其完整 graph、消息总线、角色系统或第二套 Agent loop。本项目继续使用 Pi 与已有 PlanningStore。

### 验证边界

离线回归覆盖真实 SQLite 索引迁移/重开、依赖补位、跨 run 共享 pool、排队取消、attempt 预算、失败隔离、可信终态后 child drain、并行 Frame 来源、实际 Pi faux-provider 双 session/双 cwd、同 run 原生 Verifier 串行与重复请求去重。测试不调用真实模型或 Oracle。

- 最终 Planning / execution-mode / runtime-context / subagent recovery 集合：24 个文件，243 项通过。
- 本机生产源码类型检查、改动 TS 文件 Biome、相对 TS imports 和 `git diff --check` 通过；`npm run build:offline` 通过，并经 `verify:dist` 核验 74 个模块、4 个可执行文件、347 个 legacy runtime 文件。
- Agent 测试类型检查仍在未修改的 `test/knowledge-coordinator.test.ts:500` 报 `sessionAllowsRetrieval` 类型错误；本次新增测试类型错误已修复。root 全项目测试检查另有未修改 AI 测试与生成模型目录之间的 model ID 类型不匹配，未改这些断言或模型清单。
- `check:pinned-deps` 在未改的 `.pi/extensions/repoaudit-pi-extension/package.json` 发现 `typebox: "*"`；本次未修改依赖声明或 lockfile，不把此检查报告为通过。

本次没有服务器部署或 Ubuntu 验收；本机离线生产构建不等于生产平台验证。并发解题收益、共享目标修改冲突及模型限流须在后续授权的固定题集实验中确认，不能用离线测试声称成功率已提高。
