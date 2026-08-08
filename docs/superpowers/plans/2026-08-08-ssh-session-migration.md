# SSH Session Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate SSH-hosted Claude Code and Codex sessions to the other Agent on the same SSH host, then resume the new remote session in a local terminal over SSH.

**Architecture:** Reuse the existing portable-session conversion, compression policy, remote file writer, remote index refresh, and terminal resume path. Add an explicit SSH-only target policy, opt SSH sources into portable conversion only from the guarded desktop IPC path, and adapt the existing source-restore runtime so it validates and launches Claude/Codex on SSH instead of treating SSH launch as a no-op.

**Tech Stack:** Electron, TypeScript, React, Vitest, SQLite (V1), PostgreSQL (V2), SSH stdio helpers.

---

### Task 1: Define the SSH migration policy

**Files:**
- Modify: `apps/main-1.0/src/core/session-migration.ts`
- Modify: `apps/main-2.0/src/core/session-migration.ts`
- Test: `apps/main-1.0/src/core/session-migration.test.ts`
- Test: `apps/main-2.0/src/core/session-migration.test.ts`

- [ ] **Step 1: Write failing tests for opposite-Agent targeting and guarded portable conversion**

Add cases asserting that `sshMigrationTarget("claude-cli")` returns `"codex"`, `sshMigrationTarget("codex-cli")` returns `"claude"`, unsupported sources return `null`, and `portableSessionFrom(..., { allowSsh: true })` accepts SSH while the default call still rejects it.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npx vitest run apps/main-1.0/src/core/session-migration.test.ts apps/main-2.0/src/core/session-migration.test.ts`

Expected: FAIL because `sshMigrationTarget` and `allowSsh` do not exist.

- [ ] **Step 3: Implement the policy in both apps**

Add the same public contract in each app:

```ts
export function sshMigrationTarget(source: SessionSource): "claude" | "codex" | null {
  if (source === "claude-cli") return "codex";
  if (source === "codex-cli") return "claude";
  return null;
}
```

Extend portable conversion options with `allowSsh?: boolean` and allow an SSH session only when that flag is true. Keep imported-local and ordinary MCP migration rejection unchanged.

- [ ] **Step 4: Re-run the focused tests**

Expected: PASS in V1 and V2.

### Task 2: Expose only the remote opposite Agent in the UI

**Files:**
- Modify: `apps/main-1.0/src/renderer/src/session-ui.ts`
- Modify: `apps/main-2.0/src/renderer/src/session-ui.ts`
- Modify: `apps/main-1.0/src/renderer/src/App.tsx`
- Modify: `apps/main-2.0/src/renderer/src/App.tsx`
- Modify: `apps/main-1.0/src/renderer/src/components/session-migration-dialog.tsx`
- Modify: `apps/main-2.0/src/renderer/src/components/session-migration-dialog.tsx`
- Test: `apps/main-1.0/src/renderer/src/session-ui.test.ts`
- Test: `apps/main-2.0/src/renderer/src/session-ui.test.ts`

- [ ] **Step 1: Write failing target-selection tests**

Assert that SSH Claude returns `["codex"]`, SSH Codex returns `["claude"]`, unsupported SSH sources return `[]`, and local/WSL behavior is unchanged.

- [ ] **Step 2: Run the focused renderer tests and verify failure**

Run: `npx vitest run apps/main-1.0/src/renderer/src/session-ui.test.ts apps/main-2.0/src/renderer/src/session-ui.test.ts`

Expected: FAIL because SSH targets are currently empty.

- [ ] **Step 3: Enable the existing migration entry points**

Use `sshMigrationTarget(session.source)` in `migrationTargetsForSession`. Change detail/context-menu eligibility from `environmentKind !== "ssh"` to `migrationTargetsForSession(...).length > 0`. Remove the dialog's unconditional SSH empty-target override and display copy stating that the new target session remains on the same SSH host.

- [ ] **Step 4: Re-run renderer tests**

Expected: PASS in V1 and V2.

### Task 3: Run migration and Resume on the source SSH host

**Files:**
- Modify: `apps/main-1.0/src/main/index.ts`
- Modify: `apps/main-2.0/src/main/index.ts`
- Test: `apps/main-1.0/src/main/main-startup-wiring.test.ts`
- Test: `apps/main-2.0/src/main/main-startup-wiring.test.ts`

- [ ] **Step 1: Write failing wiring tests**

Assert that each `session:migrate` handler hydrates SSH details, enforces `sshMigrationTarget`, calls `portableSessionFrom` with `allowSsh: true`, and delegates to `createSourceRemoteRestoreDependencies`. Assert that the SSH source runtime validates the remote target CLI and calls `openResumeInTerminal` with SSH arguments rather than returning without launching.

- [ ] **Step 2: Run the focused main-process tests and verify failure**

Run: `npx vitest run apps/main-1.0/src/main/main-startup-wiring.test.ts apps/main-2.0/src/main/main-startup-wiring.test.ts`

Expected: FAIL because the SSH migration branch and launch path are absent.

- [ ] **Step 3: Add guarded SSH migration handling in both IPC handlers**

For SSH sessions: hydrate complete details, reject any target other than `sshMigrationTarget(source)`, resolve the same SSH environment, convert with `allowSsh: true`, and call `restoreRemotePortableSession` with the remote project path.

- [ ] **Step 4: Make the source runtime genuinely SSH-aware**

For SSH, validate `claude` or `codex` with a quoted remote `command -v` preflight. Launch by creating the synthetic target session and calling the existing terminal opener with SSH transport arguments. Keep `remoteMigrationResumeDisplayCommand` as both primary and fallback command, so failure always yields a complete `ssh ...` command.

- [ ] **Step 5: Re-run main-process tests**

Expected: PASS in V1 and V2.

### Task 4: Release note and verification

**Files:**
- Create: `.release-notes/feat-ssh-session-migration.md`
- Modify: `docs/v1/guide.md`
- Modify: `docs/v2/guide.md`

- [ ] **Step 1: Add user-facing documentation**

Document that SSH Claude Code and Codex sessions can migrate to each other on the same host and automatically resume through SSH.

- [ ] **Step 2: Add exactly one release note**

```md
# SSH 会话迁移

## 新增功能

- SSH 环境中的 Claude Code 与 Codex 会话现在可以在同一台远程主机上互相迁移，并自动通过 SSH 继续新会话。
```

- [ ] **Step 3: Run focused and structural verification**

Run the V1/V2 focused tests from Tasks 1-3, both app typechecks, `git diff --check`, and `npm run release-note:check`.

Expected: all commands pass, no real SSH host or user session data is accessed, and exactly one release note is accepted.

- [ ] **Step 4: Commit the implementation**

Stage only the feature files, tests, guides, plan, and release note. Leave the user's untracked `docs/architecture-diagrams.md` untouched.
