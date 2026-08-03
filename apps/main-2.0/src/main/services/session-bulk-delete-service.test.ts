import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionBulkDeleteTarget } from "../../core/session-bulk-delete";
import type { SessionStore } from "../../core/session-store";
import type { SessionSource } from "../../core/types";
import { SessionBulkDeleteService } from "./session-bulk-delete-service";

function target(sessionKey: string, overrides: Partial<SessionBulkDeleteTarget> = {}): SessionBulkDeleteTarget {
  return {
    sessionKey, cascadeRootSessionKey: sessionKey, rawId: sessionKey,
    source: "codex-cli", filePath: "missing.jsonl", isSubagent: false, parentSessionId: null,
    sourceAvailable: false, favorited: false, lastActivityAt: 100,
    environmentId: "local", environmentKind: "local", ...overrides,
  };
}

function createStore(targets: SessionBulkDeleteTarget[]) {
  return {
    getSessionDeletionTargets: vi.fn(async () => targets),
    listEnvironments: vi.fn(async () => []),
    deleteSessionRecords: vi.fn(async (keys: readonly string[]) => [...keys]),
  } as unknown as SessionStore;
}

describe("SessionBulkDeleteService", () => {
  it("previews an empty cleanup scope without failing", async () => {
    const store = createStore([]);
    await expect(new SessionBulkDeleteService(store).preview({ sessionKeys: [], liveSessionKeys: [], inactiveBefore: 200 })).resolves.toMatchObject({
      requestedCount: 0,
      deletableCount: 0,
      skipped: [],
    });
  });

  it("previews protected sessions from one target lookup", async () => {
    const targets = [
      target("old"),
      target("live"),
      target("favorite", { favorited: true }),
      target("recent", { lastActivityAt: 500 }),
      target("pi", { source: "pi-cli" }),
      target("hermes", { source: "hermes" as SessionSource }),
      target("opencode", { source: "opencode-cli" }),
      target("codewiz", { source: "codewiz-cli" }),
      target("cursor", { source: "cursor-agent", filePath: "synthetic/state.vscdb", sourceAvailable: true }),
    ];
    const store = createStore(targets);
    const preview = await new SessionBulkDeleteService(store).preview({
      sessionKeys: [...targets.map((item) => item.sessionKey), "missing"],
      liveSessionKeys: ["live"], inactiveBefore: 200, protectFavorites: false,
    });
    expect(preview.deletableCount).toBe(1);
    expect(preview.skipped.map((item) => item.reason)).toEqual([
      "live", "favorite", "recent", "read-only",
      "shared-database", "shared-database", "shared-database", "shared-database", "not-found",
    ]);
    expect(store.getSessionDeletionTargets).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly selected favorite when favorite protection is disabled", async () => {
    const store = createStore([target("favorite", { favorited: true })]);
    const preview = await new SessionBulkDeleteService(store).preview({
      sessionKeys: ["favorite"], liveSessionKeys: [], protectFavorites: false,
    });
    expect(preview.deletableCount).toBe(1);
    expect(preview.skipped).toEqual([]);
  });

  it("previews and deletes an entire descendant tree as one unit", async () => {
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const store = createStore(targets);
    const service = new SessionBulkDeleteService(store);

    await expect(service.preview({ sessionKeys: ["parent"], liveSessionKeys: [] })).resolves.toMatchObject({
      requestedCount: 1,
      matchedCount: 1,
      deletableCount: 2,
    });
    await expect(service.delete({ sessionKeys: ["parent"], liveSessionKeys: [] })).resolves.toMatchObject({
      deletedSessionKeys: ["parent", "child"],
      failed: [],
    });
    expect(store.deleteSessionRecords).toHaveBeenCalledWith(["parent", "child"]);
  });

  it("keeps the whole tree when a descendant is live", async () => {
    const targets = [
      target("parent"),
      target("child", { cascadeRootSessionKey: "parent", isSubagent: true, parentSessionId: "parent" }),
    ];
    const preview = await new SessionBulkDeleteService(createStore(targets)).preview({
      sessionKeys: ["parent"],
      liveSessionKeys: ["child"],
    });

    expect(preview.deletableCount).toBe(0);
    expect(preview.skipped).toMatchObject([{ sessionKey: "child", reason: "live" }]);
  });

  it("keeps source files untouched when the cascade root is cache-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cached-tree-delete-"));
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        sourceAvailable: true,
        filePath: root,
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    try {
      await expect(new SessionBulkDeleteService(createStore(targets)).delete({
        sessionKeys: ["parent"],
        liveSessionKeys: [],
      })).resolves.toMatchObject({ deletedSessionKeys: ["parent", "child"], failed: [] });
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests orphaned subagent trees without explicit session keys", async () => {
    const orphan = target("orphan", { isSubagent: true, parentSessionId: "missing" });
    const store = createStore([orphan]);

    await expect(new SessionBulkDeleteService(store).preview({
      sessionKeys: [],
      liveSessionKeys: [],
      includeOrphanedSubagents: true,
    })).resolves.toMatchObject({ requestedCount: 1, matchedCount: 1, deletableCount: 1 });
    expect(store.getSessionDeletionTargets).toHaveBeenCalledWith([], true);
  });

  it("keeps failures retryable and deletes successful indexes in one batch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-bulk-delete-"));
    const targets = [target("cached"), target("directory", { sourceAvailable: true, filePath: root })];
    const store = createStore(targets);
    try {
      const result = await new SessionBulkDeleteService(store).delete({ sessionKeys: ["cached", "directory"], liveSessionKeys: [] });
      expect(result.deletedSessionKeys).toEqual(["cached"]);
      expect(result.failed).toMatchObject([{ sessionKey: "directory", reason: "delete-failed" }]);
      expect(store.getSessionDeletionTargets).toHaveBeenCalledTimes(1);
      expect(store.deleteSessionRecords).toHaveBeenCalledTimes(1);
      expect(store.deleteSessionRecords).toHaveBeenCalledWith(["cached"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
