# Conversation UI

这是一个标准 Pi 插件，同时为 SecHeur Agent Desktop 声明可选的 CSS 和 JavaScript 资源。启用后，主对话会采用 DeepSeek Harness 风格的连续文档流：所有模型回复按正文展示，`Think`、命令和其他工具调用显示为紧凑的可折叠行。

工具行与右上角会话轨迹共用 `toolCallId`：调用参数、运行状态、结果和错误会合并到同一行；轨迹中存在而消息列表暂时缺失的调用也会自动补到对话。该插件不修改轨迹查看器本身。

## 安装

在“设置 -> 插件”中填入本目录的绝对路径，作用域选择“项目”或“Agent”，然后点击“安装”。插件开关会同时控制 Pi Extension 和 Desktop UI。

## Desktop UI 声明

插件通过 `package.json` 中的 `secheur.desktop.styles` 和 `secheur.desktop.scripts` 声明页面资源。所有路径必须是插件目录内的相对路径；SecHeur Agent 会校验扩展名、真实路径和启用状态后再提供资源。
