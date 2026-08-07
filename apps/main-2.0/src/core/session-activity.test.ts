import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadLiveSessionSnapshot } from "./session-activity";

describe("live session deletion guards", () => {
  it("does not invent live session ids for unresolved Windows CLI families", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "win32",
      runner: async () => [
        '321 "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe"',
        '322 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
      ].join("\n"),
    });

    expect(snapshot.sessions).toEqual([]);
  });

  it("does not invent live session ids when macOS cannot map plain CLI processes", async () => {
    const snapshot = await loadLiveSessionSnapshot({
      platform: "darwin",
      homeDir: path.join(os.tmpdir(), "agent-recall-missing-live-session-fixtures"),
      runner: async (command) => {
        if (command === "/bin/ps") return "321 /opt/homebrew/bin/claude\n322 /opt/homebrew/bin/codex";
        if (command === "lsof") return "";
        return "";
      },
    });

    expect(snapshot.sessions).toEqual([]);
  });
});
