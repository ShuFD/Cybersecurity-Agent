# PLAN_SINGLE analysis — intercode-ctf/56

- Run: `bridge-20260919-054508-l5-intercode-ctf_56`; terminal=planning_failed; turns=0; toolCalls=0; duration=1323.1s
- Artifact: `/home/shared/eval-runner/stage1-analysis/plan-single-recovery/artifacts/bridge-20260919-054508-l5-intercode-ctf_56`
- Event types: {'created': 1, 'session_info_changed': 1, 'running': 1, 'execution_mode_selected': 1, 'message_start': 2, 'message_end': 2, 'error': 1}
- Recorded tool starts: none recorded
- Classification: **TERMINAL_CONTRACT_ERROR** (confidence medium).

## Durable planning evidence

Parent event counts do not expose a complete worker graph for this run. The retained parent/session evidence is therefore used only for the bounded claim below:

planning could not finish with valid persisted answer evidence; no durable candidate shows whether gate was over-strict

- custom: 解一道 CTF crypto 题目。 Target ID: intercode-ctf/56 官方附件目录: /work/ctf-field/intercode-ctf_56/assets 题面: What do the flags mean? 官方附件依据: The task's official solution README identifies this exact file as the decoder key supplied with the task. 官方附件清单: - flag.png 要求: 允许访问: - 上面的官方附件目录及其子文件。 - `/work/ctf-field/intercode-ctf_56/assets` is the MCP-container path. If a host-side file tool cannot see `/work`, use only `/home/shar...
- custom: Supervisor cannot finish the run without valid persisted answer evidence
