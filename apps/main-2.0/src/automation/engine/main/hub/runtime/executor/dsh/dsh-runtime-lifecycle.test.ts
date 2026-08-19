import { describe, expect, test, vi } from "vitest";
import type { DshRunOptions } from "../../../../agents/dsh/dsh-runner";
import {
  DshRuntimeLifecycle,
  type DshRunnerHandle,
} from "./dsh-runtime-lifecycle";

const options = {
  executable: "dsh",
  cwd: "/workspace",
  prompt: "Run the task.",
  onEvent: () => undefined,
  onExit: () => undefined,
} satisfies DshRunOptions;

describe("DshRuntimeLifecycle", () => {
  test("stops every active surface and waits for process settlement during shutdown", async () => {
    const runners: Array<{
      handle: DshRunnerHandle;
      stop: ReturnType<typeof vi.fn>;
      release: () => void;
    }> = [];
    const lifecycle = new DshRuntimeLifecycle(() => {
      let resolveStart!: () => void;
      let resolveStop!: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const stopPromise = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const stop = vi.fn(() => stopPromise);
      const handle: DshRunnerHandle = {
        start: () => startPromise,
        stop,
      };
      runners.push({
        handle,
        stop,
        release: () => {
          resolveStart();
          resolveStop();
        },
      });
      return handle;
    });
    const first = lifecycle.createRunner(options);
    const second = lifecycle.createRunner(options);
    const starts = [first.start(), second.start()];

    let shutdownSettled = false;
    const shutdown = lifecycle.shutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(runners.map((runner) => runner.stop.mock.calls.length)).toEqual([1, 1]);

    for (const runner of runners) runner.release();
    await Promise.all([...starts, shutdown]);
    expect(shutdownSettled).toBe(true);
  });

  test("rejects new DSH work after shutdown begins", async () => {
    const lifecycle = new DshRuntimeLifecycle(() => ({
      start: async () => undefined,
      stop: async () => undefined,
    }));

    await lifecycle.shutdown();

    expect(() => lifecycle.createRunner(options))
      .toThrow("DeepSeek Harness runtime is shutting down.");
  });

  test("rejects a runner created before shutdown if it starts after shutdown", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const lifecycle = new DshRuntimeLifecycle(() => ({ start, stop }));
    const runner = lifecycle.createRunner(options);

    await lifecycle.shutdown();

    await expect(runner.start())
      .rejects.toThrow("DeepSeek Harness runtime is shutting down.");
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
});
