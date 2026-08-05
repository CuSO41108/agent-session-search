import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSkillUsageSourcesAsync, readSkillUsageSourceEventsAsync } from "./skill-usage";

describe("asynchronous skill usage refresh", () => {
  it("discovers active and archived Codex sessions without synchronous directory walking", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-skill-usage-"));
    try {
      const codexHome = path.join(homeDir, ".codex");
      const activePath = path.join(codexHome, "sessions", "2026", "08", "active.jsonl");
      const archivedPath = path.join(codexHome, "archived_sessions", "archived.jsonl");
      for (const filePath of [activePath, archivedPath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-04T00:00:00.000Z",
          payload: {
            type: "function_call",
            name: "read_file",
            arguments: JSON.stringify({ path: "/tmp/.codex/skills/async-review/SKILL.md" }),
          },
        })}\n`, "utf8");
      }

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.join(codexHome, "sessions") });
      expect(sources.map((source) => source.path)).toEqual(expect.arrayContaining([activePath, archivedPath]));
      const activeSource = sources.find((source) => source.path === activePath);
      await expect(readSkillUsageSourceEventsAsync(activeSource!)).resolves.toEqual([
        expect.objectContaining({ agent: "codex", skill: "async-review" }),
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
