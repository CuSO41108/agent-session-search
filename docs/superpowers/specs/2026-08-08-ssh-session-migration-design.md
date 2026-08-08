# SSH 会话迁移设计

## 目标

让 SSH 环境中的 Claude Code 与 Codex 会话可以在同一台远程主机上相互迁移。迁移后保留远程项目路径，并在本机新终端中建立 SSH 连接、自动 Resume 远端新会话。

## 范围

- 支持远端 Claude Code → Codex、Codex → Claude Code。
- 迁移目标始终是源会话所在的 SSH 主机，不提供迁回本机或迁往其他主机的选择。
- 不扩展到 WSL、CodeBuddy、CodeWiz、Cursor、TClaude 或 TCodex。
- V1 与 V2 保持相同行为，分别适配同步 SQLite store 与异步 PostgreSQL store。

## 交互

SSH Claude Code/Codex 会话恢复“迁移到…”入口。对话框只显示另一个 Agent。迁移期间沿用现有读取、压缩、写入和启动进度；完成后打开新终端，终端执行完整 SSH 命令，在远端项目目录 Resume 新会话。

自动启动失败时保留已经生成的远端会话，并显示可复制的完整 SSH Resume 命令。不会回退成本机 Agent 命令。

## 数据流

1. 根据会话的 environment id 解析已配置的 SSH 环境并检查可用性。
2. 按需读取远端会话的完整消息，转换为现有 portable session。
3. 在本机复用现有迁移长度策略；超限时使用现有摘要压缩流程。
4. 在临时 HOME 中生成目标 Agent 会话文件，再通过现有远程 Python 写入协议原子写入远端目标目录。
5. Codex 目标同步更新远端 session index/app state；随后刷新该 SSH 环境索引。
6. 新终端运行 `ssh ... <remote resume command>`，由远端 Claude Code 或 Codex Resume 新会话。

## 边界与错误处理

- 缺少 SSH 环境、连接失败、远端项目不存在或目标 CLI 不可用时，在写入前失败并给出明确提示。
- 远端写入使用已验证的目标路径和现有 mode-0600 文件协议，不拼接未转义的会话内容到 shell 命令。
- 写入成功但索引刷新或终端启动失败时不删除新会话；返回警告和可复制 SSH 命令。
- 源会话保持只读，迁移不会覆盖或删除它。

## 测试

- V1/V2 迁移模型：SSH Claude/Codex 可迁移，其他 SSH 来源仍不可迁移。
- V1/V2 UI：SSH 会话显示唯一的相反目标，非 SSH 行为不变。
- V1/V2 主进程：使用合成 SSH runner 验证读取、远端路径、写入、索引刷新和 SSH Resume 命令，不连接真实主机。
- 覆盖连接失败、目标 CLI 缺失、写入失败、启动失败回退命令，以及包含空格和特殊字符的项目路径。
