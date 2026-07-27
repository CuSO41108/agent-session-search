# Studio 房间上下文、Runtime 唤醒与执行追踪设计

## 背景

Studio 当前已经具备房间、员工实例、持续 Runtime Session、定向投递和协作 MCP，但消息语义仍偏向“只把相关消息派发给某个 Agent”：

- 用户消息必须选择目标员工，输入区还会默认选中第一名员工。
- `@员工` 同时承担可见性和启动目标的含义。
- Runtime 续接时调用 `listDirectedContext`，只选择发给自己、由自己发送、系统发布或公共 post 的消息。
- 同一条群体消息没有 `recipient_member_id`，在 Session 重置后可能无法重新进入某个员工的定向上下文。
- 一次 dispatch 最多会因为原生 Session 失效执行两次 Runtime 调用，但数据库只保存 dispatch，没有保存每次调用及其原生 Turn。

这使 Studio 更接近“消息派发器”，而不是一个所有成员共享事实、按需唤醒 Runtime 的房间。

本次把模型调整为：

```text
Room
├─ Room Runtime 小王 ── Native Session ── Turn 1, Turn 2...
├─ Room Runtime 小李 ── Native Session ── Turn 1, Turn 2...
└─ Room Runtime 小张 ── Native Session ── Turn 1, Turn 2...
```

多个 Room Runtime 属于一个 Room；每个 Room Runtime 实例只属于一个 Room。房间消息是共享事实，`@` 只表示提醒和唤醒，不再限制消息可见性。

## 术语与基数

### Configured Agent

Configured Agent 是可复用的执行配置模板，包含 Runtime 类型、Channel、Model 和其他执行配置。它不是房间中的 Runtime 实例。

同一个 Configured Agent 可以在不同房间或同一房间中创建多个独立实例。例如，同一份 Codex 配置可以创建“小王”和“小李”，两者不能共享原生 Session。

### Room Runtime

Room Runtime 对应当前 `TeamChatRoomAgent` 和 `chat_room_agents` 中的一条成员记录：

- 以现有 `agent_id` 作为实例 ID；它在产品语义上是 `memberId`，不是 Configured Agent ID。
- 每条记录只带一个 `room_id`，因此一个 Room Runtime 只属于一个房间。
- 一个房间可以拥有多个 Room Runtime。
- 记录中的 `runtime_id` 是 `codex`、`claude` 等 Runtime 类型，不是实例身份。

不会增加“同一个 Configured Agent 只能加入一个房间”的全局约束，因为 Configured Agent 是模板。隔离边界是 Room Runtime 实例。

### Runtime Session 与 Runtime Turn

每个 Room Runtime 在自己的房间内最多拥有一个当前可续接的 Runtime Session。现有 `(room_id, agent_id)` 主键继续作为 Session 隔离边界。

一次唤醒对应一个 dispatch。一次 dispatch 可以包含一次或多次 execution attempt：

```text
Room Message
  └─ Inbox Mention
      └─ Dispatch
          ├─ Execution Attempt 1 ── Native Session / Native Turn
          └─ Execution Attempt 2 ── Fresh retry / Native Turn
```

原生 Session 不存在时，当前代码会在尚未产生文本增量的前提下 fresh 重试一次。两次 Runtime 调用属于同一个 dispatch，但必须分别记录。

## 方案选择

### 方案 A：只修改 Prompt

把 `listDirectedContext` 改成读取房间消息，其他模型保持不变。

优点是改动小。缺点是 `@`、无目标消息、未读位置、重试和 Runtime Turn 仍混在 dispatch 中，后续无法准确解释“为什么唤醒、看到了什么、实际执行了几次”。

### 方案 B：共享房间上下文、Inbox 与执行 Attempt

保留现有房间和 dispatch 主干，补充：

- 房间公开消息与唤醒目标分离。
- 每个 Room Runtime 的房间阅读游标。
- 持久 Inbox mention。
- dispatch 下的 execution attempt。
- 房间上下文和 Inbox MCP。

这是本次采用的方案。它修正核心语义，又能复用当前 TeamChatService、RuntimeConversation 和 Studio MCP。

### 方案 C：完整复制 Raft 的消息与草稿系统

一次实现线程订阅、持有草稿、房间版本冲突、完整任务看板和人工审批。

该方案范围过大，而且当前 UI、Runtime 返回合同和数据库均没有草稿生命周期。本次只保留可扩展字段和清晰边界，不实现完整 Raft 克隆。

## 产品语义

### 消息可见性

- 房间中的公开消息对该房间下所有 Room Runtime 可读。
- Room Runtime 不能通过 Studio MCP 读取其他房间。
- `@小王` 不会把消息变成小王私有消息，只会为小王创建 Inbox mention 并启动小王。
- 只有用户发送的结构化 `@` 可以启动 Room Runtime。
- Room Runtime 可以通过 `studio_post` 发布公开消息，但不能自动启动另一个 Room Runtime。

本次不实现私聊。如果未来需要私聊，应增加独立的可见性模型，不能继续复用 `recipient_member_id` 暗示权限。

### 用户发送

- 用户可以不选择任何 Runtime 直接发送，消息只保存到房间，不启动 Runtime。
- 文本输入中的 `@名称` 由 Renderer 转成结构化 `targetMemberIds`；主进程只使用校验后的实例 ID 决定唤醒目标。
- 一条消息 `@` 多个 Runtime 时只保存一条公开消息，为每个目标分别创建 Inbox mention 和 dispatch。
- 输入区不再默认选中第一名员工，避免普通房间发言意外启动 Runtime。
- 回复某条消息不会隐式改变可见性。是否启动某个 Runtime仍由结构化目标决定。

### Runtime 被唤醒后收到什么

每次执行仍分为两个输入层：

1. `developerInstructions`：当前 Room Runtime 身份、房间成员、共享目录以及协作规则。
2. delivery prompt：房间快照、增量公开消息和本次触发消息。

示意：

```text
[AgentRecall Studio Delivery]
Studio: 登录项目
Runtime: 小王 (<member id>)
Session: resumed
Room snapshot: sequence 37
Previous snapshot: sequence 31

Room updates:
[32] 用户: 登录偶尔失败
[33] 小李: 我确认接口会返回 401

Trigger:
[35] 用户: @小王 请检查前端 token 刷新

Older room history remains queryable through Studio MCP.
```

触发消息在结构上单独标记，并从 `Room updates` 中排除，正文不得重复。`developerInstructions` 每次执行都会提供，因为它是本次调用的身份和权限合同；房间历史不会每轮全量重复发送。

Runtime 根据自然语言自行决定读取代码、修改文件、运行测试、查询房间消息或调用协作 MCP。应用不把普通 `@` 消息自动转换成带验收条件的结构化 Task。

Room Runtime 需要其他成员配合时，只能在最终回复或 `studio_post` 中说明需要谁处理，由用户决定是否再 `@` 对方。

## 房间上下文与阅读游标

### 快照边界

每次 dispatch 开始执行前读取房间当前最大 `sequence`，记为 `room_sequence_at_start`。本次显式上下文只允许包含不超过该序号的消息。

这相当于本轮 Runtime 实际看到的房间快照。执行过程中产生的新消息不能被声称为“已看到”。

### 续接 Session

`chat_agent_sessions` 增加 `room_context_sequence`：

- 首次执行：从最近一段完整房间公开历史构造上下文，受消息数和字符预算限制。
- 后续执行：读取 `(room_context_sequence, room_sequence_at_start]` 内的全部公开房间消息。
- 成功后：把 `room_context_sequence` 更新为本次 `room_sequence_at_start`。
- 失败或中止：不推进阅读游标。

不能在回复写入后把游标直接推进到回复序号。执行期间可能插入其他消息；推进到回复序号会错误跳过 Runtime 从未看到的并发消息。

现有 `last_context_message_id` 在迁移期保留，用对应消息的 `sequence` 回填游标，后续读取以序号为准。

`room_context_sequence` 表示该 Runtime 已完成到哪个房间快照，不是人类意义上的逐条已读回执。若增量超过 Prompt 预算，Prompt 必须给出被省略的序号范围和查询方法；Runtime 成功结束本轮后才推进快照游标。

### 上下文预算

显式 Prompt 继续使用有界消息数和字符数。超过预算时：

- 保留最新的完整消息。
- 明确标记较早房间更新未展开。
- Runtime 可以通过 MCP 按序号读取或搜索同一房间的全部历史。

“所有房间消息可读”表示信息系统可查询，不表示每轮把无限历史全部塞进模型上下文。

Session 被重置或原生 Session 失效 fresh 重试时，重新提供最近的完整房间公开历史，不再使用定向消息筛选。

## Inbox 与调度

新增 `chat_member_inbox`，记录某条公开消息为什么需要某个 Room Runtime 注意：

- `id`
- `room_id`
- `message_id`
- `member_id`
- `status`：`pending`、`processing`、`handled`、`failed`
- `created_at`、`updated_at`、`handled_at`

同一消息和成员只能创建一条 Inbox item。

状态流转：

```text
pending -> processing -> handled
                      -> failed
```

创建带结构化 `@` 的用户消息时，消息、Inbox item 和初始 dispatch 应保持一致。dispatch 成功后 Inbox 自动标记 handled；失败或中止时记录失败状态和对应 dispatch 结果。

同一 Room Runtime 的 dispatch 继续串行，不同 Room Runtime 可以并行。Inbox 不替代队列，它负责持久记录注意事项和处理结果。

## Execution Attempt 与原生 Turn

新增 `chat_dispatch_attempts`：

- `id`
- `dispatch_id`
- `attempt_number`
- `runtime_id`
- `runtime_session_ref`：可选的原生 Session 引用
- `native_turn_id`：Runtime 能提供时保存
- `room_sequence_at_start`
- `room_sequence_at_finish`
- `status`：`running`、`completed`、`failed`、`interrupted`
- `error`
- `started_at`、`finished_at`

`(dispatch_id, attempt_number)` 唯一。一次正常执行只有 attempt 1；原生 Session 失效且符合安全重试条件时创建 attempt 2。

Runtime 执行合同增加可选 execution reference：

- Codex workflow 已能从 `turn/start` 取得原生 `turnId`，本次把它向上返回并持久化。
- Claude 当前只有原生 `sessionId`，先保存 Session 引用，`native_turn_id` 允许为空。
- 其他 Runtime没有原生标识时，Attempt ID仍是稳定追踪 ID。

Room Message 和 Runtime Turn 不是一对一。一条消息可以 `@` 多个 Runtime，从而产生多个 dispatch 和多个原生 Turn；一次 dispatch 也可能因 fresh retry 产生两个原生 Turn。

## Studio MCP

保留现有工具：

- `studio_list_members`
- `studio_post`
- `studio_read_messages`
- `studio_read_range`
- `studio_search`
- `workspace_reserve`
- `workspace_release`
- `workspace_status`

当前已经存在的 `studio_send_message` 不再向 Room Runtime 暴露，developer instructions 也不再要求 Runtime 使用它。首版不提供任何可绕过用户确认的 Agent-to-Agent 唤醒入口。

增加以下房间信息工具：

### `studio_get_context`

返回当前 Room Runtime 的 `contextSequence`、房间 `latestSequence`、有界增量消息、被省略的序号范围以及是否截断。用于 Runtime 主动补齐本轮 Prompt 之外的更新。

### `studio_get_room_state`

返回房间名称、当前 Room Runtime 身份、成员列表、共享目录和最新序号，不返回其他房间信息或原生 Session 凭据。

### `studio_inbox_list`

按状态列出当前 Room Runtime 的 Inbox item。身份从 Studio token 获取，参数不能冒充其他成员。

### `studio_inbox_update`

首版只允许当前 Room Runtime 把自己的 Inbox item 标记为 handled。正常 dispatch 成功仍会自动处理；该工具用于 Runtime 查询旧 item 后显式确认。

### `studio_read_thread`

根据 `rootMessageId` 返回当前房间内同一回复链的有界消息，方便理解用户与多个 Runtime 围绕同一问题的讨论。

所有工具继续使用短期 Studio scope token，并固定到 `{roomId, memberId, dispatchId}`。即使调用者猜到其他房间的消息 ID，也不能跨房间读取。

本次不增加独立 MCP 服务或端口，继续复用现有 `agent_recall` bridge。

## 回复与房间新鲜度

每条 Runtime 回复记录它基于哪个 `room_sequence_at_start` 生成。Runtime 返回结果后、发布该 Runtime 自己的回复之前，读取当前房间最大序号作为 `room_sequence_at_finish`：

- 两者相同：回复基于最新房间快照。
- finish 更大：执行期间房间有新消息，回复仍正常发布，但追踪记录可以明确显示它没有看到后续消息。

本次不实现 Raft 的 held draft：不会因为房间变化自动扣住 Runtime 最终回复，也不增加草稿审核 UI。未来可以基于 Attempt 的两个序号增加该能力，而无需重新定义上下文边界。

## 数据与迁移

追加迁移，不重建或删除历史表：

1. `chat_agent_sessions` 增加 `room_context_sequence`，按 `last_context_message_id` 对应消息回填。
2. 新增 `chat_member_inbox`。
3. 新增 `chat_dispatch_attempts`。
4. `chat_dispatches` 增加可选 `inbox_item_id`，建立唤醒来源关系。
5. Agent 回复增加可选 `based_on_sequence`，保存生成回复时的房间快照边界。

旧消息没有 Inbox item，不进行猜测性回填。旧 Session 没有有效 `last_context_message_id` 时游标从 0 开始，下一次 fresh/续接按有界完整房间历史处理。

## 错误处理

- 目标 ID 不存在或已禁用：公开消息仍保存；无效目标不创建 Inbox 或 dispatch，发送结果向 UI 返回被拒绝的目标 ID。
- Runtime执行失败：Attempt 和 dispatch 标记 failed，Inbox 标记 failed；房间阅读游标不推进。
- 用户中止：Attempt 和 dispatch 标记 interrupted；游标不推进。
- 原生 Session 失效：Attempt 1 失败；仅在没有输出增量、没有中止且错误明确表示会话不可用时，清除旧 Session并创建 Attempt 2 fresh 重试。
- MCP token 过期或跨房间：拒绝请求，不产生消息或 Inbox 写入。
- 数据库写入失败：不报告虚假的 Runtime进度；已完成的外部文件副作用无法回滚，错误信息应对用户可见。

## UI

- 移除输入区默认选中第一名员工。
- 允许没有目标时发送普通房间消息。
- `@` 选择继续显示员工名称，并在请求中携带结构化 `targetMemberIds`。
- 一条消息 `@` 多人时，时间线只显示一条消息，运行状态按目标分别展示。
- 保留员工的排队、运行、失败和 Session 状态。
- 首版不增加完整 Inbox 管理页面；Inbox主要供 Runtime MCP 和执行追踪使用。

## 测试

### 消息和上下文

- 无 `@` 的用户消息只保存一次，不创建 Inbox、dispatch 或 Runtime 调用。
- `@` 一名 Runtime 创建一条消息、一个 Inbox 和一个 dispatch。
- `@` 多名 Runtime仍只创建一条消息，每个目标拥有独立 Inbox 和 dispatch。
- 小李未被唤醒时不会执行；下次被唤醒时能在房间增量中看到此前 `@小王` 的公开消息。
- Session 重置和 fresh retry 使用有界完整房间上下文，不丢失旧群体消息。
- 执行期间插入的新消息不会被错误计入 `room_context_sequence`。

### Room Runtime 隔离

- 一个房间可以创建多个 Room Runtime。
- 同一个 Configured Agent 可以创建多个 Room Runtime实例，并拥有不同 `memberId` 和 Runtime Session。
- 每个 Room Runtime记录只属于一个房间。
- 同一 Configured Agent在两个房间创建的实例不能共享阅读游标、Inbox、Studio token 或 Runtime Session。

### Dispatch、Attempt 与 Turn

- 正常 dispatch 只创建一个成功 Attempt。
- 原生 Session失效时在同一 dispatch 下创建两个 Attempt，并且仅第二次结果发布到房间。
- 已产生输出增量的失败不自动重试。
- Codex Attempt保存原生 Session 和 `turnId`；没有 Turn ID的 Runtime仍保存 Attempt ID。
- 一条消息唤醒多个 Runtime时，每个 dispatch/Attempt独立关联自己的原生 Turn。
- 回复保存 `based_on_sequence`，并能识别执行期间房间是否前进。

### MCP 与安全

- `studio_get_context` 只返回当前房间消息和正确的序号边界。
- `studio_get_room_state` 不泄露原生 Session 凭据。
- `studio_inbox_list/update` 不能读取或修改其他成员 Inbox。
- `studio_read_thread` 不能跨房间读取相同或猜测的消息 ID。
- dispatch结束或 token过期后所有 Studio MCP写入均被拒绝。

### UI 与回归

- 输入区初始无默认目标，普通发送可用。
- 选择一个或多个 `@` 目标时提交正确的成员 ID。
- 同一 Room Runtime仍串行执行，不同 Room Runtime保持并行。
- 现有 Session重置、停止执行、workspace reservation 和消息分页行为保持可用。

## 发布范围

本次作为一个用户可见的 Bug 修复交付：Studio 成员能够基于完整的房间公开上下文协作，普通房间消息不会意外启动默认员工，Runtime 调用和安全重试可以被准确追踪。

不包含 Agent-to-Agent 自动唤醒、结构化任务看板、私聊、held draft、人工审批、跨设备多人协作或自动 Git 提交。
