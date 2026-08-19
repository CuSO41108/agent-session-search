import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteHermesSession, deleteHermesSessions } from "./hermes-session-writer";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

function databasePath(root: string): string {
  return path.join(root, "state.db");
}

function createFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_session_id TEXT,
        model_config TEXT,
        started_at REAL NOT NULL,
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL
      );
      CREATE TABLE session_model_usage (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO sessions (id, title, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?, ?)").run(
      "sess-delete",
      "Delete me",
      null,
      "{}",
      1,
    );
    db.prepare("INSERT INTO sessions (id, title, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?, ?)").run(
      "sess-keep",
      "Keep me",
      null,
      "{}",
      2,
    );
    db.prepare("INSERT INTO sessions (id, title, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?, ?)").run(
      "sess-branch",
      "Branch child",
      "sess-delete",
      "{}",
      3,
    );
    db.prepare("INSERT INTO sessions (id, title, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?, ?)").run(
      "sess-delegate",
      "Delegate child",
      "sess-delete",
      JSON.stringify({ _delegate_from: "sess-delete" }),
      4,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "sess-delete",
      "user",
      "delete",
      1,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "sess-keep",
      "user",
      "keep",
      2,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "sess-branch",
      "user",
      "branch",
      3,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "sess-delegate",
      "user",
      "delegate",
      4,
    );
    db.prepare("INSERT INTO session_model_usage (session_id, model) VALUES (?, ?)").run("sess-delete", "model-a");
    db.prepare("INSERT INTO session_model_usage (session_id, model) VALUES (?, ?)").run("sess-keep", "model-b");
  } finally {
    db.close();
  }
}

describe("Hermes session writer", () => {
  it("deletes one session, cascades delegates, and orphans branch children", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-hermes-delete-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);

    expect(deleteHermesSession(dbPath, "sess-delete")).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
        { id: "sess-branch" },
        { id: "sess-keep" },
      ]);
      expect(db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get("sess-branch")).toEqual({
        parent_session_id: null,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get("sess-delete")).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get("sess-delegate")).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get("sess-keep")).toEqual({
        count: 1,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_model_usage WHERE session_id = ?").get("sess-delete")).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_model_usage WHERE session_id = ?").get("sess-keep")).toEqual({
        count: 1,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false for a missing session or database and refuses non-Hermes paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-hermes-delete-missing-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);

    expect(deleteHermesSession(dbPath, "does-not-exist")).toBe(false);
    expect(deleteHermesSession(path.join(root, "missing", "state.db"), "sess-delete")).toBe(false);
    expect(() => deleteHermesSession(path.join(root, "hermes.db"), "sess-delete")).toThrow(/non-Hermes database path/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes only explicit ids without silently expanding delegate descendants", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-hermes-delete-exact-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);

    expect(deleteHermesSessions(dbPath, ["sess-delete"])).toEqual(["sess-delete"]);
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
        { id: "sess-branch" },
        { id: "sess-delegate" },
        { id: "sess-keep" },
      ]);
      expect(db.prepare("SELECT parent_session_id FROM sessions WHERE id = ?").get("sess-delegate")).toEqual({
        parent_session_id: null,
      });
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
