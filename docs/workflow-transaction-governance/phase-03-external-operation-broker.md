# 阶段三：外部操作代理与补偿

## 目标

为 HTTP API、消息发送和后续 Git/数据库/部署适配器建立统一的 `prepare/apply/inspect/compensate` 合同，使用 WAL 和幂等键处理崩溃与重复执行。

## 统一合同

```ts
interface TransactionalOperationAdapter<TPlan, TReceipt> {
  prepare(input: { transactionId: string; runId: string; nodeId: string; plan: TPlan }): Promise<PreparedOperation<TPlan>>;
  apply(input: { prepared: PreparedOperation<TPlan>; signal: AbortSignal }): Promise<TReceipt>;
  inspect(input: { prepared: PreparedOperation<TPlan>; receipt?: TReceipt }): Promise<"applied" | "not_applied" | "unknown">;
  compensate(input: { prepared: PreparedOperation<TPlan>; receipt: TReceipt; signal: AbortSignal }): Promise<void>;
}
```

### WAL 顺序

```text
persist planned
→ persist applying
→ execute apply
→ persist receipt/applied
```

崩溃发生在 `applying` 时，恢复器必须先 `inspect`；无可靠查询时标记 `unknown`，不得重试。

### 幂等

幂等键由 `transactionId + nodeId + attempt + operation semantic identity` 生成。适配器必须把幂等键传给远端（若协议支持），并在本地拒绝同一键的第二次 apply。

## HTTP API

- GET/HEAD 等只读请求可以直接执行并记录摘要；
- 写请求必须有状态查询和补偿接口才能进入 `strict_atomic`；
- 没有补偿能力的写请求只能进入 `controlled`，执行前明确确认；
- 请求 Header、Token 和敏感字段脱敏；
- `strict_atomic` 不持久化嵌入式凭据；宿主尚未提供 durable credential reference 时，含 Authorization、Token、Cookie 或其他会被脱敏字段的严格 HTTP 计划在 `prepare` 阶段失败关闭；
- 远端返回 2xx 但本地 receipt 写入失败时，恢复器优先查询幂等键；
- 查询结果为 `unknown` 时暂停并生成报告。

## 消息适配器

消息在节点执行期间只生成草稿：渠道、接收者、标题、正文、附件和发送时间都必须绑定到确认请求。确认后任何字段变化都要求重新确认。

发送时记录 provider message ID。不可撤回消息标记 `irreversible`；失败后只能生成更正消息建议，不能声称已回滚。

消息适配器是宿主能力边界，不内置真实邮件或聊天服务。宿主必须注入 `WorkflowMessageProvider` 的 `send/inspect`；`controlled` 可在明确确认后发送不可撤回消息，`strict_atomic` 只接受同时提供 `retract` 的 Provider。缺少对应能力时，运行时的严格能力清单不包含 `message`，节点发放前失败关闭。

## 补偿顺序

补偿按成功操作的逆序执行；同一操作的补偿必须幂等。补偿失败后停止自动补偿，状态进入 `partially_rolled_back` 或 `recovery_required`。

## 提交协调协议

事务协调器不能把文件和外部系统包装成一个虚假的原子事务。最终收口必须保存一份不可变 `commitPlan`，其中列出顺序、前置条件、补偿动作和用户确认凭据：

```text
prepare 全部操作
→ persist commitPlan
→ apply 可查询/可补偿外部操作
→ apply 隔离工作区 diff
→ apply 已确认的不可撤销操作
→ persist committed
```

如果文件应用失败，保留隔离区并补偿已经成功的外部操作；如果不可撤销操作已经执行，事务不得回写为 `rolled_back`，只能进入 `partially_rolled_back` 并生成未恢复项。任何步骤崩溃都从 `commitPlan` 和 operation ledger 恢复，不重新猜测执行顺序。

## 验收

- apply 前必有持久化 planned；
- 崩溃注入能从 applying 恢复到正确 inspect 分支；
- 同一幂等键不会造成重复远端操作；
- 消息内容变更能使原确认失效；
- 补偿逆序、失败停止和报告内容可审计。
