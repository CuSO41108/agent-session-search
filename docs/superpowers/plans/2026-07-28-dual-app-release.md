# AgentRecall Dual-App Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish AgentRecall 1.0 and `agent-recall-v2` together in one GitHub Release with clearly separated notes and collision-free update assets.

**Architecture:** The root release-note utility remains the source of product routing and gains a dual-product renderer plus an explicit empty-target fallback. V2 keeps the shared tag/version but gets V2-specific package aliases and manifest names; the GitHub workflow builds, validates, uploads, and remotely verifies both applications before publishing the draft.

**Tech Stack:** Node.js 22, npm packaging, Node test runner, GitHub Actions, GitHub CLI.

---

### Task 1: Render routed notes for both applications

**Files:**
- Modify: `scripts/release-notes.mjs`
- Test: `scripts/release-notes.test.mjs`

- [ ] **Step 1: Write failing release-note tests**

Add assertions that V1 and V2 notes render under separate `## AgentRecall 1.0` and `## agent-recall-v2` headings, and that an empty target receives the fixed fallback bullet `本次随统一版本同步发布，暂无单独的用户可见变化。`.

- [ ] **Step 2: Verify the tests fail**

Run: `node --test scripts/release-notes.test.mjs`

Expected: FAIL because dual rendering and empty-target fallback do not exist.

- [ ] **Step 3: Implement the routed renderer**

Add `combineReleaseNotesForTarget(notes, target)` and `renderDualReleaseNotes(notes)`. Extend the CLI with `combine --target v1|v2 --include-empty` and `dual <file...>` so the workflow can generate the two update manifests and the human-facing Release body from the same note set.

- [ ] **Step 4: Verify the tests pass**

Run: `node --test scripts/release-notes.test.mjs`

Expected: all root release-note tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-notes.mjs scripts/release-notes.test.mjs
git commit -m "feat: render dual app release notes"
```

### Task 2: Isolate V2 release assets and update discovery

**Files:**
- Modify: `apps/main-2.0/scripts/create-release-assets.mjs`
- Test: `apps/main-2.0/scripts/create-release-assets.test.mjs`
- Modify: `apps/main-2.0/bin/update-client.cjs`
- Test: `apps/main-2.0/scripts/update-client.test.mjs`

- [ ] **Step 1: Write failing V2 asset and updater tests**

Change expectations to:

```text
agent-recall-v2-<version>.tgz
agent-recall-v2.tgz
update-v2.json
release-notes-v2.md
```

Also assert that the V2 updater searches for `update-v2.json` and its manual fallback installs `agent-recall-v2.tgz`.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
node --test apps/main-2.0/scripts/create-release-assets.test.mjs apps/main-2.0/scripts/update-client.test.mjs
```

Expected: FAIL on the old V1-compatible asset names.

- [ ] **Step 3: Implement V2-specific asset names**

Set V2 constants to:

```js
export const LATEST_PACKAGE_NAME = "agent-recall-v2.tgz";
export const UPDATE_MANIFEST_NAME = "update-v2.json";
export const RELEASE_NOTES_NAME = "release-notes-v2.md";
```

Generate versioned packages as `agent-recall-v2-${version}.tgz`. Point the V2 update client at `update-v2.json` and `agent-recall-v2.tgz` without changing V1.

- [ ] **Step 4: Verify the tests pass**

Run:

```bash
node --test apps/main-2.0/scripts/create-release-assets.test.mjs apps/main-2.0/scripts/update-client.test.mjs
```

Expected: both test files pass.

- [ ] **Step 5: Commit**

```bash
git add apps/main-2.0/scripts/create-release-assets.mjs apps/main-2.0/scripts/create-release-assets.test.mjs apps/main-2.0/bin/update-client.cjs apps/main-2.0/scripts/update-client.test.mjs
git commit -m "fix: isolate v2 release assets"
```

### Task 3: Publish and verify both applications in one Release

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `scripts/release-notes.test.mjs`

- [ ] **Step 1: Write failing workflow assertions**

Require the workflow to generate V1, V2, and dual note files; run root setup/test/typecheck/build; stamp V2 with the computed version; build both packages; upload both update manifests; and download/validate both asset sets before publishing.

- [ ] **Step 2: Verify the workflow test fails**

Run: `node --test scripts/release-notes.test.mjs`

Expected: FAIL because the workflow currently skips V2.

- [ ] **Step 3: Update the GitHub Actions workflow**

Make any pending routed note publish a shared release. Generate:

```text
agent-recall-v1-note.md
agent-recall-v2-note.md
agent-recall-release-note.md
```

Use the combined note for version calculation, the per-app notes for update manifests, and the dual note for the GitHub Release page. Build both apps and keep the Release as a draft until both downloaded asset groups validate.

- [ ] **Step 4: Run focused validation**

Run:

```bash
node --test scripts/release-notes.test.mjs
npm run release-note:check
git diff --check
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml scripts/release-notes.test.mjs .release-notes/monorepo-main-apps.md
git commit -m "build: publish both AgentRecall apps"
```

### Task 4: Full verification and publication

**Files:**
- Verify only.

- [ ] **Step 1: Run both script suites**

Run: `npm run test:scripts`

Expected: root, V1, and V2 script tests pass.

- [ ] **Step 2: Run typecheck and production builds**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both applications typecheck and build.

- [ ] **Step 3: Run package smoke tests**

Run:

```bash
npm run package:smoke
npm run package:smoke:v2
```

Expected: both temporary package installs and CLI checks pass without touching real user data.

- [ ] **Step 4: Push the branch and merge through an MR**

```bash
git push origin refactor/monorepo-main-apps
gh pr create --base main --head refactor/monorepo-main-apps --title "Build AgentRecall V1 and V2 monorepo" --fill
```

Wait for required checks, then merge the MR through GitHub. Do not push feature commits directly to `main`.
