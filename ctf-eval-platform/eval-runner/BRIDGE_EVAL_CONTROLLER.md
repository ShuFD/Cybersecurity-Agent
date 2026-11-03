# Bridge 并发评测控制器

该控制器通过 CTF Field HTTP API 准备题目、通过 SecHeur bridge HTTP API 创建独立 Agent session，并将结构化终态写回 CTF Field。它不读取标准答案，不从模型文本提取答案，也不使用旧 `batch-run`、`agent_eval`、`stage-for-agent-eval` 或 `sync-agent-eval`。

## 资源模型

- 控制器按配置运行 1 至 7 个 lane，每个 lane 串行、不同 lane 并发。
- `executionMode` 只接受 `DIRECT`、`PLAN_SINGLE` 或 `PLAN_MULTI`；它描述每个
  Bridge session 的执行语义。
- `executionCapacity` 描述单个 Bridge session 的 Runtime capacity：`DIRECT` 和
  `PLAN_SINGLE` 必须为 `1`，`PLAN_MULTI` 至少为 `2`。
- `controllerConcurrency` 描述同时运行的独立题目数，必须等于配置的 lane 数；它
  不是 `executionCapacity`。
- 默认配置仍使用三个 lane，并在各 lane 的 profile 列表内逐题轮换。
- 七并发配置可将 profile `1` 至 `7` 分别绑定到七个 lane，并保留 profile `0` 供调试。
- 不同 lane 的 profile 不得重复；调试 profile 不得进入执行 lane。
- 每题使用 bridge 全局配置的 800 Turn 硬上限，autonomous session 禁止自动续期。
- 每题墙钟上限为 9000 秒；达到上限时通过 bridge cancel API 写入 `wall_clock_timeout`。
- 创建 session 后，控制器会在发送题目 prompt 前读取 Bridge snapshot，并核对实际
  `executionMode`、`executionCapacity` 和 `legacyPlanningMode`；不一致时以
  `execution_contract_mismatch` fail closed。

## 安全默认值

不带参数运行时仅执行只读 health/profile 检查、读取 `status=untested` 的可启动题目并输出分配预览，不启动题目、不创建 session、不写状态：

```bash
cd ctf-eval-platform/eval-runner
python3 bridge_eval_controller.py
```

真正执行必须同时给出三个条件：

```bash
python3 bridge_eval_controller.py \
  --execute \
  --confirm RUN_3_LANE_EVAL \
  --max-targets 3
```

缺少确认字符串或正数上限时控制器拒绝执行。首次使用新 lane 配置时，必须先通过 mock 测试和只读预检确认所有 profile 可用。

默认队列仍只读取 `ready + untested`。只有操作员逐项提供精确的
`--target-id` 时，控制器才允许将 `ready + failed + 非运行中` 的题目加入重测；
显式清单中只要存在 `done`、不可启动、正在运行或不存在的题目，整批会在创建
session 前被拒绝，不会静默跳过后继续执行。

## 状态与恢复

控制器通过配置的 `stateRoot/controller.lock` 防止重复实例，并原子写入 `state.json` 保存 lane 游标、目标 lease、profile、run/session 和终态。若进程异常退出并留下 `running` lease，后续执行会拒绝启动；应先人工核对 bridge session、靶场容器和 CTF Field 记录，再恢复状态，禁止自动覆盖或重复领取。

可用 `--list-running` 在不启动任务的情况下列出遗留的 `targetId`、`runId`、`sessionId`、profile、lane 和 artifact 目录：

```bash
python3 bridge_eval_controller.py --config /path/to/bridge-eval-controller.json --list-running
```

每道题使用独立 Agent 工作目录：

```text
<workRoot>/<run-id>/
```

`workRoot` 和 `stateRoot` 应指向持久磁盘，不要放在 `/tmp`。控制器在记录
成功保存且 bridge session 已删除后清理本题 `<workRoot>/<run-id>/`；记录保存或
session 删除失败时保留目录，供故障排查。可在配置中用
`"cleanupWorkspaces": false` 暂停自动清理。Agent CTF session 的
`TMPDIR/TMP/TEMP` 由 bridge 单独指向持久盘下的 session 临时目录，关闭 session
后由 bridge 清理。

每个 run 还会在 `artifactRoot/<run-id>/` 原子写入 `manifest.json`、`result.json`、
`runtime-events.jsonl` 和 `session-export.json`。manifest 在启动时为
`artifactState=running`，所有归档文件写入成功后才切换为 `complete`；归档完成前
不会删除 bridge session 或工作目录。runtime log 使用每个 session 独立的
`logEpoch`、`afterEventId`、`afterMessageId` 游标增量追加；epoch/history/cursor
重置或拉取失败会将 `traceComplete=false` 并保留 `traceGapReason`。

`retentionClass` 仅记录保留策略元数据，支持 `pinned`、`benchmark`、`debug` 和
`incomplete`，当前正式基线默认使用 `pinned`，本控制器不自动 prune。

完整 Agent export 仅写入权威记录的 `process_note`；`process_summary` 只含受控终态字段。只有同时满足以下条件才写 `done`：

```text
taskKind=ctf
terminalReason=verified_true
verificationState=accepted
```

其他退出均写 `failed`，不得以 `<FINAL_ANSWER>`、普通文本返回或 bridge `idle` 判定解出。
