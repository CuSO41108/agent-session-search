import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteHermesSessions } from "./hermes-session-writer";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

describe("Hermes session writer", () => {
  it("deletes only explicit ids without silently expanding delegate descendants", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-hermes-delete-"));
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT REFERENCES sessions(id),
        model_config TEXT,
        started_at REAL NOT NULL
      );
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL NOT NULL);
    `);
    const insert = db.prepare(
      "INSERT INTO sessions (id, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("root", null, "{}", 1);
    insert.run("delegate", "root", JSON.stringify({ _delegate_from: "root" }), 2);
    db.close();

    expect(deleteHermesSessions(dbPath, ["root"])).toEqual(["root"]);
    const verify = new DatabaseSync(dbPath);
    try {
      expect(verify.prepare("SELECT id, parent_session_id FROM sessions").all()).toEqual([
        { id: "delegate", parent_session_id: null },
      ]);
    } finally {
      verify.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
