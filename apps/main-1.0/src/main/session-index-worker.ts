import { parentPort, workerData } from "node:worker_threads";
import { runSessionIndexWorker } from "./session-index-worker-runner";
import type {
  SessionIndexWorkerInput,
  SessionIndexWorkerMessage,
} from "./session-index-worker-protocol";

const port = parentPort;
if (!port) throw new Error("Session index worker requires a parent port.");

const emit = (message: SessionIndexWorkerMessage): void => port.postMessage(message);

try {
  const result = await runSessionIndexWorker(workerData as SessionIndexWorkerInput, emit);
  emit({ type: "result", result });
} catch (error) {
  emit({ type: "error", error: error instanceof Error ? error.stack || error.message : String(error) });
}
