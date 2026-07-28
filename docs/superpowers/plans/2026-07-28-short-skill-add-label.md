# Short Skill Add Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten the Skill discovery import button from “加入 Skill 库 / Add to Skill library” to “加入 / Add”.

**Architecture:** Change only the idle label in the existing discovery-dialog button. Protect the copy with a source test; keep loading text, click behavior, disabled state, and other Skill-page actions unchanged.

**Tech Stack:** TypeScript, React, Vitest.

---

### Task 1: Shorten and protect the discovery button label

**Files:**
- Modify: `src/renderer/src/features/skills/skill-discovery-dialog.tsx`
- Test: `src/renderer/src/skills-page.test.ts`
- Create: `.release-notes/short-skill-add-label.md`

- [ ] **Step 1: Write the failing source test**

Add this test inside the existing `SkillDiscoveryDialog` suite:

```ts
it("uses a compact label for adding a discovered Skill", () => {
  expect(discoveryDialogSource).toContain('l("Add", "加入")');
  expect(discoveryDialogSource).not.toContain('l("Add to Skill library", "加入 Skill 库")');
  expect(discoveryDialogSource).toContain('l("Adding…", "正在加入…")');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run src/renderer/src/skills-page.test.ts
```

Expected: FAIL because the component still contains `Add to Skill library / 加入 Skill 库`.

- [ ] **Step 3: Replace only the idle label**

Change the existing button expression to:

```tsx
<Download size={13} />{importing ? l("Adding…", "正在加入…") : l("Add", "加入")}
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
npx vitest run src/renderer/src/skills-page.test.ts
npm run typecheck
```

Expected: all renderer tests PASS and TypeScript exits 0.

- [ ] **Step 5: Add the branch release note**

Create:

```markdown
# Skill 加入操作更简洁

## Bug 修复

- Skill 发现页的加入按钮使用更简洁的文案，减少界面拥挤。
```

- [ ] **Step 6: Run final verification**

Run:

```bash
npm test
npm run build
npm run release-note:check -- main-2.0 HEAD
git diff --check
```

Expected: all tests and script tests pass, production build exits 0, exactly one release note is reported, and diff check prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/skills/skill-discovery-dialog.tsx src/renderer/src/skills-page.test.ts .release-notes/short-skill-add-label.md
git commit -m "fix(skills): shorten discovery add label"
```
