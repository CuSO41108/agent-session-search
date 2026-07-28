import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManagedSkill } from "../../core/managed-skill-library";
import type { SkillSyncSnapshot } from "../../core/skill-sync";
import { SkillsPage } from "./features/skills/skills-page";
import { SkillDiscoveryDialog } from "./features/skills/skill-discovery-dialog";

const discoveryDialogSource = readFileSync(
  new URL("./features/skills/skill-discovery-dialog.tsx", import.meta.url),
  "utf8",
);
const targetDialogSource = readFileSync(
  new URL("./features/skills/skill-target-dialog.tsx", import.meta.url),
  "utf8",
);

const managedSkill: ManagedSkill = {
  id: "agent-recall:/library/review/SKILL.md",
  managedId: "review",
  name: "review",
  description: "Review code changes",
  agent: "codex",
  source: "agent-recall",
  path: "/library/review/SKILL.md",
  directoryPath: "/library/review",
  rootPath: "/library",
  markdown: "# Review\n",
  mtimeMs: 100,
  usageCount: 12,
  lastUsedAt: 99,
  origin: { kind: "local", label: "Codex" },
  installations: [
    { target: "codex", path: "/home/.codex/skills/review", state: "installed" },
    { target: "claude", path: "/home/.claude/skills/review", state: "not-installed" },
  ],
};

const syncSnapshot: SkillSyncSnapshot = {
  status: { kind: "ready", setupSql: "" },
  remoteSkillGroups: [],
  bindings: [],
  relations: [{
    identity: "agent-recall/review",
    localSkillPath: "/library/review/SKILL.md",
    localContentHash: "local",
    remoteFingerprint: null,
    remoteLatestId: null,
    remoteContentHash: "",
    state: "local-only",
  }],
  scannedAt: 100,
};

describe("SkillsPage", () => {
  it("renders app-managed and local Skill tabs with usage and installation state", () => {
    const html = renderToStaticMarkup(createElement(SkillsPage, {
      snapshot: { skills: [managedSkill], roots: [], scannedAt: 100 },
      syncSnapshot,
      loading: false,
      feedback: null,
      language: "zh" as const,
      revealLabel: "Finder",
      onRefresh: () => undefined,
      onUpload: async () => null,
      onUploadSelected: async () => ({ remainingSkillIds: [] }),
      onInstallRemote: async () => undefined,
      onFetchVersion: async () => {
        throw new Error("not used");
      },
      onRefreshRemote: () => undefined,
      onCopySetupSql: () => undefined,
      onOpenSqlEditor: () => undefined,
      onCopyPath: () => undefined,
      onReveal: () => undefined,
      onDelete: async () => undefined,
    }));

    expect(html).toContain('role="tablist"');
    expect(html).toContain("本 App Skill");
    expect(html).toContain("本地 Skill");
    expect(html).toContain("发现 Skill");
    expect(html).toContain("使用 12 次");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
  });
});

describe("SkillDiscoveryDialog", () => {
  it("keeps AI exploration clickable while the user is still entering a request", () => {
    const html = renderToStaticMarkup(createElement(SkillDiscoveryDialog, {
      open: true,
      language: "zh",
      onClose: () => undefined,
      onImported: () => undefined,
    }));

    expect(html).toContain("AI 探索");
    expect(html).toMatch(/class="skill-discovery-ai-action"/);
    expect(html).not.toMatch(/class="skill-discovery-ai-action"[^>]*disabled/);
  });

  it("shows grounded AI descriptions and match reasons", () => {
    expect(discoveryDialogSource).toContain("skill.description");
    expect(discoveryDialogSource).toContain("selectedAiMatch?.reason");
    expect(discoveryDialogSource).toContain("Why it matches");
    expect(discoveryDialogSource).toContain("匹配原因");
  });

  it("uses a compact label for adding a discovered Skill", () => {
    expect(discoveryDialogSource).toContain('l("Add", "加入")');
    expect(discoveryDialogSource).not.toContain('l("Add to Skill library", "加入 Skill 库")');
    expect(discoveryDialogSource).toContain('l("Adding…", "正在加入…")');
  });
});

describe("SkillTargetDialog", () => {
  it("describes target choices as selected or not selected", () => {
    expect(targetDialogSource).toContain('l("Selected", "已选择")');
    expect(targetDialogSource).toContain('l("Not selected", "未选择")');
    expect(targetDialogSource).not.toContain('l("Will be installed", "将安装")');
    expect(targetDialogSource).not.toContain('l("Not installed", "不安装")');
  });
});
