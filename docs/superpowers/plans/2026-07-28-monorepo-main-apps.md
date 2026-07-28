# AgentRecall 1.0 / 2.0 Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place the stable SQLite V1 and the PostgreSQL V2 in two independently runnable app directories on one `main`-targeting branch, while preserving V1 releases and isolating V2 identity, data, CLI, and MCP integrations.

**Architecture:** Start from current `origin/main`, record `main-2.0` as merged without letting its root tree overwrite V1, then materialize the two snapshots under `apps/main-1.0` and `apps/main-2.0`. Keep each app's dependency graph and lockfile independent. The repository root owns orchestration, release-note routing, CI, stable V1 documentation, and the V1-only release workflow.

**Tech Stack:** Electron 42, React 19, TypeScript 5.7, Vitest 2.1, Node.js 22, npm, SQLite (`node:sqlite`) for V1, embedded PostgreSQL for V2, GitHub Actions.

---

### Task 1: Record Both Histories and Materialize the Two Apps

**Files:**
- Create: `apps/main-1.0/**`
- Create: `apps/main-2.0/**`
- Preserve at root: `.github/**`, `.release-notes/**`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `Install.md`, `LICENSE`, `docs/**`, `assets/**`
- Remove from root after copying: `src/**`, `bin/**`, `dist/**`, `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`

- [ ] **Step 1: Verify the isolated branch and source commits**

Run:

```bash
git status --short --branch
git rev-parse origin/main
git rev-parse main-2.0
```

Expected: branch is `refactor/monorepo-main-apps`, `origin/main` resolves to `646c5f1`, and `main-2.0` resolves to `0c48191`.

- [ ] **Step 2: Record the V2 history without replacing the V1 tree**

Run:

```bash
git merge -s ours --no-ff main-2.0 -m "chore: join V1 and V2 histories"
```

Expected: merge commit has both the design branch and `main-2.0` as parents; working files still match V1.

- [ ] **Step 3: Materialize the V1 application snapshot**

Create `apps/main-1.0`, then extract these paths from `origin/main` into it:

```text
.npmignore
.npmrc
.nvmrc
Install.md
LICENSE
README.md
assets
bin
dist
electron.vite.config.ts
package-lock.json
package.json
scripts
src
tsconfig.json
vitest.config.ts
```

Run:

```bash
mkdir -p apps/main-1.0
git archive origin/main -- \
  .npmignore .npmrc .nvmrc Install.md LICENSE README.md assets bin dist \
  electron.vite.config.ts package-lock.json package.json scripts src \
  tsconfig.json vitest.config.ts \
  | tar -x -C apps/main-1.0
```

Expected: `apps/main-1.0/src/main/index.ts` contains the SQLite startup and `apps/main-1.0/package.json` is `agent-recall`.

- [ ] **Step 4: Materialize the V2 application snapshot**

Run:

```bash
mkdir -p apps/main-2.0
git archive main-2.0 -- \
  .npmignore .npmrc .nvmrc Install.md LICENSE README.md THIRD_PARTY_NOTICES.md \
  assets bin dist electron.vite.config.ts package-lock.json package.json scripts \
  src tsconfig.json vitest.config.ts \
  | tar -x -C apps/main-2.0
```

Expected: `apps/main-2.0/src/main/postgres/managed-postgres.ts` exists and `apps/main-2.0/package.json` includes `embedded-postgres`.

- [ ] **Step 5: Remove application-owned files from the root**

Remove only these now-duplicated root paths:

```text
src
bin
dist
electron.vite.config.ts
tsconfig.json
vitest.config.ts
```

Keep the root `scripts` directory until Task 4 separates repository and app release tooling.

Run:

```bash
git rm -r src bin dist
git rm electron.vite.config.ts tsconfig.json vitest.config.ts
```

- [ ] **Step 6: Commit the mechanical layout**

Run:

```bash
git add apps src bin dist electron.vite.config.ts tsconfig.json vitest.config.ts
git diff --cached --check
git commit -m "refactor: place V1 and V2 in app directories"
```

Expected: the commit contains the two complete application trees and root application removals.

### Task 2: Add Repository-Level Orchestration

**Files:**
- Replace: `package.json`
- Replace: `package-lock.json`
- Test: `scripts/monorepo-layout.test.mjs`

- [ ] **Step 1: Write the failing repository layout test**

Create `scripts/monorepo-layout.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = JSON.parse(await readFile("package.json", "utf8"));
const v1 = JSON.parse(await readFile("apps/main-1.0/package.json", "utf8"));
const v2 = JSON.parse(await readFile("apps/main-2.0/package.json", "utf8"));

test("keeps V1 and V2 as independent app packages", () => {
  assert.equal(root.private, true);
  assert.equal(root.workspaces, undefined);
  assert.equal(v1.name, "agent-recall");
  assert.equal(v2.name, "agent-recall-v2");
  assert.notEqual(v1.productName, v2.productName);
});

test("exposes explicit root commands for both apps", () => {
  assert.match(root.scripts["dev:v1"], /apps\/main-1\.0/);
  assert.match(root.scripts["dev:v2"], /apps\/main-2\.0/);
  assert.match(root.scripts.test, /test:repo/);
  assert.match(root.scripts.test, /test:v1/);
  assert.match(root.scripts.test, /test:v2/);
});
```

- [ ] **Step 2: Run the layout test to verify it fails**

Run:

```bash
node --test scripts/monorepo-layout.test.mjs
```

Expected: FAIL because the root package still describes the old single app and V2 still has the old package name.

- [ ] **Step 3: Replace the root package manifest**

Use this root structure:

```json
{
  "name": "agent-recall-monorepo",
  "version": "0.1.0",
  "private": true,
  "description": "AgentRecall stable and preview desktop applications.",
  "license": "MIT",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "setup": "npm run setup:v1 && npm run setup:v2",
    "setup:v1": "npm ci --prefix apps/main-1.0",
    "setup:v2": "npm ci --prefix apps/main-2.0",
    "dev": "npm run dev:v1",
    "dev:v1": "npm --prefix apps/main-1.0 run dev",
    "dev:v2": "npm --prefix apps/main-2.0 run dev",
    "test": "npm run test:repo && npm run test:v1 && npm run test:v2",
    "test:repo": "node --test scripts/*.test.mjs",
    "test:v1": "npm --prefix apps/main-1.0 test",
    "test:v2": "npm --prefix apps/main-2.0 test",
    "test:scripts": "npm run test:repo && npm --prefix apps/main-1.0 run test:scripts && npm --prefix apps/main-2.0 run test:scripts",
    "typecheck": "npm --prefix apps/main-1.0 run typecheck && npm --prefix apps/main-2.0 run typecheck",
    "build": "npm --prefix apps/main-1.0 run build && npm --prefix apps/main-2.0 run build",
    "package:smoke": "npm --prefix apps/main-1.0 run package:smoke",
    "package:smoke:v2": "npm --prefix apps/main-2.0 run package:smoke",
    "release-note:check": "node scripts/release-notes.mjs check-range"
  }
}
```

- [ ] **Step 4: Generate a root-only lockfile**

Run `npm install --package-lock-only --ignore-scripts` from the root.

Expected: the root lockfile names `agent-recall-monorepo` and has no workspaces or application dependencies.

- [ ] **Step 5: Run the repository layout test**

Run `node --test scripts/monorepo-layout.test.mjs`.

Expected: package-name assertion still fails until Task 3 updates V2; root-command assertions pass.

- [ ] **Step 6: Commit root orchestration**

Run:

```bash
git add package.json package-lock.json scripts/monorepo-layout.test.mjs
git diff --cached --check
git commit -m "build: orchestrate both AgentRecall apps"
```

### Task 3: Isolate the V2 Product, Data, CLI, and MCP Identity

**Files:**
- Modify: `apps/main-2.0/package.json`
- Modify: `apps/main-2.0/package-lock.json`
- Modify: `apps/main-2.0/src/main/index.ts`
- Modify: `apps/main-2.0/src/core/app-paths.ts`
- Modify: `apps/main-2.0/src/core/app-paths.test.ts`
- Modify: `apps/main-2.0/src/main/app-path-bootstrap.test.ts`
- Modify: `apps/main-2.0/bin/setup-mcp.cjs`
- Modify: `apps/main-2.0/src/core/setup-mcp.test.ts`
- Modify: V2 package tests that assert package or binary names

- [ ] **Step 1: Write failing V2 isolation assertions**

Extend V2 tests to assert:

```ts
expect(databaseUrlPointerPath("/home/user")).toBe(
  path.join("/home/user", ".agent-recall-v2", "database-url"),
);
```

and:

```ts
expect(bootstrapApplicationPaths({
  app,
  productName: "AgentRecall 2",
  env: {},
})).toMatchObject({
  userData: path.join(appData, "AgentRecall 2"),
});
```

Extend `setup-mcp.test.ts` to expect Claude key `agent-recall-v2` and Codex table `[mcp_servers.agent_recall_v2]`, while preserving a pre-existing V1 `agent-recall` entry.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run \
  src/core/app-paths.test.ts \
  src/main/app-path-bootstrap.test.ts \
  src/core/setup-mcp.test.ts
```

Expected: FAIL on the old `.agent-recall`, `AgentRecall`, and `agent-recall` identifiers.

- [ ] **Step 3: Update the V2 package identity**

Set:

```json
{
  "name": "agent-recall-v2",
  "productName": "AgentRecall 2",
  "private": true
}
```

Rename exposed V2 bin keys to `agent-recall-v2`, `agent-recall-v2-mcp`, `agent-recall-v2-workflow-mcp`, and corresponding `agent-recall-v2-*` setup/hook names. Keep the physical filenames unchanged so internal relative imports remain stable.

- [ ] **Step 4: Update the V2 Electron identity**

In `apps/main-2.0/src/main/index.ts`:

```ts
const PRODUCT_NAME = "AgentRecall 2";
const releaseUpdateRuntime = false;
```

Use an app user model ID ending in `.agent-recall-v2`, keep `legacyProductNames` empty, and keep the V1 main process unchanged.

- [ ] **Step 5: Isolate the V2 database pointer**

In `apps/main-2.0/src/core/app-paths.ts` set:

```ts
const POINTER_DIR = ".agent-recall-v2";
```

Keep the explicit `AGENT_RECALL_DATABASE_URL` override for development and tests.

- [ ] **Step 6: Isolate V2 MCP registration**

In `apps/main-2.0/bin/setup-mcp.cjs` set:

```js
const SERVER_NAME = "agent-recall-v2";
const CODEX_SECTION = "mcp_servers.agent_recall_v2";
```

The remove path must delete only the V2 key/table and leave V1 configuration untouched.

- [ ] **Step 7: Regenerate only the V2 lockfile**

Run:

```bash
npm install --prefix apps/main-2.0 --package-lock-only --ignore-scripts
```

Expected: V2 package-lock root package name is `agent-recall-v2`; V1 lockfile is unchanged.

- [ ] **Step 8: Run the focused isolation tests**

Run the focused Vitest command from Step 2 and `node --test scripts/monorepo-layout.test.mjs`.

Expected: PASS.

- [ ] **Step 9: Commit V2 isolation**

Run:

```bash
git add apps/main-2.0 package.json scripts/monorepo-layout.test.mjs
git diff --cached --check
git commit -m "feat: isolate the AgentRecall 2 preview app"
```

### Task 4: Separate Repository Release Tooling from App Tooling

**Files:**
- Keep at root: `scripts/release-notes.mjs`, `scripts/release-notes.test.mjs`, `scripts/generate-star-history.mjs`, `scripts/generate-star-history.test.mjs`, `scripts/monorepo-layout.test.mjs`
- Remove other V1 application scripts from root
- Modify: `apps/main-1.0/scripts/release-notes.test.mjs`
- Modify: `apps/main-2.0/scripts/release-notes.test.mjs`
- Modify: `.release-notes/README.md`
- Test: `scripts/release-notes.test.mjs`

- [ ] **Step 1: Add failing release-target tests**

Extend the root release-note tests:

```js
test("routes V1 and V2 notes without publishing V2 notes in V1 releases", () => {
  const v1 = parseReleaseNote("# Stable\n\n## Bug 修复\n\n- Stable fix.\n");
  const v2 = parseReleaseNote("# Preview\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Preview fix.\n");
  assert.equal(v1.target, "v1");
  assert.equal(v2.target, "v2");
  assert.deepEqual(combineReleaseNotes([v1, v2], { target: "v1" }).fixes, ["Stable fix."]);
});
```

Expected metadata behavior:

- Missing target defaults to `v1` for backward compatibility.
- Allowed targets are `v1`, `v2`, and `both`.
- Rendered public release notes never include the HTML routing comment.

- [ ] **Step 2: Run the release-note test to verify it fails**

Run `node --test scripts/release-notes.test.mjs`.

Expected: FAIL because parsed notes do not expose `target` and combine cannot filter.

- [ ] **Step 3: Implement release-target parsing**

Update `scripts/release-notes.mjs` so `parseReleaseNote` recognizes exactly:

```md
<!-- release-target: v2 -->
```

Return `target`, default it to `v1`, reject unknown values, and let `combineReleaseNotes(notes, { target: "v1" })` include `v1` and `both`.

- [ ] **Step 4: Document note targeting**

Add to `.release-notes/README.md`:

```md
V1 说明无需标记。仅影响 2.0 的说明在标题后添加
`<!-- release-target: v2 -->`；同时影响两个版本时使用 `both`。
路由注释不会出现在用户看到的更新说明中。
```

- [ ] **Step 5: Remove repository-coupled tests from each app**

Keep each app's `release-notes.mjs` because its version scripts import it, but remove `release-notes.test.mjs` and `generate-star-history.test.mjs` from both app script test globs by moving repository-owned copies to the root and deleting app duplicates.

- [ ] **Step 6: Remove root application script duplicates**

At root, keep only the five repository scripts listed in **Files**. Application packaging, installation, update, MCP, build, and smoke scripts must exist only inside the corresponding app directory.

- [ ] **Step 7: Run repository and app script tests**

Run:

```bash
node --test scripts/*.test.mjs
npm --prefix apps/main-1.0 run test:scripts
npm --prefix apps/main-2.0 run test:scripts
```

Expected: PASS.

- [ ] **Step 8: Commit release-tool ownership**

Run:

```bash
git add scripts .release-notes apps/main-1.0/scripts apps/main-2.0/scripts
git diff --cached --check
git commit -m "build: route releases by app version"
```

### Task 5: Preserve the Current V2 Chat Fixes

**Files:**
- Modify: `apps/main-2.0/package.json`
- Modify: `apps/main-2.0/package-lock.json`
- Modify: `apps/main-2.0/src/renderer/src/features/team-chat/team-chat-page.tsx`
- Modify: `apps/main-2.0/src/renderer/src/styles/team-chat.css`
- Create: `apps/main-2.0/src/renderer/src/team-chat-existing-room-employees.test.tsx`

- [ ] **Step 1: Add the observable Chat test**

Copy the existing untracked test from the original `main-2.0` worktree into the V2 app. It must verify:

- Adding a room employee preserves the existing `memberId`.
- Agent Markdown tables render through `.md-table-wrap > table.md-table`.

- [ ] **Step 2: Run the Chat test against the V2 snapshot**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run src/renderer/src/team-chat-existing-room-employees.test.tsx
```

Expected: FAIL before the working-tree overlay is applied.

- [ ] **Step 3: Apply the original working-tree overlay**

Reproduce only the original dirty changes inside `apps/main-2.0`:

- Add `happy-dom` to V2 dev dependencies and lockfile.
- Add the existing-room employee dialog and update call.
- Render messages with the shared `Markdown` component.
- Apply the scoped dialog button and table-related styling.

Do not clean, reset, or commit the original `main-2.0` working tree.

- [ ] **Step 4: Run focused Chat tests**

Run:

```bash
npm --prefix apps/main-2.0 exec vitest run \
  src/main/team-chat \
  src/main/team-chat-ipc.test.ts \
  src/renderer/src/team-chat-page.test.ts \
  src/renderer/src/team-chat-existing-room-employees.test.tsx
```

Expected: 6 files and 48 tests pass, matching the verified original working tree.

- [ ] **Step 5: Commit the preserved Chat behavior**

Run:

```bash
git add apps/main-2.0
git diff --cached --check
git commit -m "fix: preserve Studio room employee controls"
```

### Task 6: Update Root Documentation

**Files:**
- Modify: `README.md`
- Modify: `Install.md`
- Modify: `apps/main-1.0/README.md`
- Modify: `apps/main-1.0/Install.md`
- Modify: `apps/main-2.0/README.md`
- Modify: `apps/main-2.0/Install.md`

- [ ] **Step 1: Keep the root README V1-first**

Preserve V1 feature, install, privacy, and usage content. Add one short section linking to:

```md
## AgentRecall 2.0 开发版

2.0 开发版与 1.0 稳定版独立运行、独立保存数据。
开发和功能说明见 [`apps/main-2.0/README.md`](./apps/main-2.0/README.md)。
```

- [ ] **Step 2: Correct root development commands**

Document:

```bash
npm run setup:v1
npm run dev
```

Keep stable installation commands unchanged because the published V1 package remains `agent-recall`.

- [ ] **Step 3: Make each app README self-contained**

V1 app docs describe SQLite and V1 commands. V2 app docs describe PostgreSQL, `npm run setup:v2`, `npm run dev:v2`, product name `AgentRecall 2`, and explicitly state there is no V1 data import.

- [ ] **Step 4: Verify documentation links**

Run:

```bash
rg -n "apps/main-2.0/README.md|setup:v1|dev:v2|SQLite|PostgreSQL" README.md Install.md apps/main-1.0 apps/main-2.0
```

Expected: root begins with V1, and V2-specific data statements occur in V2 docs.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add README.md Install.md apps/main-1.0/README.md apps/main-1.0/Install.md apps/main-2.0/README.md apps/main-2.0/Install.md
git diff --cached --check
git commit -m "docs: explain stable and preview apps"
```

### Task 7: Update CI and the V1-Only Release Workflow

**Files:**
- Modify: `.github/workflows/quality-check.yml`
- Modify: `.github/workflows/release-note-check.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/update-star-history.yml`
- Modify: `scripts/release-notes.test.mjs`

- [ ] **Step 1: Extend workflow tests before workflow changes**

Assert the quality workflow contains:

```text
npm run setup:v1
npm run setup:v2
npm run test:v1
npm run test:v2
npm run package:smoke
npm run package:smoke:v2
```

Assert the release workflow uses `apps/main-1.0` for install, versioning, tests, build, and packaging, and filters release notes to target `v1`.

- [ ] **Step 2: Run workflow tests to verify they fail**

Run `node --test scripts/release-notes.test.mjs`.

Expected: FAIL on old single-root commands.

- [ ] **Step 3: Update quality checks**

Configure `actions/setup-node` with both app lockfiles in `cache-dependency-path`, install V1 and V2 separately, and call root aggregate scripts. Preserve the current Windows-only script-test branch.

- [ ] **Step 4: Update V1 release commands**

The release workflow must:

- Detect root `.release-notes`.
- Validate every pending note.
- Combine only `v1` and `both` notes.
- Skip publication when pending notes are V2-only.
- Run V1 version, install, test, build, pack, asset, and package commands from `apps/main-1.0`.
- Preserve existing V1 tag names, npm package filenames, GitHub Release titles, and update manifest URLs.

- [ ] **Step 5: Keep star-history generation at root**

Verify the star-history workflow still calls the root script and writes root README assets:

```bash
rg -n "node scripts/generate-star-history\\.mjs|assets/star-history" \
  .github/workflows/update-star-history.yml scripts/generate-star-history.mjs
```

Expected: both paths remain rooted at the repository, so no application-relative path is introduced.

- [ ] **Step 6: Run repository workflow tests**

Run `node --test scripts/*.test.mjs`.

Expected: PASS.

- [ ] **Step 7: Commit workflow changes**

Run:

```bash
git add .github scripts
git diff --cached --check
git commit -m "ci: verify both apps and release V1"
```

### Task 8: Add the Single User-Facing Release Note

**Files:**
- Create: `.release-notes/monorepo-main-apps.md`

- [ ] **Step 1: Add one V2-targeted product note**

Create:

```md
# 1.0 与 2.0 独立运行

<!-- release-target: v2 -->

## Bug 修复

- AgentRecall 1.0 稳定版与 2.0 开发版现在会分别保存应用数据和运行状态，同时使用时不会再互相占用或覆盖。
- 已创建的 Chat 房间现在可以继续添加员工，并会保留原有员工各自的持续会话。
- Chat 中的 Markdown 表格、代码块、标题和链接现在可以正确显示，较宽的表格支持横向滚动查看。
```

- [ ] **Step 2: Validate the exact branch-note count**

Run:

```bash
npm run release-note:check
```

Expected: PASS with exactly one newly added root release-note file.

- [ ] **Step 3: Commit the product note**

Run:

```bash
git add .release-notes/monorepo-main-apps.md
git commit -m "docs: announce independent V1 and V2 apps"
```

### Task 9: Full Safe Verification

**Files:**
- Verify: all files changed by Tasks 1-8

- [ ] **Step 1: Create a synthetic verification environment**

Run:

```bash
VERIFICATION_ROOT="$(node -e "const fs=require('node:fs');const os=require('node:os');const path=require('node:path');process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),'agentrecall-monorepo-verify.')))")"
export VERIFICATION_ROOT
export HOME="$VERIFICATION_ROOT/home"
export USERPROFILE="$VERIFICATION_ROOT/home"
export NPM_CONFIG_CACHE="$VERIFICATION_ROOT/npm-cache"
export NPM_CONFIG_PREFIX="$VERIFICATION_ROOT/npm-prefix"
export electron_config_cache="$VERIFICATION_ROOT/electron-cache"
export AGENT_RECALL_TEST_HOME="$VERIFICATION_ROOT/home"
export AGENT_RECALL_NO_UPDATE_CHECK=1
node -e "const fs=require('node:fs');for(const p of ['home','npm-cache','npm-prefix','electron-cache','v1-user-data','v2-user-data'])fs.mkdirSync(process.env.VERIFICATION_ROOT+'/'+p,{recursive:true})"
```

Expected: every path is under the newly created OS temporary directory; never use the developer's real Agent, Skills, session, Supabase, or Electron data.

- [ ] **Step 2: Install both dependency trees safely**

Run root `npm run setup:v1` and `npm run setup:v2` with the synthetic HOME and npm prefix.

Expected: both installs complete without writing outside the synthetic environment.

- [ ] **Step 3: Run all tests**

Run:

```bash
npm test
```

Expected: root tests, V1 tests, and V2 tests pass.

- [ ] **Step 4: Run type checks and builds**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both apps typecheck and build.

- [ ] **Step 5: Run both package smoke tests**

Run:

```bash
npm run package:smoke
npm run package:smoke:v2
```

Expected: each app builds first, installs its generated tarball into a temporary npm prefix, verifies its CLI, and cleans its child processes and temporary files.

- [ ] **Step 6: Verify identity and path isolation**

Run focused V2 path/MCP tests and inspect package manifests:

```bash
node -e "const a=require('./apps/main-1.0/package.json'); const b=require('./apps/main-2.0/package.json'); console.log(a.name,a.productName,b.name,b.productName)"
```

Expected:

```text
agent-recall AgentRecall agent-recall-v2 AgentRecall 2
```

- [ ] **Step 7: Run repository checks**

Run:

```bash
npm run release-note:check
git diff --check
git status --short --branch
```

Expected: release-note check and whitespace check pass; only intentional committed branch state remains.

- [ ] **Step 8: Clean verification artifacts**

No `dev` command is used in this verification, so no Electron UI should remain. Confirm no verification-owned process is running, then clean the validated temporary root:

```bash
node -e "const fs=require('node:fs');const root=process.env.VERIFICATION_ROOT;if(!root||!root.includes('agentrecall-monorepo-verify.'))throw new Error('refusing unsafe cleanup');fs.rmSync(root,{recursive:true,force:true})"
test ! -e "$VERIFICATION_ROOT"
```

- [ ] **Step 9: Commit migration-caused fixes**

If verification required code changes, stage only the known migration scope:

```bash
git add -A apps package.json package-lock.json scripts .github .release-notes README.md Install.md
git diff --cached --check
git commit -m "fix: complete monorepo verification"
```

If no changes were required, do not create an empty commit.
