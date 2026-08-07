import { syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { SessionStore } from "../core/session-store";
import { createSessionIndexFailureLogger } from "./session-index-failure-log";
import type {
  SessionIndexWorkerInput,
  SessionIndexWorkerMessage,
  SessionIndexWorkerResult,
} from "./session-index-worker-protocol";

export async function runSessionIndexWorker(
  input: SessionIndexWorkerInput,
  emit: (message: SessionIndexWorkerMessage) => void,
): Promise<SessionIndexWorkerResult> {
  const store = new SessionStore(input.dbPath, { initializeSchema: false });
  try {
    if (input.type === "prune-sources") {
      store.deleteSessionsBySource(input.sources);
      return { type: "prune-sources" };
    }
    const logger = createSessionIndexFailureLogger(input.userDataPath);
    store.deleteSessionsBySource(input.disabledSources);
    const status: IndexStatus = await syncDefaultSessionsInBatches(store, {
      batchSize: input.batchSize,
      timeBudgetMs: input.timeBudgetMs,
      loadOptions: input.loadOptions,
      indexFailureLogPath: logger.logPath,
      logIndexFailure: logger.write,
      onEnvironmentsChanged: () => emit({ type: "environments-changed" }),
      onProgress: (status) => emit({ type: "progress", status }),
    });
    return { type: "index", status };
  } finally {
    store.close();
  }
}
