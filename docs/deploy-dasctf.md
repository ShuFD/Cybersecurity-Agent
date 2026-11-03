# DASCTF 部署运维说明

本文记录当前部署的配置、日常操作与已知限制。部署对象是 main 分支的 TypeScript 版
agent(`packages/secheur-agent`),`legacy/` 仅作为镜像内捆绑的 Python 兼容工具层。

## 部署形态

| 项 | 值 |
| --- | --- |
| 服务 | `agent`(常驻,桌面 UI + 桥)+ `ctf-toolbox`(profile `ctf`,完整版 Sage+Ghidra)；本地闭环另有 `local-ctf` profile |
| 入口 | http://127.0.0.1:14168/(`agent`);MCP `http://127.0.0.1:18080`(仅本机) |
| 数据 | bind mount:`./runtime/state`→`/data`、`./runtime/workspace`→`/workspace`、`./runtime/work`→`/work`(属主 uid 1000) |
| 代理 | 构建与容器内 npm/npx/pip 走 `host.docker.internal:7890`(见 `.env` 的 `BUILD_HTTP_PROXY`/`RUNTIME_HTTP_PROXY`);模型流量直连(`NO_PROXY` 覆盖 `llm-gateway.dasctf.com`) |
| docker daemon | 已配 systemd 代理 `/etc/systemd/system/docker.service.d/proxy.conf`;BuildKit 解析器不走 daemon 代理,新基础镜像需先 `docker pull` 预拉 |

## 模型配置(已完成)

官方 GLM 网关是**整端点代理**:网关 URL 本身就是完整请求地址,追加
`/responses` 或 `/chat/completions` 会 404。SecHeur 已将这段 URL 适配内置到
路由扩展、CLI、TUI、桌面桥和比赛协调器均自动生效,不依赖运行目录中的临时插件。

| Provider ID | 网关 | API | 模型 |
| --- | --- | --- | --- |
| `secheur-deepseek` | `https://loliapi.org` | openai-responses | `deepseek-v4-flash` |
| `secheur-glm` | `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/H5Jx-bqJJQCkbZys` | openai-responses | `glm-5.3` |

当设置 `BIGMODEL_API_KEY` 时，运行时会对 `secheur-glm/glm-5.3` 做进程内路由覆盖，使用
`BIGMODEL_RESPONSES_ENDPOINT`（默认 `https://open.bigmodel.cn/api/v1/responses`）；未设置时
保留上面的 DASCTF gateway 配置。

- 配置文件:`runtime/workspace/.secheur-agent/pi/{models.json, auth.json, settings.json}`;UI 侧 profile 在 `api-profiles.json`
- API key 已写入 `pi/auth.json`(按 provider id 存放)
- 默认路由:`router/auto`,默认推理强度为 `max`

### 模型切换

- 桌面 UI:设置页 / 模型选择(`secheur-deepseek/deepseek-v4-flash`、`secheur-glm/glm-5.3`)
- TUI / CLI:`/model` 或 `--model`,Ctrl+P 循环
- **自动按复杂度切换**:配置在项目 `.pi/model-router.json`。`high` 使用
  `secheur-glm/glm-5.3`,失败或额度耗尽回退到 DeepSeek；`medium` 和 `low` 使用
  `secheur-deepseek/deepseek-v4-flash`。三档都传递 `max`，只有显式选择 GLM 的
  high 路由才会访问 GLM。
- 若 UI 重写了 Pi 的 `models.json`,确认 provider 的 `baseUrl`、`api` 和 auth
  仍存在，然后重启 `agent`;不要把密钥写入 Git。

## 比赛日准备

1. 填 `runtime/workspace/.secheur-agent/competition.env`(`SLAB_MATCH_HOST`、
   `SLAB_MATCH_ID`、`SLAB_AGENT_ACCESSKEY`),或在 compose `agent.environment` 注入同名变量。
   比赛页面为 `https://gcsis.dasctf.com/1629`，API 的 `SLAB_MATCH_HOST` 应填写
   Server Host `https://pro.dasctf.com`，并设置 `SLAB_MATCH_ID=1629`。
2. 先用 `slab-match info`、`slab-match exercises` 验证比赛阶段和题目列表；官方
   API 文档在 `/workspace/api_doc.md`。
3. 附件与靶机操作在 `/work`(与 ctf-toolbox 共享)或题目工作目录进行。
4. 比赛阶段未开始时平台会返回业务错误，此时比赛队列保持不变，不应调用
   build-env 或提交测试 flag。

### 本地 CTFd 与环境 gateway

本地回归使用 `docker compose --profile local-ctf up -d --build`。在 compose 网络内，
`CTFD_URL` 必须是 `http://ctfd:8000`，宿主机浏览器使用 `http://127.0.0.1:18000`；
CTFd API token 通过 `CTFD_API_TOKEN` 注入 agent，不写入 gateway。gateway 的
`challenges.example.json` 只描述已准备好的本地 challenge 镜像，默认 10756 镜像名为
`secheur-10756:local`，没有该镜像时环境会明确返回 `environment_unconfigured`，不会把
本地 shell proof 当作平台 accepted。

gateway 的状态文件和环境容器由 Docker socket 管理。它限制并发槽位、环境 TTL、动态
端口、CPU/内存/PID 配置，并支持 `GET`、`POST heartbeat` 和 `DELETE`；broker 的 SQLite
租约仍是跨 agent/Bridge 进程的最终协调层。

为让 Main Agent 使用与 Slab 相同的结构化交互协议，设置 `CTFD_AGENT_ACCESS_KEY` 和
`CTFD_AGENT_USER_ID=1`。compose 会把 `docker/ctfd-agent-plugin` 挂载到 CTFd，提供
`/slab-match/api/v1/agent` 的题目列表、详情、环境启动/回收和答案提交接口。插件会
过滤 CTFd 浏览器 HTML，并在 CTFd 内部执行 `attempt/solve/fail`；未设置 access key
时仍使用原生 CTFd API 兼容路径。完整请求约定见仓库根目录的 `api_doc.md`。

Main Agent 若运行在宿主机，使用宿主机映射地址启动；`ctfd:8000` 只用于 compose 网络内：

```bash
CTFD_URL=http://127.0.0.1:18000 \
CTFD_AGENT_API_URL=http://127.0.0.1:18000/slab-match/api/v1/agent \
npm run secheur -- --model router/auto
```

## 多题目并行解题

Main Agent 是官方 Pi Agent TUI 中的唯一比赛 coordinator。它按需同步开放题目，
持久化比赛计划和人工确认的批量尝试预算，再显式启动独立的 solver Pi TUI；每个 solver
运行在自己的 tmux 窗口中。需要靶机的题最多同时 3 道，只有附件的题目不占用该上限。
协调器和 solver 都通过 competition broker 记录租约、证据、失败和平台提交，正确提交后
自动回收环境并保存 writeup 元数据。

### Main Agent 与 WebUI

Docker 的 `agent` 服务只启动 attach-only bridge；它不会创建 Main Agent 或隐藏任务
调度器。先启动一个与 `/data`、`/workspace` 共享状态的 Main Agent，再启动 bridge：

```bash
npm run secheur -- --model router/auto
npm run secheur:bridge
curl -fsS http://127.0.0.1:14168/competition
curl -fsS http://127.0.0.1:14168/competition/tasks
```

打开 `http://127.0.0.1:14168/` 的比赛任务区域即可查看 Main/solver 会话、
环境槽位、attempt budget、计划、证据和事件。WebUI 的 prompt、steer、abort、model
和 transcript 操作通过 Pi Unix-socket client 连接；计划、预算、dispatch、引导和停止
由 Main Agent 执行。

`flag` 次数只统计实际平台提交，不统计模型文本中的候选值。`failed` 或 `blocked`
题目需由 Main Agent 在复核证据后重新排队；同一工作目录只允许运行一个 Main Agent。

Bridge WebUI 的 `比赛任务视图`区域与 `worklist-state` WebSocket 事件展示相同持久状态。
普通 Main/solver 会话使用 `router/auto`；需要对题目启用 Ultracode 时仍可设置
`WORKLIST_ULTRACODE=1`，但 dispatch 由 Main Agent 显式发起。

恢复已有题目的 TUI 会话时，从 WebUI 比赛任务视图打开对应 session，或复用相同的
`WORKLIST_WORK_ROOT` 和 Pi session directory；不要让两个进程同时写同一个 JSONL。

### WebUI 会话

WebUI 只发现并连接 Main Agent 和 solver 的已注册 Pi 会话，不会通过
`/session/new` 创建第二个 agent loop。没有 Main Agent 时，页面会显示等待连接；
需要新会话时应在 Main TUI 中使用 Pi 的 session 命令。

返回的 `sessionId` 可用于向该独立会话发送任务:

```bash
curl -fsS -X POST "http://127.0.0.1:14168/session/<sessionId>/prompt" \
  -H 'content-type: application/json' \
  -d '{"prompt":"/ultracode once 完成当前题目并验证候选 flag"}'
```

### 提交边界

Ultracode 的本地验证和 Flag Oracle gate 不是 DASCTF 计分接口。比赛提交必须在
确认题目 ID、flag 格式和证据后显式执行:

```bash
/workspace/skills/slab-match/slab-match.sh submit 123 'DASCTF{...}'
```

只有平台返回 `isCorrect=true` 才算解出;成功提交会自动 recover 该题环境并保存
`/workspace/writeups/<id>-<name>.meta.json`。错误提交不会 recover,不要把候选猜测
批量提交。若当前比赛接口关闭,不要用本地正则命中或模型文本作为解出证明。

## 日常运维

```bash
sudo docker compose ps                                    # 状态
sudo docker compose logs -f agent                         # 日志
sudo docker compose restart agent                         # 重启(改配置文件后)
curl -fsS http://127.0.0.1:14168/status                   # 健康
sudo docker compose exec agent /opt/secheur/node_modules/.bin/secheur doctor     # Python 兼容层
sudo docker compose exec agent /opt/secheur/node_modules/.bin/secheur self-test  # 离线自检
```

修改 `pi/` 下配置文件(models/auth/settings)后需 `restart agent` 生效;UI 内保存
profile 则即时生效。不要执行 `docker compose down -v`(会删卷;当前为 bind mount,
但仍避免误伤)。

## 已知限制与排查

- **桥会话偶发 502(stgw)**:网关边缘偶发,agent 自动重试;重试仍失败时重新发送即可
- **GLM 思考内容**:网关 responses 返回 `reasoning_text` 类型块,pi 可能不识别该
  变体(文本输出不受影响);如需思考展示再适配
- **BuildKit 拉基础镜像超时**:`docker pull <image>` 预拉后再 build
- **ctf-toolbox 完整镜像**:构建 30 分钟以上、体积大;临时精简重建可在 `.env` 设
  `INSTALL_SAGE=0 INSTALL_GHIDRA=0`
- 修改了 `legacy/ctf-mcp/Dockerfile`(移除 Ubuntu 不存在的 `hexdump`/`forensics-extra`
  apt 包,venv 内补装 `uv` 供 pwndbg 使用)
