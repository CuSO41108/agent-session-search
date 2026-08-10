# Workflow 重写设计

## 目标

彻底替换现有 Workflow V2。新版以结构化属性描述工作流和节点，由运行时统一组装执行指令；界面不再暴露原始 Prompt、Task Packet、Review Gate、事务协调器等内部概念。

本次不兼容旧 Workflow 定义、运行记录或恢复状态。升级后重置 Workflow 专属数据，但不得影响会话、Agent、Provider、Memory、设置等其他数据。

## 产品原则

- 工作流的结构必须能从画布直接看懂。
- Prompt 是运行时产物，不是用户编辑的核心数据。
- 输入和输出都使用带名称、类型和描述的字段。
- Agent、Script、Review、Approval 都是显式节点，共享同一套输入、输出和生命周期。
- 完整节点输出必须可以直接查看和被下游精确引用，摘要不能替代真实输出。
- 功能保留，但实现只建立一套定义、一套运行状态和一套输出协议。

## 工作流定义

```ts
interface WorkflowDefinition {
  id: string
  name: string
  description: string
  inputs: WorkflowInputDefinition[]
  nodes: WorkflowNode[]
  createdAt: number
  updatedAt: number
}

interface WorkflowInputDefinition {
  key: string
  name: string
  description: string
  type: WorkflowValueType
  required: boolean
}
```

节点间依赖只通过节点输入中的 `nodeId + outputKey` 表达，不另存 `edges` 或 `dependsOn`。画布连线由输入引用推导，避免两份拓扑状态不一致。

## 通用节点模型

```ts
interface BaseNode {
  id: string
  kind: "agent" | "script" | "review" | "approval"
  title: string
  goal: string
  inputs: WorkflowNodeInput[]
  outputs: WorkflowOutputField[]
  acceptanceCriteria: string[]
}

type WorkflowNodeInput =
  | {
      key: string
      name: string
      description: string
      required: boolean
      source: "workflow"
      workflowInputKey: string
    }
  | {
      key: string
      name: string
      description: string
      required: boolean
      source: "workspace"
      path?: string
    }
  | {
      key: string
      name: string
      description: string
      required: boolean
      source: "node"
      nodeId: string
      outputKey: string
    }
  | {
      key: string
      name: string
      description: string
      required: boolean
      source: "literal"
      value: unknown
    }
```

所有输入必须有业务名称和描述。下游只接收明确引用的字段，不会默认注入整个上游结果。

## 输出字段模型

```ts
type WorkflowValueType =
  | "text"
  | "number"
  | "boolean"
  | "file"
  | "object"
  | "list"

interface WorkflowOutputField {
  key: string
  name: string
  description: string
  type: WorkflowValueType
  required: boolean
  fields?: WorkflowOutputField[]
  item?: WorkflowOutputField
}
```

规则：

- 每个节点可以声明多个顶层输出字段。
- `object` 使用 `fields` 描述属性；其他类型不得包含 `fields`。
- `list` 使用 `item` 描述元素；其他类型不得包含 `item`。
- `object/list` 最多嵌套两层。
- 同一级 `key` 唯一，并使用稳定的 ASCII 标识符；`name` 和 `description` 面向用户。
- 运行结果是以输出字段 `key` 为键的对象。缺少必填字段或类型不匹配时，节点不能完成。
- `file` 的值是当前 Run 输出目录中的相对路径；禁止引用目录外文件。

## 节点类型

### AgentNode

```ts
interface AgentNode extends BaseNode {
  kind: "agent"
  agentId: string
  instructions: string[]
  constraints: string[]
}
```

运行时根据目标、解析后的输入、执行要求、约束、输出字段和完成标准确定性组装 Prompt。Agent 必须通过统一完成协议返回结构化输出。

### ScriptNode

```ts
interface ScriptNode extends BaseNode {
  kind: "script"
  runtime: "bash" | "python" | "typescript"
  source: string
  timeoutSeconds: number
  permissions: Array<"workspace_read" | "workspace_write" | "workspace_delete" | "network" | "process">
}
```

脚本输入以 JSON 通过标准输入一次性传入，脚本以 JSON 输出统一结果。只读脚本自动执行；包含写入、删除、网络或子进程权限时，首次运行前要求用户确认。超时后终止子进程并标记失败。

### ReviewNode

```ts
interface ReviewNode extends BaseNode {
  kind: "review"
  agentId: string
  instructions: string[]
  constraints: string[]
  targetNodeIds: string[]
  criteria: Array<{ key: string; description: string }>
  maxRevisions: number
  onReject: "revise" | "stop"
}
```

Review 是画布上的显式节点。它的输出声明必须包含 `verdict`（值为 `pass` 或 `revise`）、`criteriaResults` 和 `feedback` 三个字段，校验器会检查这些固定字段。`revise` 会带反馈重跑目标节点，并使依赖这些目标输出的已完成下游节点失效。达到 `maxRevisions` 后停止运行，不再进入另一套干预或恢复机制。

### ApprovalNode

```ts
interface ApprovalNode extends BaseNode {
  kind: "approval"
  message: string
  options: Array<{ value: string; label: string; description: string }>
  allowComment: boolean
}
```

Approval 进入 `waiting` 状态。用户选择后，选择值和可选备注作为普通命名输出写入，随后调度下游节点。

## Prompt 组装

Agent 与 Review 共用同一个 Prompt Assembler，固定顺序为：

```text
# Goal
# Inputs
# Instructions
# Constraints
# Expected outputs
# Completion criteria
```

系统级执行协议、工具调用方法、输出目录限制和安全规则由执行器提供，不存进 Workflow 定义。输入值在运行时注入，并与定义文本明确分隔，避免把上游内容误当成指令。

## 定义校验

保存和运行前使用同一个纯函数校验器，至少检查：

- ID、字段 key 和同级 key 唯一性。
- 节点输入引用的 Workflow 输入、节点和输出字段真实存在。
- 不允许节点引用自己或形成循环依赖。
- 所有节点从 Workflow 输入或无依赖节点可达。
- 输出结构符合类型规则和两层嵌套限制。
- Agent/Review 引用的 Agent 存在。
- Review 目标必须位于其上游、至少有一个目标输出被 Review 输入引用、包含三个固定输出字段，且 `maxRevisions` 为有限非负整数。
- Script runtime、超时和权限合法。
- Approval 至少有两个不同选项。

错误返回字段路径和面向用户的说明，例如 `nodes.extra.outputs.highlights.item.fields.evidence`，界面直接定位并高亮对应属性。

## 运行模型

```ts
interface WorkflowRun {
  id: string
  workflowId: string
  definition: WorkflowDefinition
  inputs: Record<string, unknown>
  status: "running" | "waiting" | "completed" | "failed" | "cancelled"
  nodeRuns: Record<string, NodeRun>
  startedAt: number
  finishedAt?: number
}

interface NodeRun {
  nodeId: string
  status: "pending" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  attempt: number
  resolvedInputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: { code: string; message: string; fieldPath?: string }
  startedAt?: number
  finishedAt?: number
}
```

启动 Run 时冻结完整定义。Scheduler 只执行所有必填输入已就绪的节点，彼此无依赖的节点并行运行。节点完成后先验证输出，再持久化结果并唤醒下游。

节点失败时，依赖它的节点保持 `pending`，不相关的已运行分支允许结束；当没有更多可运行节点时，整个 Run 标记为 `failed`。用户可以重试失败节点，重试会保留仍有效的上游结果，并清空依赖该节点输出的下游结果。取消 Run 会终止活跃 Agent 和 Script 进程。

新版不提供旧 Run 的断点恢复。应用重启时，仍处于 `running` 的 Run 统一转为 `failed`，用户可从失败节点重新运行。

## 持久化

只保留三类 Workflow 数据：

- Workflow definitions。
- Workflow runs，其中包含冻结定义和节点运行状态。
- Run artifacts，记录 `file` 输出的相对路径和元数据。

写入 NodeRun 时以一次数据库事务同时保存状态、完整输出和时间信息。输出不使用摘要替代；列表页需要摘要时在读取后计算。

首次启用新版 Workflow 时删除所有旧 Workflow V2 定义、计划、对话、Review、事务账本和运行恢复记录，不保留不可达的旧数据。清理范围必须由明确的 Workflow 表或存储键白名单限定，并在测试中证明不会触碰其他产品数据。

## 创建与编辑界面

主界面由工作流列表、节点画布和节点属性面板组成。

用户输入自然语言目标后，AI 一次生成完整的 `WorkflowDefinition`。生成结果必须通过同一校验器才能进入画布；校验失败时由生成器根据字段错误自动修正一次，仍失败则展示错误，不保存半成品。

节点卡片显示：类型、名称、输入数量、输出数量、Agent 或 Script runtime，以及本次运行状态。连线从节点输入引用推导。

节点属性面板分为：

- 基本信息：类型、名称、目标、Agent。
- 输入：来源、字段引用、名称、描述和必填状态。
- 执行：Agent 指令与约束，或对应节点类型配置。
- 输出：字段、类型、描述、必填状态和最多两层子字段。
- 完成标准：可排序、可增删的条件列表。

默认界面不显示原始 Prompt、原始 JSON、运行内部协议或数据库标识符。

## 运行与结果界面

画布顶部提供“定义”和“本次运行”切换。运行视图沿用同一张图显示节点状态。

点击节点时，运行面板按已声明字段展示解析后的输入和完整输出：标量直接显示，列表显示数量并可展开，对象按子字段展示，文件提供预览或打开操作。错误显示在对应字段或节点类型配置旁。

运行历史是独立页面，仅展示 Run 状态、时间、耗时和节点结果；不把运行消息、系统指令和内部事件混进定义编辑器。

## 删除旧实现

新版功能完成并通过测试后，删除现有 Workflow V2 的定义、规划、Task/Result Packet、Review Gate、事务协调、恢复协调、旧 Conversation Manager、旧节点抽屉和旧运行中心。不得保留新旧执行路径或兼容适配层。

共享的 Agent Runtime、Provider 调用、审批 UI 基础组件和安全脚本执行能力可以复用，但必须通过新版 Executor 接口接入，不得让旧 Workflow 类型泄漏进新模块。

## 测试策略

- 定义测试：字段规则、两层嵌套、引用解析、循环检测和各节点类型校验。
- Prompt 测试：结构化属性按固定顺序组装，上游数据与指令明确隔离。
- 调度测试：串行、并行、失败分支、重试失效范围、取消和 Approval 等待/继续。
- Executor 测试：Agent 结构化完成、Script 权限与超时、Review pass/revise、Approval 输出。
- 输出测试：必填、类型、对象、列表、文件目录边界和完整内容持久化。
- 持久化测试：节点状态与输出原子写入，重启时运行状态收敛，旧 Workflow 数据清理不影响其他数据。
- UI 测试：结构化编辑、字段错误定位、画布连线推导、定义/运行切换和完整输出展开。
- 内置 Workflow 测试：所有内置定义通过新版校验并完成至少一次合成 Runtime 运行。

测试安装和清理必须使用临时 HOME、临时数据库、临时输出目录和合成 Agent/脚本，不得读取或修改开发者真实的会话、Agent、Memory 或 Workflow 数据。

## 完成标准

- 新版四类节点都能创建、编辑、保存和运行。
- 节点输入能精确引用 Workflow 输入和上游命名输出字段。
- 多字段、带描述、最多两层嵌套的输出能被验证、持久化、展示和下游消费。
- Review 和 Approval 都是图中可见节点，状态和反馈可以直接查看。
- UI 不再要求用户理解 Prompt、Packet、Gate、事务或恢复内部模型。
- 所有内置 Workflow 使用新版格式。
- 旧 Workflow V2 代码路径和兼容层被删除。
- 类型检查、自动化测试、构建和 release-note 检查通过。
