import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { cursorStateDatabasePath } from "./session-source-archive";
import type { SessionSearchResult } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

export function setCursorNativeSessionTitle(
  session: Pick<SessionSearchResult, "source" | "filePath" | "rawId">,
  title: string,
): boolean {
  if (session.source !== "cursor-agent") return false;
  const normalized = title.trim();
  const databasePath = cursorStateDatabasePath(session.filePath);
  if (!normalized || !databasePath || !fs.existsSync(databasePath)) return false;

  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const row = db
      .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
      .get(session.rawId) as { value?: string | Uint8Array } | undefined;
    if (row?.value === undefined) return false;

    const text = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    const header = JSON.parse(text) as unknown;
    if (!header || typeof header !== "object" || Array.isArray(header)) return false;
    if ((header as { name?: unknown }).name === normalized) return true;

    const updated = JSON.stringify({ ...header, name: normalized });
    const value = typeof row.value === "string" ? updated : Buffer.from(updated);
    return Number(db
      .prepare("UPDATE composerHeaders SET value = ? WHERE composerId = ?")
      .run(value, session.rawId).changes) > 0;
  } finally {
    db.close();
  }
}
