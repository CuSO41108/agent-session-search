import { describe, expect, it, vi } from "vitest";
import { createIndexRunCoordinator } from "./index-run-coordinator";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("index run coordinator", () => {
  it("serializes runs, coalesces one queued request, and preserves later refreshes", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const settingsSnapshots: boolean[] = [];
    let includePi = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn(() => {
      const gate = gates[settingsSnapshots.length];
      settingsSnapshots.push(includePi);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return gate.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const coordinator = createIndexRunCoordinator<string>();

    const first = coordinator.request(run);
    expect(run).toHaveBeenCalledTimes(1);
    includePi = true;
    const queued = coordinator.request(run);
    const joinedQueued = coordinator.request(run);

    expect(queued).toBe(joinedQueued);
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    gates[0].resolve("first");
    await expect(first).resolves.toBe("first");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(settingsSnapshots).toEqual([false, true]);

    includePi = false;
    const later = coordinator.request(run);
    const joinedLater = coordinator.request(run);
    expect(later).toBe(joinedLater);
    expect(run).toHaveBeenCalledTimes(2);

    gates[1].resolve("second");
    await expect(queued).resolves.toBe("second");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(settingsSnapshots).toEqual([false, true, false]);
    expect(maxInFlight).toBe(1);

    gates[2].resolve("third");
    await expect(later).resolves.toBe("third");
    expect(maxInFlight).toBe(1);
  });

  it("waits for post-run cleanup before resolving or starting a queued run", async () => {
    const runGates = [deferred<void>(), deferred<void>()];
    const cleanupGates = [deferred<void>(), deferred<void>()];
    const indexedSources = new Set<string>();
    let includePi = true;
    let runIndex = 0;
    let cleanupIndex = 0;
    const coordinator = createIndexRunCoordinator<void>({
      afterRun: async () => {
        const gate = cleanupGates[cleanupIndex++];
        await gate.promise;
        if (!includePi) indexedSources.delete("pi-cli");
      },
    });
    const run = vi.fn(() => {
      const snapshot = includePi;
      const gate = runGates[runIndex++];
      return gate.promise.then(() => {
        if (snapshot) indexedSources.add("pi-cli");
      });
    });

    const first = coordinator.request(run);
    includePi = false;
    indexedSources.delete("pi-cli");
    const queued = coordinator.request(run);

    runGates[0].resolve(undefined);
    await vi.waitFor(() => expect(cleanupIndex).toBe(1));
    expect(indexedSources.has("pi-cli")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    cleanupGates[0].resolve(undefined);
    await expect(first).resolves.toBeUndefined();
    expect(indexedSources.has("pi-cli")).toBe(false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    runGates[1].resolve(undefined);
    await vi.waitFor(() => expect(cleanupIndex).toBe(2));
    cleanupGates[1].resolve(undefined);
    await expect(queued).resolves.toBeUndefined();
    expect(indexedSources.has("pi-cli")).toBe(false);
  });
});
