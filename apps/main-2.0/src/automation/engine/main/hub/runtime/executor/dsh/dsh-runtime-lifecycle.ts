import {
  DshRunner,
  type DshRunOptions,
} from "../../../../agents/dsh/dsh-runner";

export interface DshRunnerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type DshRunnerFactory = (options: DshRunOptions) => DshRunnerHandle;

export class DshRuntimeLifecycle {
  private readonly active = new Set<DshRunnerHandle>();
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(
    private readonly createRunnerImplementation: DshRunnerFactory =
      (options) => new DshRunner(options),
  ) {}

  readonly createRunner: DshRunnerFactory = (options) => {
    if (this.shuttingDown) {
      throw new Error("DeepSeek Harness runtime is shutting down.");
    }
    const runner = this.createRunnerImplementation(options);
    const handle: DshRunnerHandle = {
      start: async () => {
        if (this.shuttingDown) {
          this.active.delete(handle);
          throw new Error("DeepSeek Harness runtime is shutting down.");
        }
        try {
          await runner.start();
        } finally {
          this.active.delete(handle);
        }
      },
      stop: () => runner.stop(),
    };
    this.active.add(handle);
    return handle;
  };

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownPromise ??= this.stopAll();
    return this.shutdownPromise;
  }

  private async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.active].map((runner) => runner.stop()),
    );
  }
}
