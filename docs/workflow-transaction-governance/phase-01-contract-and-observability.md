# 阶段一：事务合同与观测底座

## 目标

先建立类型、持久化和事件合同，不改变现有节点的实际执行策略。该阶段完成后，系统能够记录一次 Run 的事务身份、执行模式、保存点、操作账本和恢复状态，为后续隔离执行提供稳定载体。

## 需求

### 1. Workflow 合同

在 Workflow 定义增加事务配置：

```ts
interface WorkflowTransactionPolicy {
  defaultMode: "strict_atomic" | "controlled" | "direct";
  approvalMode: "batch" | "per_operation" | "user_choice";
  checkpoints: Array<{
    id: string;
    title: string;
    afterNodeIds: string[];
    kind: "savepoint" | "commit";
    approval: "automatic" | "required";
  }>;
  retentionDays: number;
  onUnknown: "pause";
  onConflict: "user_or_manager";
}
```

完整能力发布后，新建 Coding Workflow 默认 `strict_atomic`；旧定义读取时映射为 `direct` 并产生兼容警告。按照阶段六的灰度顺序，在工作区隔离、外部操作代理和恢复审批尚未就绪时，新建 Workflow 暂时显式使用 `direct`；用户主动配置 `strict_atomic` 或 `controlled` 时必须在运行前失败关闭，不能降级为直接执行。只有阶段六灰度第 7 步完成后才切换新建默认值。

### 2. Run 事务状态

Run 持久化结构增加：

```ts
interface WorkflowTransactionState {
  transactionId: string;
  mode: "strict_atomic" | "controlled" | "direct";
  status: WorkflowTransactionStatus;
  baselineId: string;
  currentSavepointId?: string;
  currentSavepointOperationIds?: string[];
  operationCount: number;
  unknownOperationCount: number;
  irreversibleOperationCount: number;
  startedAt: number;
  updatedAt: number;
  retentionUntil: number;
}
```

### 3. 操作账本

新增统一操作记录：

```ts
interface WorkflowOperationRecord {
  operationId: string;
  transactionId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  kind: "file" | "http" | "message" | "git" | "database" | "other";
  target: string;
  idempotencyKey: string;
  state: "planned" | "applying" | "applied" | "compensating" | "compensated" | "unknown";
  reversible: boolean;
  compensationAdapter?: string;
  requestSummary?: unknown;
  receipt?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

请求体、Header 和输出必须经过脱敏；账本不保存凭据原文。

### 4. 事件

新增持久化事件：

```text
transaction_started
baseline_frozen
preflight_passed / preflight_blocked
operation_planned
operation_started
operation_applied
operation_unknown
savepoint_created
commit_started / commit_completed
compensation_started / compensation_completed
recovery_required
conflict_detected
```

事件必须有 `transactionId`、`runId`、`nodeId`、`operationId`（适用时）、sequence 和时间。

## 不变量

- 事务事件按 sequence 单调追加，不通过修改历史事件“纠正”事实；
- 账本状态只能沿合法状态转移前进，恢复动作产生新事件；
- `unknown` 不得自动转成 `applied` 或 `compensated`；
- `direct` 模式仍记录账本，但不伪造可回滚能力；
- 所有新字段必须支持旧 Run 兼容读取。

## 验收

- 新旧 Workflow 均可读取；
- 重启后能恢复事务状态和账本；
- 敏感信息脱敏测试通过；
- 事件重复写入不会制造第二个操作；
- 操作状态非法跳转会被拒绝并形成结构化错误。
