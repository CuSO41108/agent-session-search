import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncType };

const SESSION_ID_PATTERN = /^[^\x00]+$/;
const SESSION_RELATED_TABLES = ["messages", "session_model_usage"] as const;

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

function assertHermesDatabasePath(dbPath: string): string {
  const normalized = path.resolve(dbPath.trim());
  if (path.basename(normalized).toLowerCase() !== "state.db") {
    throw new Error("Refusing to modify a non-Hermes database path.");
  }
  return normalized;
}

function delegateFrom(modelConfig: unknown): string | null {
  if (typeof modelConfig !== "string" || !modelConfig.trim()) return null;
  try {
    const parsed = JSON.parse(modelConfig) as { _delegate_from?: unknown };
    return typeof parsed._delegate_from === "string" && parsed._delegate_from.trim()
      ? parsed._delegate_from.trim()
      : null;
  } catch {
    return null;
  }
}

function collectDelegateChildIds(db: DatabaseSyncType, parentIds: readonly string[]): string[] {
  if (!hasColumn(db, "sessions", "model_config")) return [];
  const seeds = new Set(parentIds.filter(Boolean));
  const found = new Set(seeds);
  let frontier = [...seeds];
  while (frontier.length > 0) {
    const rows = db
      .prepare("SELECT id, parent_session_id, model_config FROM sessions")
      .all() as Array<{ id?: unknown; parent_session_id?: unknown; model_config?: unknown }>;
    const next: string[] = [];
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : null;
      if (!id || found.has(id)) continue;
      const parentId = typeof row.parent_session_id === "string" ? row.parent_session_id : null;
      const from = delegateFrom(row.model_config);
      if ((from && frontier.includes(from)) || (parentId && frontier.includes(parentId) && from)) {
        found.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return [...found].filter((id) => !seeds.has(id));
}

function deleteSessionRows(db: DatabaseSyncType, sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    for (const tableName of SESSION_RELATED_TABLES) {
      if (tableExists(db, tableName) && hasColumn(db, tableName, "session_id")) {
        db.prepare(`DELETE FROM ${tableName} WHERE session_id = ?`).run(sessionId);
      }
    }
  }
  if (hasColumn(db, "sessions", "parent_session_id")) {
    for (const sessionId of sessionIds) {
      db.prepare("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?").run(sessionId);
    }
  }
  for (const sessionId of sessionIds) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
}

/** Permanently removes one Hermes session while keeping the shared state.db and other sessions intact. */
export function deleteHermesSession(dbPath: string, sessionId: string): boolean {
  const normalizedPath = assertHermesDatabasePath(dbPath);
  const normalizedId = sessionId.trim();
  if (!SESSION_ID_PATTERN.test(normalizedId)) throw new Error("Hermes session id is invalid.");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile()) throw new Error("Hermes database path is not a regular file.");

  const db = new DatabaseSync(normalizedPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (!tableExists(db, "sessions") || !hasColumn(db, "sessions", "id")) {
      throw new Error("Hermes database schema is incompatible.");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const exists = Boolean(db.prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1").get(normalizedId));
      if (!exists) {
        db.exec("COMMIT");
        return false;
      }

      const delegateIds = collectDelegateChildIds(db, [normalizedId]);
      deleteSessionRows(db, [...delegateIds, normalizedId]);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
