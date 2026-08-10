import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { setCursorNativeSessionTitle } from "./cursor-session-title";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Cursor native session titles", () => {
  it("writes an AgentRecall rename back to the Cursor composer header", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-cursor-title-"));
    tempDirs.push(homeDir);
    const transcriptPath = path.join(
      homeDir,
      ".cursor",
      "projects",
      "repo",
      "agent-transcripts",
      "composer-1",
      "composer-1.jsonl",
    );
    const databasePath = process.platform === "win32"
      ? path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb")
      : process.platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
        : path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)").run(
      "composer-1",
      JSON.stringify({ name: "Old title", subtitle: "Keep me" }),
    );
    db.close();

    expect(setCursorNativeSessionTitle({
      source: "cursor-agent",
      filePath: transcriptPath,
      rawId: "composer-1",
    }, "Renamed in AgentRecall")).toBe(true);

    const updatedDb = new DatabaseSync(databasePath, { readOnly: true });
    const row = updatedDb.prepare("SELECT value FROM composerHeaders WHERE composerId = ?").get("composer-1") as { value: string };
    updatedDb.close();
    expect(JSON.parse(row.value)).toEqual({ name: "Renamed in AgentRecall", subtitle: "Keep me" });
  });
});
