# PR #276 旧版 Codex Turn 生命周期修复设计

## 背景

PR #276 已按原生 `turn_id` 关联 Codex 生命周期、消息和 Token，但旧版 Codex 的 `task_started`、`task_complete` 与 `turn_aborted` 没有该字段。旧日志经过回滚后，V2 仍可能生成 running synthetic Preamble，把已回滚 Turn 的 Token 计入保留 Turn；详情页也会用 Session live 状态覆盖无原生 ID 的明确终态。

远程同步还有一处独立错误：running Turn 会被快照转换为 `codex.turn.completed`，远端重新加载后得到 completed 状态。

## 范围

本次修复覆盖：

- V1/V2 的 Codex 全量加载与增量索引；
- V2 Turn 派生和详情页状态展示；
- V2 远程详情快照中的 Turn 生命周期；
- PR #276 现有 release note。

不修改远程快照 schema，不增加用户设置，也不改 Claude、Pi、Hermes 等其他来源。

## 方案

### 旧日志 Turn 归属

`CodexRolloutAccumulator` 在 `task_started` 缺少原生 ID 时生成形如 `agent-recall:legacy-turn:<n>` 的内部 Turn ID。ID 使用会话内单调序号；增量扫描从已有消息、轨迹和 Token 事件恢复下一个序号，避免回滚后重用 ID。此后的消息、Token、`task_complete` 和 `turn_aborted` 沿用当前唯一活动 ID。

现有回滚逻辑据此删除已回滚 Turn 的消息和轨迹。Session 总 Token 仍保留；已回滚 Token 带有已经不存在的 Turn ID，V2 派生时会跳过其 Turn 级归属，因此不会污染保留 Turn 或生成空白 Turn。

V1/V2 采用相同语义，但沿用各自的同步、异步存储接口。

### 详情页状态

详情页只在 Turn 状态为 `running` 时参考 Session live 状态：live 显示 running，closed 回退为 completed。completed、failed 和 aborted 都保持生命周期给出的状态，不再根据是否为最后一个 Turn 或是否缺少原生 ID 改写。

### 远程快照

远程摘要按 Turn 状态生成对应生命周期：

- running 生成 `codex.turn.started`；
- completed 与 failed 生成 `codex.turn.completed`；
- aborted 生成 `codex.turn.aborted`。

快照继续过滤普通隐藏轨迹，但会保留没有终止事件的 started 生命周期，供远端重建 running 状态。该事件仍由展示层隐藏，也不写入远程搜索文本。已有终止事件时不重复生成摘要。

## 测试

按 TDD 逐项增加以下行为测试：

1. V1/V2 加载旧协议日志时，生命周期、消息和 Token 获得同一个内部 Turn ID。
2. V1/V2 全量与增量回滚保留 Session 总 Token，但不把已回滚 Token 归到保留 Turn。
3. V2 旧协议回滚后只有一个可见 Turn，Token 为保留 Turn 的 11，而不是 Session 总量 33。
4. V2 Session live 时，completed、failed、aborted 不被改成 running；真正的 running Turn 仍随 live/closed 状态展示。
5. V2 running Turn 的远程快照包含 started，不包含 completed；重新派生后仍为 running。
6. 现有 completed、failed、aborted 远程摘要行为保持不变。

验证范围包括相关 V1/V2 Vitest、两套 typecheck、release-note 检查、`git diff --check` 和 GitHub CI。

## 交付

修复提交直接推送到 PR #276 的 `fix/codex-custom-tool-traces`。本设计文档只用于实施过程，推送前从分支中移除。
