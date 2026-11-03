# 定时任务 SOP

目录：`../sche_tasks/` 放任务定义 JSON，`../sche_tasks/pending/` 放已派发任务，`../sche_tasks/done/` 放执行报告

## 任务JSON格式（*.json）
```json
{"schedule":"08:00", "repeat":"daily", "enabled":true, "prompt":"...", "max_delay_hours":6}
```
repeat可选：daily | weekday | weekly | monthly | once | every_Nh（每N小时）| every_Nd（每N天）
max_delay_hours（可选，默认6）：超过schedule多少小时后不再触发，防止开机太晚执行过时任务

## 触发流程
1. `frontends/desktop_bridge.py` 启动后内置 `SchedulerPoller`，按 `reflect/scheduler.py` 的 `INTERVAL` 轮询 `sche_tasks/*.json`
2. 条件全满足才触发：enabled=true + 当前时间≥schedule + 冷却时间已过（基于done/最新报告时间戳）
3. 触发时写入 `pending/任务名.json`，再拼 prompt，含报告路径 `../sche_tasks/done/YYYY-MM-DD_HHMM_任务名.md`
4. bridge 将 prompt 作为 scheduler 来源的用户消息注入空闲会话；如果当前会话运行中，本轮不调用 `scheduler.check()`，避免提前占用任务
5. 执行完毕后，Agent 应将报告写入上述路径；`scheduler.on_done()` 也会兜底写入报告并删除 pending
6. 冷却判断依赖 `done/` 报告；pending 存在时不会重复触发，pending 超过 24 小时会被视为过期并允许重试

## 日志与监控
- scheduler自动写日志到 `sche_tasks/scheduler.log`（触发/跳过/错误）
- JSON解析错误、schedule格式错误、未知repeat类型均会记录日志

## 注意
- once类型：执行一次后冷却100年（实际效果为永久跳过）
- 任务文件只管"干什么"，报告路径由 scheduler 自动生成注入 prompt
- sche_tasks目录在../，即code root下
