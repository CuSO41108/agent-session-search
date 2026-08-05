import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { IndexStatus } from "../../core/indexer";
import type {
  SessionIndexWorkerInput,
  SessionIndexWorkerMessage,
  SessionIndexWorkerResult,
} from "../session-index-worker-protocol";

export interface LocalSessionIndexHandlers {
  onProgress?: (status: IndexStatus) => void;
  onEnvironmentsChanged?: () => void;
}

export class LocalSessionIndexService {
  private activeWorker: Worker | null = null;

  constructor(private readonly workerPath: string) {}

  run(input: SessionIndexWorkerInput, handlers: LocalSessionIndexHandlers = {}): Promise<SessionIndexWorkerResult> {
    if (this.activeWorker) throw new Error("A local session index worker is already running.");
    const worker = new Worker(pathToFileURL(this.workerPath), { workerData: input });
    this.activeWorker = worker;

    return new Promise<SessionIndexWorkerResult>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        if (this.activeWorker === worker) this.activeWorker = null;
        complete();
      };

      worker.on("message", (message: SessionIndexWorkerMessage) => {
        if (message.type === "progress") {
          handlers.onProgress?.(message.status);
          return;
        }
        if (message.type === "environments-changed") {
          handlers.onEnvironmentsChanged?.();
          return;
        }
        if (message.type === "result") {
          finish(() => resolve(message.result));
          return;
        }
        finish(() => reject(new Error(message.error)));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (settled) return;
        finish(() => reject(new Error(`Local session index worker exited before returning a result (code ${code}).`)));
      });
    });
  }

  stop(): void {
    const worker = this.activeWorker;
    this.activeWorker = null;
    if (worker) void worker.terminate();
  }
}
