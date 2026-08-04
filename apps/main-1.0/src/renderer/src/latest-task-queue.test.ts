import { describe, expect, it } from "vitest";

import { createLatestTaskQueue } from "./latest-task-queue";

describe("createLatestTaskQueue", () => {
  it("runs one active task and only the latest queued task", async () => {
    const queue = createLatestTaskQueue<string>();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.request(async () => {
      calls.push("first");
      await firstGate;
      return "first-result";
    });
    const superseded = queue.request(async () => {
      calls.push("superseded");
      return "superseded-result";
    });
    const latest = queue.request(async () => {
      calls.push("latest");
      return "latest-result";
    });

    releaseFirst();

    await expect(first).resolves.toBe("first-result");
    await expect(superseded).resolves.toBe("latest-result");
    await expect(latest).resolves.toBe("latest-result");
    expect(calls).toEqual(["first", "latest"]);
  });

  it("continues with the pending task after an active task fails", async () => {
    const queue = createLatestTaskQueue<string>();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.request(async () => {
      await firstGate;
      throw new Error("failed");
    });
    const next = queue.request(async () => "recovered");

    releaseFirst();

    await expect(first).rejects.toThrow("failed");
    await expect(next).resolves.toBe("recovered");
  });
});
