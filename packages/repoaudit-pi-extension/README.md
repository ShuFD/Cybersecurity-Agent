# RepoAudit Pi Extension

这是 RepoAudit 面向 Pi Agent 的外部插件与 TypeScript Adapter。插件复用现有 RepoAudit Python 运行时，将仓库级数据流缺陷分析封装为 `repoaudit_scan` Tool，使 Pi Agent 可以通过自然语言发起源码审计，而不需要修改 Pi Agent 或 RepoAudit 的核心分析流程。

插件通过 `-e / --extension` 从外部加载。它负责连接 Pi Tool 契约与 RepoAudit CLI，并在两者之间完成参数校验、进程管理、结果判定和输出去敏。

## 主要能力

- 注册单一 `repoaudit_scan` Tool，保持调用边界清晰
- 支持 C/C++、Java、Python 和 Go 仓库的指定数据流缺陷分析
- 在运行前检查目标仓库、源文件、Python 版本、依赖和 Tree-sitter grammar
- 使用独立参数启动 RepoAudit Python 进程，不经过 shell 字符串拼接
- 支持超时、主动取消、进程树终止和单进程内串行执行
- 联合分析退出码、log 与 `detect_info.json`，避免把执行失败误判为零发现
- 区分“有发现”“无发现”和“执行失败”三种状态
- 精简返回给 Agent 的 finding，并过滤原始 stdout、stderr、完整日志和内部运行配置
- 通过 `promptSnippet` 和 `promptGuidelines` 接入 Pi 的 system prompt 路由，主动告知 Agent 何时应该调用 `repoaudit_scan`

## 支持范围

| Language 参数 | 源码范围 | Bug Type |
| --- | --- | --- |
| `Cpp` | C / C++ | `NPD`、`UAF`、`MLK` |
| `Java` | Java | `NPD` |
| `Python` | Python | `NPD` |
| `Go` | Go | `NPD` |

- `NPD`：Null Pointer Dereference
- `UAF`：Use After Free
- `MLK`：Memory Leak

该 Tool 面向上述仓库级数据流缺陷，不用于 Web 渗透、网络或端口扫描、二进制逆向、依赖/CVE 扫描、其他漏洞类别或通用代码审查。

## System prompt 集成

`repoaudit_scan` 不只是一个被动等待 Agent 调用的工具——它在 ToolDefinition 上挂了两段 system prompt 元数据，让 Pi 在拼装默认 system prompt 时就把 RepoAudit 的能力注入进去：

| 字段 | 位置 | 作用 |
| --- | --- | --- |
| `promptSnippet` | 默认 system prompt 的 *Available tools* 段 | 单行简介，让 Agent 知道这个工具能做什么 |
| `promptGuidelines` | 默认 system prompt 的 *Guidelines* 段 | 多条决策依据：什么场景下该用、什么场景下不该用、repoPath 语义、如何处理返回的 finding |

两段内容由常量 `REPOAUDIT_PROMPT_SNIPPET` 与 `REPOAUDIT_PROMPT_GUIDELINES` 导出，宿主也可以直接复用它们写自己的 prompt 模板：

```ts
import {
  REPOAUDIT_PROMPT_SNIPPET,
  REPOAUDIT_PROMPT_GUIDELINES,
} from "@repoaudit/typescript-adapter";
```

挂上这两个字段之后，Agent 即使收到“帮我看看有没有内存泄漏”这种自然语言指令，也能主动想起用 `repoaudit_scan`，而不需要用户显式提到 RepoAudit。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/index.ts` | Extension 入口以及 Adapter 的公开导出 |
| `src/extension/` | Tool schema、`repoaudit_scan` 注册和 Pi 结果映射 |
| `src/adapter/` | 配置、预检、Python 进程管理、artifact 定位和结果解析 |
| `tests/*.test.ts` | Adapter、进程生命周期、结果映射和 Extension 契约测试 |
| `tests/verify-extension-load.mjs` | 使用真实 Pi loader 验证 `-e` 加载 |
| `tests/standalone-smoke.ts` | 真实调用 RepoAudit Python 的手动 smoke test |
| `tests/fixtures/` | 测试用的最小源码仓库 |
| `.gitignore` | 忽略依赖和构建产物，并保留名称以 `result` 开头的源码与测试 |
| `package.json`、`package-lock.json` | Node.js 工程配置与锁定依赖 |
| `tsconfig.json` | TypeScript 编译配置 |

## 快速开始

### 环境要求

- Node.js `>=22.19.0`
- Python 3.13
- Pi Agent：`@earendil-works/pi-coding-agent@0.84.1`
- RepoAudit Python 依赖
- 已构建的 `lib/build/my-languages.so`
- Pi Agent 与 RepoAudit 所选模型各自需要的凭证

### 1. 准备 RepoAudit

Linux：

```bash
cd /app/RepoAudit
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python lib/build.py
```

Windows PowerShell：

```powershell
cd "E:\path\to\RepoAudit"
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe .\lib\build.py
```

### 2. 安装插件依赖与 Pi Agent

```bash
cd /app/RepoAudit/pi-extension
npm ci --ignore-scripts
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
```

### 3. 加载插件

建议从待审计仓库启动 Pi。这样 Tool 参数中的相对 `repoPath` 会相对于当前 Pi 工作目录解析：

```bash
cd /workspace/target-repository
pi -e "/app/RepoAudit/pi-extension/dist/src/index.js"
```

Windows PowerShell：

```powershell
cd "E:\workspace\target-repository"
pi.cmd -e "E:\path\to\RepoAudit\pi-extension\dist\src\index.js"
```

加载成功后，Pi Agent 中应出现 `repoaudit_scan` Tool。

### 4. 发起审计

可以直接使用自然语言：

```text
请使用 RepoAudit 对当前仓库执行 Python NPD/None dereference 数据流审计。
```

对应的 Tool 参数为：

```json
{
  "repoPath": ".",
  "language": "Python",
  "bugType": "NPD"
}
```

Tool 只接受这三个任务参数：

```ts
{
  repoPath: string;
  language: "Cpp" | "Java" | "Python" | "Go";
  bugType: "MLK" | "NPD" | "UAF";
}
```

模型、Python 路径、超时时间和 RepoAudit 根目录属于运行时配置，不对每次 Agent 调用开放。

## 运行时配置

生产环境应显式设置 `REPOAUDIT_ROOT`。本地开发仍可从当前工作目录或插件模块位置向上查找 `src/repoaudit.py`；doctor 会把这种情况标为 `inferred root`。设置 `REPOAUDIT_REQUIRE_EXPLICIT_ROOT=1` 后禁用推导，缺少 `REPOAUDIT_ROOT` 会稳定返回 `RUNTIME_NOT_FOUND`。

| 环境变量 | 默认值 / 说明 |
| --- | --- |
| `REPOAUDIT_ROOT` | RepoAudit 根目录；无法自动定位或采用独立部署布局时设置 |
| `REPOAUDIT_REQUIRE_EXPLICIT_ROOT` | `0`；生产建议设为 `1`，强制显式 root |
| `REPOAUDIT_PYTHON` | Linux 为 `<RepoAudit>/.venv/bin/python`；Windows 为 `.venv/Scripts/python.exe` |
| `REPOAUDIT_MODEL` | `claude-3.7` |
| `REPOAUDIT_TIMEOUT_MS` | `1800000`，即 30 分钟；必须是正整数 |
| `REPOAUDIT_REQUIRE_API_KEY` | 默认启用；仅设为 `0` 时跳过扫描前凭证强制检查，doctor 仍会报告缺失但不会因此整体失败 |
| `REPOAUDIT_MAX_SYMBOLIC_WORKERS` | `4`；允许 `1..32` |
| `REPOAUDIT_MAX_NEURAL_WORKERS` | `1`；允许 `1..8` |
| `REPOAUDIT_LOCK_DIR` | `<RepoAudit>/lock` |
| `REPOAUDIT_LOCK_TIMEOUT_MS` | `300000`，即等待锁 5 分钟 |
| `REPOAUDIT_LOCK_STALE_MS` | `120000`，即锁心跳超过 2 分钟才进入 stale 判定 |
| `REPOAUDIT_HEARTBEAT_MS` | `25000`；Tool `onUpdate` 和锁心跳的基础周期 |

Linux 示例：

```bash
export REPOAUDIT_ROOT=/app/RepoAudit
export REPOAUDIT_REQUIRE_EXPLICIT_ROOT=1
export REPOAUDIT_PYTHON=/app/RepoAudit/.venv/bin/python
export REPOAUDIT_MODEL=claude-3.7
export REPOAUDIT_TIMEOUT_MS=1800000
export REPOAUDIT_REQUIRE_API_KEY=1
export REPOAUDIT_MAX_SYMBOLIC_WORKERS=4
export REPOAUDIT_MAX_NEURAL_WORKERS=1
export REPOAUDIT_LOCK_TIMEOUT_MS=300000
export REPOAUDIT_LOCK_STALE_MS=120000
export REPOAUDIT_HEARTBEAT_MS=25000
export ANTHROPIC_API_KEY=<secret>
```

RepoAudit 模型与凭证的对应关系：

| `REPOAUDIT_MODEL` 名称包含 | 凭证环境变量 |
| --- | --- |
| `claude` | `ANTHROPIC_API_KEY` |
| `gpt` 或 `o3-mini` | `OPENAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY2` |
| `gemini` | `GOOGLE_API_KEY` |

Pi Agent 的模型凭证与 RepoAudit 的模型凭证是两类独立配置。两者都应通过云平台 Secret 或受控环境变量注入，不要写入源码或提交到 Git。

### 独立 doctor

doctor 不启动正式扫描、不访问模型，也不会产生 LLM 费用：

```bash
npm run doctor
# 安装包后也可执行：repoaudit-doctor
```

它检查显式/推导 root、`src/repoaudit.py`、Python 3.13、逐个 Python 模块、Tree-sitter 动态库及 C/Cpp/Java/Python/Go grammar、模型凭证映射与凭证是否存在、`log/result/runs/lock` 可写性，以及最终生效的 timeout/worker/lock/heartbeat 数值。输出只包含 API Key 是否存在，不包含值。任一必需检查失败时 CLI 以非零状态退出。

## 结果语义

| 状态 | 含义 |
| --- | --- |
| `success_with_findings` | 扫描完整结束，并产生至少一个经 Path Validator 接受的 finding |
| `success_no_findings` | 本次指定语言与缺陷类型的扫描完整结束，但没有 accepted finding |
| `failed` | 输入、环境、分析、artifact 解析、超时或取消失败 |

RepoAudit 的 Python worker 在部分异常下可能仍返回退出码 `0`。Adapter 不会仅依赖退出码，而会结合本次新生成的 log、结果目录、错误标记和 finding summary 判定最终状态。

`success_no_findings` 只说明本次选定范围没有报告 accepted finding，不代表整个仓库没有漏洞或绝对安全。`failed` 也不能解释为零发现。

成功结果会返回精简 finding、报告路径、日志路径和必要的执行摘要；失败结果会返回稳定错误码和去敏消息。原始 stdout、stderr、完整 log、Python 可执行文件路径及完整内部配置不会直接写入 Agent content。

每个 finding 只提供当前 RepoAudit 能够稳定归一化的信息：漏洞类型、文件、行号、解释摘要，以及 Path Validator / 人工确认状态。当前结果不包含 confidence score、结构化 sink 或完整 data-flow path；Agent 和下游系统不应推断或虚构这些字段。

## 运行产物

RepoAudit 将原始产物写入自身根目录，而不是待审计仓库：

```text
<RepoAudit>/log/dfbscan/<model>/<bugType>/<language>/<projectName>/<run_id>/dfbscan.log
<RepoAudit>/result/dfbscan/<model>/<bugType>/<language>/<projectName>/<run_id>/detect_info.json
```

- 只有产生 accepted finding 时，RepoAudit 才通常会写入 `detect_info.json`。
- 正常的零发现扫描可能只有 log，没有 JSON；这本身不代表执行失败。
- 插件生成 `run_<32 hex>` ID，通过新增的可选 `--run-id` 参数传给 legacy Python CLI；未传该参数的原有 CLI 调用仍保留时间戳目录行为。
- Pi 插件调用使用 run ID 作为 log/result 末级目录，实现本次调用的 artifact 隔离；Adapter 仍保留严格的运行前后快照，并校验新增目录必须与预期 run ID 一致。
- `<RepoAudit>/log/repoaudit-pi.jsonl` 只记录 run ID、阶段、耗时、退出码、终止来源和相对 artifact 路径，不记录 stderr、密钥、模型请求或源码。
- Tool 返回产物路径和精简摘要，不把完整源码、prompt、模型响应或原始日志写入 Agent 上下文。

## 常见失败排查

| 错误码 | 常见原因 | 处理方式 |
| --- | --- | --- |
| `REPOSITORY_NOT_FOUND`、`NO_ANALYZABLE_FILES` | 目标路径不存在、不是目录或没有所选语言源码 | 检查 `repoPath`、Pi 工作目录和 `language` |
| `RUNTIME_NOT_FOUND` | 无法定位 RepoAudit 根目录、入口或运行目录不可用 | 设置 `REPOAUDIT_ROOT` 并运行 doctor |
| `PYTHON_NOT_FOUND`、`PYTHON_VERSION_UNSUPPORTED` | 虚拟环境缺失或不是 Python 3.13 | 重建 `.venv` 或设置 `REPOAUDIT_PYTHON` |
| `DEPENDENCY_MISSING` | RepoAudit Python 依赖不完整 | 按 doctor 列出的模块在指定 Python 环境安装依赖 |
| `TREE_SITTER_NOT_READY` | `my-languages.so` 缺失或 grammar 无法加载 | 使用同一 Python 环境运行 `lib/build.py` |
| `API_KEY_MISSING`、`MODEL_CONFIGURATION_ERROR` | 所选模型的凭证缺失或名称无法映射 | 检查 `REPOAUDIT_MODEL` 和对应 Secret |
| `UNSUPPORTED_*` | 语言、漏洞类型或二者组合不受支持 | 按支持矩阵修改 Tool 参数 |
| `ANALYSIS_FAILED`、`RESULT_*` | Python worker、日志或结果产物不完整/冲突 | 查看返回的 `logPath`，修复环境后重试 |
| `SCAN_TIMEOUT` | 插件内部扫描 timeout | 调整任务范围或 `REPOAUDIT_TIMEOUT_MS` 后重试 |
| `USER_ABORTED` | 用户取消，或取消来源无法可靠识别 | 确认后重新发起扫描 |
| `HOST_WATCHDOG_ABORTED` | `AbortSignal.reason` 或 runtime option 明确标识宿主 watchdog | 检查宿主 watchdog 与 update 事件链路 |
| `LOCK_TIMEOUT` | 另一个进程长期持有 RepoAudit 文件锁 | 等待活动扫描结束，或用 doctor/锁元数据排查 stale lock |
| `LOCK_LEASE_LOST` | heartbeat 无法更新、锁文件消失或 owner token 被替换 | 停止并发扫描，检查锁存储可靠性后重试 |

## 配置与安全

- 插件通过 `spawn(command, args, { shell: false })` 调用 Python，仓库路径不会拼接进 shell 命令。
- 传递给 RepoAudit 子进程的环境变量采用允许列表，并只加入当前模型需要的凭证。
- 不要提交 `.venv/`、`node_modules/`、`dist/`、`.env`、API key、`log/` 或 `result/`。
- RepoAudit 的 log 和 report 可能包含源码、模型输入输出与绝对路径，应限制访问权限和保留时间。
- RepoAudit 会把被分析的源码片段发送给所选 LLM 供应商。部署前应确认代码分类、供应商协议、数据驻留和组织合规策略允许该行为。
- 不要把 RepoAudit 根目录、`src/`、`.venv/`、`log/` 或 `result/` 目录自身作为扫描目标。
- 插件当前没有面向业务目录的通用 allowlist 配置；生产环境应通过容器挂载、文件系统权限或独立运行账户，把可读取范围限制在获准的工作目录。
- 进程内 Promise 队列只是轻量优化；真正的跨进程保障是 `REPOAUDIT_LOCK_DIR/repoaudit-scan.lock` 的原子 exclusive-create 文件锁。锁包含 owner token、PID、run ID、创建时间和 heartbeat；释放时只删除自己的锁，同主机 PID 仍存活时不会作为 stale 回收。heartbeat 更新失败、锁消失或 owner 被替换时，适配器会终止活动进程树并返回 `LOCK_LEASE_LOST`，不会把该运行解释为零发现。
- 文件锁适用于具有可靠原子创建语义的共享本地文件系统。多容器并发或不保证原子语义/一致性的网络文件系统必须改用中央队列、数据库 lease 或独立 RepoAudit worker 服务，不能把本文件锁当作分布式锁。
- 扫描取消保留 Windows `taskkill /T` 后有限 grace 再 `/F`，Unix 使用进程组 `SIGTERM` 后再 `SIGKILL`，避免遗留 Python worker。
- `repoaudit_scan` 每 25 秒（可配置）通过 `onUpdate` 发送包含 run ID、阶段和已运行秒数的 heartbeat；可识别的 Python JSONL 进度会转为精简更新，非结构化 stdout/stderr 不转发给 Agent。
- Extension 契约当前锁定在 `@earendil-works/pi-coding-agent@0.84.1`；升级 Pi Agent 后应重新执行加载验证和测试。

## 开发检查

普通开发检查不会调用真实模型：

```bash
cd /app/RepoAudit/pi-extension
npm run typecheck
npm run lint
npm test
npm run verify:extension-load
npm run doctor
npm run verify:pack
```

当前测试覆盖：

- ExtensionFactory、Tool schema 和参数路由
- 非法语言、缺陷类型与不支持组合
- Python、依赖、Tree-sitter 和仓库输入预检
- 含空格及中文路径的独立参数传递
- 超时、取消来源、进程树终止、heartbeat 及 finally 清理
- 文件锁互斥、多进程竞争、stale 恢复和 owner 校验
- doctor 成功/失败分支、worker 配置和五种 grammar 检查
- log/result artifact 定位与三态解析
- Agent 结果精简、失败去敏和上下文泄漏防护

真实 smoke test：

```bash
npm run smoke
```

该命令会真实调用 RepoAudit Python runtime，并在 RepoAudit 根目录生成 `log/`、`result/`。当前 smoke 同时包含 clean fixture 和“缺少 RepoAudit 模型凭证”的失败验证；如果环境中已经注入模型凭证，toy case 可能发起真实 LLM 请求并产生费用，且测试预期也会发生变化。运行前应检查脚本与环境，不要使用生产凭证，也不要把它作为普通单元测试或 CI 的默认步骤。

## 部署建议

推荐将 RepoAudit runtime 与插件一同部署，并将待审计仓库放在独立工作目录：

```text
/app/RepoAudit/
├── .venv/
├── lib/build/my-languages.so
├── src/repoaudit.py
└── pi-extension/

/workspace/target-repository/
```

部署时还应遵循以下约束：

- 使用目标机器上的 Python 3.13 重新创建 `.venv`，不要从开发机复制虚拟环境。
- `lib/build.py` 可能需要下载并编译多种 Tree-sitter grammar，应在构建或发布阶段完成；Tool 调用期间不会自动联网构建。
- Python 依赖当前以 RepoAudit 的 `requirements.txt` 为准，尚未提供完整锁文件；升级依赖后应重新执行预检和 smoke test。
- Adapter 当前内部参数为 `temperature=0`、`callDepth=3`，worker 默认分别为 `4` 和 `1`。这些参数不暴露给 Agent Tool schema，只通过受控环境变量配置。
- 同一个 RepoAudit runtime 的扫描由跨进程文件锁串行化。需要多容器水平扩展时，应使用中央队列/独立 worker 服务，或为每个 worker 准备隔离 runtime。

部署后至少执行以下验收：

```bash
cd /app/RepoAudit/pi-extension
npm ci --ignore-scripts
npm run typecheck
npm test
npm run verify:extension-load
npm run doctor
npm run verify:pack
```

随后从一个无敏感数据的最小仓库启动 Pi，确认 `repoaudit_scan` 可见，并分别验证一次合法参数和一次不支持的语言/缺陷组合。只有在使用获准的测试凭证时，才执行会调用 LLM 的真实扫描。
