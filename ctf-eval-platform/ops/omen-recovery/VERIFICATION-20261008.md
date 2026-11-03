# 恢复环境故障修复 — 2026-10-08

## 本轮实施

- InterCode/17 官方只有空 `.placeholder`，没有公开附件；恢复时排除该标记造成 evalctl 的 `empty_assets`。仅恢复官方零字节标记，未复制 `solution`。staging helper 同步修复，以免再次准备目录时丢失标记。没有修改 evalctl 的附件/解答边界。
- Controller 在消息压缩后继续携带旧 messageCursor，引发反复 reset。现改为采用返回的新 messageCursor；eventCursor 不回退，去重和事件缺失检查保留，traceComplete=false 的历史风险标记也保留。没有把既有 19 题改成完整 Trace。
- 正式 Agent 仍为 011f32a，PID 2994748；本轮未修改其发布目录、Prompt、Planning、配额或模型参数，未重启 Agent。

## 验证

- Controller Ubuntu 全套 66/66 通过，包括新增游标恢复回归。最初的缺 fixture 错误已通过独立测试目录补齐官方测试 fixture/config 后解决，未删改断言。
- 官方占位文件恢复回归 3/3：不造文件、不复制非空 marker、不复制 solution、不改变已有附件任务。
- 正式 Field 模块隔离 HTTP/SQLite 回执回归 5/5；不改真实成绩数据库。
- 实际 pi-eval 账户原生 bash、legacy code_run、list_files 均通过，Python 3.11.17；正式服务环境变量已指向 /opt/secheur-agent-python/bin/python。
- InterCode/17 真实 Field 启动成功，runId=ui-20261008-174020-intercode-ctf_17，随后关闭成功，无残留该题容器。模型调用 0、Verifier 调用 0。
- Agent、Field 前后端 active，/sessions 为空；未重跑 50 题或改写历史测试结果。

## 部署与回滚

备份：`/var/lib/secheur-benchmark-recovery/environment-repair-20261008`，含原 Controller、staging script 及部署哈希。

正式 Controller SHA256：`a07f52a112ce85f4a2b51a2fc0f9ef7522a4667379bac724c743e558b443524b`。

staging script SHA256：`bb44ed7161dfdb4d4649821dabd3a28d7f3f84400a66916279e21dcf8dc0d04a`。

没有执行完整 catalog 导入，未改 Oracle/gold，未提交或推送 Git。

## 不应混入环境修复的未确认项

- 当前只有 reviewer/researcher/planner 三个内置子 Agent，与当前发布代码一致。未找到旧自定义定义；不能通过伪造 general/bash 等角色冒充恢复。模型调用不存在角色的工具发现问题，尚未证明是环境故障，本轮未改 Prompt 或 Agent 代码。
- HTTP 529 是上游模型集群过载，不能由本机部署宣称修好。host_watchdog 属于模型输出超时保护；现场配置为首输出 120 秒、流空闲 600 秒，没有擅自延长或关闭。
- 本次只验证环境调用链，没有以离线测试代替端到端解题成绩。
