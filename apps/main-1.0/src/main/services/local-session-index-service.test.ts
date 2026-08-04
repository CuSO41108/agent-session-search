import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionIndexWorkerInput } from "../session-index-worker-protocol";
import { LocalSessionIndexService } from "./local-session-index-service";

const roots: string[] = [];
const input: SessionIndexWorkerInput = {
  type: "index",
  dbPath: "/tmp/session-search.sqlite",
  userDataPath: "/tmp/agent-recall-user-data",
  batchSize: 1,
  timeBudgetMs: 1,
  loadOptions: { homeDir: "/tmp/agent-recall-home" },
  disabledSources: [],
};

function workerScript(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-service-"));
  roots.push(root);
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, source);
  return workerPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LocalSessionIndexService", () => {
  it("forwards progress and environment updates before resolving the result", async () => {
    const workerPath = workerScript(`
      import { parentPort } from "node:worker_threads";
      const status = { running: false, indexed: 1, skipped: 0, total: 1, lastIndexedAt: 42, error: null };
      parentPort.postMessage({ type: "progress", status: { ...status, running: true } });
      parentPort.postMessage({ type: "environments-changed" });
      parentPort.postMessage({ type: "result", result: { type: "index", status } });
      parentPort.close();
    `);
    const onProgress = vi.fn();
    const onEnvironmentsChanged = vi.fn();

    await expect(new LocalSessionIndexService(workerPath).run(input, {
      onProgress,
      onEnvironmentsChanged,
    })).resolves.toMatchObject({ type: "index", status: { indexed: 1, running: false } });

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onEnvironmentsChanged).toHaveBeenCalledOnce();
  });

  it("rejects worker errors and exits that occur before a result", async () => {
    const errorWorker = workerScript('throw new Error("worker boom");');
    const emptyWorker = workerScript("");

    await expect(new LocalSessionIndexService(errorWorker).run(input)).rejects.toThrow("worker boom");
    await expect(new LocalSessionIndexService(emptyWorker).run(input)).rejects.toThrow(
      "exited before returning a result",
    );
  });

  it("rejects a second run while a worker is active", async () => {
    const workerPath = workerScript(`
      import { parentPort } from "node:worker_threads";
      setTimeout(() => {
        parentPort.postMessage({
          type: "result",
          result: {
            type: "index",
            status: { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null },
          },
        });
        parentPort.close();
      }, 50);
    `);
    const service = new LocalSessionIndexService(workerPath);
    const first = service.run(input);

    expect(() => service.run(input)).toThrow("already running");
    await expect(first).resolves.toMatchObject({ type: "index", status: { running: false } });
  });

  it("terminates an active worker without leaving the request pending", async () => {
    const workerPath = workerScript("setInterval(() => undefined, 1_000);");
    const service = new LocalSessionIndexService(workerPath);
    const running = service.run(input);

    service.stop();

    await expect(running).rejects.toThrow("exited before returning a result");
  });
});
