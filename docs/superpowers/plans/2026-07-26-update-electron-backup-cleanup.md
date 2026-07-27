# Electron Update Backup Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an application update finish after its repaired Electron runtime passes validation even when deleting the previous runtime backup keeps returning `ENOTEMPTY`.

**Architecture:** Keep the existing runtime validation and rollback flow. After validation succeeds, atomically move the old `dist` backup from inside the staged package to a unique sibling cleanup path, then remove that path with the existing retry helper on a best-effort basis so it cannot travel into the installed package or invalidate a usable runtime.

**Tech Stack:** Node.js CommonJS, `node:fs/promises`, Node test runner, npm release-note checks.

## Global Constraints

- Do not restore bundled Electron or change the release package layout.
- Do not change update download, runtime validation, rollback, atomic replacement, or UI flows.
- Keep rollback possible until the replacement runtime has passed the existing validation.
- Installation tests must use temporary homes, npm prefixes, caches, and fixtures.
- The branch must contain exactly one user-facing release note.

---

### Task 1: Make validated runtime cleanup non-blocking

**Files:**
- Modify: `scripts/update-client.test.mjs:1044-1120`
- Modify: `bin/update-client.cjs:868-970`
- Create: `.release-notes/fix-update-electron-backup-cleanup-blocking.md`

**Interfaces:**
- Consumes: `ensureInstalledElectron(options)`, `removeRuntimeDirectory(directoryPath, options)`, and the existing Electron runtime fixture executor.
- Produces: unchanged `ensureInstalledElectron(options): Promise<void>` behavior, with successful validation no longer reverted by persistent backup deletion errors.

- [ ] **Step 1: Add a failing persistent-`ENOTEMPTY` regression test**

Add a test beside the existing transient cleanup retry test. Build a corrupt runtime and an install script that replaces it with a valid runtime. Temporarily wrap `node:fs/promises.rm` so both the current package-internal backup path and the new sibling cleanup path always throw `ENOTEMPTY`:

```js
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

test("keeps a validated Electron repair when backup cleanup stays blocked", async () => {
  // Use the same real temporary Electron fixture layout as
  // "retries transient ENOTEMPTY failures while removing the previous Electron runtime".
  const originalRm = mutableFsPromises.rm;
  mutableFsPromises.rm = async (target, options) => {
    const value = String(target);
    if (
      (value.includes(".agent-recall-dist-") && value.endsWith(".backup"))
      || value.includes(".agent-recall-electron-cleanup-")
    ) {
      const error = new Error("directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return originalRm(target, options);
  };
  try {
    await ensureInstalledElectron({
      packagePath,
      timeoutMs: 5_000,
      findCachedArchiveImpl: async () => null,
      execFileImpl: electronFixtureExec,
    });
  } finally {
    mutableFsPromises.rm = originalRm;
  }

  assert.equal(isElectronRuntimeReady(packagePath), true);
  assert.deepEqual(
    (await readdir(electronPath)).filter((name) => name.endsWith(".backup")),
    [],
  );
});
```

The break this test catches is putting backup deletion back inside the success condition: current code rejects with `Electron 运行时安装失败：ENOTEMPTY`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="keeps a validated Electron repair when backup cleanup stays blocked" scripts/update-client.test.mjs
```

Expected: FAIL because `ensureInstalledElectron` rejects after all backup removal retries return `ENOTEMPTY`.

- [ ] **Step 3: Implement sibling isolation and best-effort deletion**

Keep `cleanupBackups` in `ensureInstalledElectron`, because it has one caller and does not form a reusable domain boundary. Change it to remove the small `path.txt` backup best-effort, rename the `dist` backup to a unique path beside `packagePath`, and remove that isolated path without propagating cleanup errors:

```js
const cleanupBackups = async (distBackup, pathBackup, cleanupPath) => {
  await fsp.rm(pathBackup, { force: true }).catch(() => undefined);
  if (fs.existsSync(distBackup)) await fsp.rename(distBackup, cleanupPath);
  await removeRuntimeDirectory(cleanupPath).catch(() => undefined);
};
```

Create the cleanup path from the existing `repairId`:

```js
const cleanupPath = path.join(
  path.dirname(packagePath),
  `.agent-recall-electron-cleanup-${repairId}`,
);
```

Pass `cleanupPath` only after `validate()` succeeds:

```js
await validate();
await cleanupBackups(distBackup, pathBackup, cleanupPath);
return true;
```

Update the existing transient cleanup test to inject two `ENOTEMPTY` failures for `.agent-recall-electron-cleanup-` and retain its assertion that the third attempt succeeds.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern="retries transient ENOTEMPTY|keeps a validated Electron repair" scripts/update-client.test.mjs
```

Expected: the transient retry test and persistent cleanup regression test both PASS.

- [ ] **Step 5: Add the branch release note**

Create `.release-notes/fix-update-electron-backup-cleanup-blocking.md`:

```markdown
# 修复应用内更新被临时目录清理中断

## Bug 修复

- 修复部分 macOS 设备点击“立即更新”后提示 `ENOTEMPTY` 并中断安装的问题。
```

- [ ] **Step 6: Run complete verification**

Run:

```bash
node --test scripts/update-client.test.mjs
npm test
npm run typecheck
npm run build
npm run release-note:check
npm run package:smoke
git diff --check
```

Expected: all commands exit zero; package smoke uses only its temporary HOME, npm prefix, cache, and installation directories.

- [ ] **Step 7: Commit the implementation**

```bash
git add bin/update-client.cjs scripts/update-client.test.mjs .release-notes/fix-update-electron-backup-cleanup-blocking.md
git commit -m "fix: do not fail updates on Electron backup cleanup"
```
