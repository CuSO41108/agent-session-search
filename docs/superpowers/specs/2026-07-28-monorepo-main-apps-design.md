# AgentRecall V1 / V2 Monorepo Design

## 目标

把仓库整理成一个长期维护的 `main` 分支，并在同一仓库中保留两个同级、可独立运行的桌面应用：

- `apps/main-1.0`：当前稳定版，继续使用 SQLite。
- `apps/main-2.0`：当前融合后的 2.0 版本，继续使用内置 PostgreSQL。

根目录 README 继续以 1.0 稳定版为主，只增加一个简短的 2.0 开发入口。两个应用不共享应用数据库，也不提供 V1 SQLite 到 V2 PostgreSQL 的导入或迁移。

## 当前代码事实

截至 2026-07-28：

- V1 的来源是最新 `origin/main`，当前提交为 `646c5f1`。
- V2 的来源是 `main-2.0`，当前已提交版本为 `0c48191`，并需要叠加原工作树中尚未提交的 Chat 员工添加、按钮样式和 Markdown 表格修复。
- V1 使用 Electron 内置的 `node:sqlite`，数据库位于 `<Electron userData>/session-search.sqlite`。
- V2 使用 `embedded-postgres`，数据库运行目录位于 `<Electron userData>/postgres/`。
- 两个版本当前的包名、产品名和主进程常量都仍是 `agent-recall` / `AgentRecall`。
- 两个版本都调用 `app.requestSingleInstanceLock()`，且都包含同名 CLI、MCP、安装脚本和更新逻辑。
- V1 当前完整基线测试通过：1085 个 Vitest 测试通过、1 个跳过，95 个脚本测试通过。
- `origin/main` 和 `main-2.0` 已经分叉：V1 有 22 个独有提交，V2 有 204 个独有提交。不能用简单覆盖目录的方式丢弃任一侧历史。

## 方案比较

### 方案 A：两个独立包，由根目录统一编排（采用）

每个应用保留自己的 `package.json`、`package-lock.json`、源码、测试和构建配置。根目录只提供统一命令、CI、发布说明和文档入口，不启用依赖提升，也不抽取共享业务代码。

优点：

- V1 和 V2 的依赖升级、构建产物和安装生命周期互不影响。
- V1 的稳定发布包可以继续保持 `agent-recall` 的名称和兼容性。
- V2 可以先作为独立预览应用演进，不会被 V1 的发布节奏约束。

代价：

- 两个应用会保留部分重复依赖和配置。
- 同时验证两个应用时，安装时间和磁盘占用更高。

### 方案 B：npm workspaces 和单一 lockfile

根目录使用 npm workspaces，并让两个应用共享一个依赖树。

不采用的原因：两个应用都带有 `postinstall`、CLI 和 MCP 安装逻辑，workspace 安装时容易重复执行或覆盖同名集成；依赖提升还会弱化 V1/V2 的可独立验证性。

### 方案 C：Git submodule 或 subtree

把 V1、V2 当成两个外部仓库挂入。

不采用的原因：用户要求在一个仓库和一个 `main` 分支中维护两个应用。额外仓库会把普通修改、评审和发布拆散，增加维护成本。

## 目录结构

```text
/
├── apps/
│   ├── main-1.0/
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   ├── src/
│   │   ├── bin/
│   │   ├── scripts/
│   │   ├── assets/
│   │   ├── README.md
│   │   └── Install.md
│   └── main-2.0/
│       ├── package.json
│       ├── package-lock.json
│       ├── src/
│       ├── bin/
│       ├── scripts/
│       ├── assets/
│       ├── README.md
│       └── Install.md
├── scripts/                 # 仓库级发布说明、版本计算与文档脚本
├── .github/                 # 同一个 main 分支的检查和 V1 发布流程
├── .release-notes/          # 每个开发分支唯一的用户更新说明
├── docs/                    # 稳定版公共文档和架构文档
├── assets/                  # 根 README 使用的文档资源
├── package.json             # 无运行时依赖，仅提供仓库级命令
├── package-lock.json        # 仅锁定根目录工具；不包含两个应用依赖
├── README.md                # V1 稳定版介绍
├── Install.md               # V1 稳定版安装说明
└── LICENSE
```

应用目录不复制仓库级 `.github`、`.release-notes` 或 `AGENTS.md`。应用自身的测试和构建脚本留在各自目录；仅依赖仓库根路径的版本发布脚本移到根目录。

## 应用边界

### V1 稳定版

- npm 包名继续使用 `agent-recall`。
- 产品名继续使用 `AgentRecall`。
- CLI 和 MCP 名称保持不变，避免破坏现有安装和配置。
- userData 路径和 `session-search.sqlite` 路径保持不变。
- GitHub Release、`vX.Y.Z` 标签、自动更新和每日发布继续只面向 V1。
- 根 README、根 Install 文档和默认的 `npm run dev` 都指向 V1。

### V2 预览版

- npm 包名改为 `agent-recall-v2`，并保持 `private: true`。
- 产品名改为 `agent-recall-v2`，使 Electron userData 和单实例锁与 V1 分离。
- 内置 PostgreSQL 继续位于 V2 自己的 `<Electron userData>/postgres/` 下。
- V2 的数据库连接指针、CLI、MCP Server 名称和显式安装命令使用 `agent-recall-v2` 命名空间，防止覆盖 V1 集成。
- V2 不读取、复制或迁移 V1 的 SQLite 数据，也不自动复制旧 `AgentRecall` userData。
- V2 自动更新暂时关闭。等以后有独立版本号、发布产物和更新通道时再单独设计。
- V2 仍可读取用户主动授权的外部 Agent 会话、Skills 和项目目录；这些是输入来源，不属于两个应用共享内部数据库。

## 根目录命令

根 `package.json` 作为命令入口，不持有 Electron、React 或数据库依赖：

```text
npm run setup:v1       安装 apps/main-1.0 依赖
npm run setup:v2       安装 apps/main-2.0 依赖
npm run setup          依次安装两个应用
npm run dev            启动 V1
npm run dev:v1         启动 V1
npm run dev:v2         启动 V2
npm run test:v1        验证 V1
npm run test:v2        验证 V2
npm test               依次验证根工具、V1 和 V2
npm run typecheck      依次检查 V1 和 V2
npm run build          依次构建 V1 和 V2
npm run package:smoke  仅验证当前稳定发布的 V1 安装包
npm run package:smoke:v2
                       使用独立临时 HOME 和 npm prefix 验证 V2 包
npm run release-note:check
                       检查根目录的单份用户更新说明
```

根脚本通过 `npm --prefix apps/main-1.0 ...` 和 `npm --prefix apps/main-2.0 ...` 调用子应用。两个应用分别执行 `npm ci`，不进行 workspace 依赖提升。

## Git 历史合并

迁移分支从最新 `origin/main` 创建，以保证 V1 的 22 个新提交不会丢失。随后把 `main-2.0` 的提交历史记录为已合入，但不让它直接覆盖 V1 根目录；再把两个提交树分别物化到对应应用目录。

最终结果必须同时满足：

- `origin/main` 是迁移分支祖先，MR 可以正常以 `main` 为目标。
- `main-2.0` 的提交历史也可以从最终分支追溯。
- V1 文件内容来自最新 `origin/main`。
- V2 文件内容来自 `main-2.0`，并叠加原工作树中的未提交 Chat 修复。

原 `main-2.0` 工作树保持不清理、不重置。未提交改动只复制到新 monorepo 的 `apps/main-2.0`，避免丢失用户现有工作。

## 文档策略

- 根 `README.md` 保持 V1 的稳定版内容和安装入口。
- 根 README 只增加一小段“2.0 开发版”，链接到 `apps/main-2.0/README.md`。
- 根 `Install.md` 继续描述 V1。
- `apps/main-1.0/README.md` 和 `Install.md` 与稳定版保持一致，保证 npm 包和独立目录内文档完整。
- `apps/main-2.0/README.md` 和 `Install.md` 只描述 V2 的功能、依赖、启动方法和独立数据目录。
- 不添加 V1 SQLite 到 V2 PostgreSQL 的迁移文档、按钮、命令或兼容层。

## CI 与发布

### 合并请求检查

质量检查继续覆盖 macOS、Windows 和 Linux：

- 根目录发布说明检查。
- V1 与 V2 各自安装依赖。
- V1 与 V2 各自执行测试、类型检查和构建。
- 安装、更新、卸载、MCP、Skills 和会话发现相关测试继续使用临时 HOME、临时 npm prefix 和合成数据。
- Windows 路径测试使用 Windows runner，平台差异保留显式分支。
- 分别执行 V1、V2 的 package smoke，构建后把各自 tarball 安装到临时 prefix。

### 稳定发布

现有每日 10:00（北京时间）发布流程只发布 V1：

- 版本计算读取 `apps/main-1.0/package.json`。
- 测试、类型检查、构建和打包命令在 `apps/main-1.0` 中执行。
- npm 包名、CLI、Git 标签、GitHub Release 标题和更新清单格式保持兼容。
- V2 的变更可以随 `main` 合入，但不会被打进 V1 发布包。

V2 发布工作流、标签前缀和更新源不在本次范围内。

## 错误处理与回退

- 任一应用安装、测试或构建失败时，根聚合命令立即失败并显示是 V1 还是 V2。
- 目录迁移后先验证 V1；V1 不通过时不继续修改发布流程。
- V2 启动时如果独立 PostgreSQL 目录无法创建，沿用现有可读错误并退出，不回退到 V1 数据。
- V2 不存在隐式数据迁移；旧目录存在时也不会自动复制。
- 原 `main-2.0` 工作树和分支在迁移完成、验证并得到用户确认前保留，可用于逐文件对照。

## 测试与验收标准

迁移完成必须满足：

1. 根目录能分别安装、启动、测试、类型检查和构建两个应用。
2. V1 完整测试与 package smoke 通过，现有 `agent-recall` CLI 和更新行为不变。
3. V2 完整测试与 package smoke 通过，当前未提交的 Chat 修复仍在。
4. 同时启动 V1 和 V2 时，两个进程不会因单实例锁互相退出。
5. V1 写入 SQLite；V2 只写入自己的 PostgreSQL 目录。
6. V2 不读取或复制 V1 数据，也不存在导入入口。
7. V1 与 V2 的 CLI/MCP 安装目标和配置名不会互相覆盖。
8. 根 README 仍首先展示 V1，只通过简短链接引导到 V2 文档。
9. 分支只新增一份符合规范的用户更新说明。
10. `npm run release-note:check`、`git diff --check` 和跨平台 CI 全部通过后才进入 MR。

## 明确不做

- 不把 V1 SQLite 数据导入 V2。
- 不共享数据库、业务状态、Runtime Session 或应用 userData。
- 不抽取共享 React 组件、数据库接口或业务服务。
- 不统一 V1/V2 的依赖版本。
- 不发布 V2，也不为 V2 创建正式更新通道。
- 不删除 `main-2.0` 分支或原工作树。
