# OMEN 环境恢复补丁（2026-10-08）

本目录保存本机恢复正式评测环境时已验收的配置和脚本，不是新的 Agent/Planning 实现。Agent 业务代码仍为 `011f32a1a6ae06ef9f6600d26db49ed69975c597`。

## 已部署的修改

- `eval-runner/bridge_eval_controller.py`：消息压缩后采用新的 messageCursor，避免反复携带旧游标；保持 gap 标记、事件游标单调和缺失检测。
- `prepare-controller-workspace.py` + `run-controller.sh`：Controller 的工作目录共享给 pi-eval；state/artifact 目录保持私有。服务器 `seu` 和 `pi-eval` 已加入既有 shared 组，不给题目提权。
- `prepare-agent-python.sh` + `agent-python.conf`：独立 Python 3.11 和 legacy core 依赖；不替换系统 Python。正式 systemd drop-in 已使用 `/opt/secheur-agent-python/bin/python`。代理和 uv 安装路径为此主机的实际配置，迁移其他机器时须核对。
- `field-record-contract.patch`：Field HTTP record 路径保存 session_id、terminal_reason、verification_state。针对恢复前后端 SHA256 `1cbbdb1bbd8183e9bd87c659e2b8d0cc02bd2ece61a727b931166f05e96b2264`，不得不检查基线就覆盖完整 Field 后端。已部署时不要重复应用。
- `stage-official-catalogs.py`：保留官方零字节 `.placeholder`，不把无附件 InterCode 题误判成附件丢失。没有复制 solution。完整脚本涉及私有 catalog/gold 导入，只有恢复 catalog 时才由已有 root 流程执行；不要为部署这个小修复重新导入 catalog 或重置成绩。

## 验证

Ubuntu 独立目录保留仓库布局后运行：

```bash
python3.11 ctf-eval-platform/eval-runner/test_bridge_eval_controller.py
python3.11 ctf-eval-platform/ops/omen-recovery/test-intercode-placeholder.py
FIELD_RECORD_TEST_MODULE=/home/shared/eval-runner/ctf-field-backend.py \
PYTHONPATH=/usr/lib/python3/dist-packages \
python3.11 ctf-eval-platform/ops/omen-recovery/test-field-record-contract.py
```

最后一项使用真实 Field Handler 代码，但 HTTP/SQLite/record 存储是隔离 fixture，不触碰正式成绩。该测试需要 Field 自身依赖；不要因测试缺依赖而把它安装进 Agent runtime。

已验收 Controller 66 项、占位文件 3 项、Field 回执 5 项；实际 pi-eval bash/code_run/list_files 烟测通过。InterCode/17 通过真实 Field 启动和关闭，没有模型或 Verifier 调用。现场证据详见 `VERIFICATION-20261008.md`（这是推送前的历史验收记录）。

## 部署/回滚

Controller 和 workspace/launcher 脚本由现有 `/home/shared/eval-runner` 使用；不要编辑 Agent immutable release。切换前确认无活动 Controller/session。Field 的补丁已部署，Python drop-in 已生效，本次推送无需重启 Agent。

服务器备份在 `/var/lib/secheur-benchmark-recovery/environment-repair-20261008`；包含原 Controller 和 catalog staging script。Python/Field 之前备份位置见主机恢复记录。回滚之前先核对目标 SHA 和是否有运行任务。

不会上传配置凭据、gold、Oracle 数据、原始 session/Trace 或历史批次成绩。HTTP 529 过载及不存在子 Agent 名称不通过这个环境补丁伪装成已解决。
