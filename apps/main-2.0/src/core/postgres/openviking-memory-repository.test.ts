import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore } from "../session-store";
import { PostgresDatabase } from "./database";
import { PostgresOpenVikingMemoryRepository } from "./openviking-memory-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

describe("PostgresOpenVikingMemoryRepository", () => {
  let database: PostgresDatabase;
  let repository: PostgresOpenVikingMemoryRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresOpenVikingMemoryRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("stores one stable OpenViking workspace mapping per directory", async () => {
    const created = await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });

    await expect(repository.listWorkspaces()).resolves.toEqual([created]);
    await expect(repository.getWorkspace("workspace-1")).resolves.toEqual(created);
    await expect(repository.findWorkspaceByRootPath("/projects/app")).resolves.toEqual(created);
    await expect(repository.findWorkspaceByIdentity("repo:github.com/acme/app")).resolves.toEqual(created);
    await expect(repository.addWorkspace({
      id: "workspace-2",
      userId: "workspace_other",
      rootPath: "/projects/app",
      identity: "path:other",
      displayName: "duplicate",
    })).rejects.toThrow();
  });

  it("keeps directory tracking independent from legacy session-import tables", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });

    const result = await database.query<{ count: number | string }>(
      "select count(*) as count from agent_recall.openviking_import_jobs where workspace_id = $1",
      ["workspace-1"],
    );

    expect(Number(result.rows[0]?.count ?? 0)).toBe(0);
  });

  it("relinks and pauses directory tracking while keeping the OpenViking user", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/old",
      identity: "repo:github.com/acme/app",
      displayName: "old",
    });

    const relinked = await repository.relinkWorkspace("workspace-1", "/projects/new", "new");

    expect(relinked).toMatchObject({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/new",
      displayName: "new",
    });
    await expect(repository.setWorkspaceManaged("workspace-1", false)).resolves.toMatchObject({
      id: "workspace-1",
      managed: false,
    });
  });

  it("exposes directory workspaces through SessionStore without import state", async () => {
    const store = new SessionStore(database);
    const created = await store.addOpenVikingWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "path:workspace-1",
      displayName: "app",
    });

    await expect(store.listOpenVikingWorkspaces()).resolves.toEqual([created]);
    await expect(store.findOpenVikingWorkspaceByRootPath("/projects/app")).resolves.toEqual(created);
    await expect(store.findOpenVikingWorkspaceByIdentity("path:workspace-1")).resolves.toEqual(created);
    await expect(store.setOpenVikingWorkspaceManaged("workspace-1", false)).resolves.toMatchObject({
      managed: false,
    });
    expect(await store.getOpenVikingWorkspace("workspace-1")).not.toHaveProperty("importState");
  });

  it("keeps user-edited memories authoritative and locked against automatic extraction", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });
    const uri = "viking://user/memories/preferences/editor.md";
    await repository.saveUserMemory({
      workspaceId: "workspace-1",
      uri,
      title: "Editor",
      content: "Prefer concise diffs.",
      source: "user-edit",
      now: "2026-08-05T00:00:00.000Z",
    });

    const conflicts = await repository.applyCommitResult({
      run: {
        taskId: "task-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        agent: "codex",
        trigger: "token-threshold",
        state: "completed",
        sourceTurnIds: ["turn-1"],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:01:00.000Z",
        completedAt: "2026-08-05T00:02:00.000Z",
        updatedAt: "2026-08-05T00:02:00.000Z",
      },
      changes: [{
        kind: "add",
        uri,
        memoryType: "preferences",
        after: "Use verbose diffs.",
      }],
      memoryDiffUri: "viking://resources/memory_diff.json",
    });

    expect(conflicts).toEqual([expect.objectContaining({
      uri,
      content: "Prefer concise diffs.",
    })]);
    await expect(repository.getMemoryControl("workspace-1", uri)).resolves.toMatchObject({
      authority: "user",
      locked: true,
      lockedContent: "Prefer concise diffs.",
      lifecycle: "active",
    });
  });

  it("records online Commit evidence, feedback and runtime diagnostics", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });
    const uri = "viking://user/memories/events/release.md";
    await repository.applyCommitResult({
      run: {
        taskId: "task-2",
        workspaceId: "workspace-1",
        sessionId: "session-2",
        agent: "claude",
        trigger: "explicit-remember",
        state: "completed",
        sourceTurnIds: ["turn-a", "turn-b"],
        tokenEstimate: 240,
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:30.000Z",
        updatedAt: "2026-08-05T00:00:30.000Z",
      },
      changes: [{
        kind: "add",
        uri,
        memoryType: "events",
        after: "Release requires a user-facing note.",
      }],
      archiveUri: "viking://session/archive/session-2.md",
      memoryDiffUri: "viking://resources/memory_diff.json",
      modelSnapshot: { model: "deepseek-v4-flash" },
      policySnapshot: { trigger: "explicit-remember" },
    });
    await repository.recordOperationEvent({
      id: "event-1",
      workspaceId: "workspace-1",
      sessionId: "session-2",
      taskId: "task-2",
      phase: "verify",
      status: "completed",
      startedAt: "2026-08-05T00:00:00.000Z",
      completedAt: "2026-08-05T00:00:30.000Z",
      durationMs: 30_000,
    });
    await repository.recordRecallTrace({
      id: "trace-1",
      workspaceId: "workspace-1",
      agent: "codex",
      query: "release",
      contextualQuery: "release",
      searchedScopes: ["workspace-1"],
      searchedTypes: ["events"],
      candidates: [],
      injectedUris: [uri],
      injectedTokenCount: 18,
      durationMs: 24,
      createdAt: "2026-08-05T00:01:00.000Z",
    });

    await expect(repository.getMemoryControl("workspace-1", uri)).resolves.toMatchObject({
      authority: "model",
      lifecycle: "active",
      evidenceStatus: "verified",
      evidenceCount: 1,
    });
    await expect(repository.listMemoryEvidence("workspace-1", uri)).resolves.toEqual([
      expect.objectContaining({
        sourceSessionId: "session-2",
        sourceAgent: "claude",
        sourceTurnIds: ["turn-a", "turn-b"],
        remoteTaskId: "task-2",
      }),
    ]);
    await expect(repository.recordMemoryFeedback({
      id: "feedback-1",
      workspaceId: "workspace-1",
      memoryUri: uri,
      feedback: "outdated",
      actor: "user",
      createdAt: "2026-08-05T00:02:00.000Z",
    })).resolves.toMatchObject({
      lifecycle: "superseded",
      evidenceStatus: "invalid",
      evidenceCount: 0,
    });
    await expect(repository.getControlDiagnostics()).resolves.toMatchObject({
      recentEvents: [expect.objectContaining({ id: "event-1", phase: "verify" })],
      recentRecallTraces: [expect.objectContaining({ id: "trace-1", injectedTokenCount: 18 })],
      recentCommits: [expect.objectContaining({ taskId: "task-2", state: "completed" })],
    });
  });

  it("invalidates deleted source-session evidence without discarding independently supported memory", async () => {
    await repository.addWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/projects/app",
      identity: "repo:github.com/acme/app",
      displayName: "app",
    });
    const uri = "viking://user/memories/events/release.md";
    const commit = async (taskId: string, sourceSessionId: string) => repository.applyCommitResult({
      run: {
        taskId,
        workspaceId: "workspace-1",
        sessionId: `agent-recall-${taskId}`,
        sourceSessionId,
        agent: "codex",
        trigger: "session-end",
        state: "completed",
        sourceTurnIds: [`turn-${taskId}`],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:10.000Z",
        updatedAt: "2026-08-05T00:00:10.000Z",
      },
      changes: [{ kind: "add", uri, memoryType: "events", after: "Release note required." }],
    });
    await commit("task-1", "session-1");
    await commit("task-2", "session-2");

    await expect(repository.invalidateSourceSessionEvidence([{
      sourceSessionId: "session-1",
      sourceAgent: "codex",
    }], "2026-08-05T01:00:00.000Z")).resolves.toEqual(["workspace-1"]);
    await expect(repository.getMemoryControl("workspace-1", uri)).resolves.toMatchObject({
      lifecycle: "active",
      evidenceStatus: "verified",
      evidenceCount: 1,
    });

    await expect(repository.invalidateSourceSessionEvidence([{
      sourceSessionId: "session-2",
      sourceAgent: "codex",
    }], "2026-08-05T02:00:00.000Z")).resolves.toEqual(["workspace-1"]);
    await expect(repository.getMemoryControl("workspace-1", uri)).resolves.toMatchObject({
      lifecycle: "invalidated",
      evidenceStatus: "invalid",
      evidenceCount: 0,
    });
    await expect(repository.getControlDiagnostics()).resolves.toMatchObject({
      recentEvents: expect.arrayContaining([expect.objectContaining({
        phase: "evidence-invalidate",
        details: expect.objectContaining({ source: "session-delete" }),
      })]),
    });
  });
});
