import { describe, expect, it } from "vitest";
import { inferOpenVikingMemoryType } from "./openviking-memory-control";
import {
  canonicalOpenVikingMemoryUri,
  normalizeWorkspacePath,
  tryCanonicalOpenVikingMemoryUri,
  workspaceUserId,
} from "./openviking-memory";
import { isOpenVikingMemoryTransient } from "./openviking-memory-lifecycle";

describe("OpenViking workspace identity", () => {
  it("derives a deterministic, account-safe user ID from a stable workspace identity", () => {
    const identity = "repo:github.com/acme/app";

    expect(workspaceUserId(identity)).toMatch(/^workspace_[a-f0-9]{24}$/);
    expect(workspaceUserId(identity)).toBe(workspaceUserId(identity));
    expect(workspaceUserId("repo:github.com/acme/other")).not.toBe(workspaceUserId(identity));
  });

  it("normalizes directory paths without applying POSIX rules to Windows paths", () => {
    expect(normalizeWorkspacePath("/Users/me/project/../project/")).toBe("/Users/me/project");
    expect(normalizeWorkspacePath("C:\\Users\\me\\project\\..\\project\\", "win32")).toBe(
      "C:\\Users\\me\\project",
    );
    expect(() => normalizeWorkspacePath("   ")).toThrow("Workspace path is required");
  });

  it("canonicalizes OpenViking user-qualified memory URIs to the control-plane URI", () => {
    expect(canonicalOpenVikingMemoryUri(
      "viking://user/workspace_abcd/memories/preferences/editor.md",
      "workspace_abcd",
    )).toBe("viking://user/memories/preferences/editor.md");
    expect(canonicalOpenVikingMemoryUri(
      "viking://user/memories/preferences/editor.md",
      "workspace_abcd",
    )).toBe("viking://user/memories/preferences/editor.md");
    expect(() => canonicalOpenVikingMemoryUri(
      "viking://user/workspace_other/memories/preferences/editor.md",
      "workspace_abcd",
    )).toThrow(/selected OpenViking workspace/u);
    expect(tryCanonicalOpenVikingMemoryUri(
      "viking://user/memories/decisions/中文决策.md",
    )).toBe("viking://user/memories/decisions/中文决策.md");
    expect(tryCanonicalOpenVikingMemoryUri("viking://user/memories/../secret.md")).toBeNull();
  });

  it("polls only while runtime or model preparation is actively progressing", () => {
    const snapshot = {
      runtime: { state: "running" as const },
      model: { model: "BAAI/bge-small-zh-v1.5" as const, installed: true },
      workspaces: [{
        id: "workspace-1",
        userId: "workspace_abcd",
        rootPath: "/repo",
        identity: "path:one",
        displayName: "repo",
        managed: true,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      }],
    };

    expect(isOpenVikingMemoryTransient(snapshot)).toBe(false);
    expect(isOpenVikingMemoryTransient({
      ...snapshot,
      runtime: { state: "starting" },
    })).toBe(true);
    expect(isOpenVikingMemoryTransient({
      ...snapshot,
      model: { ...snapshot.model, downloading: true },
    })).toBe(true);
  });

  it("infers memory types that match the runtime template vocabulary", () => {
    expect(inferOpenVikingMemoryType("viking://user/memories/preferences/editor.md")).toBe("preferences");
    expect(inferOpenVikingMemoryType("viking://user/memories/identity.md")).toBe("profile");
    expect(inferOpenVikingMemoryType("viking://user/memories/manual/todo.md")).toBe("notes");
    expect(inferOpenVikingMemoryType("viking://user/memories/context/project.md")).toBe("context");
    expect(inferOpenVikingMemoryType("viking://user/memories/decisions/db.md")).toBe("decisions");
    expect(inferOpenVikingMemoryType("viking://user/memories/open_loops/follow-up.md")).toBe("open_loops");
    expect(inferOpenVikingMemoryType("viking://user/memories/unknown-kind/item.md")).toBe("unknown-kind");
  });
});
