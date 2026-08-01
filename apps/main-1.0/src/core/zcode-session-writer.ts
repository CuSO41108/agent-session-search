import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

const SESSION_ID_PATTERN = /^[^\x00]+$/;
const SESSION_RELATED_TABLES = [
  "part",
  "message",
  "model_usage",
  "turn_usage",
  "tool_usage",
  "input_history",
] as const;

function tableExists(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName),
  );
}

function hasColumn(db: DatabaseSyncType, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>).some(
    (column) => column.name === columnName,
  );
}

function assertZcodeDatabasePath(dbPath: string): string {
  const normalized = path.resolve(dbPath.trim());
  const segments = normalized.split(path.sep).map((segment) => segment.toLowerCase());
  if (segments.at(-1) !== "db.sqlite" || segments.at(-2) !== "db" || segments.at(-3) !== "cli") {
    throw new Error("Refusing to modify a non-ZCode database path.");
  }
  return normalized;
}

/** Permanently removes one ZCode session while keeping the shared database and all other sessions intact. */
export function deleteZcodeSession(dbPath: string, sessionId: string): boolean {
  return deleteZcodeSessions(dbPath, [sessionId]).length > 0;
}

export function deleteZcodeSessions(dbPath: string, sessionIds: readonly string[]): string[] {
  const normalizedPath = assertZcodeDatabasePath(dbPath);
  const normalizedIds = [...new Set(sessionIds.map((sessionId) => sessionId.trim()))];
  if (normalizedIds.some((sessionId) => !SESSION_ID_PATTERN.test(sessionId))) {
    throw new Error("ZCode session id is invalid.");
  }
  if (normalizedIds.length === 0) return [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile()) throw new Error("ZCode database path is not a regular file.");

  const db = new DatabaseSync(normalizedPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (!tableExists(db, "session") || !hasColumn(db, "session", "id")) {
      throw new Error("ZCode database schema is incompatible.");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingIds = selectExistingSessionIds(db, normalizedIds);
      if (existingIds.length === 0) {
        db.exec("COMMIT");
        return [];
      }

      for (const tableName of SESSION_RELATED_TABLES) {
        if (tableExists(db, tableName) && hasColumn(db, tableName, "session_id")) {
          for (const ids of chunks(existingIds, 500)) {
            db.prepare(`DELETE FROM ${tableName} WHERE session_id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
          }
        }
      }
      for (const ids of chunks(existingIds, 500)) {
        db.prepare(`DELETE FROM session WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
      }
      db.exec("COMMIT");
      return existingIds;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function selectExistingSessionIds(db: DatabaseSyncType, sessionIds: readonly string[]): string[] {
  const existing = new Set<string>();
  for (const ids of chunks(sessionIds, 500)) {
    const rows = db.prepare(`SELECT id FROM session WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Array<{ id: string }>;
    for (const row of rows) existing.add(row.id);
  }
  return sessionIds.filter((sessionId) => existing.has(sessionId));
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
