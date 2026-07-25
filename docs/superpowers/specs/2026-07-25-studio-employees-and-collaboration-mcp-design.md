# 工作室员工会话与统一协作 MCP 设计

## 背景

当前 Team Chat 把房间成员直接绑定到一个 Configured Agent，并把同一轮对话当作由多个 Agent 共同完成的广播任务。用户没有明确 `@` 时会同时调用所有成员，Agent 回复中的 `@名称` 还会被解析成下一跳。这使房间存在隐含的主轮次和自动接力，无法自然表达“在同一个工作室里创建多个独立员工，分别持续对话”的产品模型。

目标模型是：

```text
工作室
├─ 员工 Codex  → Runtime 配置 A → 原生 Session 1
├─ 员工 Codex2 → Runtime 配置 A → 原生 Session 2
└─ 员工 Claude → Runtime 配置 B → 原生 Session 3
```

员工不是职业、角色或新的 Agent 配置。员工是工作室内的持久实例：它引用一个已有 Runtime 配置，拥有独立显示名、执行队列和原生 Runtime Session。同一个 Runtime 配置可以创建多个员工。

项目已经同时存在用户配置 MCP、Workflow 内置 MCP 和对应的 Runtime 注入逻辑。工作室协作不能继续为每项能力启动独立服务或占用独立端口，需要复用应用托管的统一 MCP 桥接入口。

## 目标

- 工作室可以基于同一个 Configured Agent 创建多个员工实例。
- 每个员工首次收到消息时创建自己的原生 Runtime Session，后续优先恢复该 Session。
- 用户消息在发送时明确选择目标员工；没有目标时只投递给当前选中的员工，不再默认广播全房间。
- Prompt 只携带当前投递、明确引用和必要的增量上下文，不重复灌入整个房间记录。
- 所有员工共享工作室绑定的真实项目目录，不创建 worktree 或目录副本。
- 员工可以通过结构化工具向另一名员工发送可见、异步、可追踪的消息。
- AgentRecall 只启动一个应用级 MCP 桥接端口；Workflow、工作室协作和后续内置能力通过同一入口按能力域路由。
- 用户配置的第三方 MCP 继续独立注册和绑定，不被工作室能力写入或替换。

## 不包含的范围

- 不增加固定职业、角色模版、主 Agent、主管或层级关系。
- 不从普通模型输出中解析 `@名称` 来启动其他员工。
- 不创建 Git worktree，不自动提交、不自动合并代码。
- 不实现多人账号、远程协同或跨设备实时消息。
- 首版不实现完整任务看板、不可变代码快照或强制文件锁。
- 不把全部房间记录、工具调用过程或模型思考写入每次 Prompt。

## 核心对象

### 工作室

沿用现有 Chat room 作为工作室，保存名称、共享 `workDir`、归档状态和时间信息。

### 员工

将当前房间成员从“Configured Agent 本身”改成独立实例：

- `member_id`：工作室内稳定 UUID，也是消息投递和 Session 归属标识。
- `configured_agent_id`：引用已有 Configured Agent。
- `display_name`：工作室内唯一、可编辑的名称，例如 `Codex`、`Codex2`。
- `runtime_id`、`channel_id`、`model_id`：创建或刷新时保存的执行配置快照。
- `enabled`、`position`、`joined_at`：沿用成员状态。

现有数据迁移时，为每条旧成员记录保留原有 `agent_id` 作为 `member_id`，并把它同时写入 `configured_agent_id`，避免旧工作室和 Session 失效。新建员工一律使用 UUID。

### 员工 Session

原生 Runtime 会话按 `(room_id, member_id)` 隔离。同一 Configured Agent 创建的两个员工不得共享 Session。

Session 记录继续保存 Runtime、Channel、Model 快照和 `RuntimeConversation`。员工切换到不兼容的执行配置时清除旧 Session 引用；历史消息保留。

## 消息投递

### 用户投递

消息发送请求携带结构化 `targetMemberIds`：

1. 用户在输入区选择一名当前员工时，消息只投递给该员工。
2. 用户显式选择多名员工时，为每名员工建立独立投递并并行运行。
3. 回复某位员工的消息且没有重新选择目标时，默认投递回该员工。
4. 文本中的 `@名称` 只用于输入体验，Renderer 在发送前解析成结构化目标；主进程只相信校验后的成员 ID。
5. 未提供目标且无法从回复关系推导时，拒绝发送并提示选择员工，不再广播全房间。

每名员工拥有独立串行队列。不同员工的队列可以并行运行，任一员工运行都不锁住工作室输入框。

### 员工投递

员工普通最终回复只写入时间线，不触发其他员工。需要协作时必须调用工作室 MCP 的 `studio_send_message`：

- 发送者身份由本次执行的作用域令牌确定，工具参数不能伪造。
- 收件人使用 `memberId`，显示名只用于查找和展示。
- 消息写入同一工作室时间线，用户始终可见。
- 消息进入收件人员工的串行队列并立即触发执行。
- 发送者异步结束，不等待收件人完成。
- 收件人若要继续协作，必须显式再次调用 `studio_send_message`。

每条员工消息保存 `root_message_id`、`source_message_id` 和 `hop`。同一因果链最多启动 8 次员工执行；达到上限后写入可见系统消息并停止继续投递。

首版同时提供不会启动收件人的 `studio_post`，用于发布状态、文件位置或阶段性结果。它仍显示在时间线中。

## Prompt 合同

工作室规则通过 `developerInstructions` 传给 Runtime，用户消息原文保持为 Prompt 主体。规则包括：

- 当前员工名称和 `memberId`。
- 工作室名称和成员目录。
- 共享工作目录。
- 普通回复不会自动通知其他员工；协作必须调用 `studio_send_message`。
- 不虚构其他员工的进度或输出。

首次调用员工时使用 `fresh`，Prompt 包含：

- 当前投递消息。
- 明确回复的父消息。
- 当前因果链中与该员工直接相关的少量消息。
- 可查询的未读范围，不展开无关房间记录。

后续调用使用 `resume-preferred`，只发送上次成功执行后的新定向消息、明确引用和未读范围。原生 Session 已拥有该员工自己的历史，不再重复发送全部房间记录。

内部消息信封采用稳定结构：

```text
[AgentRecall Studio Delivery]
Studio: <name>
To: <display name> (<member id>)
From: <user or member>
Message: <message id>
Reply to: <optional message id>
Root: <root message id>

<原始消息正文>

Other unread studio messages: <count and sequence range>
Use studio_read_messages or studio_read_range only when needed.
```

若 Runtime 明确报告 Session 不存在且失败前没有产生文本增量，清除 Session 并 fresh 重试一次。重试只重建该员工的定向历史和明确引用，不拼接完整房间。

## 共享工作区

工作室只保存一个真实 `workDir`。每次员工 Runtime 调用都传递同一个目录，因此某个员工的文件改动会立即被其他员工看到。

首版共享方式：

- 项目文件：员工直接读写 `workDir`。
- 中间产物：员工在消息中发布相对路径，或使用工作室 MCP 发布文本资料。
- 消息不复制大段文件内容；Prompt 引用消息 ID、资料 ID或相对路径。

工作室 MCP 提供轻量路径占用能力：

- `workspace_reserve(paths, reason)`：声明准备修改的相对路径，带超时。
- `workspace_release(paths)`：释放自己的占用。
- `workspace_status(paths?)`：查看当前占用。

占用是协作提示，不是操作系统级锁。Runtime 仍可能绕过工具直接修改文件；AgentRecall 检测到重叠声明时显示警告，但不隐瞒也不伪装成绝对隔离。

## 统一 MCP 管理

### 一个桥接端口

Electron main 继续只启动一个监听 `127.0.0.1` 随机端口的 AgentRecall MCP bridge，并通过权限受限的 discovery 文件发布地址。它承载多个逻辑能力域：

```text
AgentRecall MCP bridge（一个端口）
├─ /mcp/workflow/*
├─ /mcp/agents/*
├─ /mcp/studio/*
├─ /mcp/workspace/*
└─ 后续内置能力
```

能力域只是内部路由，不各自监听端口。Runtime 只看到一个名为 `agent_recall` 的 MCP server。

### 一个 Runtime 入口

Codex 和 Claude 的工作室执行都注入同一个打包后的 stdio MCP 入口。stdio 子进程不再启动网络服务，只读取 discovery 文件并代理到应用级 bridge。Workflow 和 Studio 同时可用时也不出现两个 `agent_recall` server。

用户配置的第三方 MCP 保持现有行为：它们仍由 MCP 注册表保存，按 Configured Agent 绑定，并与内置 `agent_recall` server 合并注入。

### 能力裁剪与作用域

内置 MCP 根据执行上下文只暴露必要工具：

- Workflow planning 执行：Workflow 工具。
- 工作室员工执行：Studio、消息读取和 Workspace 工具。
- 两种上下文同时存在：同一 server 中暴露两个工具集合。
- 普通单次执行：不注入工作室工具。

每次工作室 dispatch 创建短期作用域令牌，服务端绑定：

- `roomId`
- `memberId`
- `dispatchId`
- `rootMessageId`
- 到期时间

stdio MCP 将令牌放入 bridge 请求头。bridge 不接受工具参数覆盖这些身份字段。dispatch 完成或中止后撤销令牌，避免旧进程继续发送消息。

## 工作室 MCP 工具

首版提供：

- `studio_list_members()`：列出当前工作室员工及运行状态。
- `studio_send_message(toMemberId, content, replyTo?, artifactIds?)`：发送并启动目标员工。
- `studio_post(content, replyTo?, artifactIds?)`：发布可见但不触发员工的消息。
- `studio_read_messages(messageIds)`：读取明确消息。
- `studio_read_range(after?, before?, limit?)`：读取有界消息区间。
- `studio_search(query, limit?)`：搜索当前工作室消息。
- `workspace_reserve(paths, reason?)`
- `workspace_release(paths)`
- `workspace_status(paths?)`

所有读取限制在令牌绑定的工作室；路径必须是工作室 `workDir` 下的相对路径，不允许通过 `..` 或绝对路径声明目录外资源。

## 调度与并发

删除房间级 `active turn` 作为输入锁。调度单位改为员工投递：

- 同一 `memberId` 的 dispatch 串行。
- 不同 `memberId` 的 dispatch 并行。
- 用户可以在员工运行时继续发送消息；新消息进入对应队列。
- 停止操作可以针对某个员工 dispatch，也可以停止同一 root 因果链的全部 dispatch。
- 应用退出后，运行中 dispatch 标为 interrupted，排队但尚未开始的投递保留为可重新触发状态。

员工使用 MCP 发送消息时，TeamChatService 写入消息和 dispatch，然后把目标员工加入队列；不在 HTTP bridge 请求内等待 Runtime 完成。

## UI

- 房间成员区改称员工区。
- “添加员工”先选择已有 Configured Agent，再填写工作室内显示名；名称默认从配置名称生成并自动处理重复，例如 `Codex2`。
- 同一 Configured Agent 可以重复添加。
- 输入框上方显示当前收件员工，可切换或多选。
- 每名员工独立显示 `空闲 / 排队 / 运行中 / 失败` 和 Session 状态。
- 员工运行时不禁用全局输入框。
- 员工之间的定向消息在时间线显示 `@发送者 → @收件人`。
- 保留“新会话”，只清除所选员工的 Session，不影响其他员工和历史消息。

## 数据迁移

新增迁移：

1. `chat_room_agents` 增加 `configured_agent_id`。
2. 旧记录把 `configured_agent_id` 回填为原 `agent_id`。
3. 后续代码把现有 `agent_id` 解释为 `member_id`；列名可暂时保留，降低迁移风险。
4. `chat_messages` 增加可选 `recipient_member_id` 和单调递增的房间序号。
5. `chat_dispatches.target_agent_id` 改为目标 `member_id` 语义。
6. 增加工作室路径占用表，保存 member、相对路径、原因和到期时间。

不会删除旧表或历史记录。旧房间首次打开时仍能显示并继续使用。

## 错误与安全

- 目标员工已删除或禁用：消息保留，dispatch 标记 skipped，并显示可操作提示。
- Configured Agent 已删除：员工保留快照但不可运行，用户可以重新绑定或删除员工。
- 作用域令牌无效、过期或与路由不匹配：bridge 返回未授权，不执行任何写入。
- 员工给自己发送触发消息：允许，但仍计入因果链上限。
- 达到 8 次执行：写入系统消息并停止新增触发 dispatch；已发布的普通消息保留。
- MCP bridge 退出：Runtime 工具调用得到清楚错误；用户消息和已完成文件改动不回滚。
- 所有 Runtime/MCP 安装与测试使用临时 HOME、临时 npm prefix 和合成数据，不读取开发者真实配置。

## 测试

- 数据迁移：旧成员正确回填 Configured Agent 引用，旧 Session 归属不变。
- 员工实例：同一 Configured Agent 可创建两个员工并生成不同 member ID。
- Session：两个员工分别 fresh，之后各自 resume，绝不交叉复用。
- Prompt：原文只出现一次；首次包含明确引用；续接只携带新定向消息。
- 路由：无目标不广播；多目标并行；同一员工严格串行；不同员工可并行。
- MCP：一个 discovery 端口承载 Workflow 与 Studio；工作室上下文只列出工作室工具。
- 鉴权：令牌不能跨房间、跨员工使用，结束后失效，参数不能伪造发送者。
- 通信：`studio_send_message` 写入可见消息并排队目标员工；`studio_post` 不启动员工。
- 循环限制：第 9 次因果链投递不启动 Runtime，并产生可见系统消息。
- Workspace：相对路径可声明，绝对路径和目录穿越被拒绝，重叠占用显示冲突。
- UI：添加重复 Runtime 员工、切换收件人、并行状态和单员工新会话均可操作。
- 在 macOS 与 Windows 路径分支下运行类型检查、Vitest、构建和发布说明检查。
