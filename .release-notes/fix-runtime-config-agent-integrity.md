# 修复 Runtime 配置与 Agent 删除校验

## Bug 修复

- 修复离开 Runtime 页面保存执行配置时可能未保留自动生成 Agent 的问题。
- 删除执行配置或 Agent 时会检查 Chat、任务、团队和 Workflow 的使用关系，避免仍在使用的配置被误删。
