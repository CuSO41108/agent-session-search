import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureOpenVikingMemoryTemplates } from "./openviking-memory-templates";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenViking memory templates", () => {
  it("writes the decision and open-loop schemas into an app-owned directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-templates-"));
    roots.push(root);

    const directory = await ensureOpenVikingMemoryTemplates(root);
    const decisions = await readFile(path.join(directory, "decisions.yaml"), "utf8");
    const openLoops = await readFile(path.join(directory, "open_loops.yaml"), "utf8");

    expect(decisions).toContain("memory_type: decisions");
    expect(decisions).toContain("name: alternatives");
    expect(decisions).toContain("name: evolution");
    expect(openLoops).toContain("memory_type: open_loops");
    expect(openLoops).toContain("name: next_step");
    expect(openLoops).toContain("completed, or cancelled");
    if (process.platform !== "win32") {
      expect((await stat(path.join(directory, "decisions.yaml"))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(directory, "open_loops.yaml"))).mode & 0o777).toBe(0o600);
    }
  });
});
