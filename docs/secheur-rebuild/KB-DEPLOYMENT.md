# 知识库工程部署清单（2026-10-19）

本文件记录知识库相关的全部改动、部署位置和恢复方式，供后续部署者核对，避免覆盖。

## 当前运行版本

| 项 | 值 |
| --- | --- |
| 服务 | `secheur-agent-rebuild.service` |
| systemd 覆盖 | `/etc/systemd/system/secheur-agent-rebuild.service.d/zzzzzzzzzz-kb-pro-20261019.conf` |
| 入口 | `/home/shared/agent-rebuild/web-kb-pro-20261019-1910/bridge-kb-web.mjs` |
| 构建产物 | `/home/shared/agent-rebuild/app-releases/agent-kb-pro-20261019-1910/` |
| 构建源 | `/home/seu/digital-employee-agent/` |
| 语料 | 10 个分类 / 7625 条，指纹 `99cbcbab268529bd` |
| 端口 | 14171（网页版）、15172（另一套部署，未受影响） |

## 改动的文件

### 运行时源码（构建源内）

- `packages/secheur-agent/src/knowledge-retrieval.ts`
  采用 `SecHeur-Agent-pro-95148ae` 的门禁体系（`GATE_SCORE_FLOOR=0.4`、
  `VERIFIED_ACCEPT_THRESHOLD=0.55`、`needs_verification` 降级注入、
  `assessApplicability` 适用性评估、`gate_scores` 逐卡评分明细），
  在其上追加消融测试所需字段：`knowledge_base_enabled`、
  `knowledge_base_snapshot`、`retrieval_latency_ms`、`injected_card_ids`、
  `injected_characters`、`injected_into_context`，以及 `manual_tool` 触发类型与
  `recordManualRetrieval()`。
- `legacy/ctf_attack_memory/index.py`
  `SecHeur-Agent-pro-95148ae` 原版 + `knowledge_base_snapshot()`（语料快照指纹）。
- `legacy/secheur_core.py`
  `do_attack_memory_search` 的返回体增加 `knowledge_base` 快照字段。
- `packages/secheur-agent/src/planning/pi-adapters.ts`
  仅新增 `knowledgeTaskInputToSuggestedTask()`（pro 版知识库代码依赖该导出）。
- `packages/secheur-agent/src/config.ts`、`desktop-config.ts`
  **必须保留**：统一 `resolveSecHeurStateDir()`，修复网页版设置读写与运行时配置分属
  两个目录导致知识库开关永不生效的问题；`desktop-config.ts` 另增
  `updateDesktopConfig()` 合并写入，避免保存设置抹掉部署侧的
  `executionMode` / `planning`。
- `legacy/agentmain.py`、`legacy/judge_agent.py`
  跟随 stateDir 统一，认 `SECHEUR_CONFIG_DIR`。

### 发布规则（必须保留）

- `packages/secheur-agent/scripts/attack-memory-publish.mjs`（新增）
  知识库语料的发布规则唯一定义：发布各分类的 `manifest.json` /
  `records.jsonl` / `embeddings.jsonl` 与 `knowledge/cards.jsonl`，排除 `evidence/`。
- `packages/secheur-agent/scripts/stage-legacy.mjs`、`verify-dist.mjs`
  改为共用上述规则，并校验每个 `*_v*` 分类的 manifest 与 records 均已落盘。
  二者若各自维护白名单，会出现「拷少了但校验通过」的静默语料缺失。

### 知识库工程脚本（此前服务器缺失，已从 pro 包补齐）

- `legacy/scripts/repair_attack_memory_index.py`
- `legacy/scripts/evaluate_attack_memory_ranking.py`
- `legacy/scripts/import_attack_memory.py`

### 测试与文档

- `packages/secheur-agent/test/knowledge-coordinator.test.ts`（pro 版 + 消融字段用例）
- `packages/secheur-agent/test/knowledge-base-routing.test.ts`（对齐 kb-95148 版本）
- `legacy/tests/test_knowledge_base_snapshot.py`（新增）
- `docs/secheur-rebuild/knowledge-retrieval.md`

## 补丁与备份

| 内容 | 路径 |
| --- | --- |
| 全部改动的 patch | `/home/seu/kb-patches/knowledge-base-20261019.patch` |
| 新增文件 | `/home/seu/kbwork-mine/`（源文件快照）、`/home/seu/kb-eval/` |
| 升级前备份 | `/home/seu/kb-backups/20261019-1610/` |
| 前一版本 release | `app-releases/agent-kb-statedir-20261019-1630` |
| 升级前 release | `app-releases/agent-kb-95148-20261019-102537` |
| 回退脚本 | `/home/seu/rollback-kb-statedir.sh` |

## 回退

```bash
sudo rm /etc/systemd/system/secheur-agent-rebuild.service.d/zzzzzzzzzz-kb-pro-20261019.conf
sudo systemctl daemon-reload && sudo systemctl restart secheur-agent-rebuild.service
# 回到 kb-95148 版本
```

## 给后续部署者

1. **不要用 `publishedAttackMemoryFiles` 之类的硬编码文件列表**。发布规则只在
   `attack-memory-publish.mjs` 定义一次；缺分类必须让构建失败，而不是静默少发。
2. **不要把 `desktop-config.ts` 的 `stateDir()` 改回 `join(root, ".secheur-agent")`**。
   部署环境设置了 `SECHEUR_CONFIG_DIR`，一旦分叉，网页版保存的所有设置
   （含知识库开关）都不会被运行时读取。
3. **不要用 `writeDesktopConfig` 整体覆盖**保存设置，必须用 `updateDesktopConfig`。
4. 本仓库 `src/` 是重构后的目录结构，`SecHeur-Agent-pro-95148ae` 包是重构前的扁平结构，
   两者不可按文件逐个对比，只按模块对比。
