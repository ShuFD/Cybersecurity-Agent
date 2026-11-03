# RepoAudit 插件定位、运行环境与模型接入修复记录

记录日期：2026-11-01（Asia/Shanghai）。本文记录本次服务器排查、本地修复、复制发布及验证过程。不包含密码或 API Key。

## 1. 修复结论与边界

主 agent 已能调用 `repoaudit_scan`，插件能定位 Python 运行时、加载依赖与五种语言语法，并读取主 agent 默认模型的 OpenAI 兼容接口和凭据。doctor 全部通过，真实接口请求返回非空文本。

这不等于大型仓库扫描已完成。后续 N1/N2 测试出现等待模型回复、扫描超时及取消后遗留进程，尚需单独修复。本文不将这些问题计为已解决。

最初“找不到插件”需要区分三层：工具是否注册、Python 运行时是否可定位、运行依赖和模型是否可用。服务器原版本已经注册插件，本次主要修复后两层，未新增工具注册代码。

## 2. 服务器与发布布局

| 项目 | 本次确认的配置 |
| --- | --- |
| SSH | `seu@100.85.231.58` |
| 主服务 | `secheur-agent-rebuild.service` |
| 服务用户 | `pi-eval`，组 `shared` |
| 工作目录 | `/home/shared/secheur-agent` |
| 发布根目录 | `/home/shared/agent-rebuild/app-releases` |
| 原生效版本 | `agent-kb-export-20260720-1430` |
| 新发布版本 | `agent-repoaudit-fix-20261031` |
| 主 agent 配置目录 | `/home/shared/agent-rebuild/web-cairn-switch-20261016/frontend-state/pi` |
| Node | `/opt/node-v24.14.0-linux-x64/bin/node` |

原发布目录没有 `.git`；`DEPLOYED_COMMIT` 标记为 `ad610b6cc98f16e32b1a20da7314487aab28106a`。初次对比时本地 HEAD 为 `909fb238f899fd05e80b7eb251ebc9b0ca8ea6b6`，两者不相同。新目录通过复制服务器原生效版本创建，再应用本次修复，并非整份本地代码覆盖。

主服务有多份 systemd drop-in，历史上用增加 `z` 前缀覆盖 `ExecStart`。本次沿用最后生效文件，不新增一层覆盖：

```text
/etc/systemd/system/secheur-agent-rebuild.service.d/zzzzzzzzzzzzzzzzzz-kb-export3-20260720.conf
```

当前启动链路：

```text
systemd → 新发布目录/bridge-kb-web.mjs
        → 新发布目录/packages/secheur-agent/dist/bridge.js
        → @repoaudit/typescript-adapter
        → 新发布目录/vendor/repoaudit/src/repoaudit.py
```

## 3. 根因和修复文件

以下路径均相对于本地 `SecHeur-Agent-pro/`。

| 文件 | 问题与修改 |
| --- | --- |
| `packages/repoaudit-pi-extension/src/adapter/config.ts` | 原来只向上寻找 `src/repoaudit.py`，漏掉真实的 `vendor/repoaudit/src/repoaudit.py`；补充 vendored 目录检测。复制环境后读取主 agent 默认 provider 的模型、接口、存储凭据，传递给 Python。 |
| `vendor/repoaudit/src/llmtool/LLM_utils.py` | 原来按模型名称关键词分流，MiniMax 不在支持范围；设置 `REPOAUDIT_OPENAI_BASE_URL` 时优先走 OpenAI 兼容调用。保留完整 API Key，不再按冒号截断该调用路径的 Key。 |
| `packages/repoaudit-pi-extension/src/adapter/doctor.ts` | 原来检查原始环境，而复用的 Key 位于派生配置，造成误报；改为检查 `config.environment`。 |
| `packages/repoaudit-pi-extension/tests/config.test.ts` | 添加 vendored 根目录和主模型配置复用测试，覆盖子进程环境、原环境不被修改、显式模型配置优先级。 |

`config.ts` 的模型复用条件：未显式设置 `REPOAUDIT_MODEL`，且存在 `SECHEUR_AGENT_DIR`。从该目录读取：

- `settings.json`：`defaultProvider`、`defaultModel`。
- `models.json`：对应 provider 的 `api` 和 `baseUrl`。
- `auth.json`：对应 provider 的 `key`。

当前适配要求 provider 的 `api` 为 `openai-completions`，凭据为存储的非空字符串；不执行以 `!` 开头的凭据命令。配置不符合条件时返回 `MODEL_CONFIGURATION_ERROR`。这不是通用 OAuth 或所有 provider 适配；也不读取会话中临时切换的模型，只复用默认配置。

派生配置将模型名设置为主 agent 的默认模型，通过 `REPOAUDIT_OPENAI_BASE_URL` 和 `OPENAI_API_KEY` 传给审计子进程，不将 Key 写入源码或打印。显式 `REPOAUDIT_MODEL` 保留独立配置优先级。

## 4. 创建新版本与部署源码

以下为本次操作记录。不要对已完成部署的目录盲目重复执行。新终端或切换用户后需要重新定义变量。

```bash
BASE=/home/shared/agent-rebuild
OLD="$BASE/app-releases/agent-kb-export-20260720-1430"
NEW="$BASE/app-releases/agent-repoaudit-fix-20261031"
PLUGIN="$NEW/packages/repoaudit-pi-extension"
INSTALLED="$NEW/packages/secheur-agent/node_modules/@repoaudit/typescript-adapter"
ROOT="$NEW/vendor/repoaudit"

sudo test ! -e "$NEW" && sudo cp -a "$OLD" "$NEW"
```

本地通过 `scp` 上传修复源码到服务器 `/tmp`，再备份并替换新发布目录对应文件。上传过的临时文件为 `/tmp/config.ts`、`/tmp/LLM_utils.py`、`/tmp/repoaudit-doctor.ts`，临时文件不作为长期发布源。

每次替换前建立唯一备份目录，保留源码和实际安装副本的 `dist`：

```bash
BACKUP="$NEW/model-reuse-backup-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "$BACKUP"
sudo cp -a "$PLUGIN/src/adapter/config.ts" "$BACKUP/config.ts"
sudo cp -a "$PLUGIN/src/adapter/doctor.ts" "$BACKUP/doctor.ts"
sudo cp -a "$ROOT/src/llmtool/LLM_utils.py" "$BACKUP/LLM_utils.py"
sudo cp -a "$INSTALLED/dist" "$BACKUP/installed-dist"
```

构建与同步：

```bash
cd "$NEW"
sudo env PATH=/opt/node-v24.14.0-linux-x64/bin:$PATH \
  npm run build --workspace=@repoaudit/typescript-adapter
# 仅构建成功后执行
sudo cp -a "$PLUGIN/dist/src/." "$INSTALLED/dist/src/"
```

本次发现主 agent 加载的是 `packages/secheur-agent/node_modules/@repoaudit/typescript-adapter/dist/src/index.js`，不是 workspace 的构建目录。只修改 TypeScript 或只构建 workspace 都不足以更新实际运行副本。

检查加载位置必须在主程序包目录执行：

```bash
cd "$NEW/packages/secheur-agent"
/opt/node-v24.14.0-linux-x64/bin/node --input-type=module -e \
  "console.log(import.meta.resolve('@repoaudit/typescript-adapter'))"
```

路径应属于新发布目录。复制版本时还应检查软链接，避免新目录继续加载旧目录的文件。

## 5. 补齐 Python 与 Tree-sitter

原有 `/opt/secheur-agent-python/bin/python` 为 Python 3.11.17，且没有 pip；插件预检查明确要求 Python 3.13。因此没有替换主 agent 的 Python，而是创建独立工具环境与审计环境。

实际采用的安装步骤：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv
sudo /usr/bin/python3 -m venv /opt/repoaudit-bootstrap
sudo /opt/repoaudit-bootstrap/bin/python -m pip install uv

sudo env UV_PYTHON_INSTALL_DIR=/opt/repoaudit-python \
  /opt/repoaudit-bootstrap/bin/uv python install 3.13
sudo env UV_PYTHON_INSTALL_DIR=/opt/repoaudit-python \
  /opt/repoaudit-bootstrap/bin/uv venv --python 3.13 "$ROOT/.venv"

sudo /opt/repoaudit-bootstrap/bin/uv pip install \
  --python "$ROOT/.venv/bin/python" -r "$ROOT/requirements.txt"
```

本次实际安装的解释器为 Python 3.13.18。上面的 `uv` 安装与 requirements 没有完整锁定全部版本，是本次恢复步骤，不是可复现依赖锁；后续正式发布应保存验证后的工具和依赖版本。

确认 `git`、`cc`、`c++` 存在，缺少编译工具时安装 `build-essential`，然后执行：

```bash
cd "$ROOT"
sudo "$ROOT/.venv/bin/python" lib/build.py
ls -lh "$ROOT/lib/build/my-languages.so"
sudo -u pi-eval "$ROOT/.venv/bin/python" --version
```

脚本下载 C、C++、Java、Python、Go 语法并 checkout 指定 commit。Git 的 detached HEAD 提示是预期行为，`Language.build_library` 的弃用警告不代表失败。实际生成语言库约 6.8 MB，doctor 验证全部语法可加载。

## 6. 修正启动包装与服务入口

原 `bridge-kb-web.mjs` 的代码导入路径和 `staticRoot` 写死到旧版本，复制发布目录不会自动改变这两个引用。本次创建新包装并替换路径：

```bash
sudo cp "$BASE/web-kb-export-20260720-1430/bridge-kb-web.mjs" \
  "$NEW/bridge-kb-web.mjs"
sudo sed -i "s|$OLD|$NEW|g" "$NEW/bridge-kb-web.mjs"
cat "$NEW/bridge-kb-web.mjs"
```

确认代码与静态文件都指向新版本，备份最后生效的 drop-in 并更改入口：

```bash
OVERRIDE=/etc/systemd/system/secheur-agent-rebuild.service.d/zzzzzzzzzzzzzzzzzz-kb-export3-20260720.conf
sudo cp -a "$OVERRIDE" "$NEW/service-override.before"
printf '[Service]\nExecStart=\nExecStart=/opt/node-v24.14.0-linux-x64/bin/node %s/bridge-kb-web.mjs\n' "$NEW" \
  | sudo tee "$OVERRIDE"
sudo systemctl daemon-reload
sudo systemctl show secheur-agent-rebuild -p ExecStart --no-pager
```

上述备份在首次切换时创建，不要再次用新入口覆盖旧入口备份。服务配置原有的 `SECHEUR_AGENT_DIR` 继续提供主模型配置目录，无需在源码写入密钥。

在没有活跃测试时重启：

```bash
sudo systemctl restart secheur-agent-rebuild
sudo systemctl status secheur-agent-rebuild --no-pager -l
sudo journalctl -u secheur-agent-rebuild -n 80 --no-pager
```

本次 2026-11-01 13:08 重启后主进程 PID 为 `3691961`，入口是新版本包装文件，日志出现 `KB export3 ready`。

## 7. 分层验收与实际结果

### 7.1 本地配置测试

```bash
node --experimental-strip-types --test \
  packages/repoaudit-pi-extension/tests/config.test.ts \
  packages/repoaudit-pi-extension/tests/doctor.test.ts
```

配置与 doctor 共 12 项测试通过。服务器 TypeScript 构建成功。此结果不替代真实扫描验证。

### 7.2 使用服务身份运行 doctor

```bash
sudo -u pi-eval env \
  SECHEUR_AGENT_DIR=/home/shared/agent-rebuild/web-cairn-switch-20261016/frontend-state/pi \
  /opt/node-v24.14.0-linux-x64/bin/node \
  "$INSTALLED/dist/src/doctor-cli.js"
```

2026-11-01 13:02（北京时间）用户提供的结果为：`ok: true`、模型 `MiniMax-M3`、凭据映射 `OPENAI_API_KEY`、`apiKeyPresent: true`；运行时、Python、依赖、五种语法、输出目录均通过。

普通 `seu` 用户不能进入 `/home/shared/secheur-agent`，但服务用户 `pi-eval` 可以，验证应使用服务身份，不应为方便排查放宽工作目录权限。

### 7.3 真实模型请求

通过实际加载的插件 `createRuntimeConfig()` 与 `buildChildEnvironment()`，启动审计 Python，向派生接口发送一次简短 Chat Completions 请求。返回：

```text
接口调用成功；返回非空文本： True
```

该验证说明接口地址、模型、凭据和 Python SDK 可用，不证明长提示、多轮分析和扫描报告产出已完成。

### 7.4 工具调用和扫描

会话记录中已有 `repoaudit_scan` 调用，因此 agent 能发现并调用工具。后续测试出现 `SCAN_TIMEOUT`、`USER_ABORTED`，应作为运行阶段问题继续排查，不能解释为插件未注册或路径再次丢失。

## 8. 操作中遇到的问题

| 现象 | 原因或处理 |
| --- | --- |
| 导入 `/packages/...` 报不存在 | 新终端/root 会话没有 `$NEW`，重新定义路径变量。 |
| `seu` 切换服务工作目录报 EACCES | 使用 `sudo -u pi-eval` 验证；不修改目录访问权限。 |
| 构建成功但不含修复 | 主程序使用 node_modules 中的打包副本，需要同步构建产物。 |
| doctor 能识别 MiniMax 但误报 Key 缺失 | doctor 错用原始环境，已改为检查派生配置环境。 |
| restart 等待约 90 秒 | 旧服务遗留子进程不退出，停止超时后新主进程才启动；与新服务启动成功是两件事。 |
| SQLite ExperimentalWarning | 本次启动提示，不是 RepoAudit 路径失败。 |

## 9. 尚未解决：请求超时与遗留进程

2026-11-01 15:01 左右只读检查得到：

- N1：`run_e7ad5b391ecd45a783eec2f021b14a7a`，进程 `3727467`，当时父进程为主服务 `3691961`。14:49:49 发起模型调用后约 12 分钟无新分析日志，但锁心跳仍更新。
- ImageMagick：`run_9167a9663df34f19af6064bdb891bba2`，进程 `3705619`，父进程为 `1`，当时已运行约 35 分钟，标准输出为 `/home/shared/secheur-agent/work/scan_npd.log`。脱离主服务的原因仍需调查，不能仅据此判断是谁取消。
- 该批扫描实际模型为 `MiniMax-M3.1-Flash`，不同于前面 doctor 验证时的 `MiniMax-M3`，记录应以各次运行参数为准。
- ImageMagick 一次调用从 14:33:40 到 14:54:39 才返回，约 21 分钟。

Python `run_with_timeout()` 使用 `with ThreadPoolExecutor(...)`，`future.result(timeout=100)` 超时后，退出上下文仍等待正在执行的线程。因此 100 秒并非有效的请求结束期限。OpenAI 客户端构造未显式设置请求超时和重试限制。应另行修复请求期限、取消传播和子进程回收，而不是只加大扫描总时限。

主服务还遗留 `tail`（PID `3169343`）和 `/tmp/zone`（PID `3169345`），重启时曾反复等待停止超时；具体进程状态与来源需要单独检查。本次未为整理文档取消测试或清理进程。

## 10. 回滚记录

回滚首次版本切换前，确认以下备份仍是旧入口：

```bash
cat "$NEW/service-override.before"
sudo cp -a "$NEW/service-override.before" "$OVERRIDE"
sudo systemctl daemon-reload
sudo systemctl restart secheur-agent-rebuild
```

如果仅回滚模型复用补丁，则从对应唯一备份目录恢复 `config.ts`、`doctor.ts`、`LLM_utils.py` 和安装副本 `dist`，重新构建时注意不要再次覆盖已恢复的副本，最后在没有活跃任务时重启。保留新旧发布目录、备份路径与验证日志；不要将密钥、auth.json 或会话内容提交到仓库。
