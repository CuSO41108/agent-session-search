import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../core/session-store";
import { runSessionIndexWorker } from "./session-index-worker-runner";
import type { SessionIndexWorkerMessage } from "./session-index-worker-protocol";

describe("runSessionIndexWorker", () => {
  it("indexes an isolated home and reports progress through the worker protocol", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-worker-"));
    const homeDir = path.join(root, "home");
    const userDataPath = path.join(root, "user-data");
    const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "08", "04");
    const dbPath = path.join(userDataPath, "session-search.sqlite");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "rollout-worker.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-04T09:00:00.000Z",
        payload: { id: "worker-session", cwd: "/tmp/worker-project" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-04T09:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "worker searchable content" }],
        },
      }),
    ].join("\n"));
    new SessionStore(dbPath).close();
    const messages: SessionIndexWorkerMessage[] = [];

    try {
      const result = await runSessionIndexWorker({
        type: "index",
        dbPath,
        userDataPath,
        batchSize: 1,
        timeBudgetMs: 1,
        loadOptions: { homeDir },
        disabledSources: [],
      }, (message) => messages.push(message));

      expect(result).toMatchObject({
        type: "index",
        status: { indexed: 1, skipped: 0, total: 1, error: null },
      });
      expect(messages.some((message) => message.type === "progress")).toBe(true);
      const store = new SessionStore(dbPath, { initializeSchema: false });
      try {
        expect(store.searchSessions({ query: "worker searchable content" })).toHaveLength(1);
      } finally {
        store.close();
      }

      await expect(runSessionIndexWorker({
        type: "prune-sources",
        dbPath,
        userDataPath,
        sources: ["codex-cli"],
      }, (message) => messages.push(message))).resolves.toEqual({ type: "prune-sources" });
      const prunedStore = new SessionStore(dbPath, { initializeSchema: false });
      try {
        expect(prunedStore.searchSessions({ query: "worker searchable content" })).toHaveLength(0);
      } finally {
        prunedStore.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
