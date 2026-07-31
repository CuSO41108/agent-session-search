# agent-recall-v2 本地运行

`agent-recall-v2` 是 AgentRecall 仓库中的独立 V2 预览版，使用与 V1 分开的 Release 安装包和自动更新通道。本文档面向从源码运行 V2 的开发者；只想安装使用请阅读仓库根目录的 [Install.md](../../Install.md)。

## 环境要求

- Node.js 22.13 或更高版本
- npm
- macOS 或 Windows

## 从仓库根目录启动

```bash
npm run setup:v2
npm run dev:v2
```

Windows 上首次执行 `npm run setup:v2` 需要以管理员身份运行终端，以便创建内置 PostgreSQL 所需的符号链接。

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
- V1 的稳定安装链接使用 `releases/latest/download/`；V2 使用滚动的 `releases/download/v2-latest/`。全仓库只有一个 Latest 标记，且 V1 的自动更新依赖它，无法让给 V2。
- V2 的 Electron 应用数据目录使用 `agent-recall-v2`，内部 PostgreSQL 数据保存在该目录下。
- V2 的外部数据库连接指针保存在 `~/.agent-recall-v2/database-url`。
- V2 使用独立的更新缓存、进程记录、MCP 标识和 macOS App 启动器。
- V2 不读取 V1 的 `session-search.sqlite`，也不执行自动导入。

如需运行当前稳定版，请回到仓库根目录阅读 [README.md](../../README.md) 和 [Install.md](../../Install.md)。
