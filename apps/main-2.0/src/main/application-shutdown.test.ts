import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("application shutdown wiring", () => {
  it("runs asynchronous cleanup once and stops PostgreSQL after closing the pool", async () => {
    const source = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    const preventQuit = source.indexOf("event.preventDefault();");
    const repeatedQuitGuard = source.indexOf("if (automationQuitStarted) return;");
    const markQuitStarted = source.indexOf("automationQuitStarted = true;");
    const shutdownAutomation = source.indexOf("automationService?.shutdown()");
    const closeDatabase = source.indexOf("postgresDatabase?.close()", shutdownAutomation);
    const stopRuntime = source.indexOf("postgresRuntime?.stop()", closeDatabase);

    expect(preventQuit).toBeGreaterThan(-1);
    expect(repeatedQuitGuard).toBeGreaterThan(preventQuit);
    expect(markQuitStarted).toBeGreaterThan(repeatedQuitGuard);
    expect(shutdownAutomation).toBeGreaterThan(markQuitStarted);
    expect(closeDatabase).toBeGreaterThan(shutdownAutomation);
    expect(stopRuntime).toBeGreaterThan(closeDatabase);
  });
});
