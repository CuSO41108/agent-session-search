# Runtime 执行配置与 Agent 删除完整性修复

## 问题范围

V2 Runtime 页面把“执行配置”和“Agent”拆成两个视图，但两者仍是有依赖关系的一组数据：执行配置决定 Runtime、Provider 和模型，Agent 通过 `channelId` 引用执行配置，Chat、Task、Team 和 Workflow 再通过 `configuredAgentId` 引用 Agent。

本次排查针对以下问题：

- 离开 Runtime 页面时保存执行配置，自动生成的 Agent 可能没有同步到 Agent 编辑状态，随后被旧列表覆盖；直接点击保存则能看到新 Agent。
- 删除执行配置时，只检查了用户创建的 Agent，忽略了按执行配置自动生成的托管 Agent。
- 删除 Agent 时，只校验了 Workflow 节点的显式引用，Chat、Task、Team、Team Chat 房间、Workflow 审核 Agent 和评估实验均未完整覆盖；托管 Agent 还被校验逻辑主动豁免。
- Workflow 顶层还保存了一组可单独选择的默认 Agent/模型，与系统默认 Agent 形成了含义重复的配置。

## 数据关系

```text
执行配置 (AgentChannel)
  <- ConfiguredAgent.channelId
       <- ChatState.configuredAgentId
       <- TaskState.configuredAgentId
       <- AgentTeamMember.configuredAgentId
       <- TeamChatRoom.agents[].configuredAgentId
       <- WorkflowDraftState.reviewerConfiguredAgentId
       <- Workflow LLM node.configuredAgentId
       <- EvaluationExperiment.agentId
```

## 根因

### 保存不是一个一致的状态转换

执行配置通过 `saveModelChannels` 保存，主进程随后会为新增配置生成托管 Agent。Agent 列表通过另一个 `saveConfiguredAgents` 调用保存。离开页面时，如果两类数据同时处于编辑状态，前端先保存执行配置，再用保存前闭包中的 `editableAgents` 保存 Agent，刚生成的托管 Agent 因不在旧列表中而被识别为已删除。

此外，执行配置保存返回的新快照只写入全局快照，Agent 编辑列表依赖后续 React effect 才同步。切换视图或离开页面时，这个同步时序不可靠。

### 删除校验停留在前端且过滤了托管 Agent

执行配置的删除检查位于 Renderer hook，并使用 `agent.managed !== true` 过滤条件。因此，保存执行配置时生成的托管 Agent 不会阻止其执行配置被删除。该检查也可以被 IPC、MCP 或其他调用入口绕过。

### Agent 删除校验覆盖不完整

主进程原有校验只扫描 Workflow 定义中显式指定 `configuredAgentId` 的 LLM 节点，并把当前所有托管 Agent 强行加入“仍然存在”的 ID 集合。结果是：

- 托管 Agent 可以绕过 Workflow 节点引用检查。
- Workflow 审核 Agent 不在检查范围内。
- Chat、Task 和 Team 不在检查范围内。
- Team Chat 房间成员和评估实验保存在 AgentHub 之外，原删除入口无法看到这些引用。
- 删除后 `normalizeRunSelections` 会把部分失效引用静默改成默认 Agent，掩盖数据完整性问题。

### Workflow 默认 Agent 与系统默认 Agent 重复

Workflow 顶层的 `configuredAgentId` 和 `modelId` 原本既用于规划对话，又作为未显式配置节点的执行回退。用户因此需要为每个 Workflow 重复选择一次 Agent，也容易误以为这是一种独立的 Workflow Agent。现在这两个字段只为旧数据和运行快照兼容保留，创建、编辑和 Agent 列表变化时都会同步到当前系统默认 Agent；界面和 MCP 不再提供 Workflow 顶层 Agent 选择。Workflow 审核 Agent 和节点显式 Agent 仍是有意的执行路由，因此继续作为真实引用处理。

## 修复约束

删除操作遵循以下规则：

1. 删除执行配置前，必须确认没有任何 Agent 的 `channelId` 指向它，托管 Agent 与用户 Agent 一视同仁。
2. 删除 Agent 前，必须确认 Chat、Task、Team、Team Chat 房间成员、Workflow 审核、Workflow 显式节点和评估实验均未引用它。
3. 用户保存入口必须在 `AgentHub` 状态变更前开启删除校验，失败时不得修改内存状态或持久化数据；内部初始化和迁移可以显式跳过用户删除语义。
4. Renderer 可以保留即时提示，但主进程统一服务校验是最终约束，IPC 和 MCP 删除入口都不能绕过。
5. 执行配置保存产生的新托管 Agent 必须立即合并到 Agent 编辑状态；合并时保留用户未保存的 Agent 编辑和明确删除，不得再用旧列表覆盖新 Agent。

## 回归验证

- 保存新增执行配置后，返回快照包含对应托管 Agent。
- 执行配置被托管 Agent 或用户 Agent 使用时，保存删除操作失败且原配置仍存在。
- Agent 被 Chat、Task、Team、Workflow 审核或 Workflow 节点使用时，删除失败且原 Agent 仍存在。
- Agent 被 Team Chat 房间成员或评估实验使用时，删除失败，提示中包含所有引用位置。
- Workflow 创建和编辑请求即使携带顶层 Agent，也会使用系统默认 Agent；未显式指定 Agent 的节点显示为“System default”。
- 未被引用的用户 Agent 和托管 Agent 仍可删除。
- 离开页面保存执行配置后，新生成的托管 Agent 会合并到本地 Agent 编辑列表，不覆盖用户正在编辑的条目，也不恢复用户明确删除的旧条目。
