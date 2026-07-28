import { describe, expect, it } from "vitest";
import { PostgresDatabase } from "./postgres/database";
import { POSTGRES_MIGRATIONS } from "./postgres/schema";
import { PGliteTestPool } from "./postgres/test-pglite";
import { findSessionFamily } from "./session-family";

async function setupDatabase(): Promise<PostgresDatabase> {
  const database = new PostgresDatabase(new PGliteTestPool(), {
    migrationLock: false,
    migrations: POSTGRES_MIGRATIONS,
  });
  await database.initialize();
  await database.query(`
    insert into agent_recall.environments (
      id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
    ) values ('ssh-dev', 'ssh', 'SSH dev', 'none', true, 'idle', now(), now())
  `);
  return database;
}

async function insertSession(
  database: PostgresDatabase,
  input: {
    sessionKey: string;
    rawId: string;
    title: string;
    parentSessionId?: string | null;
    source?: string;
    environmentId?: string;
    timestamp?: number;
    hidden?: boolean;
    messageCount?: number;
    aiSummary?: string | null;
  },
): Promise<void> {
  await database.query(`
    insert into agent_recall.sessions (
      session_key, raw_id, source, environment_id, project_path, file_path,
      original_title, first_question, started_at, file_mtime_ms, file_size,
      hidden, message_count, ai_summary, indexed_at, is_subagent, parent_session_id
    ) values (
      $1, $2, $3, $4, '/repo', $5,
      $6, $6, $7, 0, 0,
      $8, $9, $10, now(), $11, $12
    )
  `, [
    input.sessionKey,
    input.rawId,
    input.source ?? "codex-cli",
    input.environmentId ?? "local",
    `/tmp/${input.rawId}.jsonl`,
    input.title,
    new Date(input.timestamp ?? 1).toISOString(),
    input.hidden ?? false,
    input.messageCount ?? 1,
    input.aiSummary ?? null,
    Boolean(input.parentSessionId),
    input.parentSessionId ?? null,
  ]);
}

describe("findSessionFamily", () => {
  it("returns an empty family for an unknown session", async () => {
    const database = await setupDatabase();
    await expect(findSessionFamily(database, "missing")).resolves.toEqual({
      parent: null,
      children: [],
      truncated: false,
    });
    await database.close();
  });

  it("builds an ordered descendant tree and returns the direct parent", async () => {
    const database = await setupDatabase();
    await insertSession(database, { sessionKey: "codex:root", rawId: "root", title: "Root" });
    await insertSession(database, {
      sessionKey: "codex:child-b",
      rawId: "child-b",
      title: "Child B",
      parentSessionId: "root",
      timestamp: 3,
    });
    await insertSession(database, {
      sessionKey: "codex:child-a",
      rawId: "child-a",
      title: "Child A",
      parentSessionId: "root",
      timestamp: 2,
      messageCount: 4,
      aiSummary: "Investigated the first task.",
    });
    await insertSession(database, {
      sessionKey: "codex:grandchild",
      rawId: "grandchild",
      title: "Grandchild",
      parentSessionId: "child-a",
      timestamp: 4,
    });

    const family = await findSessionFamily(database, "codex:root");
    expect(family.children.map((node) => node.sessionKey)).toEqual([
      "codex:child-a",
      "codex:child-b",
    ]);
    expect(family.children[0]).toMatchObject({
      messageCount: 4,
      aiSummary: "Investigated the first task.",
      environmentLabel: "Local",
    });
    expect(family.children[0]!.children[0]!.sessionKey).toBe("codex:grandchild");
    expect(family.truncated).toBe(false);

    await expect(findSessionFamily(database, "codex:child-a")).resolves.toMatchObject({
      parent: { sessionKey: "codex:root", title: "Root" },
    });
    await database.close();
  });

  it("does not cross source or environment boundaries and excludes hidden children", async () => {
    const database = await setupDatabase();
    await insertSession(database, { sessionKey: "codex:root", rawId: "root", title: "Root" });
    await insertSession(database, {
      sessionKey: "codex:visible",
      rawId: "visible",
      title: "Visible",
      parentSessionId: "root",
    });
    await insertSession(database, {
      sessionKey: "codex:hidden",
      rawId: "hidden",
      title: "Hidden",
      parentSessionId: "root",
      hidden: true,
    });
    await insertSession(database, {
      sessionKey: "ssh:duplicate",
      rawId: "duplicate",
      title: "SSH duplicate",
      parentSessionId: "root",
      environmentId: "ssh-dev",
    });
    await insertSession(database, {
      sessionKey: "claude:duplicate",
      rawId: "duplicate",
      title: "Claude duplicate",
      parentSessionId: "root",
      source: "claude-cli",
    });

    const family = await findSessionFamily(database, "codex:root");
    expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:visible"]);
    await database.close();
  });

  it("marks cyclic relationships as truncated without repeating nodes", async () => {
    const database = await setupDatabase();
    await insertSession(database, {
      sessionKey: "codex:cycle-a",
      rawId: "cycle-a",
      title: "Cycle A",
      parentSessionId: "cycle-b",
    });
    await insertSession(database, {
      sessionKey: "codex:cycle-b",
      rawId: "cycle-b",
      title: "Cycle B",
      parentSessionId: "cycle-a",
    });

    const family = await findSessionFamily(database, "codex:cycle-a");
    expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:cycle-b"]);
    expect(family.children[0]!.children).toEqual([]);
    expect(family.truncated).toBe(true);
    await database.close();
  });
});
