# Turn-scoped Session Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users right-click a visible Session turn and migrate the conversation prefix through that turn, with a configurable complete-migration threshold and bounded parallel compression for longer prefixes.

**Architecture:** The renderer sends a structured migration request containing an optional stable `throughTurnId`. The main process resolves and validates that turn against the indexed Session, removes later messages before migration, and carries indexed turn boundaries into the portable Session. The existing migration compressor becomes token/turn-aware: complete below the configured threshold; otherwise summarize the early 60% in at most four independent parallel fragments, merge once, and preserve the recent 40% as complete turns.

**Tech Stack:** TypeScript, Electron IPC, React, Vitest, existing SessionStore and migration writer/summarizer modules.

---

## File map

- `src/core/platform.ts`: persist and normalize `migrationCompleteTokenLimit`.
- `src/core/platform.test.ts`: settings default, valid values, invalid values, and clamps.
- `src/core/types.ts`: structured migration request and optional portable turn boundaries.
- `src/core/session-migration.ts`: use the configured complete threshold for strategy/progress selection.
- `src/core/session-migration-compression.ts`: select the recent 40% by complete turns, create one to four early fragments, merge once, and remove silent local truncation.
- `src/core/session-migration-compression.test.ts`: observable complete/AI/error behavior, 40% preservation, whole-turn boundaries, fragment count, concurrency, and progress.
- `src/main/local-session-migration.ts`: load and validate an optional turn-scoped source prefix; pass threshold and turn boundaries through the local runtime.
- `src/main/local-session-migration.test.ts`: reject invalid/synthetic/cross-session turns and prove later messages are removed before preparation.
- `src/main/index.ts`: register the structured IPC request and use the validated local migration source.
- `src/preload/index.ts`: expose the structured migration request.
- `src/renderer/src/app-types.ts`: retain optional turn metadata in migration dialog state.
- `src/renderer/src/features/session-detail/turn-accordion.tsx`: right-click menu for non-synthetic turns.
- `src/renderer/src/features/session-detail/turn-accordion.test.ts`: menu copy and eligible/ineligible turn rendering.
- `src/renderer/src/features/session-detail/detail-panel.tsx`: forward turn migration callbacks.
- `src/renderer/src/features/sessions/session-details.tsx`: bind turn migration to the selected local Session.
- `src/renderer/src/App.tsx`: open the existing migration dialog with optional cutoff and send the structured request.
- `src/renderer/src/components/session-migration-dialog.tsx`: display the inclusive cutoff note.
- `src/renderer/src/session-migration-ui.test.ts`: cutoff copy.
- `src/renderer/src/features/settings/settings-dialog.tsx`: editable complete-migration threshold in K Token.
- `.release-notes/feat-workflow-run-center-v1.md`: user-facing release note for per-turn migration and configurable long-session behavior.

### Task 1: Configurable complete-migration threshold

**Files:**
- Modify: `src/core/platform.ts`
- Modify: `src/core/platform.test.ts`
- Modify: `src/renderer/src/features/settings/settings-dialog.tsx`

- [ ] **Step 1: Write failing settings tests**

Add assertions equivalent to:

```ts
expect(defaultSettings.migrationCompleteTokenLimit).toBe(100_000);
expect(mergeAppSettings(defaultSettings, {
  migrationCompleteTokenLimit: 240_000,
}).migrationCompleteTokenLimit).toBe(240_000);
expect(mergeAppSettings(defaultSettings, {
  migrationCompleteTokenLimit: Number.NaN,
}).migrationCompleteTokenLimit).toBe(100_000);
expect(mergeAppSettings(defaultSettings, {
  migrationCompleteTokenLimit: 1,
}).migrationCompleteTokenLimit).toBe(10_000);
expect(mergeAppSettings(defaultSettings, {
  migrationCompleteTokenLimit: 2_000_000,
}).migrationCompleteTokenLimit).toBe(1_000_000);
```

- [ ] **Step 2: Run the focused test and observe the failure**

Run:

```bash
npx vitest run src/core/platform.test.ts
```

Expected: FAIL because `migrationCompleteTokenLimit` is not defined.

- [ ] **Step 3: Add and normalize the setting**

Add the field to `AppSettings`, default it to `100_000`, and normalize it in `mergeAppSettings`:

```ts
function normalizeMigrationCompleteTokenLimit(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.migrationCompleteTokenLimit;
  return Math.max(10_000, Math.min(1_000_000, Math.round(value)));
}
```

Add a K Token number field next to migration compression concurrency. The input displays `settings.migrationCompleteTokenLimit / 1_000` and saves `Number(value) * 1_000`, with `min={10}`, `max={1000}`, and `step={10}`.

- [ ] **Step 4: Run the focused settings test**

Run:

```bash
npx vitest run src/core/platform.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the setting**

```bash
git add src/core/platform.ts src/core/platform.test.ts src/renderer/src/features/settings/settings-dialog.tsx
git commit -m "feat(session): configure complete migration threshold"
```

### Task 2: Turn-aware 40% preservation and bounded parallel compression

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/session-migration.ts`
- Modify: `src/core/session-migration-compression.ts`
- Modify: `src/core/session-migration-compression.test.ts`
- Modify: `src/core/session-migration.test.ts`

- [ ] **Step 1: Write failing policy tests**

Create portable Sessions with explicit portable message boundaries:

```ts
const session: PortableSession = {
  ...portable(messages),
  turnBoundaries: [0, 2, 4, 6, 8],
};
```

Cover:

```ts
await expect(applyMigrationLengthPolicy(
  exactly100k,
  null,
  undefined,
  100_000,
)).resolves.toMatchObject({ strategy: "complete" });

expect(compress).toHaveBeenCalledWith(expect.objectContaining({
  messages: expect.not.arrayContaining(recentMessages),
  turnBoundaries: expect.any(Array),
}));

expect(result.session.messages.slice(-recentTurnMessageCount))
  .toEqual(recentCompleteTurns);

await expect(applyMigrationLengthPolicy(
  overLimit,
  null,
  undefined,
  100_000,
)).rejects.toThrow(/summary model/i);
```

Also capture summarizer calls and assert that approximately 108K early history at a 100K threshold creates four independent chunk calls, followed by one handoff call; no chunk prompt contains the previous chunk response.

- [ ] **Step 2: Run focused migration tests and observe failures**

Run:

```bash
npx vitest run src/core/session-migration-compression.test.ts src/core/session-migration.test.ts
```

Expected: FAIL on the old 60K threshold, character slicing, fixed 10K recent window, and local fallback.

- [ ] **Step 3: Add portable turn boundaries and threshold propagation**

Extend the portable type:

```ts
export interface PortableSession {
  // existing fields
  turnBoundaries?: number[];
}
```

Keep `MIGRATION_TOKEN_LIMIT` as the compatibility default but change it to `100_000`. Add `completeTokenLimit` to `MigrateSessionOptions` and use it both for the pre-compression progress decision and `deps.prepare`.

- [ ] **Step 4: Replace the length policy**

Use the selected Session total as the recent budget source:

```ts
const totalTokens = estimatePortableSessionTokens(session);
const recentTokenBudget = Math.floor(totalTokens * 0.4);
const summaryCharacterLimit = Math.floor(completeTokenLimit * 0.2 * 4);
const targetFragmentTokens = Math.floor(completeTokenLimit * 0.35);
```

Resolve complete turns from `turnBoundaries`, falling back to each user message as a new turn. Walk backward and retain whole turns until adding the next turn would exceed `recentTokenBudget`; always retain the last selected turn. Pass only the earlier prefix to `compress`.

Build the result as:

```ts
messages: withContinuousIndexes([
  {
    role: "user",
    content: `${HANDOFF_HEADER}${safePrefix(summary, summaryCharacterLimit)}`,
    timestamp: session.startedAt,
    index: 0,
  },
  {
    role: "user",
    content: "[迁移说明：以下为最近 40% 的完整对话轮次，之前内容已并入上方摘要。]",
    timestamp: session.startedAt,
    index: 0,
  },
  ...recentMessages,
])
```

If no compressor exists, its response is invalid, or it throws, propagate an actionable error and do not produce `locally-truncated`.

- [ ] **Step 5: Make the compressor create one to four whole-turn fragments**

Calculate:

```ts
const requiredChunks = Math.max(
  1,
  Math.ceil(estimatePortableSessionTokens(earlySession) / targetFragmentTokens),
);
if (requiredChunks > 4) {
  throw new Error("The selected history is too long for the configured complete migration threshold.");
}
```

Partition contiguous whole turns as evenly as possible into `requiredChunks`, run them through the existing bounded parallel mapper, preserve result ordering, cap each fragment extraction to about 2K Token, and invoke the final handoff exactly once. Keep progress events as `completed/totalChunks`.

- [ ] **Step 6: Require the fixed handoff structure**

Update the handoff prompt to require these Markdown sections inside `<summary>`:

```text
## 用户原始目标
## 约束与用户纠正
## 已确定的决定
## 已完成工作
## 相关产物
## 当前状态
## 遗留问题
## 下一步
```

Retain exact identifiers, paths, commands, and still-relevant errors; later corrections override earlier assumptions. Validate the required sections before accepting the handoff.

- [ ] **Step 7: Run the focused tests**

Run:

```bash
npx vitest run src/core/session-migration-compression.test.ts src/core/session-migration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the policy**

```bash
git add src/core/types.ts src/core/session-migration.ts src/core/session-migration-compression.ts src/core/session-migration-compression.test.ts src/core/session-migration.test.ts
git commit -m "feat(session): preserve recent turns during migration"
```

### Task 3: Validate and cut off migration at a selected turn

**Files:**
- Modify: `src/main/local-session-migration.ts`
- Modify: `src/main/local-session-migration.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Write failing source-resolution tests**

Define a store stub with `getSession`, `getAllMessages`, `listSessionTurns`, and `getSessionTurn`. Assert:

```ts
const resolved = await loadLocalSessionMigrationSource(store, {
  sessionKey: "claude:1",
  target: "codex",
  throughTurnId: "turn-2",
});
expect(resolved.messages.map((message) => message.index)).toEqual([0, 1, 2, 3]);
expect(resolved.turnSourceMessageIndexes).toEqual([0, 2]);
```

Add rejection tests for a missing turn, synthetic turn, turn from another Session, and a turn whose detail has no usable `sourceMessageIndex`.

- [ ] **Step 2: Run the focused main test and observe failure**

Run:

```bash
npx vitest run src/main/local-session-migration.test.ts
```

Expected: FAIL because the source resolver and structured request do not exist.

- [ ] **Step 3: Add the structured request and source loader**

Add:

```ts
export interface SessionMigrationRequest {
  sessionKey: string;
  target: MigrationTarget;
  throughTurnId?: string;
}
```

`loadLocalSessionMigrationSource` must validate the selected detail, compute the maximum non-null `sourceMessageIndex`, filter all later messages before any summarizer is created, and return indexed turn starts for the retained prefix.

- [ ] **Step 4: Carry indexed turn boundaries into the portable Session**

Extend `portableSessionFrom` with optional source turn starts. Convert source indexes to portable message indexes after filtering out non-user/assistant messages. `runLocalSessionMigration` passes the resulting `turnBoundaries` and `settings.migrationCompleteTokenLimit` into migration preparation.

- [ ] **Step 5: Replace positional Electron IPC**

Preload:

```ts
migrateSession: (request: SessionMigrationRequest): Promise<SessionMigrationResult> =>
  ipcRenderer.invoke("session:migrate", request),
```

Main:

```ts
ipcMain.handle("session:migrate", async (event, request: SessionMigrationRequest) => {
  const selected = await loadLocalSessionMigrationSource(store, request);
  const settings = Object.freeze(await providerService.hydrateSettings());
  return runLocalSessionMigration({
    ...selected,
    target: request.target,
    settings,
  }, localSessionMigrationRuntime(event));
});
```

Remove the implicit Codex summary endpoint fallback; the selected summary configuration must resolve successfully for compressed migrations.

- [ ] **Step 6: Run focused main tests and typecheck**

Run:

```bash
npx vitest run src/main/local-session-migration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the IPC boundary**

Stage only this task’s hunks, preserving the existing unrelated `setPinned` removal:

```bash
git add -p src/preload/index.ts
git add src/main/local-session-migration.ts src/main/local-session-migration.test.ts src/main/index.ts
git commit -m "feat(session): migrate through a selected turn"
```

### Task 4: Turn context menu and cutoff-aware dialog

**Files:**
- Modify: `src/renderer/src/app-types.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/features/session-detail/turn-accordion.tsx`
- Modify: `src/renderer/src/features/session-detail/turn-accordion.test.ts`
- Modify: `src/renderer/src/features/session-detail/detail-panel.tsx`
- Modify: `src/renderer/src/features/sessions/session-details.tsx`
- Modify: `src/renderer/src/components/session-migration-dialog.tsx`
- Modify: `src/renderer/src/session-migration-ui.test.ts`
- Modify: the existing Session/turn context-menu stylesheet selected by `rg`

- [ ] **Step 1: Write failing renderer tests**

Render the turn migration menu and dialog:

```ts
expect(renderToStaticMarkup(
  <TurnMigrationContextMenu
    x={10}
    y={20}
    language="zh"
    onMigrate={() => undefined}
  />,
)).toContain(">迁移<");

expect(renderToStaticMarkup(
  <SessionMigrationDialog
    session={session}
    throughTurnIndex={2}
    // existing props
  />,
)).toContain("包含至第 3 轮，之后的内容不会迁移");
```

Also render a synthetic turn and assert it is not marked as context-menu eligible.

- [ ] **Step 2: Run focused renderer tests and observe failures**

Run:

```bash
npx vitest run src/renderer/src/features/session-detail/turn-accordion.test.ts src/renderer/src/session-migration-ui.test.ts
```

Expected: FAIL because the menu, callback, and cutoff copy are absent.

- [ ] **Step 3: Add the turn context menu**

`TurnAccordion` accepts:

```ts
onMigrateTurn?: (turn: SessionTurnSummary) => void;
```

Only non-synthetic turns with a non-null source boundary handle `contextmenu`. Clamp the fixed menu to the viewport with the existing context-menu position utility. The menu contains only one action, `迁移`; it closes on selection, outside pointer input, Escape, Session change, and scrolling.

- [ ] **Step 4: Bubble the selected turn to App**

Change the action contract to:

```ts
migrate(session: SessionSearchResult, turn?: SessionTurnSummary): void;
```

Store:

```ts
{
  kind: "select",
  session,
  throughTurnId?: string,
  throughTurnIndex?: number,
}
```

Send:

```ts
window.sessionSearch.migrateSession({
  sessionKey: session.sessionKey,
  target,
  ...(migrationDialog.throughTurnId
    ? { throughTurnId: migrationDialog.throughTurnId }
    : {}),
});
```

Preserve the existing whole-Session migration entry by omitting `throughTurnId`.

- [ ] **Step 5: Show inclusive cutoff copy**

When `throughTurnIndex` is present, show:

```text
包含至第 N 轮，之后的内容不会迁移。
```

Use the one-based display value `throughTurnIndex + 1`.

- [ ] **Step 6: Run renderer tests and typecheck**

Run:

```bash
npx vitest run src/renderer/src/features/session-detail/turn-accordion.test.ts src/renderer/src/session-migration-ui.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit renderer behavior**

Stage only this task’s hunks, preserving existing unrelated App changes:

```bash
git add -p src/renderer/src/App.tsx
git add src/renderer/src/app-types.ts src/renderer/src/features/session-detail/turn-accordion.tsx src/renderer/src/features/session-detail/turn-accordion.test.ts src/renderer/src/features/session-detail/detail-panel.tsx src/renderer/src/features/sessions/session-details.tsx src/renderer/src/components/session-migration-dialog.tsx src/renderer/src/session-migration-ui.test.ts
git add <context-menu-stylesheet>
git commit -m "feat(session): add turn migration menu"
```

### Task 5: Cross-entry consistency, release note, and verification

**Files:**
- Modify: `src/core/mcp-migration.ts`
- Modify: `src/core/mcp-migration.test.ts`
- Modify: `src/main/index.ts`
- Modify: relevant remote migration tests located with `rg`
- Modify: `.release-notes/feat-workflow-run-center-v1.md`

- [ ] **Step 1: Write failing MCP and remote threshold tests**

Assert that custom `migrationCompleteTokenLimit` reaches `applyMigrationLengthPolicy`, that long migrations without a configured summary model fail before writing, and that no entry silently substitutes the current Codex configuration.

- [ ] **Step 2: Run the focused tests and observe failures**

Run:

```bash
npx vitest run src/core/mcp-migration.test.ts src/main/local-session-migration.test.ts
```

Expected: FAIL where the threshold is not forwarded or a fallback is still used.

- [ ] **Step 3: Forward one policy across every migration entry**

Pass `settings.migrationCompleteTokenLimit` to compressor creation and length-policy application in local desktop, remote restore, and MCP migration. Remove local truncation and implicit provider substitution from all three paths.

- [ ] **Step 4: Update the single branch release note**

Add one user-facing bullet under `## 新增功能`:

```markdown
- Session 详情支持右键任意对话轮次并迁移该轮及之前的内容；长会话会保留最近 40% 的完整轮次并并行压缩更早历史，完整迁移阈值可在设置中调整。
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run src/core/platform.test.ts src/core/session-migration.test.ts src/core/session-migration-compression.test.ts src/core/mcp-migration.test.ts src/main/local-session-migration.test.ts src/renderer/src/features/session-detail/turn-accordion.test.ts src/renderer/src/session-migration-ui.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run release-note:check
git diff --check
```

Expected: every command exits 0. Do not start the Electron app during this validation.

- [ ] **Step 7: Commit final integration**

```bash
git add src/core/mcp-migration.ts src/core/mcp-migration.test.ts src/main/index.ts .release-notes/feat-workflow-run-center-v1.md
git commit -m "feat(session): finish turn-scoped migration"
```
