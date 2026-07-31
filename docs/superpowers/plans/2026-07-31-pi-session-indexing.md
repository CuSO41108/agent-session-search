# Pi Agent Session Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, read-only indexing of local Pi Agent sessions to both AgentRecall session applications, including search, detail, tool trace, token usage, and existing export flows.

**Architecture:** Register Pi as a standard optional session source, then add a dedicated parser in each application's existing loader structure. The parser recursively discovers Pi JSONL files, reconstructs the active v2/v3 parent chain without mutating it, falls back to linear v1 rows, and emits the existing `LoadedSession` model so storage, search, detail, and export remain generic.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Vitest, React server rendering tests, SQLite V1 session store, PostgreSQL-compatible V2 session store.

## Global Constraints

- `includePi` defaults to `false`; disabled indexing must not read `~/.pi/agent/sessions`.
- Enabled indexing recursively scans `<homeDir>/.pi/agent/sessions/**/*.jsonl`.
- Parsing is read-only and must not import Pi runtime code or migrate/rewrite Pi files.
- V1 and V2 must expose the same product behavior; V2 must wire both sync and async default iterators.
- Pi has no live-process, resume, migration, remote-sync, or native-app capability in this change.
- Tests use temporary HOME directories and synthetic fixtures based on the real Pi 0.83.0 v3 session.
- A malformed file, broken parent chain, or cycle is skipped without blocking valid sibling files.
- The branch contains exactly one user-facing release note and passes `npm run release-note:check`.
- Temporary `docs/superpowers` specification and plan commits are removed before the Draft PR.

---

### Task 1: Register the Pi source and parse Pi message blocks

**Files:**
- Modify: `apps/main-1.0/src/core/types.ts`
- Modify: `apps/main-2.0/src/core/types.ts`
- Modify: `apps/main-1.0/src/core/session-sources.ts`
- Modify: `apps/main-2.0/src/core/session-sources.ts`
- Modify: `apps/main-1.0/src/core/session-sources.test.ts`
- Modify: `apps/main-2.0/src/core/session-sources.test.ts`
- Modify: `apps/main-1.0/src/core/format-adapters.ts`
- Modify: `apps/main-2.0/src/core/format-adapters.ts`
- Modify: `apps/main-1.0/src/core/format-adapters.test.ts`
- Modify: `apps/main-2.0/src/core/format-adapters.test.ts`
- Modify: `apps/main-1.0/src/core/format-session.test.ts`
- Modify: `apps/main-2.0/src/core/format-session.test.ts`

**Interfaces:**
- Produces: `SessionSource` value `"pi-cli"`, `SessionFormat` value `"pi"`, source family `"pi"`, optional setting `"includePi"`, and `getAdapter("pi")`.
- Consumes: existing generic `FormatAdapter`, `SessionAttachment`, and source registry contracts.

- [ ] **Step 1: Write failing source registry tests**

Add `"pi-cli"` to `ALL_SOURCES`, `"includePi"` to the optional-setting expectation, and this assertion in both `session-sources.test.ts` files:

```ts
expect(sessionSourceDescriptor("pi-cli")).toMatchObject({
  label: "Pi",
  format: "pi",
  family: "pi",
  uiFamily: "other",
  optionalSetting: "includePi",
  liveFamily: null,
  migrationAgent: null,
  remoteFamily: null,
  capabilities: {
    live: false,
    resume: false,
    migrate: false,
    sessionSync: false,
    openApp: false,
  },
});
```

- [ ] **Step 2: Write failing adapter and export tests**

Add this behavior to both `format-adapters.test.ts` files:

```ts
it("parses Pi text and inline image blocks without exposing tool calls", () => {
  const parsed = getAdapter("pi").parseLine({
    type: "message",
    timestamp: "2026-07-31T02:39:01.181Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Inspect this image" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/private/secret" } },
      ],
    },
  });

  expect(parsed).toMatchObject({
    role: "user",
    content: "Inspect this image",
    timestamp: "2026-07-31T02:39:01.181Z",
    attachments: [
      expect.objectContaining({
        mimeType: "image/png",
        previewKind: "image",
        source: { kind: "inline", value: "aGVsbG8=" },
      }),
    ],
  });
  expect(JSON.stringify(parsed)).not.toContain("/private/secret");
});
```

Add to both `format-session.test.ts` files:

```ts
it("uses the shared source label for Pi exports", () => {
  expect(formatSessionMarkdown({ ...session, source: "pi-cli" }, messages))
    .toContain("Pi · `/repo`");
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/session-sources.test.ts src/core/format-adapters.test.ts src/core/format-session.test.ts
npm --prefix apps/main-2.0 exec -- vitest run src/core/session-sources.test.ts src/core/format-adapters.test.ts src/core/format-session.test.ts
```

Expected: failures because `"pi-cli"`/`"pi"` are not valid contracts, the registry has no Pi descriptor, and the generic adapter does not recognize Pi's top-level `data`/`mimeType` image fields.

- [ ] **Step 4: Implement the source contracts and adapter**

Extend both applications with:

```ts
// types.ts
export type SessionSource =
  | "claude-cli"
  | "claude-app"
  | "codex-cli"
  | "codex-app"
  | "tclaude-cli"
  | "tcodex-cli"
  | "codebuddy-cli"
  | "codewiz-cli"
  | "openclaw"
  | "hermes"
  | "opencode-cli"
  | "zcode-cli"
  | "cursor-agent"
  | "trae"
  | "qoder"
  | "pi-cli";
export type SessionFormat =
  | "claude"
  | "codex"
  | "codebuddy"
  | "codewiz"
  | "openclaw"
  | "hermes"
  | "opencode"
  | "zcode"
  | "cursor"
  | "trae"
  | "qoder"
  | "pi";

// session-sources.ts
"pi-cli": {
  id: "pi-cli", label: "Pi", format: "pi", family: "pi", uiFamily: "other", statsGroup: null,
  optionalSetting: "includePi", pendingKey: "pi", remoteCollectorOptional: false, liveFamily: null, migrationAgent: null,
  resumeTarget: null, remoteFamily: null, nativeAppFamily: null,
  capabilities: { live: false, resume: false, migrate: false, sessionSync: false, openApp: false },
},
```

Update `attachmentFromBlock` to use `block.data` and `block.mimeType` for Pi images and mark a top-level `data` value as inline. Add `piAdapter = genericAdapter("pi")` and route both `"pi"` and `"pi-cli"` through it in `getAdapter`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the two commands from Step 3. Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/main-1.0/src/core apps/main-2.0/src/core
git commit -m "feat: register Pi session source"
```

---

### Task 2: Implement the V1 Pi loader with real-format regression coverage

**Files:**
- Create: `apps/main-1.0/src/core/session-loader-pi.test.ts`
- Modify: `apps/main-1.0/src/core/session-loader.ts`

**Interfaces:**
- Consumes: `SessionLoadOptions`, `readJsonl`, `safeStat`, `shouldSkipFile`, `walkJsonlFiles`, `getAdapter("pi")`, and the existing token/trace types.
- Produces: `loadDefaultSessions({ homeDir, includePi: true })` results with source `"pi-cli"` and session key `pi:<header-id>`.

- [ ] **Step 1: Write a failing real v3 fixture test**

Create a temporary home and write a recursive fixture under:

```ts
const filePath = path.join(
  homeDir,
  ".pi",
  "agent",
  "sessions",
  "--work-pi--",
  "2026-07-31T02-39-01-167Z_pi-session.jsonl",
);
```

The JSONL rows must include:

```ts
[
  { type: "session", version: 3, id: "pi-session", timestamp: "2026-07-31T02:39:01.167Z", cwd: "/work/pi" },
  { type: "session_info", id: "info-1", parentId: null, timestamp: "2026-07-31T02:39:01.167Z", name: "Initial name" },
  { type: "model_change", id: "model-1", parentId: "info-1", timestamp: "2026-07-31T02:39:01.179Z", provider: "openai", modelId: "gpt-test" },
  {
    type: "message",
    id: "user-1",
    parentId: "model-1",
    timestamp: "2026-07-31T02:39:01.181Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Searchable Pi question" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
  },
  {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: "2026-07-31T02:39:01.208Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } },
      ],
      usage: { input: 10, output: 6, cacheRead: 2, cacheWrite: 3, reasoning: 2, totalTokens: 21 },
    },
  },
  {
    type: "message",
    id: "tool-1",
    parentId: "assistant-1",
    timestamp: "2026-07-31T02:39:01.220Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "export const value = 1;" }],
      isError: false,
    },
  },
  { type: "session_info", id: "info-2", parentId: "tool-1", timestamp: "2026-07-31T02:39:01.230Z", name: "Real Pi title" },
  {
    type: "message",
    id: "abandoned-user",
    parentId: "info-2",
    timestamp: "2026-07-31T02:40:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Abandoned branch" }] },
  },
  {
    type: "message",
    id: "abandoned-assistant",
    parentId: "abandoned-user",
    timestamp: "2026-07-31T02:40:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Abandoned answer" }],
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 6 },
    },
  },
  {
    type: "message",
    id: "active-user",
    parentId: "info-2",
    timestamp: "2026-07-31T02:41:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "Active branch" }] },
  },
  {
    type: "message",
    id: "active-assistant",
    parentId: "active-user",
    timestamp: "2026-07-31T02:41:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Active answer" }],
      usage: { input: 5, output: 3, cacheRead: 1, cacheWrite: 0, reasoning: 1, totalTokens: 9 },
    },
  },
]
```

Assert:

```ts
expect(loadDefaultSessions({ homeDir })).not.toContainEqual(
  expect.objectContaining({ session: expect.objectContaining({ source: "pi-cli" }) }),
);
const [loaded] = loadDefaultSessions({ homeDir, includePi: true })
  .filter((item) => item.session.source === "pi-cli");
expect(loaded.session).toMatchObject({
  sessionKey: "pi:pi-session",
  source: "pi-cli",
  projectPath: "/work/pi",
  originalTitle: "Real Pi title",
  firstQuestion: "Searchable Pi question",
  timestamp: Date.parse("2026-07-31T02:39:01.167Z"),
  tokenUsage: {
    inputTokens: 19,
    outputTokens: 8,
    cachedInputTokens: 6,
    reasoningOutputTokens: 3,
    totalTokens: 36,
  },
});
expect(loaded.messages.map(({ content }) => content)).toEqual([
  "Searchable Pi question",
  "Reading the file.",
  "Active branch",
  "Active answer",
]);
expect(loaded.messages[0]?.attachments?.[0]).toMatchObject({
  mimeType: "image/png",
  source: { kind: "inline", value: "aGVsbG8=" },
});
expect(loaded.traceEvents).toEqual([
  expect.objectContaining({ kind: "tool_call", source: "pi", callId: "call-1", title: "read · src/app.ts" }),
  expect.objectContaining({ kind: "tool_result", source: "pi", callId: "call-1", status: "success" }),
]);
```

- [ ] **Step 2: Write failing compatibility and corruption tests**

Add separate tests that:

- parse a v1 header followed by linear user/assistant messages without `id` or `parentId`;
- use the first user message when the latest `session_info.name` is empty;
- keep parsing after an unknown row and a malformed JSON line;
- skip a v3 cycle or missing-parent file while still returning a valid sibling session.

- [ ] **Step 3: Run the V1 test and verify RED**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/session-loader-pi.test.ts
```

Expected: fail because `SessionLoadOptions` has no `includePi` and the default loader does not scan Pi files.

- [ ] **Step 4: Implement the V1 parser in the owning loader**

Add `includePi?: boolean`, `PI_SESSIONS_DIR = path.join(".pi", "agent", "sessions")`, and `"pi"` to the `createIndexedSession` key prefix.

Implement these private boundaries in `session-loader.ts`:

```ts
function piActiveRows(rows: unknown[]): unknown[] | null;
function piTokenEvents(rows: unknown[]): TokenUsageEvent[];
function piTraceEvents(rows: unknown[]): SessionTraceEvent[];
function loadPiSessionFile(filePath: string, stat?: VirtualSessionFileStat): LoadedSession | null;
function* loadPiSessionsIterator(
  piSessionsDir: string,
  options: SessionLoadOptions,
): Generator<LoadedSession>;
```

`piActiveRows` must:

- require a valid `session` header;
- return non-header rows in file order for version `< 2`;
- for v2/v3, start at the last entry with an ID, follow `parentId` through a map, reject cycles and missing parents, then reverse the collected path.

`piTokenEvents` must scan all assistant rows, map Pi usage with:

```ts
createTokenUsage(
  usage.input,
  Math.max(0, usage.output - usage.reasoning),
  usage.cacheRead + usage.cacheWrite,
  usage.reasoning,
);
```

`piTraceEvents` must inspect only active rows. Convert assistant `toolCall` blocks and `toolResult` messages into paired trace entries with the same call ID. Use `isError` to set result status.

Wire the iterator only when enabled:

```ts
if (options.includePi) {
  yield* loadPiSessionsIterator(path.join(homeDir, PI_SESSIONS_DIR), options);
}
```

- [ ] **Step 5: Run V1 tests and verify GREEN**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/session-loader-pi.test.ts src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/main-1.0/src/core/session-loader.ts apps/main-1.0/src/core/session-loader-pi.test.ts
git commit -m "feat: index Pi sessions in V1"
```

---

### Task 3: Implement equivalent V2 sync and async loading

**Files:**
- Create: `apps/main-2.0/src/core/session-loader-pi.test.ts`
- Modify: `apps/main-2.0/src/core/session-loaders/common.ts`
- Modify: `apps/main-2.0/src/core/session-loaders/alternative-sources.ts`
- Modify: `apps/main-2.0/src/core/session-loader.ts`

**Interfaces:**
- Consumes: V2 `common.ts` loader helpers and standard `LoadedSession`.
- Produces: `loadPiSessionsIterator(piSessionsDir, options)` used by both `loadDefaultSessionsIterator` and `loadDefaultSessionsAsyncIterator`.

- [ ] **Step 1: Copy the behavior contract, not the implementation**

Create the V2 test file with the same fixture and assertions from Task 2. Add one explicit async assertion:

```ts
const asyncLoaded: LoadedSession[] = [];
for await (const item of loadDefaultSessionsAsyncIterator({ homeDir, includePi: true })) {
  if (item.session.source === "pi-cli") asyncLoaded.push(item);
}
expect(asyncLoaded.map((item) => item.session.sessionKey)).toEqual(["pi:pi-session"]);
```

- [ ] **Step 2: Run the V2 test and verify RED**

Run:

```bash
npm --prefix apps/main-2.0 exec -- vitest run src/core/session-loader-pi.test.ts
```

Expected: fail because V2 has no Pi option or iterator.

- [ ] **Step 3: Implement V2 using existing loader boundaries**

Add `includePi?: boolean` and `"pi"` key prefix support in `session-loaders/common.ts`.

Implement and export from `alternative-sources.ts`:

```ts
export const PI_SESSIONS_DIR = path.join(".pi", "agent", "sessions");
export function* loadPiSessionsIterator(
  piSessionsDir: string,
  options: SessionLoadOptions = {},
): Generator<LoadedSession>;
```

Keep the active-chain, title, message, token, and trace semantics identical to Task 2 while using V2's exported common helpers.

Import the iterator in `session-loader.ts` and add the same `includePi` block to both default iterators.

- [ ] **Step 4: Run V2 focused tests and verify GREEN**

Run:

```bash
npm --prefix apps/main-2.0 exec -- vitest run src/core/session-loader-pi.test.ts src/core/session-loader.test.ts src/core/session-loader-extra-sources.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Compare V1 and V2 observable fixtures**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/session-loader-pi.test.ts
npm --prefix apps/main-2.0 exec -- vitest run src/core/session-loader-pi.test.ts
```

Expected: both versions pass the same source, title, branch, message, attachment, trace, and token assertions.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/main-2.0/src/core/session-loader.ts apps/main-2.0/src/core/session-loaders apps/main-2.0/src/core/session-loader-pi.test.ts
git commit -m "feat: index Pi sessions in V2"
```

---

### Task 4: Expose the opt-in setting and prove indexed Pi content is searchable

**Files:**
- Modify: `apps/main-1.0/src/core/platform.ts`
- Modify: `apps/main-2.0/src/core/platform.ts`
- Modify: `apps/main-1.0/src/core/platform.test.ts`
- Modify: `apps/main-2.0/src/core/platform.test.ts`
- Modify: `apps/main-1.0/src/main/index.ts`
- Modify: `apps/main-2.0/src/main/index.ts`
- Modify: `apps/main-1.0/src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `apps/main-2.0/src/renderer/src/features/settings/settings-dialog.tsx`
- Modify: `apps/main-1.0/src/renderer/src/features/settings/settings-dialog.test.ts`
- Modify: `apps/main-2.0/src/renderer/src/features/settings/settings-dialog.test.ts`
- Modify: `apps/main-1.0/src/core/indexer.test.ts`
- Modify: `apps/main-2.0/src/core/indexer.test.ts`

**Interfaces:**
- Produces: persisted `AppSettings.includePi`, a settings checkbox, and main-process indexing propagation.
- Consumes: optional source registry pruning/filter behavior and existing indexer/store search APIs.

- [ ] **Step 1: Write failing default-setting tests**

Add to both platform tests:

```ts
expect(defaultSettings.includePi).toBe(false);
```

- [ ] **Step 2: Write failing settings UI tests**

Import `defaultSettings` and render the sessions section with:

```ts
settings: { ...defaultSettings, includePi: true },
initialSection: "sessions",
```

Assert:

```ts
expect(html).toContain("Include Pi");
expect(html).toContain("以只读方式索引本地 Pi 会话。");
expect(html).toContain('checked=""');
```

Keep separate V1 and V2 render helpers because their dialog props differ.

- [ ] **Step 3: Write failing end-to-end search tests**

In each `indexer.test.ts`, create a temporary Pi JSONL with header, user, and assistant rows, then run:

```ts
await syncDefaultSessionsInBatches(store, {
  batchSize: 1,
  loadOptions: { homeDir, includePi: true },
});
```

Assert the store finds the Pi content:

```ts
const results = await Promise.resolve(
  store.searchSessions({ query: "searchable Pi integration", limit: 10 }),
);
expect(results).toHaveLength(1);
expect(results[0]).toMatchObject({
  sessionKey: "pi:pi-indexed",
  source: "pi-cli",
});
```

Close the V2 test store in `finally` and remove both temporary homes.

- [ ] **Step 4: Run the selected tests and verify RED**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/platform.test.ts src/core/indexer.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
npm --prefix apps/main-2.0 exec -- vitest run src/core/platform.test.ts src/core/indexer.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
```

Expected: failures because `AppSettings` and the settings UI do not expose Pi, and main settings propagation is incomplete.

- [ ] **Step 5: Implement settings and main-process propagation**

Add `includePi: boolean` to both `AppSettings` interfaces and `includePi: false` to both defaults.

Add this UI control in both session settings panes:

```tsx
<label className="settings-field settings-toggle">
  <div className="settings-field-text">
    <span className="settings-field-title">Include Pi</span>
    <span className="settings-field-sub">
      {l("Indexes local Pi sessions read-only.", "以只读方式索引本地 Pi 会话。")}
    </span>
  </div>
  <input
    type="checkbox"
    className="switch"
    checked={Boolean(settings?.includePi)}
    disabled={!settings || saving}
    onChange={(event) => onSettingsChange({ includePi: event.currentTarget.checked })}
  />
</label>
```

Pass `includePi: settings.includePi` in both `runIndexSync` loader options. Do not add Pi to live-session options, skill usage, remote collectors, migration targets, or resume routing.

- [ ] **Step 6: Run selected tests and typecheck**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/platform.test.ts src/core/session-sources.test.ts src/core/indexer.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
npm --prefix apps/main-2.0 exec -- vitest run src/core/platform.test.ts src/core/session-sources.test.ts src/core/indexer.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
npm run typecheck
```

Expected: all selected tests and both TypeScript projects pass. If a complete `AppSettings` fixture fails typechecking, add `includePi: false` to that fixture rather than weakening the type.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/main-1.0/src apps/main-2.0/src
git commit -m "feat: expose Pi session indexing"
```

---

### Task 5: Add the release note and run complete verification

**Files:**
- Create: `.release-notes/feat-pi-session-indexing.md`

**Interfaces:**
- Produces: one final user-facing release-note entry.

- [ ] **Step 1: Add the release note**

Create exactly:

```md
# 支持索引 Pi 会话

## 新增功能

- 可在设置中开启 Pi 会话索引，搜索、查看并导出本地 Pi 对话和工具调用记录。
```

- [ ] **Step 2: Run formatting and diff checks**

Run:

```bash
git diff --check
npm run release-note:check
```

Expected: both pass.

- [ ] **Step 3: Run all focused Pi and registry tests**

Run:

```bash
npm --prefix apps/main-1.0 exec -- vitest run src/core/session-loader-pi.test.ts src/core/format-adapters.test.ts src/core/session-sources.test.ts src/core/platform.test.ts src/core/indexer.test.ts src/core/format-session.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
npm --prefix apps/main-2.0 exec -- vitest run src/core/session-loader-pi.test.ts src/core/format-adapters.test.ts src/core/session-sources.test.ts src/core/platform.test.ts src/core/indexer.test.ts src/core/format-session.test.ts src/renderer/src/features/settings/settings-dialog.test.ts
```

Expected: all selected tests pass with no warnings caused by this change.

- [ ] **Step 4: Run repository verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: typecheck, repository tests, both app test suites, MCP bundles, and both application builds pass.

- [ ] **Step 5: Inspect the final source scope**

Run:

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline --decorate main..HEAD
```

Confirm only Pi source contracts, loaders/tests, settings/wiring, and the single release note remain.

- [ ] **Step 6: Commit the release note**

```bash
git add .release-notes/feat-pi-session-indexing.md
git commit -m "docs: add Pi session indexing release note"
```

---

### Task 6: Remove temporary planning artifacts and publish a Draft PR

**Files:**
- Delete: `docs/superpowers/specs/2026-07-31-pi-session-indexing-design.md`
- Delete: `docs/superpowers/plans/2026-07-31-pi-session-indexing.md`

**Interfaces:**
- Produces: final branch without ignored planning documents and a Draft PR targeting `main`.

- [ ] **Step 1: Remove only the two task-local planning files**

Use an explicit patch deleting the two listed files. Do not alter other `docs/superpowers` files or worktrees.

- [ ] **Step 2: Commit cleanup**

```bash
git add -u docs/superpowers
git commit -m "chore: remove temporary Pi planning docs"
```

- [ ] **Step 3: Re-run final fast gates after cleanup**

Run:

```bash
git diff --check
npm run release-note:check
npm run typecheck
git status --short
```

Expected: all commands pass and the worktree is clean.

- [ ] **Step 4: Push the feature branch**

```bash
git push -u origin feat/pi-session-indexing
```

- [ ] **Step 5: Open a Draft PR**

Create a Draft PR targeting `main` with:

```md
## Summary

- add opt-in, recursive indexing for local Pi Agent v1-v3 JSONL sessions
- reconstruct the active Pi branch and preserve messages, images, tool traces, and token usage
- expose the source consistently in V1 and V2 settings, search, detail, and export flows

## Verification

- `npm run release-note:check`
- `npm run typecheck`
- `npm test`
- `npm run build`

Closes #274
```

- [ ] **Step 6: Inspect PR status**

Verify the PR targets `main`, is Draft, contains exactly the intended changed files, and has no immediate failing checks before handoff.
