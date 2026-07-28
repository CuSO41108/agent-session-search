# agent-recall-v2 本地运行

`agent-recall-v2` 是 AgentRecall 仓库中的独立 V2 开发版，目前不使用 AgentRecall 1.0 的 Release 安装包或自动更新通道。

## 环境要求

- Node.js 22.13 或更高版本
- npm
- macOS 或 Windows

## 从仓库根目录启动

```bash
npm run setup:v2
npm run dev:v2
```

也可以进入 `apps/main-2.0` 后单独运行：

```bash
npm ci
npm run dev
```

## 常用验证命令

在仓库根目录运行：

```bash
npm run test:v2
npm run typecheck
npm run build
npm run package:smoke:v2
```

`package:smoke:v2` 会先构建，再把生成的包安装到临时 HOME 和临时 npm prefix 中验证，不会覆盖本机正在使用的 AgentRecall 1.0。

## 与 AgentRecall 1.0 的边界

- V1 包名和命令为 `agent-recall`；V2 为 `agent-recall-v2`。
- V2 的 Electron 应用数据目录使用 `agent-recall-v2`，内部 PostgreSQL 数据保存在该目录下。
- V2 的外部数据库连接指针保存在 `~/.agent-recall-v2/database-url`。
- V2 使用独立的更新缓存、进程记录、MCP 标识和 macOS App 启动器。
- V2 不读取 V1 的 `session-search.sqlite`，也不执行自动导入。

如需运行当前稳定版，请回到仓库根目录阅读 [README.md](../../README.md) 和 [Install.md](../../Install.md)。
