import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "./environments";
import { SessionsStore } from "./sessions";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
const openDatabases: DatabaseSyncType[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe("SessionsStore tree deletion", () => {
  it("expands recursive descendants and detects an orphan root without FTS5", () => {
    const { database, store } = createStore();
    insertSession(database, { sessionKey: "codex:parent", rawId: "parent" });
    insertSession(database, { sessionKey: "codex:child", rawId: "child", parentSessionId: "parent" });
    insertSession(database, { sessionKey: "codex:grandchild", rawId: "grandchild", parentSessionId: "child" });

    expect(store.getSessionDeletionTargets(["codex:parent"]).map((target) => target.sessionKey)).toEqual([
      "codex:parent",
      "codex:child",
      "codex:grandchild",
    ]);
    expect(store.deleteSessionRecord("codex:parent")).toBe(true);
    expect(store.getSessionDeletionTargets([], true).map((target) => target.sessionKey)).toEqual([
      "codex:child",
      "codex:grandchild",
    ]);
    expect(store.deleteSessionRecords(["codex:child"])).toEqual(["codex:child", "codex:grandchild"]);

    insertSession(database, { sessionKey: "codex:cycle-a", rawId: "cycle-a", parentSessionId: "cycle-b" });
    insertSession(database, { sessionKey: "codex:cycle-b", rawId: "cycle-b", parentSessionId: "cycle-a" });
    expect(store.getSessionDeletionTargets(["codex:cycle-a"]).map((target) => target.sessionKey)).toEqual([
      "codex:cycle-a",
      "codex:cycle-b",
    ]);
  });

  it("deletes Claude source artifacts before removing the full indexed tree", () => {
    const { database, store } = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v1-tree-delete-"));
    const parentFile = path.join(root, "parent.jsonl");
    const subagentsDirectory = path.join(root, "parent", "subagents");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const childMetadata = path.join(subagentsDirectory, "agent-child.meta.json");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    for (const filePath of [parentFile, childFile, childMetadata]) fs.writeFileSync(filePath, "fixture", "utf8");
    insertSession(database, {
      sessionKey: "claude:parent", rawId: "parent", source: "claude-cli", filePath: parentFile,
    });
    insertSession(database, {
      sessionKey: "claude:child", rawId: "child", source: "claude-cli", filePath: childFile,
      parentSessionId: "parent",
    });

    try {
      expect(store.deleteSession("claude:parent")).toBe(true);
      expect(database.prepare("SELECT session_key FROM sessions").all()).toEqual([]);
      expect(fs.existsSync(parentFile)).toBe(false);
      expect(fs.existsSync(path.join(root, "parent"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes a ZCode parent and descendants in one shared database operation", () => {
    const { database, store } = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v1-zcode-tree-delete-"));
    const databaseDirectory = path.join(root, "cli", "db");
    const sourceDatabasePath = path.join(databaseDirectory, "db.sqlite");
    fs.mkdirSync(databaseDirectory, { recursive: true });
    const sourceDatabase = new DatabaseSync(sourceDatabasePath);
    sourceDatabase.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    sourceDatabase.prepare("INSERT INTO session (id) VALUES (?), (?), (?)").run("parent", "child", "keep");
    sourceDatabase.close();
    insertSession(database, {
      sessionKey: "zcode:parent", rawId: "parent", source: "zcode-cli", filePath: sourceDatabasePath,
    });
    insertSession(database, {
      sessionKey: "zcode:child", rawId: "child", source: "zcode-cli", filePath: sourceDatabasePath,
      parentSessionId: "parent",
    });

    try {
      expect(store.deleteSession("zcode:parent")).toBe(true);
      const verificationDatabase = new DatabaseSync(sourceDatabasePath);
      try {
        expect(verificationDatabase.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "keep" }]);
      } finally {
        verificationDatabase.close();
      }
      expect(database.prepare("SELECT session_key FROM sessions").all()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createStore(): { database: DatabaseSyncType; store: SessionsStore } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec(`
    CREATE TABLE environments (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    INSERT INTO environments (id, kind) VALUES ('local', 'local');
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      raw_id TEXT NOT NULL,
      source TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      is_subagent INTEGER NOT NULL,
      parent_session_id TEXT,
      source_available INTEGER NOT NULL,
      favorited INTEGER NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE message_events (session_key TEXT, timestamp INTEGER);
    CREATE TABLE messages (session_key TEXT, timestamp TEXT);
    CREATE TABLE session_fts (session_key TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE session_tags (session_key TEXT, tag_id INTEGER);
  `);
  return { database, store: new SessionsStore(database, new EnvironmentStore(database)) };
}

function insertSession(database: DatabaseSyncType, input: {
  sessionKey: string;
  rawId: string;
  source?: string;
  filePath?: string;
  parentSessionId?: string;
}): void {
  database.prepare(`
    INSERT INTO sessions (
      session_key, raw_id, source, environment_id, file_path, is_subagent,
      parent_session_id, source_available, favorited, file_mtime_ms, timestamp
    ) VALUES (?, ?, ?, 'local', ?, ?, ?, 1, 0, 1, 1)
  `).run(
    input.sessionKey,
    input.rawId,
    input.source ?? "codex-cli",
    input.filePath ?? `/synthetic/${input.rawId}.jsonl`,
    input.parentSessionId ? 1 : 0,
    input.parentSessionId ?? null,
  );
  database.prepare("INSERT INTO session_fts (session_key) VALUES (?)").run(input.sessionKey);
}
