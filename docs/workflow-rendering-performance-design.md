# Workflow 增量状态与渲染性能改造设计

## 背景

Workflow 在 Agent 流式输出、节点状态更新和工具事件增加后会出现明显卡顿。卡顿不只表现为消息和画布刷新慢：任务输入框、回复输入框、节点 Agent 下拉框以及定义编辑器在运行中或历史较多时也会偶发按键延迟、选项迟迟不生效。

当前实现并非完全没有增量处理：主进程会把密集的 assistant delta 合并到 32 ms 的发送窗口；但合并后的每次更新仍会重新构造、序列化并发送完整 `AppSnapshot`，Renderer 随后以整个 snapshot 作为 React Context 值更新。

因此，当前链路只实现了“事件节流”，没有实现“增量状态传输”和“局部视图订阅”。工具调用与工具结果进入节点历史后增加了快照体积和消息数量，使已有性能瓶颈更容易被观察到，但工具卡片本身不是根因。

## 现状证据

### 主进程

- `AgentHub.emitStreaming()` 使用 32 ms 定时器合并流式 delta，终止事件通过 `emit()` 立即刷新。
- `AgentHub.publishSnapshot()` 每次调用 `snapshot()`，随后把完整快照交给所有 listener。
- `AgentHub.snapshot()` 每次重新创建 channels、configured agents、chats、tasks、teams、Workflow store、scheduled workflow store、node conversations 和 artifacts 等完整投影。
- `NativeAutomationService` 将每个 Hub 变更继续发布为完整 `AppSnapshot`。
- Electron IPC 的 `automation:snapshot-changed` 传输完整对象，序列化成本和历史数据量一起增长。

关键代码：

- [`AgentHub.snapshot()`](../src/automation/engine/main/hub/agent-hub.ts)
- [`AgentHub.emitStreaming()` 与 `publishSnapshot()`](../src/automation/engine/main/hub/agent-hub.ts)
- [`NativeAutomationService.subscribe()`](../src/main/services/automation-service.ts)
- [Automation IPC](../src/main/ipc/automation.ts)

### Renderer 状态边界

- `AutomationProvider` 使用单一 `useState<AppSnapshot>` 保存全部 Automation 状态。
- 每次 `setSnapshot(next)` 都会改变 Context value，所有 `useAutomation()` 消费者重新渲染。
- Workflow Feature Manager 从完整 snapshot 重新选择 active workflow、runs、conversations、tasks 和 artifacts；由于主进程深拷贝，未变化实体也失去引用稳定性。

关键代码：

- [`AutomationProvider`](../src/renderer/src/features/automation/automation-provider.tsx)
- [`WorkflowFeaturePage`](../src/renderer/src/features/automation/workflow-feature-page.tsx)
- [`useWorkflowFeatureController`](../src/automation/engine/renderer/src/pages/workflow/hooks/useWorkflowFeatureController.ts)

### Workflow 视图

- `WorkflowPage` 每次渲染重新执行定义校验、创建 runtime/progress Map、计算状态签名并遍历节点会话。
- `runProgressByNodeId`、`renderNodeCard` 和多个回调每次获得新引用，使 React Flow 的 memo 边界失效。
- `WorkflowCanvasBoard` 虽然使用 `useMemo`，但完整快照使 `definition` 引用持续变化，画布布局和 edge 投影仍会重复计算。
- Workflow transcript 每次更新都会遍历所有消息；当前变化中的 assistant 消息持续重新解析和渲染 Markdown。
- `WorkflowRunCenter` 在 `open === false` 时仍先执行 runs 查找、过滤和时间线相关 hooks；打开后 Run、节点、事件和消息列表没有虚拟化。
- 节点会话窗口会重新遍历全部消息。`WorkflowMessageContent` 已有 `memo`，但父级列表和工具事件仍参与 reconciliation。

关键代码：

- [`WorkflowPage`](../src/automation/engine/renderer/src/pages/workflow/WorkflowPage.tsx)
- [`WorkflowCanvasBoard`](../src/automation/engine/renderer/src/pages/workflow/WorkflowCanvasBoard.tsx)
- [`WorkflowRunCenter`](../src/automation/engine/renderer/src/pages/workflow/WorkflowRunCenter.tsx)
- [`WorkflowNodeAgentWindow`](../src/automation/engine/renderer/src/pages/workflow/WorkflowNodeAgentWindow.tsx)
- [`WorkflowMessageContent`](../src/automation/engine/renderer/src/pages/workflow/WorkflowMessageContent.tsx)

### 表单交互专项排查

输入框卡顿有一条独立于 IPC 的同步渲染链路：

```text
textarea onChange
  -> useWorkflowDraft 的 workflowObjectiveInput / workflowReplyInput
  -> draft controller 重新创建
  -> WorkflowController 重新创建
  -> WorkflowPage 整体重新渲染
  -> 定义校验、Map/签名构造、消息与会话扫描、React Flow reconciliation
```

- 主输入框的值保存在 `useWorkflowDraft`，不在输入框附近的轻量叶子组件中。每次按键都会使 `useWorkflowFeatureManager`、`useWorkflowFeatureController` 和 `WorkflowPage` 的数据链更新。
- `WorkflowPage` 在每次渲染时同步执行 `validateWorkflowV2Definition(definition)`，重新创建 runtime/progress Map、运行状态签名、节点卡片 renderer，并扫描消息、会话、进度和产物。输入文本本身没有改变这些数据，但仍要支付这些同步成本。
- `WorkflowCanvasBoard` 收到每次新建的 `runProgressByNodeId` 和 `renderNodeCard` 引用，Context value、edges、MiniMap 回调和节点子树随之失效。即使 definition 没变，输入事件也可能触发画布 reconciliation。

下拉框的延迟来自另一条“悲观受控”链路：

```text
select onChange
  -> updateWorkflowNode
  -> structuredClone(完整 definition)
  -> workflowDraftPatch IPC
  -> 主进程 emit + 完整 AppSnapshot
  -> Renderer setSnapshot
  -> select 的 value 才更新
```

- 节点 Agent 下拉框的 `value` 直接来自当前 definition，没有本地 optimistic value、pending 状态或 latest-request-wins 保护。用户选择后，原生控件要等主进程往返和完整快照替换后才得到新值。
- 同一个 patch 同时通过 Hub 的 snapshot changed 订阅和 IPC 返回值影响 Renderer。当前两条路径都直接 `setSnapshot`，没有 revision/sequence 新旧判断；后台又可能继续推送流式快照，因此无法从协议层证明旧快照不会覆盖较新的交互结果。
- 下拉框位于 React Flow 节点内部，但只阻止 `click`、`contextmenu` 和 `change` 冒泡；画布启用了 `panOnDrag`。缺少明确的 `nopan`/指针按下隔离不是已证实的 CPU 根因，但可能放大“点了没反应”或误触画布的问题，应通过 pointer 事件日志单独验证。

定义 JSON 编辑器还有一个局部热点：

- 每次键入都会在组件 render 中同步 `JSON.parse(definitionJson)`，解析成功时还会扫描并渲染所有 LLM 节点的 Agent 下拉框。
- 在 Agent 下拉框中切换选项会 `structuredClone` 整个 definition，再 `JSON.stringify(..., null, 2)` 整个文档。大定义下这条同步路径会直接阻塞输入和下拉交互。

关键代码：

- [`useWorkflowDraft`](../src/automation/engine/renderer/src/pages/workflow/hooks/useWorkflowDraft.ts)
- [`useWorkflowFeatureController`](../src/automation/engine/renderer/src/pages/workflow/hooks/useWorkflowFeatureController.ts)
- [`WorkflowPage`](../src/automation/engine/renderer/src/pages/workflow/WorkflowPage.tsx)
- [`WorkflowNodeAgentSelect`](../src/automation/engine/renderer/src/pages/workflow/WorkflowNodeAgentSelect.tsx)
- [`WorkflowDraftEditorDialog`](../src/automation/engine/renderer/src/pages/workflow/WorkflowDraftEditorDialog.tsx)
- [`WorkflowCanvasBoard`](../src/automation/engine/renderer/src/pages/workflow/WorkflowCanvasBoard.tsx)

## 根因判断

性能问题由多个层次叠加形成。针对“输入框和下拉框偶发卡顿”，优先级如下：

1. **受控输入状态位于重组件上游**：每次按键都同步重渲染整个 Workflow 页面。这是空闲状态下输入仍可能变慢的直接根因。
2. **完整快照广播与全局 Context 失效**：流式刷新在同一主线程持续制造完整快照解析和大范围 React 更新，与高优先级输入事件争用时间片。这是卡顿呈现“偶发”、且运行越久越明显的首要放大器。
3. **下拉框依赖完整 IPC 往返后提交 value**：选择动作没有即时本地反馈，并且缺少 snapshot revision/sequence 仲裁。这是下拉框视觉延迟和潜在回跳的直接根因。
4. **昂贵视图缺少稳定边界**：画布、Run Center、Markdown 和历史列表在无关输入变化中重复计算或全量 reconciliation。
5. **定义编辑器同步解析/序列化完整 JSON**：这是大 Workflow 定义编辑时的专项根因。

React Flow 指针事件竞争目前只能列为待验证的交互风险，不能在没有 pointer trace 的情况下当作已证实根因。

只在 `WorkflowPage` 增加几个 `useMemo` 能缓解局部 CPU 消耗，但完整快照会持续制造新引用，无法形成稳定缓存，因此不能作为最终方案。

## 目标

- 首次进入 Automation 时加载完整快照，后续高频变化通过有序增量事件同步。
- 流式 token 只更新对应 owner 的当前 assistant 消息，不重建 Workflow、Run 和画布数据。
- Renderer 组件只订阅自己需要的实体或字段，未变化数据保持引用稳定。
- terminal、失败、审批和工具结果等关键事件立即可见；普通 token 可批量刷新。
- Run Center 和节点历史在数据量增长后仍保持可预测的 DOM 数量与交互延迟。
- AgentHub 和现有持久化仍是权威状态源，不在 Renderer 建立第二套业务状态机。

## 非目标

- 不改变 Workflow V2 状态机、调度、审批和持久化语义。
- 不丢弃工具调用、工具结果、runtime conversation 或历史消息。
- 不通过降低历史保留量掩盖性能问题。
- 不把所有页面一次性迁移到新的状态库；先建立通用增量协议，再按高频领域迁移。

## 目标架构

```text
AgentHub authoritative state
        │
        ├─ bootstrap ───────────────> AppSnapshot
        │
        └─ ordered domain changes ──> AutomationChange(seq, domain, entity, operation, payload)
                                             │
                                             v
                                  Renderer normalized store
                                   │       │        │
                                   v       v        v
                              workflow  active run  conversation
                              selector   selector     selector
```

### Bootstrap 与增量协议

保留 `automation:snapshot` 作为初始化、恢复和失序重同步入口。新增增量事件通道，事件至少包含：

```ts
interface EntityPatch<T> {
  upsert: T[];
  remove: string[];
}

interface AutomationChange {
  protocolVersion: 1;
  sequence: number;
  detectedAt: number;
  domain: "workflow";
  entityId: "workflow-state";
  operation: "patch";
  payload: {
    activeWorkflowId?: string | null;
    workflows?: EntityPatch<WorkflowDraftState>;
    runs?: EntityPatch<WorkflowRunState>;
    conversations?: EntityPatch<WorkflowNodeConversation>;
    tasks?: EntityPatch<TaskRun>;
    artifacts?: EntityPatch<RegisteredArtifact>;
  };
}
```

约束：

- `sequence` 在单个主进程生命周期内严格递增。
- Renderer 检测到 sequence 缺口、未知协议版本或 patch 应用失败时，重新请求完整快照。
- 每个实体 patch 以稳定 id 执行 `upsert/remove`；未变化实体继续保留旧引用。
- terminal 状态和失败事件立即发布；普通文本 delta 进入批处理。
- 增量协议只描述投影变化，业务校验仍由 AgentHub 完成。

当前实现先覆盖 Workflow 高频领域。其他 Automation 页面继续使用完整快照；Workflow 与其他领域同时变化时，完整快照拥有更高 flush 优先级，Renderer 仍能获得一致状态。后续迁移 Chat/Task/Team 时复用同一 sequence 和 resync 语义。

### Renderer Store 与选择器

Renderer 使用 normalized store 保存实体，并通过 `useSyncExternalStore` 或等价 selector API 提供细粒度订阅：

- `useWorkflowList()`
- `useWorkflow(workflowId)`
- `useWorkflowRuns(workflowId)`
- `useWorkflowRun(runId)`
- `useWorkflowNodeConversation(runId, nodeId)`
- `useRuntimeCatalog()`

更新一个 conversation 的 streaming message 时，只替换该 conversation 和当前 message 的引用；workflow definition、历史 runs、其他 conversations、channels 和 runtimes 保持原引用。

`AutomationProvider` 只提供稳定的 store/API，不再把完整 snapshot 直接放入 Context value。

### 流式消息聚合

- 主进程或 Renderer 的 stream accumulator 按 ownerId + messageId 聚合文本。
- 普通 token 以 50–100 ms 或 `requestAnimationFrame` 批量提交，避免每 32 ms 执行完整 React commit。
- `tool_call`、`tool_result`、审批请求、错误和 completed 事件立即 flush。
- 最终消息替换临时 streaming buffer，确保历史持久化内容与界面一致。
- 中断、Runtime 崩溃或窗口卸载时必须 flush 或明确废弃 buffer，不能遗留永久 streaming 状态。

### 视图隔离

#### Workflow 主页面

- 将 header、transcript、graph、run progress、outputs 和 overlays 拆成独立 memo 边界。
- `validateWorkflowV2Definition` 仅在 definition revision 变化时执行。
- runtime/progress Map、node sessions 和输出文档使用稳定 selector 或 `useMemo`。
- `renderNodeCard`、`onOpenNode` 等传给 React Flow 的函数使用 `useCallback`。

#### Workflow 画布

- definition 内容不变时保持对象引用稳定。
- 布局只依赖 definition revision 和 variant；运行状态变化只更新节点状态和 edge animation。
- 避免 nodes/edges 状态因无关消息变化而重新写入 React Flow。
- 画布组件使用 `memo`，并通过明确比较器忽略 transcript、history 和 conversation 更新。

#### Workflow transcript 与节点会话

- 消息行拆为 memo 组件，稳定消息不重新渲染。
- streaming 行只渲染当前文本；完成后再执行完整 Markdown/结构化输出解析。
- 工具调用和结果保留独立卡片，但只在对应事件新增或状态变化时更新。
- 长会话采用窗口化列表，并保留自动滚动与用户向上浏览时不抢滚动位置的语义。

#### Run Center

- `open === false` 时不挂载内容组件，只保留触发按钮。
- Run 列表、节点列表和消息列表使用虚拟化；展开详情时按 selectedRunId 选择数据。
- 时间线和筛选索引仅在 runs 集合实际变化时更新。
- 运行中 duration 可由局部低频时钟更新，不依赖完整 snapshot 刷新。

## 可选解决方案

### 方案 A：先隔离表单热路径

这是改动最小、最快改善体感的方案，适合先落地，但不能替代增量状态架构。

- 将任务/回复输入状态下沉到独立的 `WorkflowComposer` 叶子组件。输入值在本地立即更新，只在发送、失焦或低频同步点提交给 Workflow draft；父级通过 ref 或显式 submit payload 读取最终值。
- 对画布、transcript、outputs 和 Run Center 建立 `memo` 边界；将 validation、Map、签名和 `renderNodeCard` 依赖稳定化，确保输入字符变化不触发画布布局或历史列表 reconciliation。
- 节点 Agent 下拉框增加本地 optimistic value 和 pending/error 状态；为请求附加递增 token 或 expected revision，只接受最后一次选择的结果。失败时回滚并显示错误。
- 给画布内可交互控件添加明确的 `nopan`/`nodrag` 类或 pointer-down 隔离，并用测试确认选择控件不会触发画布平移和节点打开。
- JSON 编辑器保留轻量文本更新，将解析/校验延迟到 150–300 ms debounce、显式校验或 Web Worker；只有解析结果变化时才更新节点 Agent 列表。下拉框修改结构化 draft，避免每次都格式化整个 JSON 文本。

优点：风险低、能快速改善输入和选择反馈。缺点：后台完整快照仍会占用 CPU/IPC，长时间流式运行时仍可能出现长任务。

### 方案 B：拆分 Renderer 状态与选择器订阅

- `AutomationProvider` 只提供稳定 store/API；Workflow composer 本地状态不进入 snapshot store。
- workflow definition、active run、conversation、runtime catalog 分别通过 selector 订阅，并保持未变化实体的引用稳定。
- 将完整快照导入 normalized store 时做结构共享；即使过渡期仍接收完整 snapshot，也只通知真正变化的 selector。
- 快照带 `revision` 或 `sequence`，所有订阅推送与命令返回统一进入同一个 reducer，拒绝旧状态覆盖新状态。

优点：无需先重写主进程协议，也能显著缩小 React 更新范围，并解决状态覆盖次序问题。缺点：完整快照的构造、序列化和传输成本仍存在。

### 方案 C：实施增量 IPC

按本文目标架构新增 `AutomationChange`，首次加载或失序恢复才使用完整快照；流式 token、节点进度和选择结果只传输对应实体的增量。Renderer normalized store 统一处理命令确认和订阅事件。

优点：同时消除主进程克隆、IPC 大对象传输和 Renderer 全局失效，是长期收益最高的根治方案。缺点：需要协议版本、顺序、幂等、resync 和迁移期单写者设计，改动及验证成本最高。

### 方案 D：调度与背压缓解

- 将普通文本 UI flush 调整为 50–100 ms 或 `requestAnimationFrame` 批处理，terminal、审批、工具结果和错误仍立即 flush。
- 对非交互 snapshot 应用使用 React transition/低优先级调度；表单本地状态保持 urgent update。
- 增加 payload 大小、commit 耗时、输入事件到 paint 延迟和 long task 监控，超过阈值时降低普通 stream 刷新频率。

优点：实施快，可降低峰值争用。缺点：它只重新安排工作，没有减少完整快照与全量渲染的总成本，不应单独作为最终方案。

### 推荐组合

1. 先做方案 A，并补齐交互延迟和 render count 基线；它直接切断“每个字符重渲染整页”和“选择后无即时反馈”。
2. 同步使用方案 D 作为过渡期背压，避免流式更新持续饿死输入事件。
3. 接着做方案 B，建立 selector、结构共享和统一 sequence 仲裁。
4. 最后实施方案 C，移除高频完整快照广播。B 与 C 共用 normalized store，不是两套互斥架构。

## 实施阶段

### Phase 1：建立测量基线与低风险隔离

- 增加开发态性能计数：snapshot/change 次数、IPC payload 字节数、stream flush 次数、React commit 耗时，以及 `keydown/input -> next paint` 延迟。
- 将 Workflow composer 状态下沉到叶子组件，保证每次按键不重新校验 definition、不更新 React Flow nodes/edges。
- 为节点 Agent 下拉框增加 optimistic/pending/error 与 latest-request-wins；验证 pointer 事件不会触发画布平移。
- 将定义 JSON 的解析/校验从每次 render 中移出，并记录解析、序列化耗时。
- 让关闭的 Run Center 完全不挂载内容。
- 稳定 WorkflowPage 的 validation、Map、callbacks 和子组件 props。
- memo 化画布、消息行和静态结果区域。
- 为 Run Center 与节点消息列表接入虚拟化。

Phase 1 用于建立基线并缓解最明显卡顿，但不视为完成增量架构。

### Phase 2：增量 IPC 与 normalized store

- 定义 `AutomationChange` 共享合同和 sequence/resync 语义。
- 主进程按领域发布事件，同时保留完整快照接口。
- Preload 暴露 `onChange`，Renderer 引入 normalized store。
- 先迁移 Workflow draft streaming、active run progress 和 node conversation 三条高频路径。
- 未迁移领域继续通过低频完整快照同步，禁止同一实体同时由两条通道无序写入。

### Phase 3：移除高频完整快照广播

- Workflow 高频路径稳定后，停止 delta 触发完整 `AppSnapshot`。
- 将 Chat、Task、Team 等高频领域迁移到同一协议。
- 完整快照只用于初始化、显式 refresh、恢复和失序重同步。
- 删除过渡期兼容分支和重复选择逻辑。

## 测试策略

### 主进程与协议

- 20 个 burst delta 只生成有限次数 `replace_stream`，completed 立即 flush。
- 一个节点消息变化不得在事件 payload 中携带完整 workflow store。
- sequence 缺口触发一次 resync；重复事件不会重复追加消息或工具结果。
- tool call/result、审批和 error 不受文本节流影响。

### Renderer Store

- 更新 conversation A 后，workflow definition、conversation B 和 run history 引用保持不变。
- selector 只通知受影响订阅者。
- bootstrap、增量更新和 resync 后得到相同最终投影。
- Workflow 切换、窗口卸载和 Runtime 中断不会遗留 streaming buffer。

### 组件

- 连续输入 100 个字符时，WorkflowCanvasBoard、Run Center 和既有消息行不重新渲染；输入 DOM 在下一帧显示最新字符。
- 快速连续切换节点 Agent 时，界面立即显示最后一次选择；乱序响应不会回滚到旧选项，失败会明确回滚并提示。
- 画布内 select 的 pointer down、滚轮和键盘操作不会触发 pan、zoom 或 node open。
- 编辑大 definition JSON 时，单次按键不执行同步全量校验；延迟校验不会覆盖较新的文本版本。
- 流式更新时 WorkflowCanvasBoard 不重新布局。
- Run Center 关闭时不执行 runs 过滤和时间线计算。
- 新增一条节点消息时，既有消息行不重新渲染。
- 虚拟列表保留键盘操作、自动滚动、详情展开和工具卡片状态。

### 性能验收

仓库提供 `npm run test:workflow-performance` 作为跨平台、确定性的性能合同检查。它不使用容易受机器负载影响的绝对耗时断言，而是验证高频事件合并次数、direct patch payload 边界、sequence/resync、结构共享、关闭态不挂载以及输入/Run Center 回归。Windows 与 macOS CI 应执行同一命令。

真实交互延迟仍需在 Electron production build 中采样；记录机器信息、fixture 规模和测试时长，并按下列阈值验收，不能用上述合同测试替代真实性能测量。

以包含多个 Workflow、至少 100 次 Run、长节点会话和持续 30 秒流式输出的合成数据验证：

- 流式阶段不发送完整 `AppSnapshot`。
- 普通文本 UI flush 不高于 20 次/秒，terminal 和交互事件不延迟。
- Workflow definition 未变化时，画布布局计算次数保持不变。
- Renderer 不出现超过 50 ms 的持续性长任务；关键交互保持可响应。
- 合成压力场景下，输入事件到下一次 paint 的 p95 小于 50 ms，空闲场景 p95 小于 16 ms；节点 Agent 选择后的本地反馈在下一帧出现。
- Run Center DOM 节点数量由可视窗口决定，不随全部历史消息线性增长。
- 增量模式与完整快照重同步后的用户可见状态完全一致。

## 风险与控制

- **事件失序或丢失**：使用 sequence 检测并回退到完整快照。
- **双通道竞争**：迁移期间明确每个实体的唯一写入通道，完整快照只能作为原子替换或 resync。
- **流式文本丢失**：terminal、interrupt 和 unload 路径统一 flush accumulator。
- **引用稳定导致旧数据**：selector 测试覆盖每个实体更新边界，不使用手写不完整的 React props 比较掩盖状态变化。
- **虚拟化破坏滚动体验**：测试用户主动上滚、自动跟随、动态高度和展开工具结果。
- **调试复杂度增加**：开发态保留 sequence、domain、entityId 和 operation 日志，但不得记录敏感消息正文。

## 完成定义

## 本分支实施状态（2026-07-25）

本分支已完成方案 C 的第一阶段落地，但尚未宣称达到上面的最终完成定义：

- 已新增 `AutomationChange` 增量合同、sequence/失序重同步语义，以及 Preload 的 `onChange` 通道。
- Workflow 高频事件不再构造或发送完整 `AppSnapshot`；草稿、节点会话和 Workflow task 流都直接发布对应实体 patch，并在 32 ms 窗口内按实体 ID 合并为最新版本。低频复合变化仍通过作用域 projection 生成 upsert/remove patch，Renderer 统一由 `AutomationStore` 应用。
- Workflow 页面已切换到外部 store；非 Workflow 页面仍保留完整快照兼容路径。
- Composer 文本改为组件本地状态，逐字输入不再触发 Workflow draft IPC 或父级页面状态更新。
- 节点 Agent 下拉框增加本地乐观值、latest-request-wins 和失败回滚，并阻止 React Flow 的 pan/zoom 事件。
- definition JSON 编辑器使用延迟副本解析，输入的紧急渲染不再与同步解析绑定；延迟解析期间禁用结构化 Agent 选择，避免旧解析结果覆盖新文本。
- 消息流更新但 revision 未变化时，Renderer 保留原 definition 引用；画布布局改为一次计算并复用给 nodes/edges，run progress 更新不再重复执行 DAG 布局。
- Workflow 历史消息保留未变化 message 的对象引用，并使用 memo 行组件，流式更新不再重复解析既有 Markdown；视口外 transcript、节点消息和 Run Center 行使用 `content-visibility` 跳过布局绘制。
- Run Center 关闭时不挂载内部计算组件；详情页按当前 Run 一次建立 progress、event、conversation、artifact 索引，避免逐节点重复扫描和排序。
- 已提供 Windows/macOS 共用的确定性性能合同命令；仍待接入两端 CI 并采集 Electron production build 的真实性能基线。超大动态高度列表当前使用 `content-visibility` 降低视口外成本，若压力 fixture 仍超过长任务阈值，再引入完整窗口化。

只有同时满足以下条件，才能认为 Workflow 前端完成增量渲染改造：

- 高频 Workflow delta 不再生成或传输完整 `AppSnapshot`。
- Renderer 使用实体级结构共享和选择器订阅，而不是全局 snapshot Context 更新。
- Workflow 画布、Run Center 和历史消息具有独立稳定的渲染边界。
- 长历史列表已虚拟化，工具调用和结果仍完整可见。
- 失序恢复、终止 flush、审批即时性和最终状态一致性均有自动化测试。
- 性能基线和验收场景能够在 Windows 与 macOS 路径下重复执行。
