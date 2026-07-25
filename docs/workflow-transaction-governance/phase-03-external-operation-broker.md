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
- 远端返回 2xx 但本地 receipt 写入失败时，恢复器优先查询幂等键；
- 查询结果为 `unknown` 时暂停并生成报告。

## 消息适配器

消息在节点执行期间只生成草稿：渠道、接收者、标题、正文、附件和发送时间都必须绑定到确认请求。确认后任何字段变化都要求重新确认。

发送时记录 provider message ID。不可撤回消息标记 `irreversible`；失败后只能生成更正消息建议，不能声称已回滚。

## 补偿顺序

补偿按成功操作的逆序执行；同一操作的补偿必须幂等。补偿失败后停止自动补偿，状态进入 `partially_rolled_back` 或 `recovery_required`。

## 验收

- apply 前必有持久化 planned；
- 崩溃注入能从 applying 恢复到正确 inspect 分支；
- 同一幂等键不会造成重复远端操作；
- 消息内容变更能使原确认失效；
- 补偿逆序、失败停止和报告内容可审计。

