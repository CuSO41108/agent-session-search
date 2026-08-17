// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import { SKILL_INSTALL_TARGETS } from "../../../../core/agent-skill-registry";
import { SkillTargetDialog } from "./skill-target-dialog";

describe("SkillTargetDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders a label for every supported installation target", async () => {
    const skill = {
      id: "skill-id",
      managedId: "skill-id",
      name: "Example Skill",
      description: "",
      agent: "codex",
      source: "agent-recall-v2",
      path: "C:/managed/skill-id/SKILL.md",
      directoryPath: "C:/managed/skill-id",
      rootPath: "C:/managed",
      markdown: "# Example",
      mtimeMs: 0,
      origin: { kind: "builtin", label: "AgentRecall" },
      installations: SKILL_INSTALL_TARGETS.map((target) => ({
        target,
        path: `C:/target/${target}`,
        state: "not-installed" as const,
      })),
    } as ManagedSkill;

    await act(async () => root.render(createElement(SkillTargetDialog, {
      open: true,
      skill,
      busy: false,
      language: "zh",
      onClose: vi.fn(),
      onSave: vi.fn(async () => undefined),
    })));

    expect([...container.querySelectorAll(".managed-skill-target-options strong")].map((node) => node.textContent)).toEqual([
      "Codex",
      "Codex shared (~/.agents/skills)",
      "Claude Code",
      "CodeBuddy",
      "Qoder",
      "Trae",
      "Pi",
    ]);
  });
});
