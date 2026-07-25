# Workflow 事务治理总览

## 1. 文档定位

本文是 Workflow 节点半成功治理的总览设计。目标不是给节点增加一个模糊的 `partial_success` 状态，而是把一次 Workflow Run 拆成可观测、可恢复、可审计的事务过程：

```text
冻结基线 → 隔离执行 → 记录副作用 → 节点验收 → 保存点/提交点 → 用户确认 → 提交或受控回滚
```

本文定义跨阶段必须保持一致的术语、状态、边界和不变量；具体实现要求见：

- [阶段一：合同与观测底座](./phase-01-contract-and-observability.md)
- [阶段二：工作区事务与保存点](./phase-02-workspace-transaction.md)
- [阶段三：外部操作代理与补偿](./phase-03-external-operation-broker.md)
- [阶段四：Agent/脚本节点接入](./phase-04-node-integration.md)
- [阶段五：恢复、冲突与用户界面](./phase-05-recovery-and-ui.md)
- [阶段六：故障注入、迁移与发布](./phase-06-validation-and-rollout.md)

## 2. 问题定义

当前 Workflow 可能出现以下“半成功”现象：

- 前置节点已经修改、创建或删除文件，后续节点失败，但真实工作区没有恢复；
- Agent 或脚本没有感知先前变更，重试时重复执行同一操作；
- Agent/脚本进程报告成功，但输出、工具调用、文件 diff 或外部请求并不支持节点目标；
- 外部 API、消息发送等操作在 Workflow 崩溃后状态未知，系统只能盲目重试或重复补偿；
- 节点输出尚未通过验收，文件产物已经写入最终目录；
- 用户在 Workflow 运行期间修改真实工作区，最终提交覆盖了用户修改。

治理目标是让系统明确回答四个问题：

1. 节点实际做了什么？
2. 哪些结果已经被验证并可作为下游输入？
3. 哪些副作用已生效、可补偿或状态未知？
4. 失败后用户能选择什么，系统会如何证明选择已经生效？

## 3. 核心原则

### 3.1 执行、验收、提交分离

`Runtime completed`、`Node completed` 和 `Workflow committed` 不是同一个事实：

- Runtime completed：底层 Agent/脚本进程结束；
- Node completed：输出、工具、差异和副作用证据通过节点合同；
- Workflow committed：所有节点和提交点通过，用户确认项已执行，工作区变更已安全应用。

### 3.2 事务状态与节点状态分离

节点状态描述节点执行；事务状态描述整个 Run 的变更是否已经提交、回滚或需要恢复。不得用一个状态同时表达两者。

### 3.3 隔离优先，补偿兜底

- 文件修改优先在隔离工作区完成，成功后一次性应用；
- 可撤销外部操作必须经过操作代理，保存执行前状态和补偿凭据；
- 不可撤销操作默认延迟到提交点；
- 无法确认状态的操作进入 `unknown`，禁止自动重试。

### 3.4 用户可见但不被底层复杂度淹没

用户应能看到计划、diff、receipt、风险和恢复选择；Undo Log、幂等检查和补偿顺序由系统负责，但不能隐藏关键事实。

### 3.5 不静默降级

Workflow 启动时固定执行模式。严格模式条件不满足时阻止启动，不得在运行到一半后自动降级为直接执行。

## 4. 执行模式

### 4.1 `strict_atomic`

适用于新的 Coding Workflow，默认模式。

- 工作区必须隔离；
- 写入型外部操作必须有操作代理、状态查询和补偿能力，或被延迟到提交点；
- 不支持治理的任意 Shell 外部写入禁止执行；
- 预检、节点验收、最终提交和冲突检测均通过后才可完成；
- 缺少依赖时直接拒绝启动。

### 4.2 `controlled`

允许不可撤销操作，但每个操作必须逐项或整批确认，并在失败后进行尽力补偿和报告。该模式不承诺严格全量回滚。

### 4.3 `direct`

兼容旧行为，仅保留审计、风险提示和历史记录，不承诺回滚。旧 Workflow 默认落在此模式，并在启动页明确提示。

## 5. 事务对象与状态

### 5.1 Workflow 事务状态

```text
active
waiting_for_user
committing
committed
rolling_back
rolled_back
partially_rolled_back
recovery_required
```

- `active`：仍在隔离执行或等待节点完成；
- `waiting_for_user`：等待审批、冲突处理、状态确认或恢复选择；
- `committing`：应用工作区变更或执行已确认的外部提交；
- `committed`：所有承诺范围内的变更已经提交；
- `rolling_back`：正在按 Undo Log 逆序补偿或恢复快照；
- `rolled_back`：承诺范围内的变更均已恢复；
- `partially_rolled_back`：部分补偿失败或存在不可撤销项；
- `recovery_required`：存在无法判断的外部状态，必须人工核实。

### 5.2 节点执行状态

沿用现有节点执行状态，不把 `partial_success` 加入调度依赖判定：

```text
queued / running / validating / awaiting_review / awaiting_approval
paused / completed / failed / skipped
```

节点另有完成结论：

```text
clean / degraded / rejected
```

只有 `clean` 或经节点策略明确允许的 `degraded` 才能作为下游输入；`rejected` 不得继续传播。

### 5.3 操作账本状态

```text
planned / applying / applied / compensating / compensated / unknown
```

所有外部副作用和需要审计的文件提交都必须有稳定 `operationId`、`runId`、`nodeId`、`attempt` 和 `idempotencyKey`。

## 6. 检查点语义

### 6.1 保存点

保存点只记录快照和账本位置，不释放 Undo Log。可以回滚到任意更早保存点，也可以继续执行。

### 6.2 提交点

提交点确认一段阶段结果正式生效，之后默认只保证回滚到该提交点。跨提交点可以发起“尽力全量补偿”，但必须标记为 best-effort。

### 6.3 回滚算法

- 隔离工作区：直接恢复快照或丢弃当前隔离区；
- 已应用文件变更：生成基于基线的反向补丁，遇到用户并发修改则暂停冲突处理；
- 外部操作：按操作账本逆序执行补偿；
- 补偿成功写入 `compensated`，补偿失败写入 `unknown` 或 `partially_rolled_back`；
- 不能把外部系统的补偿伪装成原子回滚。

## 7. Agent 与脚本的共同完成合同

两类节点都遵循：

```text
历史/实际执行 → 输出解析 → 实际证据 → 节点验收 → 事务提交
```

Agent 不需要额外声明变更计划。权威证据来自：

- 隔离工作区基线与当前快照之间的实际 diff；
- 完整工具调用与结果历史；
- 外部操作代理 receipt；
- 节点结构化输出和 Reviewer 结论。

脚本必须声明副作用模式：

```text
pure | workspace_only | brokered_external
```

并声明幂等策略和补偿适配器。无法约束副作用的任意 Shell 脚本不得获得原子性承诺。

## 8. 审批与动态操作

用户可选择：

- 整批确认启动前已列出的操作；
- 每个高风险操作逐项确认。

整批确认只覆盖当时展示的具体目标、参数、消息内容和附件。运行期间产生的新写操作、不可逆操作或计划外目标必须暂停并重新确认。

自动提交授权只在以下条件全部满足时有效：实际操作与批准计划一致、无新增操作、无 `unknown`、无补偿失败、无冲突、无新增不可逆操作，且所有节点验收通过。

## 9. 崩溃恢复

副作用必须遵循 WAL 顺序：

```text
持久化 planned → 执行操作 → 持久化 applied/receipt
```

崩溃恢复时：

1. 读取事务账本和本地快照；
2. 查询可查询的外部状态；
3. 生成恢复预览；
4. 等待用户选择继续、回滚、保留现场或放弃；
5. 不自动执行补偿。

Manager Agent 可以生成回滚顺序、补偿计划和冲突候选，但不能未经用户确认写入真实工作区或执行补偿。

## 10. 并发与冲突

多个 Run 可以在各自隔离区并行，但提交阶段必须串行，并重新校验基线版本。冲突时：

- 暂停提交；
- 展示基线、Workflow 结果和用户新修改的三方差异；
- 用户可以手动合并，或查看 Manager Agent 候选结果；
- 用户确认最终 diff 后才可写入真实工作区。

## 11. 报告与保留

报告至少包含：节点执行结论、实际文件 diff、工具失败、API receipt、消息详情、补偿顺序、未恢复项、状态未知项、用户决定和时间线。

快照和完整账本默认保留 7 天。恢复中、状态未知和部分回滚的 Run 不自动清理。Token、Authorization Header、密码和 Secret 只保存脱敏摘要或安全引用。

## 12. 第一阶段交付边界

首个完整闭环包含：

1. 文件事务：隔离工作区、受保护基线、保存点、节点级回滚、Workflow 级回滚和冲突处理；
2. 通用外部操作协议：`prepare/apply/inspect/compensate`、WAL、幂等键和 `unknown` 恢复；
3. 消息适配器：草稿、用户确认、发送 receipt、不可撤回报告；
4. HTTP API 适配器：只读请求、可查询/可补偿写请求及受限降级；
5. Agent/脚本节点共用事务协调器、完成验收和审计报告。

GitHub、数据库、部署和发布平台在同一适配器合同上后续扩展。
