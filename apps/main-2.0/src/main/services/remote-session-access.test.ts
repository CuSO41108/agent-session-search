import { describe, expect, it, vi } from "vitest";

import type { RemoteSessionFilePayload } from "../../core/remote-session-loader";
import type { SessionStore } from "../../core/session-store";
import type { SessionEnvironment, SessionSearchResult } from "../../core/types";
import { RemoteSessionAccess } from "./remote-session-access";

const { fetchRemoteSessionFilePayload } = vi.hoisted(() => ({
  fetchRemoteSessionFilePayload: vi.fn(),
}));

vi.mock("../../core/remote-sync", async () => ({
  ...await vi.importActual<typeof import("../../core/remote-sync")>("../../core/remote-sync"),
  fetchRemoteSessionFilePayload,
}));

const session = {
  sessionKey: "ssh:ssh:test:codex-cli:remote-session",
  rawId: "remote-session",
  source: "codex-cli",
  environmentId: "ssh:test",
  environmentKind: "ssh",
  environmentLabel: "test",
  projectPath: "/repo",
  filePath: "/home/me/.codex/sessions/rollout.jsonl",
  originalTitle: "Remote session",
  timestamp: Date.parse("2026-07-30T08:00:00.000Z"),
  isSubagent: false,
  parentSessionId: null,
  fileMtimeMs: 123,
  fileSize: 456,
} as SessionSearchResult;

const sshEnvironment = {
  id: "ssh:test",
  kind: "ssh",
  label: "test",
  hostAlias: "test",
  host: "test.example.com",
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
} as SessionEnvironment;

function createAccess(
  contentFresh: boolean,
  currentSession: SessionSearchResult = session,
  environment: SessionEnvironment = sshEnvironment,
) {
  const isSessionContentFresh = vi.fn(async () => contentFresh);
  const getMessages = vi.fn(async () => [{ role: "assistant" }]);
  const upsertIndexedSession = vi.fn(async () => undefined);
  const store = {
    getSession: vi.fn(async () => currentSession),
    getEnvironment: vi.fn(async () => environment),
    isSessionContentFresh,
    getMessages,
    upsertIndexedSession,
  } as unknown as SessionStore;
  const runSshCommand = vi.fn(async () => "");
  return {
    access: new RemoteSessionAccess({
      getStore: () => store,
      runSshCommand,
      runSshHealthCommand: vi.fn(async () => ""),
    }),
    getMessages,
    isSessionContentFresh,
    runSshCommand,
    upsertIndexedSession,
  };
}

function paginatedCodexPayload(rawId: string): RemoteSessionFilePayload {
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-07-30T08:00:00.000Z",
      payload: { id: rawId, cwd: "/repo", history_mode: "paginated" },
    },
    {
      type: "event_msg",
      timestamp: "2026-07-30T08:00:01.000Z",
      payload: { type: "task_started", turn_id: "turn-1" },
    },
    {
      type: "response_item",
      timestamp: "2026-07-30T08:00:02.000Z",
      payload: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "still running" }],
      },
    },
  ];
  return {
    kind: "codex-session",
    source: "codex-cli",
    path: "/home/me/.codex/sessions/rollout.jsonl",
    mtimeMs: 123,
    size: 456,
    content: rows.map((row) => JSON.stringify(row)).join("\n"),
  };
}

describe("RemoteSessionAccess", () => {
  it("uses the indexed source version instead of message presence for hydration", async () => {
    const stale = createAccess(false);
    await expect(stale.access.hasHydratedDetails(session.sessionKey)).resolves.toBe(false);
    expect(stale.isSessionContentFresh).toHaveBeenCalledWith(
      session.sessionKey,
      session.fileMtimeMs,
      session.fileSize,
    );
    expect(stale.getMessages).not.toHaveBeenCalled();

    const fresh = createAccess(true);
    await expect(fresh.access.hasHydratedDetails(session.sessionKey)).resolves.toBe(true);
    expect(fresh.getMessages).not.toHaveBeenCalled();
  });

  it("does not fetch an unchanged remote version again", async () => {
    const fresh = createAccess(true);

    await fresh.access.ensureDetails(session.sessionKey);
    await fresh.access.ensureDetails(session.sessionKey);

    expect(fresh.runSshCommand).not.toHaveBeenCalled();
    expect(fresh.isSessionContentFresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["SSH", session, sshEnvironment],
    [
      "WSL",
      {
        ...session,
        sessionKey: "wsl:wsl-ubuntu:codex-cli:remote-session",
        environmentId: "wsl-ubuntu",
        environmentKind: "wsl",
        environmentLabel: "WSL · Ubuntu",
      } as SessionSearchResult,
      {
        id: "wsl-ubuntu",
        kind: "wsl",
        label: "WSL · Ubuntu",
        wslDistribution: "Ubuntu",
        enabled: true,
      } as SessionEnvironment,
    ],
  ])("persists paginated Codex provenance when hydrating %s details", async (_kind, currentSession, environment) => {
    const current = createAccess(false, currentSession, environment);
    fetchRemoteSessionFilePayload.mockResolvedValueOnce(paginatedCodexPayload(currentSession.rawId));

    await current.access.ensureDetails(currentSession.sessionKey);

    expect(current.upsertIndexedSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: currentSession.sessionKey }),
      expect.any(Array),
      expect.any(Array),
      expect.any(Array),
      {
        historyMode: "paginated",
        messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:message-1" }],
        activeTurnIds: ["turn-1"],
      },
    );
  });
});
