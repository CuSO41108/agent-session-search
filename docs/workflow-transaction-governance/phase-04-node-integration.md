# 阶段四：Agent 与脚本节点接入

## 目标

让 Agent 和脚本节点共用事务协调器，避免“进程成功就节点成功”“输出存在就可以提交”和“重试重复执行”这三类误判。

## Agent 节点

### 完成判定

Agent 完成声明不是权威。协调器必须综合：

- 完整工具调用与结果历史；
- `requiredTools` 是否调用并成功；
- 节点结构化输出和字段 Schema；
- 隔离工作区实际 diff；
- 外部操作 receipt；
- Reviewer 结论；
- 是否存在 `unknown` 或计划外副作用。

必需工具失败、缺失或状态未知时，节点不能 `clean completed`。按节点策略进入重试、人工确认或失败。

### 重试与继续

- 重试：恢复节点 attempt 开始前的保存点，再启动新 attempt；
- 继续：保留现场，向 Agent 注入已完成操作和当前 diff，禁止重复成功操作；
- 外部状态未知时不得自动选择任一项。

### 产物提交顺序

Agent 输出必须先解析、校验、Review，再提交文件产物。历史消息只用于审计，不能替代权威 completion submission 或实际 diff。

## 脚本节点

脚本定义必须增加或补齐：

```ts
effectMode: "pure" | "workspace_only" | "brokered_external";
idempotency: "safe_retry" | "keyed" | "non_idempotent";
stderrPolicy: "ignore" | "warn" | "fail";
compensationAdapter?: string;
```

- `pure`：无外部副作用，可自动重试；
- `workspace_only`：只能写隔离工作区；
- `brokered_external`：所有外部写入必须通过代理；
- 无法声明或约束副作用的任意 Shell 操作不能在 `strict_atomic` 执行。

脚本执行 receipt 至少记录退出码、signal、超时、stderr 摘要、stdout digest、operationDigest 和 effectState。

### 脚本输出

输出 Schema 必须检查类型、空值、数组元素和必填项；校验失败时保留诊断输出，但不提交最终产物。

退出码正确但 stderr 非空时，按 `stderrPolicy` 处理：默认建议 `warn`，不得把警告隐藏成纯成功。

### 副作用未知

超时、进程树未完全结束、外部请求无响应或本地 receipt 缺失时，脚本节点进入 `effect_unknown`，不得因 `onError=retry` 自动重跑非幂等操作。

## 节点验收输出

节点完成事件应携带：

```ts
{
  outcome: "clean" | "degraded" | "rejected",
  issues: Array<{ code: string; severity: "warning" | "error"; detail: string }>;
  changedPaths: string[];
  operationIds: string[];
}
```

## 验收

- Agent 工具失败不会被最终文本掩盖；
- required tool 失败不能形成绿节点；
- 脚本 exit 0 + stderr 按合同呈现；
- 输出 Schema 不合格不会提前物化产物；
- 节点重试/继续语义与保存点一致；
- Agent 与脚本生成同一种事务报告。
