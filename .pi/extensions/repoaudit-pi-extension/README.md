# RepoAudit Pi Agent 插件

这是一个根据 [PurCL/RepoAudit](https://github.com/PurCL/RepoAudit) 公开架构重新实现的 Pi Agent TypeScript 插件。它不是官方 Python 源码的复制品。

RepoAudit 的原始定位是仓库级通用缺陷检测：`MetaScanAgent` 提取语法和调用元信息，`DFBScanAgent` 针对数据流缺陷执行源到汇聚点的路径分析和可达性验证。原项目当前覆盖 C/C++、Java、Python、Go，并支持 NPD（空指针解引用）、MLK（内存泄漏）和 UAF（释放后使用）等缺陷类型；许可证为 Purdue 非商业开源软件许可证。使用和再发布时应保留原项目许可证与署名，并自行确认非商业许可边界。

## 插件定位

本插件保留 RepoAudit 的分析工作流和三类记忆模型，但不试图在 TypeScript 中重写 Tree-sitter、LLMSCAN 或具体 LLM 后端：

- 语法记忆：`index` 对本地仓库建立文件、行数、函数名和常见 API 调用索引；
- 语义记忆：`record_candidate` 和 `validate_candidate` 保存源、汇聚点、路径、调用上下文、可达性和解释；
- 报告记忆：`record_finding`、`confirm_finding` 和 `report` 保存去重后的缺陷报告；
- 外部分析：可以使用 Pi 的 `read`、`grep` 或其他本地分析工具，再将准确的文件位置和证据回填到插件；
- 全部文件读取是本地只读操作，插件不向被审计仓库写文件，也不执行 Shell 命令。

## 支持范围

| 语言 | `metascan` | `dfbscan` |
| --- | --- | --- |
| C/C++ (`Cpp`) | 支持 | `NPD`、`MLK`、`UAF` |
| Java | 支持 | `NPD` |
| Python | 支持 | `NPD` |
| Go | 支持 | `NPD` |

`metascan` 用于元信息索引，不需要 `bugType`。`dfbscan` 必须选择支持的缺陷类型，并通过候选路径和验证步骤形成结论。

## 文件位置

- 插件：`.pi/extensions/repoaudit/index.ts`
- 配置：`C:\Users\Zander\Documents\New project\.pi\extensions\repoaudit\repoaudit.json`
- 本说明：`C:\Users\Zander\Documents\New project\.pi\extensions\repoaudit\README.md`

扩展入口使用项目标准路径 `.pi/extensions/repoaudit/index.ts`，不会修改独立的 `pentest` 插件工作流。

## 加载

```powershell
pi.cmd -e ".\.pi\extensions\repoaudit\index.ts"
```

项目被 Pi 信任后，也可以通过项目级扩展配置自动加载。

## 使用流程

### 1. 初始化

```text
调用 `repoAudit` 工具：
action=init
projectPath=C:\lab\demo
language=Python
scanType=dfbscan
bugType=NPD
isReachable=false
```

`projectPath` 必须是本地目录。插件不会联网，也不会把源代码上传给任何服务。

### 2. 建立索引

调用：

```text
index
```

这一步对应 RepoAudit 的 `MetaScanAgent` 前置语法分析，会读取支持语言的源文件并建立轻量级函数、行数和 API 调用索引。

### 3. 制定分析计划

调用：

```text
plan
```

对于 `metascan`，计划是“索引 -> 查看元信息 -> 报告”；对于 `dfbscan`，计划是“索引 -> 提取源/汇聚点 -> 数据流探索 -> 路径验证 -> 报告”。

### 4. 记录数据流候选

```text
record_candidate
  bugType=NPD
  source=可能为空的参数 user_ptr
  sink=对 user_ptr 的成员访问
  steps=["parse_request", "build_user", "handle_user"]
  files=["src/handler.py", "src/user.py"]
  lineHints=[42, 87]
  explanation=...
  evidence=["Pi read 工具调用引用", "相关代码片段"]
```

### 5. 验证路径

```text
validate_candidate
  candidateId=<候选 ID>
  reachable=true
  explanation=...
  evidence=["调用链证据", "分支条件分析", "路径验证工具引用"]
```

`reachable` 必须与初始化时的 `isReachable` 方向一致，才会将候选标记为 `confirmed`；否则标记为 `rejected`。这对应 DFBScan 的 source-must-reach-sink 与 source-must-not-reach-sink 两类判定。

### 6. 记录和确认 Finding

```text
record_finding
  candidateId=<已确认候选 ID>
  title=...
  path=src/handler.py
  line=42
  functionName=handle_user
  description=...
  evidence=["文件路径和行号", "最小代码证据", "验证解释"]
```

之后在交互式 Pi 中调用 `confirm_finding`，传入 `humanConfirmed=true`。没有 UI 时，确认会被拒绝，避免自动把模型猜测当成真实缺陷。

### 7. 输出报告

调用 `report`：

- `format=markdown`：生成适合阅读的缺陷报告；
- `format=json`：导出完整状态、候选和已确认 Finding。

调用 `finish` 前，所有 DFBScan 候选必须已经验证，所有 Finding 必须已经人工确认。

## Action 一览

| Action | 作用 |
| --- | --- |
| `init` | 初始化本地仓库审计 |
| `status` | 查看审计状态和 Finding 摘要 |
| `index` | 建立本地语法/调用元信息索引 |
| `list_files` | 查看索引文件 |
| `get_file` | 查看项目内单个源文件 |
| `plan` | 生成 MetaScan 或 DFBScan 流程 |
| `record_candidate` | 记录源到汇聚点的候选路径 |
| `validate_candidate` | 记录路径可达性验证结果 |
| `record_finding` | 创建候选缺陷报告 |
| `confirm_finding` | 人工确认或拒绝 Finding |
| `report` | 输出 Markdown 或 JSON 报告 |
| `finish` | 检查未决候选和 Finding 后结束审计 |
| `rollback` | 回滚到审计快照 |

## 配置

配置文件为 [`repoaudit.json`](./repoaudit.json)：

```json
{
  "schemaVersion": 1,
  "mode": "local-readonly",
  "maxFiles": 10000,
  "maxFileBytes": 512000,
  "excludedDirectories": [".git", "node_modules", "dist", "build"],
  "requireHumanConfirmation": true
}
```

- `maxFiles`：一次索引最多读取的源文件数；
- `maxFileBytes`：单个源文件最大读取字节数；
- `excludedDirectories`：不进入索引的目录；
- `requireHumanConfirmation`：是否要求交互式人工确认 Finding。

## 与官方实现的差异

保留的核心：语言和缺陷类型约束、MetaScan/DFBScan 两阶段、源/汇聚点与路径状态、可达性判定、报告去重、审计状态和恢复。

未移植的后端：Tree-sitter 完整 AST、LLMSCAN、具体 LLM API 调用、并行神经分析器、语言专用 Extractor、详细 CFL 调用上下文和原项目的日志目录。这些功能可以由 Pi 已有工具或后续独立扩展接入，而不应在本工作流插件中暗中执行。

## 安全和研究使用

该插件只读取本地仓库，不访问外部目标，不执行网络扫描，不修改代码，不运行构建或测试命令。研究时建议使用专门的 toy benchmark 或隔离副本，并保留 RepoAudit 原始许可证和署名信息。

## 命令

- `/repoaudit`：显示当前审计摘要；
- `/repoaudit-reset`：确认后清除当前 Pi session 中的审计状态。
