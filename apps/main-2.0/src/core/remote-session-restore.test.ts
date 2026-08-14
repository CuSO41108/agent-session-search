import { describe, expect, it, vi } from "vitest";
import { restoreRemotePortableSession } from "./remote-session-restore";
import type { PortableSession } from "./types";

const PORTABLE: PortableSession = {
  sourceSessionKey: "codex:abc",
  sourceAgent: "codex",
  title: "Fix auth",
  projectPath: "/device-a/repo",
  startedAt: "2026-07-03T10:00:00.000Z",
  messages: [
    { role: "user", content: "broken auth", timestamp: "2026-07-03T10:00:00.000Z", index: 0 },
    { role: "assistant", content: "fixed auth", timestamp: "2026-07-03T10:01:00.000Z", index: 1 },
  ],
};

describe("restoreRemotePortableSession", () => {
  it("restores a remote portable session with the selected local project path", async () => {
    const write = vi.fn(async (_target, session: PortableSession) => ({
      sessionId: "target-session",
      filePath: "/target/session.jsonl",
      projectPath: session.projectPath,
    }));
    const record = vi.fn();
    const refreshIndex = vi.fn();
    const launch = vi.fn();

    const result = await restoreRemotePortableSession({
      remoteId: "remote-1",
      portable: PORTABLE,
      target: "claude",
      localProjectPath: "/device-b/repo",
      deps: {
        inspectCli: vi.fn(),
        prepare: async (session) => ({ session, strategy: "complete" }),
        write,
        record,
        refreshIndex,
        launch,
        resumeCommand: (_target, sessionId, projectPath) => `cd ${projectPath} && claude --resume ${sessionId}`,
        fallbackResumeCommand: () => "claude --resume target-session",
        idFactory: () => "migration-id",
        now: () => 123,
        projectPathExists: async () => true,
        projectPathIsDirectory: async () => true,
      },
    });

    expect(write).toHaveBeenCalledWith("claude", expect.objectContaining({ projectPath: "/device-b/repo" }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionKey: "remote:remote-1",
      sourceAgent: "codex",
      targetAgent: "claude",
    }));
    expect(refreshIndex).toHaveBeenCalledWith("claude", "/target/session.jsonl", "target-session");
    expect(launch).toHaveBeenCalledWith("claude", "target-session", "/device-b/repo");
    expect(result).toMatchObject({
      target: "claude",
      targetSessionId: "target-session",
      strategy: "complete",
      launched: true,
      indexed: true,
    });
  });

  it("restores a remote portable session without a project path", async () => {
    const write = vi.fn(async (_target, session: PortableSession) => ({
      sessionId: "target-session",
      filePath: "/target/session.jsonl",
      projectPath: session.projectPath,
    }));
    const projectPathExists = vi.fn(async () => true);
    const projectPathIsDirectory = vi.fn(async () => true);
    const launch = vi.fn();

    await restoreRemotePortableSession({
      remoteId: "remote-pathless",
      portable: PORTABLE,
      target: "codex",
      localProjectPath: "   ",
      deps: {
        inspectCli: vi.fn(),
        prepare: async (session) => ({ session, strategy: "complete" }),
        write,
        record: vi.fn(),
        refreshIndex: vi.fn(),
        launch,
        resumeCommand: (_target, sessionId, projectPath) => `${projectPath}:${sessionId}`,
        fallbackResumeCommand: () => "codex resume target-session",
        idFactory: () => "migration-id",
        now: () => 123,
        projectPathExists,
        projectPathIsDirectory,
      },
    });

    expect(projectPathExists).not.toHaveBeenCalled();
    expect(projectPathIsDirectory).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("codex", expect.objectContaining({ projectPath: "" }));
    expect(launch).toHaveBeenCalledWith("codex", "target-session", "");
  });

  it("rejects a missing local project path before writing", async () => {
    const write = vi.fn();
    await expect(
      restoreRemotePortableSession({
        remoteId: "remote-1",
        portable: PORTABLE,
        target: "codex",
        localProjectPath: "/missing",
        deps: {
          inspectCli: vi.fn(),
          prepare: async (session) => ({ session, strategy: "complete" }),
          write,
          record: vi.fn(),
          refreshIndex: vi.fn(),
          launch: vi.fn(),
          resumeCommand: () => "codex resume target-session",
          fallbackResumeCommand: () => "codex resume target-session",
          idFactory: () => "migration-id",
          now: () => 123,
          projectPathExists: async () => false,
          projectPathIsDirectory: async () => false,
        },
      }),
    ).rejects.toThrow("does not exist");
    expect(write).not.toHaveBeenCalled();
  });

  it("restores bundled subagents with remapped native parent ids", async () => {
    const extraSubagents = Array.from({ length: 199 }, (_, index): PortableSession => ({
      ...PORTABLE,
      sourceSessionKey: `cursor:extra-${index}`,
      sourceSessionId: `source-extra-${index}`,
      title: `Extra ${index}`,
      isSubagent: true,
      parentSessionId: "source-parent",
      subagents: [],
    }));
    const targetIds = [
      "target-parent",
      "target-child",
      "target-grandchild",
      ...extraSubagents.map((_, index) => `target-extra-${index}`),
    ];
    const write = vi.fn(async (_target, _session, targetSessionId?: string) => ({
      sessionId: targetSessionId!,
      filePath: `/target/${targetSessionId}.jsonl`,
    }));
    const portable: PortableSession = {
      ...PORTABLE,
      sourceSessionId: "source-parent",
      subagents: [
        {
          ...PORTABLE,
          sourceSessionKey: "cursor:child",
          sourceSessionId: "source-child",
          title: "Child",
          isSubagent: true,
          parentSessionId: "source-parent",
          subagents: [],
        },
        {
          ...PORTABLE,
          sourceSessionKey: "cursor:grandchild",
          sourceSessionId: "source-grandchild",
          title: "Grandchild",
          isSubagent: true,
          parentSessionId: "source-child",
          subagents: [],
        },
        ...extraSubagents,
      ],
    };
    const refreshIndex = vi.fn();

    const result = await restoreRemotePortableSession({
      remoteId: "remote-family",
      portable,
      target: "codex",
      localProjectPath: "/device-b/repo",
      deps: {
        inspectCli: vi.fn(),
        prepare: async (session) => ({ session, strategy: "complete" }),
        write,
        record: vi.fn(),
        refreshIndex,
        launch: vi.fn(),
        resumeCommand: () => "codex resume target-parent",
        fallbackResumeCommand: () => "codex resume target-parent",
        idFactory: vi.fn()
          .mockReturnValueOnce("migration-parent")
          .mockReturnValueOnce("migration-child")
          .mockReturnValueOnce("migration-grandchild"),
        targetSessionIdFactory: vi.fn(() => targetIds.shift()!),
        now: () => 123,
        projectPathExists: async () => true,
        projectPathIsDirectory: async () => true,
      },
    });

    expect(write).toHaveBeenNthCalledWith(1, "codex", expect.objectContaining({
      sourceSessionId: "source-parent",
      subagents: expect.arrayContaining([expect.objectContaining({
        sourceSessionId: "target-child",
        parentSessionId: "target-parent",
        subagentPath: "/root/migrated_source_child",
      })]),
    }), "target-parent");
    expect(write).toHaveBeenNthCalledWith(2, "codex", expect.objectContaining({
      sourceSessionId: "source-child",
      parentSessionId: "target-parent",
      subagents: [expect.objectContaining({
        sourceSessionId: "target-grandchild",
        parentSessionId: "target-child",
      })],
    }), "target-child");
    expect(write).toHaveBeenNthCalledWith(3, "codex", expect.objectContaining({
      sourceSessionId: "source-grandchild",
      parentSessionId: "target-child",
    }), "target-grandchild");
    expect(write).toHaveBeenCalledTimes(202);
    expect(refreshIndex).toHaveBeenCalledTimes(202);
    expect(result).toMatchObject({ targetSessionId: "target-parent", restoredSubagentCount: 201, indexed: true });
  });
});
