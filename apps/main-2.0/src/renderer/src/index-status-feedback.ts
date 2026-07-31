import type { IndexStatus } from "../../core/indexer";
import type { RefreshFeedback } from "./app-types";

export type IndexFeedbackAction =
  | { type: "start"; message: string }
  | { type: "index-status"; status: IndexStatus }
  | { type: "manual-result"; status: IndexStatus; successMessage: string }
  | { type: "manual-error"; message: string }
  | { type: "dismiss" };

export function reduceIndexFeedback(
  current: RefreshFeedback,
  action: IndexFeedbackAction,
): RefreshFeedback {
  switch (action.type) {
    case "start":
      return { kind: "running", message: action.message };
    case "index-status":
      if (action.status.running) return current;
      if (action.status.error) return { kind: "error", message: action.status.error };
      return current?.kind === "error" ? null : current;
    case "manual-result":
      return action.status.error
        ? current
        : { kind: "success", message: action.successMessage };
    case "manual-error":
      return { kind: "error", message: action.message };
    case "dismiss":
      return null;
  }
}
