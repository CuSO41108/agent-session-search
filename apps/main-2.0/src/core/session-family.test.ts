import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexedSession, SessionMessage, SessionTraceEvent } from "./types";
import { findSessionFamily } from "./session-family";
import { PostgresDatabase } from "./postgres/database";
import { PostgresSessionRepository } from "./postgres/session-repository";
import { POSTGRES_MIGRATIONS } from "./postgres/schema";
import { PGliteTestPool } from "./postgres/test-pglite";

function session(overrides: Partial<IndexedSession>): IndexedSession {
  return {
    sessionKey: "codex:root",
    rawId: "root",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/root.jsonl",
    originalTitle: "Root",
    firstQuestion: "Root",
    timestamp: Date.parse("2026-08-12T09:00:00.000Z"),
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

describe("findSessionFamily", () => {
  let database: PostgresDatabase;
  let repository: PostgresSessionRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresSessionRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("reports the parent Turn that spawned each subagent", async () => {
    const messages: SessionMessage[] = [
      {
        index: 0,
        role: "user",
        content: "first",
        timestamp: "2026-08-12T09:00:00.000Z",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        role: "user",
        content: "delegate",
        timestamp: "2026-08-12T09:05:00.000Z",
        sourceTurnId: "turn-2",
      },
    ];
    const traces: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Session metadata",
        detail: "",
        timestamp: "2026-08-12T08:59:00.000Z",
        eventType: "codex.session.metadata",
        status: "completed",
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "agent · spawn_agent",
        detail: "",
        timestamp: "2026-08-12T09:05:01.000Z",
        eventType: "codex.collaboration.tool",
        status: "completed",
        sourceTurnId: "turn-2",
        attributes: {
          codex: { rawType: "CollabAgentToolCall" },
          collaboration: { tool: "spawn_agent", receiverThreadIds: ["child"] },
        },
      },
    ];
    await repository.upsertIndexedSession(session({}), messages, [], traces);
    await repository.upsertIndexedSession(session({
      sessionKey: "codex:child",
      rawId: "child",
      filePath: "/tmp/child.jsonl",
      originalTitle: "Child",
      firstQuestion: "Child",
      isSubagent: true,
      parentSessionId: "root",
    }), [], [], []);

    const rootFamily = await findSessionFamily(database, "codex:root");
    expect(rootFamily.children[0].originTurnIndex).toBe(1);
    const childFamily = await findSessionFamily(database, "codex:child");
    expect(childFamily.parentOriginTurnIndex).toBe(1);
    expect(childFamily.parent?.originTurnIndex).toBeNull();
  });
});
