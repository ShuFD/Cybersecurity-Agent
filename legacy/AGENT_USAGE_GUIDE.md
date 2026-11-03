# SecHeur Agent 部署与代理说明

## 部署位置

Agent 可部署在受控远程服务器：

```text
服务器：`<host>`
网络地址：`<private-ip-or-domain>`
项目目录：`<project-root>`
访问地址：`http://<host>:<port>/`
```

SSH 登录：

```bash
ssh <user>@<host>
cd <project-root>
```

检查服务是否正常：

```bash
curl http://127.0.0.1:${BRIDGE_PORT:-14168}/status
```

返回里有 `"ready": true` 就说明 Agent 后端正常。

## 当前运行的服务

```text
`${BRIDGE_PORT:-14168}`：Agent Web 页面
`${TMWD_WS_PORT:-18765}`：TMWebDriver WebSocket
`${TMWD_HTTP_PORT:-18766}`：TMWebDriver HTTP link
`${CDP_PORT:-9222}`：Chrome DevTools Protocol
```

检查端口：

```bash
ss -ltnp | grep -E ':(${BRIDGE_PORT:-14168}|${TMWD_WS_PORT:-18765}|${TMWD_HTTP_PORT:-18766}|${CDP_PORT:-9222})'
```

## 代理 / 网络问题

访问 Agent 页面不需要额外代理，只要你的电脑能通过 Tailscale 访问：

```text
http://<host>:<port>/
```

如果别人也要访问，需要满足其中之一：

```text
1. 对方也在同一个 Tailscale 网络里；
2. 或者在服务器上单独配置公网反向代理 / 域名 / HTTPS。
```

如果页面能打开，但模型请求失败，通常不是 Agent 页面代理问题，而是 API 网络问题。优先检查：

```text
API Base 是否正确
API Key 是否已保存
服务器是否能访问对应 API 服务
是否需要给服务器配置 HTTP_PROXY / HTTPS_PROXY
```

如果需要临时给服务器进程加代理，可以这样启动 bridge：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
nohup .venv/bin/python -u frontends/desktop_bridge.py > remote-bridge.log 2>&1 &
```

把 `127.0.0.1:7890` 换成真实可用的代理地址。

注意：不要把 API Key、密码、代理账号密码写进 GitHub。

## 进度监督（Progress Judge）

SecHeur Agent 内置一个轻量级监督 agent：每 N 轮自动评估当前解题进展，识别偏离方向、陷入循环、已找到 flag 等状态，并以 system-reminder 形式注入到主 agent 的下一轮上下文里。监督 agent 本身不解决问题，只做观察和建议。

默认配置（写入 `.secheur-agent/desktop-config.json`）：

```json
{
  "judge": {
    "enabled": true,
    "every_n_turns": 5,
    "model_profile": null,
    "max_history_messages": 8
  }
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `every_n_turns` | 每 N 轮触发一次评估；建议 3–10 |
| `model_profile` | 监督使用的模型 profile 名；留空 = 与主 agent 相同，可设为更便宜的 profile 节省 token |
| `max_history_messages` | 喂给监督的最近消息条数 |

进阶：在项目根目录的 `.secheur-agent/judge_prompt.md` 写入自定义 prompt，可以完全覆盖内置的监督策略。
