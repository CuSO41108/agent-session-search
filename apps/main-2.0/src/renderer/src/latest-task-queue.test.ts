import { afterEach, describe, expect, it, vi } from "vitest";

import { createLatestTaskQueue } from "./latest-task-queue";

describe("createLatestTaskQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("waits for a quiet period and runs only the latest burst task", async () => {
    vi.useFakeTimers();
    const queue = createLatestTaskQueue<string>({ settleMs: 100 });
    const calls: string[] = [];

    const first = queue.request(async () => {
      calls.push("first");
      return "first-result";
    });
    await vi.advanceTimersByTimeAsync(80);
    const second = queue.request(async () => {
      calls.push("second");
      return "second-result";
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(first).resolves.toBe("second-result");
    await expect(second).resolves.toBe("second-result");
    expect(calls).toEqual(["second"]);
  });

  it("settles one latest follow-up requested during an active task", async () => {
    vi.useFakeTimers();
    const queue = createLatestTaskQueue<string>({ settleMs: 50 });
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
    await vi.advanceTimersByTimeAsync(50);
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
    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(superseded).resolves.toBe("latest-result");
    await expect(latest).resolves.toBe("latest-result");
    expect(calls).toEqual(["first", "latest"]);
  });
});
