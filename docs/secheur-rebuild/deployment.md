# SecHeur Bridge 正式部署交接

> 当前现场核验日期：2026-10-01。只有一个正式 Bridge：`secheur-agent-rebuild.service`，端口 `14171`。下文较早的发布记录均为历史快照，不再表示当前 release。

## 当前正式版本：回退到 Planning 最佳完整单轮

- 固定 35 题、只计 `verified_true / accepted` 且 `recordStatus=saved` 的完整单轮中，`a33f7420027b404b52fd9d061191d58f856f7c28` 为 **24/35**。选择的是这轮完整成绩，不把后来失败题补测或中途停止的批次混入分母。
- 2026-10-01 已停止单 Lane 的结构化输出重试批次；其 `RUN-EXIT-CODE=143`，已有 18 题结果保留。正在运行的 `avatar` session 已取消并删除，Field target 已停止。未启动新的 35 题批次。
- 正式 release 回退至 `/home/shared/agent-rebuild/app-releases/planning-terminal-order-a33f742-20260925`，同一 `secheur-agent-rebuild.service` 在 `14171` 运行；切换后 PID `327593`（仅为当时快照）。`planning/harness.js` SHA-256 为 `cbf6c57a3f687f8d0e4201a2913d7adb0edc03a35405127dff57615a6749954e`，`bridge.js` 为 `dddb1f78b5913c9897a6108e8ed488393e63e5a6fb124a3390311ee2afbc355a`。Controller 恢复为 SHA-256 `8f3e8332c1f09f4841727f3f104b3b6475d83fda9e9570ad2bc5e52b320a0a91`。
- 切换前确认无 Controller 进程、活动 Bridge session 或运行中的 Field target；切换后 `/status` ready、`activeSessionId=null`、`/`、`/app.js`、`/model-profiles` 均返回 200，Field `/api/health` 正常。正式 `PLAN_SINGLE` 容量仍为 1；未改变 Profile、Verifier 或成功判定。PlanningStore 未替换，inode 仍为 `15335544`。
- 本次切换前的 root-only 配置备份在 `/root/rollback-best-a33f742-20261001/40.before`、`60.before`；旧结构化 release 和全部 artifact 均保留。GitHub 源码采用追加提交恢复 Planning 文件到 `a33f742`，保留后续独立的知识库与 UI 改动；不是重写 `main` 历史，也不声称整个仓库与旧提交逐字节相同。

## 历史正式版本：Planning V1.2.2 Proposal format correction 收敛

- 代码提交 `2a44236e5e273dd148219e28a54e4c2392065647` 已同步到 `sxd-git1/SecHeur-Agent-pro` 和 `yg2224/SecHeur-Agent-pro` 的 `main`。本次只改 `planning/pi-adapters.ts` 和相应测试；多 Proposal 的唯一一次格式纠正不再回灌旧正文，坏 JSON／截断只携带最多 4,096 字符摘录，并复用 primary 的 durable context。Scanner、correction 次数、Verifier 与成功判定未改。
- 唯一正式 release：`/home/shared/agent-rebuild/app-releases/planning-format-correction-2a44236-20260928`，由该提交的 Git archive（SHA-256 `762750d9a54462024154346d66dbc5c9ec06712c1293aa4c5587bc1c632ec0d4`）在 Ubuntu 离线构建。`npm run build:offline`、`verify:dist` 通过，73 个编译模块、4 个可执行文件、347 个 legacy 文件；5 个定向测试文件 111/111 通过。安装包 `/home/seu/planning-format-correction-2a44236-20260928/secheur-agent-0.1.0.tgz` SHA-256 为 `0157817f1d05dd322623fadb73ab4fa9a20c84fdae50f33fcbe59043a0114cdc`。
- 正式服务仍为 `secheur-agent-rebuild.service`，端口 `14171`。2026-09-28 23:28 CST 核验 PID `2872538`（仅当时快照），实际 `ExecStart` 指向上述 release 的 `node_modules/@secheur/agent/dist/bridge-cli.js`。变更产物 `packages/secheur-agent/dist/planning/pi-adapters.js` SHA-256 `4c2c3886e582cdc29c6639a7d8ac3f2bdb85dac2554af7223b79de352aaf8e73`；`bridge.js` SHA-256 `e82e137e99c60c5364f8663d84b18b82118d02e53626e3d63046cf8dec27a6ca`（入口文件未改）。实际 drop-in SHA-256 `018d1bc4c5b0c6a43608140ab5a1c2e60ce843e6772224730d8e497ba1e3fbf9`。
- 切换前无开放 Bridge session 或 Controller 评测；切换后 `/status` ready、`/sessions` 为 0，首页、`/app.js`、`/model-profiles`、Field `14230/api/health`、UI `14231/ctf-field-ui-prototype.html` 正常。Profile 3 仍为 `secheur-minimax2 / MiniMax-M3`。PlanningStore 原路径 `/home/shared/pi-eval/config/.secheur-agent/planning.sqlite` 的 inode 仍为 `15335544`，未替换或清空。未运行真实模型、CTF 或 Benchmark。
- 回滚目标是保留的旧 release `/home/shared/agent-rebuild/app-releases/planning-handoff-review-577e34b-20260928`；切换前 drop-in 的 root-only 备份在 `/root/planning-format-correction-2a44236-20260928/40-canonical-release.conf.before`。需回滚时，先确认无运行任务，再以正常 sudo 认证恢复该文件、执行 `systemctl daemon-reload` 和 `systemctl restart secheur-agent-rebuild.service`，并核对实际进程及 `14171/status`；不要回滚 PlanningStore。
- Windows Planning 测试 257 通过、1 跳过；恢复测试 29 通过。源码类型检查、Biome、`git diff --check` 及 Windows 离线构建通过。完整测试类型检查仍报未修改的 `knowledge-coordinator.test.ts` 和既有 Planning 测试 fixture 类型错误；未修改旧断言以掩盖问题。

## 历史正式版本：Planning reference view 有界化与诊断修复

- 代码提交：`577e34b6a12499c2fd4a17b695bf07412a19c9fe`，分支 `fix/planning-handoff-reliability-20260928`；源码树 `b1917a2370d92c6f0fe40cc8901f19696d08e5ad`。本轮未修改 `main`。
- 唯一正式 release：`/home/shared/agent-rebuild/app-releases/planning-handoff-review-577e34b-20260928`；服务 `secheur-agent-rebuild.service`，端口 `14171`。2026-09-28 17:51 CST 切换后的 PID 为 `2744745`（仅为当时快照）；启动入口为新 release 的 `node_modules/@secheur/agent/dist/bridge-cli.js`。`bridge.js` SHA-256 `e82e137e99c60c5364f8663d84b18b82118d02e53626e3d63046cf8dec27a6ca` 与上一 release 相同；本轮变更的 `planning/context.js`、`planning/result-tool.js`、`planning/pi-adapters.js` SHA-256 分别为 `2ddfd80fd0725720e377169e6d5931ef5a2b86a0b5a7767357916ea099361f08`、`53eec728431a24f4d765be067f64003b654f275d4ad177cd2ab46a23bfb12210`、`b5435e8d2f3c33f2988a58a2522fcd4b95b2cbfb63e78d47c30aebeb5c4def73`。
- 构建输入归档 `/home/seu/planning-handoff-review-577e34b-20260928/source.tar` SHA-256 `0389052bf34443d5ce14cb97f43820d6c35e757b8bc6105ca5dd66b5bfc9a8e9`；Ubuntu Node `v24.14.0`，`npm run build:offline`、`verify:dist` 通过（73 个编译模块、4 个可执行文件、347 个 legacy 文件），4 个定向 Mock 文件 94/94 通过。安装包 `/home/seu/planning-handoff-review-577e34b-20260928/secheur-agent-0.1.0.tgz` SHA-256 `e890b58757dde348a4b1134200275d19ebd5c131ebba093cd1ec11a0436111dc`；发布回执在新 release 的 `BUILD-PROVENANCE.txt`。
- 实际 drop-in `/etc/systemd/system/secheur-agent-rebuild.service.d/40-canonical-release.conf` SHA-256 `56ea96e9d2a7a124fe1d4b844d3df0c280266e3c38df1254472f77d53ca9c14c`。切换前确认无 Controller 进程、`/sessions` 为空；切换后 `/status` ready、`/sessions` 为空、`/`、`/app.js`、`/model-profiles`、Field 后端 `14230/api/health` 和 UI `14231/ctf-field-ui-prototype.html` 均正常。Profile 3 的只读元数据为 `secheur-minimax2 / MiniMax-M3`。PlanningStore 原路径 `/home/shared/pi-eval/config/.secheur-agent/planning.sqlite` 未替换，inode 仍为 `15335544`。
- 旧 release `/home/shared/agent-rebuild/app-releases/planning-v12-1-0555c743-20260928` 保留。旧 drop-in 的 root-only 回滚备份为 `/root/planning-handoff-review-577e34b-20260928/40-canonical-release.conf.before`；切换前配置 SHA-256 `b989c8eef306a68544bc4951087c06a25bfb00e87d919a2c9e97f04be252f595`。若需回滚，先确认无运行任务，再以正常 sudo 认证恢复该 drop-in、执行 `systemctl daemon-reload` 和 `systemctl restart secheur-agent-rebuild.service`，然后核对实际进程、`14171/status` 和 PlanningStore；不要回滚数据库。
- 本轮未运行真实 CTF、Benchmark、模型探测或 Flag 验证；Windows Planning 回归 249 通过、1 跳过，源码类型检查、Biome、`git diff --check` 通过。旧版部署记录和评测产物均保留。

## 历史正式版本：Planning Proposal/Handoff Reliability 复审修复（2026-09-28 06:21 CST 快照）

- 代码分支：`fix/planning-handoff-reliability-20260928`；实际构建提交：`ab5e94013ed727cca60658941b43bc4b15405583`。`main` 未改，旧 `938d93d` 部署脚本未继续认证或切换。
- 唯一正式 release：`/home/shared/agent-rebuild/app-releases/planning-handoff-reliability-ab5e940-20260928`。实际启动入口为该目录的 `node_modules/@secheur/agent/dist/bridge-cli.js`，SHA-256 `cfe9f48d1c33a38213f585e751afc913202937e7a190173c92801cee8b31273d`；实际业务产物 `packages/secheur-agent/dist/bridge.js` SHA-256 `df9f0a0cbd7f21b3a41e1e163413c19afc517aa7bd3799706e1ab53b49c9e3a7`。
- 构建来源：`/home/seu/planning-handoff-dd4b8c4-20260928/source` 的 Git HEAD 已核为上述提交；Ubuntu Node `v24.14.0`，`npm run build:offline`、`npm run verify:dist` 通过（73 个编译模块、4 个可执行文件、347 个 legacy 文件）。`npm pack` 产物 `/home/seu/planning-handoff-dd4b8c4-20260928/secheur-agent-0.1.0.tgz` SHA-256 `cd0359c88b778c3d9fead016bdaca7cbe63a79eb353841042432f3c84d92450a`。发布目录由同一构建树复制、无 `.git`，已在发布目录复验 dist。
- 正式服务：`secheur-agent-rebuild.service`，运行身份 `pi-eval:shared`，Node `v24.14.0`；2026-09-28 06:21:55 CST 切换后 PID `2030249`（仅为当时快照）。`0.0.0.0:14171` 在监听；`/status`、`/`、`/app.js`、`/model-profiles` 均为 HTTP 200。Profile 3 只读元数据仍为 `secheur-minimax2 / MiniMax-M3`。Field 后端 `14230/api/health` 与 UI 页面 `14231/ctf-field-ui-prototype.html` 均为 HTTP 200。没有发起模型探测、Oracle 或 Flag 验证。
- 当前生效 drop-in：`/etc/systemd/system/secheur-agent-rebuild.service.d/40-canonical-release.conf`，SHA-256 `7297234769283449ebb947a9a2a671b569b576e479aef206aa4c65aced6b40d4`。只更新同一服务的 `ExecStart`，基础 unit 仍提供端口 `14171`；未替换 Field、Oracle、Controller 或 PlanningStore。Controller 实际文件仍为 `/home/shared/eval-runner/bridge_eval_controller.py`，SHA-256 `8f3e8332c1f09f4841727f3f104b3b6475d83fda9e9570ad2bc5e52b320a0a91`。
- 切换前 `/sessions` 仅有 1 个 idle 会话，且无 Controller 评测进程；切换后开放会话数为 0。PlanningStore 保持 `/home/shared/pi-eval/config/.secheur-agent/planning.sqlite`，切换前后 inode `15335544`，属主 `pi-eval:shared`、大小 `298582016` 字节；未清空、替换或重置。旧 release `/home/shared/agent-rebuild/app-releases/planning-v12-6cd8366-20260927` 保留。旧 drop-in 的 root-only 回滚备份位于 `/root/planning-handoff-reliability-ab5e940-20260928/40-canonical-release.conf.before`，切换前哈希 `b517468481e55914b85a120dde2840bfa86c4c5a23b484990d4570919124c589`；部署脚本已在切换前写入并在成功后退出，未触发回滚。
- 回滚目标仅为上述旧 release：在确认无运行任务后，以正常 sudo 认证恢复上述备份到 `40-canonical-release.conf`，执行 `systemctl daemon-reload` 和 `systemctl restart secheur-agent-rebuild.service`，再核对实际 ExecStart、`14171/status` 和服务 PID；**不要**回滚 PlanningStore 或覆盖历史评测数据。
- 验收：Windows Planning/恢复 25 文件，253 通过、1 原有跳过；Ubuntu Planning/恢复/Bridge 27 文件、298/298 通过，Python Controller 65/65 通过。源码类型、改动文件 Biome、`git diff --check` 通过。完整测试类型检查仍有未修改的 `knowledge-coordinator.test.ts:500` TS2353；未改其断言，也未运行真实 CTF 或 Benchmark。

## 历史交接记录：2026-09-23（非当前版本）

> 以下保留当时的部署、复测与回滚记录；其中的“当前”只指 2026-09-23 的历史现场。不得以它的旧 release 路径覆盖上面的当前版本。

## 当时的正式端口与版本（2026-09-23）

| 组件 | 正式地址 | 现场核验 |
| --- | --- | --- |
| Field UI | `http://100.112.105.109:14231/ctf-field-ui-prototype.html` | `0.0.0.0:14231` 在监听；静态服务启动日志明确打印此页面为入口。根路径是目录索引，不是 UI 首页，不需要重定向。 |
| Field 后端 | `http://127.0.0.1:14230` | `ctf-field-backend-pi.service`；`/api/health` 返回正常。 |
| SecHeur Bridge | `http://100.112.105.109:14171` | 唯一正式 Bridge，监听 `0.0.0.0:14171`；`/status`、`/`、`/app.js`、`/model-profiles` 均已检查。 |

`14171` 是固定正式 Bridge 端口。`14168` 已废弃，不得作为正式入口、客户端目标或 canary 端口。不要仅按端口相邻关系推断组件请求方向，应按下面记录的实际配置与源码路由判断。

- 分支：`fix/limit-exhausted-terminal-001`
- 当前 commit：`8bc59d69c6299c1635d62038f6aee1d44b02f93c`（分支 `fix/limit-exhausted-terminal-001`）
- 当前 release：`/home/shared/agent-rebuild/app-releases/planning-diagnostics-8bc59d6-20260923`
- 实际运行入口：`/home/shared/agent-rebuild/app-releases/planning-diagnostics-8bc59d6-20260923/node_modules/@secheur/agent/dist/bridge-cli.js`
- 实际 `bridge-cli.js` SHA-256：`cfe9f48d1c33a38213f585e751afc913202937e7a190173c92801cee8b31273d`
- 实际 `bridge.js` SHA-256：`25f798813ebb947b21ae0cfbbc5b26dde140702a1504e5b4b10cf7787938b938`
- 构建 tarball SHA-256：`f57a982fc19c9f426dedc53d5a55df151a514520cceff43867a68b0ede6a8da5`；构建 provenance：`/home/shared/agent-rebuild/app-releases/planning-diagnostics-8bc59d6-20260923/BUILD-PROVENANCE.txt`
- Controller 实际执行文件：`/home/shared/eval-runner/bridge_eval_controller.py`；SHA-256：`8f3e8332c1f09f4841727f3f104b3b6475d83fda9e9570ad2bc5e52b320a0a91`。`stage1_run_batch.py` 默认从同目录加载此文件（`--controller` 可显式覆盖）。
- Node：`v24.14.0`；本次切换后观察到的正式 Bridge PID：`3144438`（PID 会随重启变化）
- 服务：`secheur-agent-rebuild.service`，运行身份 `pi-eval:shared`，工作目录与项目根目录 `/home/shared/pi-eval`
- 配置目录：`/home/shared/pi-eval/config/.secheur-agent`
- PlanningStore：`/home/shared/pi-eval/config/.secheur-agent/planning.sqlite`

`ctf-field-frontend-pi.service` 的 `CTF_FIELD_ORACLE` 指向 `http://127.0.0.1:14171/api/ctf-oracle/summary?limit=50`；PLAN_SINGLE 历史配置均将 `bridgeBase` 指向 `14171`、`fieldBase` 指向 `14230`。本次 SLCG 定向复测已结束，当前没有活动 Controller 或 Bridge session。正式 `/model-profiles` Profile `3 = secheur-minimax2/MiniMax-M3` 保持不变；为与前一次 SLCG 执行保持相同路由，单题复测使用 Profile 4 `secheur-minimax3/MiniMax-M3`。本次没有请求 `/api/ctf-oracle/summary`，也没有发生 Flag verifier 调用。

### 端口修正记录

基础 unit `/etc/systemd/system/secheur-agent-rebuild.service` 的 `Environment=BRIDGE_PORT=14171` 一直是正式端口。此前的 `14168` 覆盖已移除，当前 drop-in 不再设置 `BRIDGE_PORT`。本次只在同一个 `/etc/systemd/system/secheur-agent-rebuild.service.d/87-planning-failure-fix-158f6f9.conf` 中将 `ExecStart` 的 release 路径从 158f6f9 更新为上面的 8bc59d6 release；没有新增 drop-in，systemd 服务名、运行用户、工作目录和环境文件均保持不变。

修正后已对同一个 systemd 服务执行 daemon-reload 和重启。当前只有该正式 Bridge 在运行；确认无活动 session 后，另一个遗留的、空闲的隔离 Bridge（旧 release，`127.0.0.1:15171`）已对其确切 PID 发送 SIGTERM 并正常退出。没有创建常驻替代实例。

PlanningStore 仍为 `/home/shared/pi-eval/config/.secheur-agent/planning.sqlite`，属主/组为 `pi-eval:shared`。本次 Bridge 切换前后（尚未运行 SLCG）SHA-256 均为 `98b99c9d40e33e3241238e16f6373427132382f01a45b050a068276060ade53a`；其后唯一一次 SLCG run 将生命周期事件写入同一数据库。复测后文件为 `104738816` bytes，SHA-256 `596e855073e53c6fa4b320f08a8f24e761842b84fd7bc533445a86545bdb8386`。数据库未清空、迁移、替换或回滚。更早端口修正时留存的旧 hash `ae1f1434a4d71e3822f2331a21e4411403d36dc8f991b7576ec4b9d31ef2f225` 属于当时快照；该次修正前没有保存 hash，不能将它解释为前后比对。

drop-in 原文件备份：`/root/planning-failure-fix-158f6f9-20260923/bridge-port-14171-20260923T152554/87-planning-failure-fix-158f6f9.conf.pre-14171`（原文件 SHA-256：`54c6d986dc4c1571f87782550b518fc792df07664ed3506daa0884a8601e558b`）。当前修正版 SHA-256：`2c0b6e5d2212674e9dddd1546d7c8700ca5e76436c090f5d06e5aaef642f83ab`。

本次按精确提交 `8bc59d69c6299c1635d62038f6aee1d44b02f93c` 在服务器独立任务目录构建；15 个源码文件哈希清单、provider-data manifest、Node/npm 版本和 tarball 哈希均记录在新 release 的 `BUILD-PROVENANCE.txt` 与清单文件中。provider 生成数据复用旧 release 的已校验 manifest，没有运行会访问外部模型目录的 hydrate 脚本。旧 release `/home/shared/agent-rebuild/app-releases/planning-failure-fix-158f6f9-20260923` 保留用于回滚，没有另启常驻实例。

本次离线 Controller Mock 在实际 Controller 哈希 `8f3e8332…0a91` 的字节一致副本上通过 5 项测试，包括 session 清理前 Planning Trace 归档、artifact 写入 `planning-events.jsonl`、trace 导出失败标记和 Profile 预检诊断。随后仅运行一次 SLCG；结果目录为 `/home/shared/eval-runner/targeted-slcg-diagnostics-8bc59d6-20260923`，artifact `bridge-20260923-222727-l1-cybench_benchmark_LosFuzzys_GlacierCTF2023_writeups_crypto_SLCG`。Controller 记录 `planningTraceComplete=true`、864 个事件；题目结果为 `unverified_idle`，Planning run 正常 completed，但没有可信 Flag 验证。该次执行用于验证交接与诊断链路，不代表挑战 solved。

该 SLCG trace 中有 3 次 checkpoint 被 Store 层拒绝：1 次 `artifacts[0].path / artifact_scope_rejected`，2 次 `evidenceRefs / evidence_reference_not_persisted_or_wrong_run`，传入的引用分别是 `read-output-encrypt-py`、`read-output-ciphertext-txt` 和 `read:encrypt.py`、`read:ciphertext.txt`；它们不是本 run 已持久化的 `tool-*` evidence ID。拒绝事件只保存 artifact path 的 SHA-256 `7e0f6486…7dfcf5fb`，child session 工具参数未进入 session export，因此无法从现有 artifact 区分该路径是相对路径、文件不存在还是越出 lease scope；不应据此放宽校验。后续 Executor 上下文中的 `evidenceRefs` 候选数最高为 121，超时后呈现 34、因预算省略 87；49 条工具证据已保存。随后 trace 记录 `executor_timeout`（600040 ms）、attempt 封存、`replanAllowed=true`，Supervisor proposal 后 `replanStarted=true` 并派发新 task。两个后续 `planning_read_evidence` 请求均从前序 task 读取同一 evidence（967 bytes、`hasMore=false`、`scopeDecision=accepted`）。这证明证据可达且确有读取，但本次最终仍为 `unverified_idle`。

以下通用发布包说明不改变上述正式服务拓扑；本次已完成发布，不需要重新构建或部署。

目标服务器目录由部署环境提供。该目录继续作为 `SECHEUR_PROJECT_ROOT`，保留现有配置、CTF 工作区和浏览器数据；Node 发布包安装到独立 release 目录，避免把程序文件与运行数据混在一起。

## 前置条件

- Node.js `>=22.19.0`。
- Python `>=3.10,<3.14`；可优先复用项目现有虚拟环境中的 Python。
- 保留项目状态目录、CTF Docker volume 和 `ctf-work`。
- 不把 `mykey.py`、`.env`、Pi `auth.json`、Cookie、会话正文或挑战临时文件放入发布包。
- 正式 Bridge 仅使用 `14171`；通过受控私网访问，HTTP 端口不应直接暴露到不可信网络。

## 生成发布包

在开发机的仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run build:offline
npm run verify:dist --workspace=@secheur/agent
mkdir -p /tmp/secheur-release
npm pack --workspace=@secheur/agent --pack-destination /tmp/secheur-release
```

`build` 和 `npm pack` 都会执行发布产物校验。根构建在 SecHeur 前构建 RepoAudit extension；SecHeur 的暂存脚本只复制该插件的 `dist/src`、`package.json` 和 README，并将其作为真实 bundled dependency 放入生产 tarball。校验范围包括全部 TypeScript 输出、3 个 CLI bin、Desktop 静态资源、RepoAudit 插件、CTF MCP、Skill、攻击知识库和敏感文件排除规则。任一入口或必需资源缺失时不会生成可发布 tarball。

## 独立安装

把 tarball 放到服务器后，在独立目录安装；不要覆盖当前 Python 目录：

```bash
mkdir -p /path/to/secheur-agent-pi/current
cd /path/to/secheur-agent-pi/current
npm init -y
npm install --omit=dev --ignore-scripts /path/to/secheur-agent-0.1.0.tgz
```

先验证 3 个入口和 Python 兼容环境：

```bash
./node_modules/.bin/secheur --help
./node_modules/.bin/secheur-bridge --help
./node_modules/.bin/secheur-server --help

SECHEUR_PROJECT_ROOT=/path/to/secheur-agent \
SECHEUR_PYTHON=/path/to/secheur-agent/.venv/bin/python \
./node_modules/.bin/secheur doctor
```

`doctor` 失败时，按输出创建独立 Python venv 并安装发布包内的 legacy runtime。不要从开发机复制 `.venv`。

非 Docker 安装还必须准备 RepoAudit runtime：使用仓库 `vendor/repoaudit/` 的同版本内容创建 Python 3.13 venv、安装其 `requirements.txt`、运行 `python lib/build.py` 生成 `lib/build/my-languages.so`，并显式设置 `REPOAUDIT_ROOT` 与 `REPOAUDIT_PYTHON`。不要在部署时临时 clone RepoAudit 仓库，也不要复制开发机 `.venv`。

## RepoAudit Docker ready 契约

根 `Dockerfile` 从版本化的 `vendor/repoaudit/` 构建 runtime，不通过网络 clone RepoAudit。独立 builder 使用 Python 3.13 安装 requirements 并编译 grammar，最终镜像固定使用 `/opt/repoaudit` 和 `/opt/repoaudit-venv/bin/python`，并创建可写的 `log`、`result`、`runs`、`lock`。

镜像构建 smoke 与容器 entrypoint 都执行：

```bash
REPOAUDIT_REQUIRE_API_KEY=0 repoaudit-doctor
```

该 doctor 只做 runtime、Python、依赖、grammar、目录和凭据状态检查，不调用模型。entrypoint 通过后才启动服务；服务环境默认 `REPOAUDIT_REQUIRE_API_KEY=1`，因此正式 `repoaudit_scan` 仍强制校验所选模型族的 API Key。验证插件可见性时先创建 Bridge 会话，再请求：

```bash
curl -fsS http://127.0.0.1:14171/session/<session-id>/tools
```

返回的 `tools` 和 `activeTools` 必须包含 `repoaudit_scan`；缺失时服务应记录或返回 `PLUGIN_NOT_LOADED` 和 loader diagnostics。

## 15 项并发 benchmark

默认 `REPOAUDIT_LOCK_TIMEOUT_MS=300000`，单次扫描 `REPOAUDIT_TIMEOUT_MS=1800000`。进程内等待和文件锁等待每 25 秒发送心跳，因此 Bridge 不会把仍在排队的请求当作无进展；`SECHEUR_AGENT_OUTPUT_IDLE_TIMEOUT` 应至少为 90 秒，且必须大于心跳周期。锁等待超时仍会在 5 分钟明确返回 `LOCK_TIMEOUT`，而不是让 15 个请求静默耗尽 30 分钟。

建议 benchmark 使用一个容量为 15 的中央 FIFO 队列和 5 个 RepoAudit worker 副本，每个副本并发 1、prefetch 1；若按 worker 分片，则每个副本最多接纳 3 项（1 项运行、2 项等待）。若 15 项必须同时执行而不是排队，则需要 15 个隔离 worker。每个 worker 使用独立可写 runtime/artifact/lock volume，队列等待 SLA 与 30 分钟扫描 timeout 分开计时，并把 queued position/heartbeat 暴露给 Bridge。worker 崩溃后由中央 lease 到期重投，不能依赖共享 NFS 文件锁。

Compose 中的 `REPOAUDIT_COORDINATION_MODE`、`REPOAUDIT_CENTRAL_QUEUE_URL` 和 `REPOAUDIT_SHARED_LEASE_URL` 只是后续接入点，当前适配器尚不消费这些设置。现阶段多容器同时指向各自本地 lock 目录时会彼此不可见；正式水平扩容前必须实现 Redis/PostgreSQL 等中央队列或 lease 服务及其幂等重投策略。

## 当前正式服务配置与只读检查

正式服务实际生效配置由 systemd base unit 与 drop-in 合并。端口来自 base unit；当前最高优先级的 `87-planning-failure-fix-158f6f9.conf` 将 `ExecStart` 指向 `planning-diagnostics-8bc59d6-20260923` release，但不覆盖端口。不要添加另一层 drop-in，也不要在本机另起 Bridge。

检查服务及唯一正式监听：

```bash
systemctl status secheur-agent-rebuild.service --no-pager
systemctl cat secheur-agent-rebuild.service
ss -ltnp | grep -E ':(14168|14171|14230|14231)\b'
curl -fsS http://127.0.0.1:14171/status
curl -fsS http://127.0.0.1:14171/
curl -fsS http://127.0.0.1:14171/app.js >/dev/null
curl -fsS http://127.0.0.1:14171/model-profiles
curl -fsS http://127.0.0.1:14230/api/health
```

14231 的正式页面为 `http://100.112.105.109:14231/ctf-field-ui-prototype.html`。静态服务日志明确配置此页面入口，因此保留根路径目录索引，不擅自加首页重定向。`ctf-field-static-server-pi.py` 曾将摘要默认值和提交记录查询硬编码到废弃端口；已将两处都改为 `14171`，并只重启 `ctf-field-frontend-pi.service`。当前脚本不再含 `14168`，页面返回 HTTP 200。备份：`/home/seu/deployment-backups/ctf-field-static-server-pi-20260923.pre-14171.py`（原 SHA-256：`bf8a618cd9abf4fcb04408ff92abf8c1c04e048496e5ac658825501f79661ddd`）；修正版 SHA-256：`4002dd06a7d0ef52fcf8d81ce111c34847d11d65790bfb5a87ce84f578c23b35`。不要为了验收启动模型会话或创建真实 CTF 任务。

## 回滚

本次没有回滚。若需回滚本次 release，先恢复本次切换前的 87 drop-in（该备份指向 158f6f9 release，且已使用正式端口 14171），再 reload/restart 同一个 Bridge 服务；另将 Controller 文件恢复到本次更新前版本。不要回滚 PlanningStore：

```bash
sudo cp --preserve=all /root/planning-diagnostics-8bc59d6-20260923/87-planning-failure-fix-158f6f9.conf.pre-8bc59d6 /etc/systemd/system/secheur-agent-rebuild.service.d/87-planning-failure-fix-158f6f9.conf
sudo systemctl daemon-reload
sudo systemctl restart secheur-agent-rebuild.service
cp --preserve=all /home/seu/deployment-backups/planning-diagnostics-8bc59d6-20260923/bridge_eval_controller.py.pre-8bc59d6 /home/shared/eval-runner/bridge_eval_controller.py
```

Controller 原文件备份 SHA-256：`2cab376d381c6dd5dcdfab732f5200306abec9efe45faaba6c4af4bd031f8a4f`；drop-in 备份及切换时的 PlanningStore SHA-256 记录在 `/root/planning-diagnostics-8bc59d6-20260923/CUTOVER-PROVENANCE.txt`。旧 release 仅用于回滚，不应另外启动常驻服务。

更早的端口修正前 drop-in 备份位于上文路径。若需要恢复该历史备份中的其他 drop-in 内容，同时必须保留正式端口 `14171`，先恢复精确文件，再将备份中的废弃 `14168` 值改回 `14171`，然后 reload/restart：

```bash
sudo cp --preserve=all /root/planning-failure-fix-158f6f9-20260923/bridge-port-14171-20260923T152554/87-planning-failure-fix-158f6f9.conf.pre-14171 /etc/systemd/system/secheur-agent-rebuild.service.d/87-planning-failure-fix-158f6f9.conf
sudo sed -i 's/BRIDGE_PORT=14168/BRIDGE_PORT=14171/' /etc/systemd/system/secheur-agent-rebuild.service.d/87-planning-failure-fix-158f6f9.conf
sudo systemctl daemon-reload
sudo systemctl restart secheur-agent-rebuild.service
```

不要单独复制原端口修正备份并重启，因为那会重新引入已废弃端口。PlanningStore 和运行数据不属于 release，不得覆盖或删除。

Field 静态服务如需回滚，可恢复对应备份并只重启该 UI 服务；不要重启 Bridge：

```bash
cp --preserve=all /home/seu/deployment-backups/ctf-field-static-server-pi-20260923.pre-14171.py /home/shared/eval-runner/ctf-field-static-server-pi.py
sudo systemctl restart ctf-field-frontend-pi.service
```

## 2026-10-19 Windows PLAN release synchronization

The Windows installation at `D:\SecHeur-Agent` follows the interactive PLAN
release served on port 15173, rather than the separately deployed knowledge-base
refactor on port 14171. A later deployment timestamp does not imply that the
refactor contains the hypothesis engine.

The synchronized functionality includes PLAN selection and per-session engine
persistence from `c29a935`, and submission metadata tolerance from `15b5d63`.
The five updated runtime modules are `bridge`, `config`,
`planning/cairn/submission-contract`, `planning/cairn/reason-prompt`, and
`planning/hypothesis-adapters`. Their declarations and source maps were copied
with them. All 125 application JavaScript modules outside bundled legacy tools
matched the interactive release by SHA-256 after synchronization. The five
updated JavaScript modules passed the installed Windows Node runtime's syntax
check.

Both desktop and React frontend assets were synchronized with the same
interactive release; 16 published static files matched by SHA-256. Do not ship
the server's `.orig` backup as a release asset. Runtime files must be updated
together with frontend controls, otherwise the selection can be visible without
taking effect in the backend.

Keep the Windows launcher, Windows Node/Python runtimes, workspace, browser
profile, session history, and API settings outside the application replacement.
Back up changed application files before replacing them. API credentials stay in
the local private `auth.json`, never in this repository or a release manifest.
Adding a model profile must preserve existing profiles and default selections.

This synchronization did not start a backend, model request, or evaluation batch.
File integrity and syntax checks do not establish live Windows frontend behavior
or improved solve performance. Launch the existing Windows entry point separately
when interactive use is desired.
