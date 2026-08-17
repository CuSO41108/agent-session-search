import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCodexDesktopProjects, readCodexDesktopProjects } from "./codex-projects";
import type { ProjectSummary } from "./types";

function indexedProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    path: "E:\\Code\\AgentRecall",
    label: "AgentRecall",
    labelKind: "path",
    labelSuffix: null,
    sessionCount: 2,
    environmentId: "local",
    environmentLabel: "Local",
    createdAt: 10,
    lastActivityAt: 20,
    ...overrides,
  };
}

describe("Codex Desktop project discovery", () => {
  it("reads saved workspace roots and labels, including projects without chats", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-projects-"));
    try {
      fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
        "electron-saved-workspace-roots": ["E:\\Code\\AgentRecall", "E:\\Code\\Resume"],
        "electron-workspace-root-labels": { "E:\\Code\\Resume": "简历" },
        "project-order": ["E:\\Code\\Resume", "E:\\Code\\AgentRecall"],
      }));

      expect(readCodexDesktopProjects(codexHome)).toEqual([
        { path: "E:\\Code\\Resume", label: "简历" },
        { path: "E:\\Code\\AgentRecall", label: "AgentRecall" },
      ]);
    } finally {
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("merges an empty Desktop project with indexed projects without duplicating paths", () => {
    const merged = mergeCodexDesktopProjects(
      [indexedProject()],
      [
        { path: "E:\\Code\\AgentRecall", label: "AgentRecall" },
        { path: "E:\\Code\\Resume", label: "简历" },
      ],
    );

    expect(merged).toEqual([
      indexedProject(),
      {
        path: "E:\\Code\\Resume",
        label: "简历",
        labelKind: "path",
        labelSuffix: null,
        sessionCount: 0,
        environmentId: "local",
        environmentLabel: "Local",
        createdAt: 0,
        lastActivityAt: 0,
      },
    ]);
  });
});
