import { describe, expect, it, vi } from "vitest";
import { createInMemoryStore } from "./postgres/test-session-store";
import { loadWslSessionDetailPayload, type RemoteSessionFilePayload } from "./remote-session-loader";
import { remoteSessionKey } from "./session-environment";
import type { SessionEnvironment } from "./types";
import { WslSessionIndexer } from "./wsl-session-indexer";

async function wslEnvironment(store: ReturnType<typeof createInMemoryStore>): Promise<SessionEnvironment> {
  return store.upsertEnvironment({
    id: "wsl-ubuntu",
    kind: "wsl",
    label: "WSL · Ubuntu",
    wslDistribution: "Ubuntu",
    enabled: true,
  });
}

function sessionPayload(mtimeMs: number, size: number): RemoteSessionFilePayload {
  return {
    kind: "codex-session",
    source: "codex-cli",
    path: "/home/me/.codex/sessions/rollout.jsonl",
    mtimeMs,
    size,
    content: [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-26T10:00:00Z", payload: { id: "wsl-session", cwd: "/repo" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-26T10:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "background WSL indexing" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-26T10:02:00Z",
        payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: "pwd" }), call_id: "call-1" },
      }),
    ].join("\n"),
  };
}

describe("WslSessionIndexer", () => {
  it("hydrates summary-only WSL sessions for full-text search and skips unchanged files", async () => {
    const store = createInMemoryStore();
    const environment = await wslEnvironment(store);
    const session = {
      sessionKey: remoteSessionKey(environment, "codex-cli", "wsl-session"),
      rawId: "wsl-session",
      source: "codex-cli" as const,
      projectPath: "/repo",
      filePath: "/home/me/.codex/sessions/rollout.jsonl",
      originalTitle: "WSL summary",
      firstQuestion: "initial question",
      timestamp: Date.parse("2026-07-26T10:00:00Z"),
      fileMtimeMs: 10,
      fileSize: 20,
      prUrl: null,
      prNumber: null,
      environmentId: environment.id,
      environmentKind: "wsl" as const,
      environmentLabel: environment.label,
    };
    await store.upsertIndexedSessionSummary(session, 1);
    const fetchSessionFile = vi.fn(async () => sessionPayload(10, 20));
    const indexer = new WslSessionIndexer({
      store,
      fetchSessionFile,
      loadSession: (currentEnvironment, payload, summary) =>
        loadWslSessionDetailPayload(currentEnvironment, payload, summary, { includeTraceEvents: true }),
    });

    try {
      await indexer.request(environment);
      expect(fetchSessionFile).toHaveBeenCalledTimes(1);
      await expect(store.searchSessions({ query: "background WSL" })).resolves.toHaveLength(1);
      await expect(store.getTraceEvents(session.sessionKey)).resolves.toEqual([
        expect.objectContaining({ kind: "tool_call", title: "shell · pwd", callId: "call-1" }),
      ]);

      await indexer.request(environment);
      expect(fetchSessionFile).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });

  it("reindexes a WSL session when the summary reports a new file version", async () => {
    const store = createInMemoryStore();
    const environment = await wslEnvironment(store);
    const session = {
      sessionKey: remoteSessionKey(environment, "codex-cli", "wsl-session"),
      rawId: "wsl-session",
      source: "codex-cli" as const,
      projectPath: "/repo",
      filePath: "/home/me/.codex/sessions/rollout.jsonl",
      originalTitle: "WSL summary",
      firstQuestion: "initial question",
      timestamp: Date.parse("2026-07-26T10:00:00Z"),
      fileMtimeMs: 10,
      fileSize: 20,
      prUrl: null,
      prNumber: null,
      environmentId: environment.id,
      environmentKind: "wsl" as const,
      environmentLabel: environment.label,
    };
    await store.upsertIndexedSessionSummary(session, 1);
    const fetchSessionFile = vi
      .fn<() => Promise<RemoteSessionFilePayload>>()
      .mockResolvedValueOnce(sessionPayload(10, 20))
      .mockResolvedValueOnce(sessionPayload(30, 40));
    const indexer = new WslSessionIndexer({
      store,
      fetchSessionFile,
      loadSession: loadWslSessionDetailPayload,
    });

    try {
      await indexer.request(environment);
      await store.upsertIndexedSessionSummary({ ...session, fileMtimeMs: 30, fileSize: 40 }, 1);
      await indexer.request(environment);
      expect(fetchSessionFile).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("does not retry the same failed file version until it changes", async () => {
    const store = createInMemoryStore();
    const environment = await wslEnvironment(store);
    const session = {
      sessionKey: remoteSessionKey(environment, "codex-cli", "wsl-session"),
      rawId: "wsl-session",
      source: "codex-cli" as const,
      projectPath: "/repo",
      filePath: "/home/me/.codex/sessions/rollout.jsonl",
      originalTitle: "WSL summary",
      firstQuestion: "initial question",
      timestamp: Date.parse("2026-07-26T10:00:00Z"),
      fileMtimeMs: 10,
      fileSize: 20,
      prUrl: null,
      prNumber: null,
      environmentId: environment.id,
      environmentKind: "wsl" as const,
      environmentLabel: environment.label,
    };
    await store.upsertIndexedSessionSummary(session, 1);
    const fetchSessionFile = vi.fn(async () => {
      throw new Error("Maximum call stack size exceeded");
    });
    const onSessionError = vi.fn();
    const indexer = new WslSessionIndexer({
      store,
      fetchSessionFile,
      loadSession: loadWslSessionDetailPayload,
      onSessionError,
    });

    try {
      await indexer.request(environment);
      await indexer.request(environment);
      expect(fetchSessionFile).toHaveBeenCalledTimes(1);
      expect(onSessionError).toHaveBeenCalledTimes(1);

      await store.upsertIndexedSessionSummary({ ...session, fileMtimeMs: 30, fileSize: 40 }, 1);
      await indexer.request(environment);
      expect(fetchSessionFile).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });
});
