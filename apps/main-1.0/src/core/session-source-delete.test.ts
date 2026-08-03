import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteLocalSessionSources, sessionSourceDeletionPaths } from "./session-source-delete";

describe("session source deletion", () => {
  it("deletes Claude subagent files and owned companion directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-session-tree-delete-"));
    const parentId = "parent-session";
    const parentFile = path.join(root, `${parentId}.jsonl`);
    const sessionDirectory = path.join(root, parentId);
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const toolResultsDirectory = path.join(sessionDirectory, "tool-results");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const childMetadata = path.join(subagentsDirectory, "agent-child.meta.json");
    const unrelatedFile = path.join(sessionDirectory, "keep.txt");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.mkdirSync(toolResultsDirectory, { recursive: true });
    for (const filePath of [parentFile, childFile, childMetadata, unrelatedFile]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }

    try {
      deleteLocalSessionSources([
        { source: "claude-cli", rawId: parentId, filePath: parentFile, isSubagent: false },
        { source: "claude-cli", rawId: "child", filePath: childFile, isSubagent: true },
      ]);

      expect(fs.existsSync(parentFile)).toBe(false);
      expect(fs.existsSync(subagentsDirectory)).toBe(false);
      expect(fs.existsSync(toolResultsDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
      expect(fs.existsSync(sessionDirectory)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the same owned artifacts for Windows paths", () => {
    expect(sessionSourceDeletionPaths([
      {
        source: "claude-cli",
        rawId: "parent-session",
        filePath: "C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl",
        isSubagent: false,
      },
    ], path.win32)).toEqual({
      files: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl"],
      directories: [
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\subagents",
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\tool-results",
      ],
      emptyDirectories: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session"],
    });
  });
});
