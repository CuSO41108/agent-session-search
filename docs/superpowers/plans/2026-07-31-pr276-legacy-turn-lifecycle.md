# PR #276 Legacy Turn Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复旧版 Codex 日志的 Turn 生命周期与 Token 归属，并让远程快照准确保留 running Turn。

**Architecture:** V1/V2 加载器为缺少原生 `turn_id` 的 Turn 分配会话内稳定 ID，继续复用现有回滚与增量索引机制。V2 展示层不覆盖明确终态；远程摘要按 Turn 状态输出 started、completed 或 aborted 生命周期。

**Tech Stack:** TypeScript、Vitest、React SSR 测试、SQLite V1、PostgreSQL V2、Electron。

## Global Constraints

- Session 行为必须检查 V1 与 V2；共同适用的加载逻辑必须成对实现和测试。
- 不修改远程快照 schema，不增加依赖或用户设置。
- Session 总 Token 保留原始累计值；回滚 Token 不得进入任何可见 Turn。
- 只更新现有 `.release-notes/codex-custom-tool-traces.md`，不得新增第二个 release note。
- `docs/superpowers/` 和临时复现测试不得进入最终推送。
- 测试不得访问真实用户 Session、Skills、Supabase 或 Electron 数据。

---

## File map

- `apps/main-1.0/src/core/session-loaders/codex-rollout.ts`: 生成、恢复旧协议内部 Turn ID。
- `apps/main-1.0/src/core/session-loader.ts`: 增量扫描时向 accumulator 提供已有 Turn ID。
- `apps/main-1.0/src/core/session-loader.test.ts`: V1 全量、文件与增量回滚覆盖。
- `apps/main-2.0/src/core/session-loaders/codex-rollout.ts`: V2 同语义实现。
- `apps/main-2.0/src/core/session-loader.ts`: V2 增量 ID 恢复。
- `apps/main-2.0/src/core/session-loader.test.ts`: V2 加载器回归。
- `apps/main-2.0/src/core/turns/derive-turns.test.ts`: 旧协议回滚后的可见 Turn 与 Token 统计。
- `apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.tsx`: 详情页状态选择。
- `apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.test.ts`: 明确终态不被 live 覆盖。
- `apps/main-2.0/src/core/remote-session-sync.ts`: 远程生命周期摘要与隐藏 started 事件保留。
- `apps/main-2.0/src/core/remote-session-sync.test.ts`: running 快照及重新派生覆盖。

### Task 1: V1 旧协议 Turn 归属

**Files:**
- Modify: `apps/main-1.0/src/core/session-loader.test.ts:260-360`
- Modify: `apps/main-1.0/src/core/session-loaders/codex-rollout.ts:809-1008`
- Modify: `apps/main-1.0/src/core/session-loader.ts:1489-1692`

**Interfaces:**
- Consumes: `CodexIncrementalState.historyMode`、`activeTurnIds`，以及已有消息、轨迹和 Token 的 `sourceTurnId`。
- Produces: `new CodexRolloutAccumulator(state?: Pick<CodexIncrementalState, "historyMode" | "activeTurnIds"> & { sourceTurnIds?: Iterable<string | null | undefined> })`；无原生 ID 的 Turn 使用 `agent-recall:legacy-turn:<n>`。

- [ ] **Step 1: 写入 V1 失败测试**

在现有生命周期回滚测试旁新增旧协议用例。fixture 分三次写入：保留 Turn、回滚 Turn、回滚后的新 Turn；所有生命周期事件都不含 `turn_id`。核心断言：

```ts
const keptTurnId = loaded?.messages.find((message) => message.content === "保留的问题")?.sourceTurnId;
const replacementTurnId = loaded?.messages.find((message) => message.content === "新的问题")?.sourceTurnId;
expect(keptTurnId).toBe("agent-recall:legacy-turn:1");
expect(replacementTurnId).toBe("agent-recall:legacy-turn:3");
expect(loaded?.traceEvents.filter((event) => event.sourceTurnId === keptTurnId)).toMatchObject([
  { eventType: "codex.turn.started" },
  { eventType: "codex.turn.completed" },
]);
expect(loaded?.tokenEvents?.map((event) => event.sourceTurnId)).toEqual([
  "agent-recall:legacy-turn:1",
  "agent-recall:legacy-turn:2",
]);
expect(loaded?.session.tokenUsage?.totalTokens).toBe(33);
```

同一组断言应用于 `loadCodexSessionRows`、`loadCodexSessionFile` 和两阶段 `loadCodexSessionsIterator` 增量结果。

- [ ] **Step 2: 运行 V1 测试并确认 RED**

Run: `cd apps/main-1.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts -t "assigns internal Turn ownership to legacy Codex rollouts"`

Expected: FAIL，旧实现返回 `sourceTurnId: null`，回滚后的新 Turn 也没有稳定 ID。

- [ ] **Step 3: 实现 V1 内部 Turn ID**

在 accumulator 中加入以下状态和生成逻辑：

```ts
const LEGACY_TURN_ID_PREFIX = "agent-recall:legacy-turn:";

private nextLegacyTurnSequence = 1;

private rememberSourceTurnId(value: string | null | undefined): void {
  if (!value?.startsWith(LEGACY_TURN_ID_PREFIX)) return;
  const sequence = Number(value.slice(LEGACY_TURN_ID_PREFIX.length));
  if (Number.isSafeInteger(sequence) && sequence >= this.nextLegacyTurnSequence) {
    this.nextLegacyTurnSequence = sequence + 1;
  }
}

private createLegacyTurnId(): string {
  return `${LEGACY_TURN_ID_PREFIX}${this.nextLegacyTurnSequence++}`;
}
```

构造时扫描 `activeTurnIds` 与 `sourceTurnIds`。处理 `task_started` 时使用：

```ts
const sourceTurnId = stringValue(payload.turn_id) || this.createLegacyTurnId();
this.activeTurnIds.add(sourceTurnId);
```

增量 accumulator 的 `sourceTurnIds` 必须包含 base 中的消息、轨迹和 Token ID，以保证已回滚但仍保留 Token 的序号不会被重用。

- [ ] **Step 4: 运行 V1 定向测试并确认 GREEN**

Run: `cd apps/main-1.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts`

Expected: 文件通过，旧协议全量与增量断言一致。

- [ ] **Step 5: 提交 V1 纵向切片**

```bash
git add apps/main-1.0/src/core/session-loader.test.ts apps/main-1.0/src/core/session-loader.ts apps/main-1.0/src/core/session-loaders/codex-rollout.ts
git commit -m "fix: preserve legacy Codex turn ownership"
```

### Task 2: V2 旧协议 Turn 与 Token 派生

**Files:**
- Modify: `apps/main-2.0/src/core/session-loader.test.ts:260-360`
- Modify: `apps/main-2.0/src/core/session-loaders/codex-rollout.ts:809-1008`
- Modify: `apps/main-2.0/src/core/session-loader.ts:1089-1286`
- Modify: `apps/main-2.0/src/core/turns/derive-turns.test.ts:234-330`

**Interfaces:**
- Consumes: Task 1 定义的 `agent-recall:legacy-turn:<n>` 语义。
- Produces: V2 加载器与 V1 相同的内部 ID；`deriveSessionTimeline` 只把 Token 归给仍存在的 source Turn。

- [ ] **Step 1: 将历史回滚复现迁入正式 V2 测试**

使用旧协议 fixture 调用 `loadCodexSessionRows` 和 `deriveSessionTimeline`：

```ts
expect(loaded.session.tokenUsage?.totalTokens).toBe(33);
expect(timeline.turns).toHaveLength(1);
expect(timeline.turns[0]).toMatchObject({
  sourceTurnId: "agent-recall:legacy-turn:1",
  status: "completed",
  totalTokens: 11,
  synthetic: false,
});
```

在 `session-loader.test.ts` 复制 Task 1 的全量、文件和两阶段增量断言，路径改为 V2。

- [ ] **Step 2: 运行 V2 测试并确认 RED**

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts src/core/turns/derive-turns.test.ts -t "legacy Codex"`

Expected: FAIL，出现两个 Turn，保留 Turn 的 `totalTokens` 为 33。

- [ ] **Step 3: 按 Task 1 语义实现 V2**

将 accumulator 的内部 ID 状态、`task_started` 分支和 base `sourceTurnIds` 恢复逻辑同步到 V2；不得直接复制 V1 的存储调用，V2 保持现有异步 PostgreSQL 路径。

- [ ] **Step 4: 运行 V2 定向测试并确认 GREEN**

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts src/core/turns/derive-turns.test.ts`

Expected: 两个文件全部通过；旧协议只派生一个可见 Turn，Turn Token 为 11。

- [ ] **Step 5: 提交 V2 纵向切片**

```bash
git add apps/main-2.0/src/core/session-loader.test.ts apps/main-2.0/src/core/session-loader.ts apps/main-2.0/src/core/session-loaders/codex-rollout.ts apps/main-2.0/src/core/turns/derive-turns.test.ts
git commit -m "fix: derive legacy Codex turns by lifecycle"
```

### Task 3: 详情页终态优先级

**Files:**
- Modify: `apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.test.ts:174-222`
- Modify: `apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.tsx:470-475`

**Interfaces:**
- Consumes: `SessionTurnSummary.status` 与 Session `live`。
- Produces: `displayStatus` 仅为原始 running Turn 使用 live/closed 回退。

- [ ] **Step 1: 修正测试期望并确认 RED**

```ts
const legacyCompletedLive = renderStatus("completed", true, null);
expect(legacyCompletedLive).toContain('class="turn-status completed">已完成');
expect(legacyCompletedLive).not.toContain('class="turn-status running"');
```

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/renderer/src/features/session-detail/turn-accordion.test.ts -t "uses Session live state"`

Expected: FAIL，旧实现输出 running。

- [ ] **Step 2: 最小化状态选择逻辑**

```ts
const displayStatus: SessionTurnSummary["status"] = turn.status === "running"
  ? live ? "running" : "completed"
  : turn.status;
```

- [ ] **Step 3: 运行详情页测试并确认 GREEN**

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/renderer/src/features/session-detail/turn-accordion.test.ts`

Expected: 文件通过；completed 与 aborted 保持终态，running 仍随 live/closed 变化。

- [ ] **Step 4: 提交详情页修复**

```bash
git add apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.test.ts apps/main-2.0/src/renderer/src/features/session-detail/turn-accordion.tsx
git commit -m "fix: keep explicit Codex turn terminal states"
```

### Task 4: 远程 running 生命周期

**Files:**
- Modify: `apps/main-2.0/src/core/remote-session-sync.test.ts:161-225`
- Modify: `apps/main-2.0/src/core/remote-session-sync.ts:283-345`

**Interfaces:**
- Consumes: `SessionTurnSummary.status`、已有 trace 的 lifecycle visibility。
- Produces: running 摘要为 `codex.turn.started`；快照保留没有终止事件的 started，但搜索文本忽略 hidden trace。

- [ ] **Step 1: 写入 running 快照失败测试**

```ts
expect(built.detail.traceEvents).toContainEqual(expect.objectContaining({
  eventType: "codex.turn.started",
  status: "running",
  sourceTurnId: "turn-running",
}));
expect(built.detail.traceEvents).not.toContainEqual(expect.objectContaining({
  eventType: "codex.turn.completed",
  sourceTurnId: "turn-running",
}));
expect(deriveSessionTimeline({
  sessionKey: session.sessionKey,
  messages: built.detail.messages,
  traceEvents: built.detail.traceEvents,
}).turns[0].status).toBe("running");
expect(built.payload.search_text).not.toContain("Turn started");
```

- [ ] **Step 2: 运行远程测试并确认 RED**

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/core/remote-session-sync.test.ts -t "preserves a running Codex Turn"`

Expected: FAIL，快照包含 `codex.turn.completed`，重新派生为 completed。

- [ ] **Step 3: 生成与状态一致的生命周期摘要**

`remoteTurnSummaryTraceEvents` 分别处理 running、aborted、failed/completed。running 只写 `startedAt`，不得写 `endedAt` 或 `durationMs`。`buildRemoteSessionSnapshot` 先收集终止事件 ID，再保留没有终止事件的 `codex.turn.started`；`remoteSessionSearchText` 过滤 visibility 为 hidden 的 trace。

- [ ] **Step 4: 运行远程回归并确认 GREEN**

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/core/remote-session-sync.test.ts src/core/remote-session-loader.test.ts src/core/turns/derive-turns.test.ts`

Expected: running、completed、failed、aborted 摘要和旧快照解析全部通过。

- [ ] **Step 5: 提交远程生命周期修复**

```bash
git add apps/main-2.0/src/core/remote-session-sync.test.ts apps/main-2.0/src/core/remote-session-sync.ts
git commit -m "fix: preserve running turns in remote snapshots"
```

### Task 5: 清理、release note 与完整验证

**Files:**
- Review: `.release-notes/codex-custom-tool-traces.md`
- Delete: `apps/main-2.0/src/core/pr276-rereview.test.ts`
- Delete: `apps/main-2.0/src/renderer/src/features/session-detail/pr276-rereview.test.ts`
- Delete before push: `docs/superpowers/specs/2026-07-31-pr276-legacy-turn-lifecycle-design.md`
- Delete before push: `docs/superpowers/plans/2026-07-31-pr276-legacy-turn-lifecycle.md`

**Interfaces:**
- Consumes: Tasks 1-4 的全部行为。
- Produces: 可直接推送到 `fix/codex-custom-tool-traces` 的净差异。

- [ ] **Step 1: 删除临时测试与设计文件**

使用 `apply_patch` 删除两个 `pr276-rereview.test.ts` 和两份 `docs/superpowers` 文档。确认正式测试已覆盖其中三个失败场景。

- [ ] **Step 2: 核对 release note**

现有第三条已经描述用户结果：

```markdown
- Codex 已撤销的请求不会再显示成没有文本的“前置轨迹”，其 token 用量也不会错误计入其他轮次。
```

若实现结果与该句一致则不机械改写；确认分支仍只有一个 release note。

- [ ] **Step 3: 运行双版本定向测试**

Run: `cd apps/main-1.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts src/core/indexer.test.ts src/core/remote-session-loader.test.ts src/core/remote-session-sync.test.ts src/core/trace-presentation.test.ts src/core/store/schema.test.ts src/core/store/sessions.test.ts`

Run: `cd apps/main-2.0 && ./node_modules/.bin/vitest run src/core/session-loader.test.ts src/core/indexer.test.ts src/core/turns/derive-turns.test.ts src/core/remote-session-loader.test.ts src/core/remote-session-sync.test.ts src/core/trace-presentation.test.ts src/renderer/src/features/session-detail/turn-accordion.test.ts src/main/services/remote-session-access.test.ts src/core/postgres/schema.test.ts src/core/postgres/session-repository.test.ts`

Expected: 两条命令退出码均为 0，无失败测试。

- [ ] **Step 4: 运行两套完整验证**

Run: `npm --prefix apps/main-1.0 test`

Run: `npm --prefix apps/main-2.0 test`

Run: `npm --prefix apps/main-1.0 run typecheck`

Run: `npm --prefix apps/main-2.0 run typecheck`

Run: `npm run release-note:check`

Run: `git diff --check 0bf3c4fad76c9c74450f827e4c817e1fb992a998...HEAD`

Expected: 全部退出码为 0；release-note 检查报告一个文件且仅含 Bug 修复。

- [ ] **Step 5: 整理提交并核对最终差异**

确保最终 diff 只包含正式实现、正式测试和现有 release note；不得包含 `docs/superpowers` 或临时复现测试。运行：

```bash
git status --short
git diff --stat 0bf3c4fad76c9c74450f827e4c817e1fb992a998...HEAD
git log --oneline 0bf3c4fad76c9c74450f827e4c817e1fb992a998..HEAD
```

- [ ] **Step 6: 推送原 PR 分支并检查 CI**

Run: `git push origin HEAD:fix/codex-custom-tool-traces`

Run: `gh pr view 276 --repo zszz3/AgentRecall --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url`

Expected: PR head 更新为本地提交；CI 启动后持续检查，直到 release-note、Ubuntu、macOS、Windows 全部完成或出现可定位失败。
