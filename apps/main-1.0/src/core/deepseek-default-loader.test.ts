import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { loadDefaultSessionsIterator } from "./session-loader";

describe("deepseek enabled end-to-end (synthetic fixture)", () => {
  it("appears in the default loaders when the setting is on and off", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-dsh-default-"));
    try {
      const home = path.join(root, "home");
      const logPath = path.join(home, ".dsh", "sessions", "--work--", "s1", "session.jsonl.zstd");
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const lines = [
        { type: "session", version: 0, id: "s1", createdAt: 1700000000000, cwd: "/work", delegationDepth: 0 },
        { type: "user/message", seq: 0, time: 1700000000001, data: { id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } }, surfaceOp: "append" },
      ];
      const text = lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10);
      fs.writeFileSync(logPath, zstdCompressSync(Buffer.from(text)));

      const off = [...loadDefaultSessionsIterator({ homeDir: home })];
      expect(off.filter((item) => item.session.source === "deepseek-cli")).toHaveLength(0);

      const on = [...loadDefaultSessionsIterator({ homeDir: home, includeDeepSeekCli: true })];
      const deepseek = on.filter((item) => item.session.source === "deepseek-cli");
      expect(deepseek).toHaveLength(1);
      expect(deepseek[0].session.sessionKey).toBe("deepseek:s1");
      expect(deepseek[0].session.projectPath).toBe("/work");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
