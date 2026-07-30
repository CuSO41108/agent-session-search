import type { IndexStatus } from "../../core/indexer";
import type { RefreshFeedback } from "./app-types";

export function completedIndexFeedback(status: IndexStatus): RefreshFeedback | undefined {
  if (status.running) return undefined;
  return status.error ? { kind: "error", message: status.error } : null;
}
