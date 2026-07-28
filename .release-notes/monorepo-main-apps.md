# agent-recall-v2 独立运行与 Chat 修复

<!-- release-target: both -->

## Bug 修复

- `agent-recall-v2` 现在使用独立的应用数据、数据库、更新缓存和 MCP 配置，与 AgentRecall 1.0 同时运行时不会互相覆盖。
- 已创建的 Chat 房间现在可以继续添加员工，并会保留原有员工的会话身份。
- Chat 消息中的 Markdown 表格现在可以正确显示，添加员工和取消按钮也更加清晰紧凑。
- GitHub Release 现在会分别展示 AgentRecall 1.0 与 `agent-recall-v2` 的更新，并同时提供两套互不覆盖的安装包。
