# Skill Library Runtime Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten the discovery add button, make installation selection wording accurate, and consistently support Codex, Claude Code, CodeBuddy, Qoder, and Trae Skills.

**Architecture:** Extend the existing explicit Skill target/source unions and root lists rather than adding a new abstraction. Reuse the managed library's symlink/Junction lifecycle for new targets. Extend local root scanning for the same products. Protect UI copy and filesystem mappings with observable tests.

**Tech Stack:** TypeScript, React, Vitest, Node.js filesystem fixtures.

---

### Task 1: Protect the requested UI wording

**Files:**
- Modify: `src/renderer/src/features/skills/skill-discovery-dialog.tsx`
- Modify: `src/renderer/src/features/skills/skill-target-dialog.tsx`
- Test: `src/renderer/src/skills-page.test.ts`

- [ ] Add failing source assertions for `Add / 加入`, `Selected / 已选择`, and `Not selected / 未选择`.
- [ ] Run `npx vitest run src/renderer/src/skills-page.test.ts` and confirm the assertions fail because old copy remains.
- [ ] Change only the existing labels and rerun the focused test.

### Task 2: Add managed installation targets

**Files:**
- Modify: `src/core/managed-skill-library.ts`
- Test: `src/core/managed-skill-library.test.ts`
- Modify: `src/renderer/src/features/skills/skill-target-dialog.tsx`

- [ ] Extend the existing target-installation test first to expect `codebuddy` and `qoder` targets and their user-directory mappings.
- [ ] Run `npx vitest run src/core/managed-skill-library.test.ts` and confirm RED.
- [ ] Add `codebuddy` and `qoder` to `SkillInstallTarget`, `INSTALL_TARGETS`, path resolution, and target labels.
- [ ] Rerun the focused core test.

### Task 3: Align local Skill scanning

**Files:**
- Modify: `src/core/skill-manager.ts`
- Test: `src/core/skill-manager.test.ts`

- [ ] Add a failing fixture test for CodeBuddy and Trae user/project roots alongside Qoder.
- [ ] Run `npx vitest run src/core/skill-manager.test.ts` and confirm RED.
- [ ] Extend the existing source/agent unions, root lists, project-directory exclusions, and project discovery to CodeBuddy and Trae.
- [ ] Rerun the focused core test and `npm run typecheck`.

### Task 4: Release note and verification

**Files:**
- Create: `.release-notes/skill-library-runtime-support.md`

- [ ] Add exactly one product-facing release note under `## 新增功能`, covering additional Agent targets and clearer Skill actions.
- [ ] Run `node scripts/release-notes.mjs check-file .release-notes/skill-library-runtime-support.md`.
- [ ] Run `npm test`, `npm run build`, `git diff --check`, and inspect `git status`.
- [ ] Commit the implementation and note.
- [ ] Run `npm run release-note:check -- main-2.0 HEAD`.

Expected: all focused and full suites pass, production build exits 0, exactly one release note is reported, and no whitespace or unexpected file changes remain.
