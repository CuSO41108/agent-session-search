# 修复 Runtime 配置与 Agent 删除校验

## Bug 修复

- 修复离开 Runtime 页面保存执行配置时可能未保留自动生成 Agent 的问题。
- Workflow 不再单独绑定默认 Agent，未指定 Agent 的节点会跟随系统默认配置。
- 删除执行配置或 Agent 时会汇总检查 Chat、任务、团队聊天、团队、Workflow 和评估实验的使用关系，并明确提示所有引用位置，避免仍在使用的配置被误删。
