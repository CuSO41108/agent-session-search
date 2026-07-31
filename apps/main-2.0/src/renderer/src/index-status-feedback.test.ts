import { describe, expect, it } from "vitest";
import type { IndexStatus } from "../../core/indexer";
import type { RefreshFeedback } from "./app-types";
import { reduceIndexFeedback } from "./index-status-feedback";

function status(running: boolean, error: string | null): IndexStatus {
  return { running, indexed: 1, skipped: error ? 1 : 0, total: 2, lastIndexedAt: running ? null : 1, error };
}

describe("reduceIndexFeedback", () => {
  it("keeps running events silent and reports terminal failures", () => {
    const current: RefreshFeedback = { kind: "running", message: "Refreshing" };
    expect(reduceIndexFeedback(current, { type: "index-status", status: status(true, "intermediate") })).toBe(current);
    expect(reduceIndexFeedback(current, { type: "index-status", status: status(false, "index failed") }))
      .toEqual({ kind: "error", message: "index failed" });
  });

  it("does not reopen a dismissed failure when the same manual refresh returns", () => {
    let feedback = reduceIndexFeedback(null, { type: "index-status", status: status(false, "index failed") });
    feedback = reduceIndexFeedback(feedback, { type: "dismiss" });
    feedback = reduceIndexFeedback(feedback, {
      type: "manual-result",
      status: status(false, "index failed"),
      successMessage: "Index refreshed",
    });

    expect(feedback).toBeNull();
  });

  it("clears an old failure after a successful run and reports manual success", () => {
    const failure: RefreshFeedback = { kind: "error", message: "old failure" };
    expect(reduceIndexFeedback(failure, { type: "index-status", status: status(false, null) })).toBeNull();
    expect(reduceIndexFeedback(null, {
      type: "manual-result",
      status: status(false, null),
      successMessage: "Index refreshed",
    })).toEqual({ kind: "success", message: "Index refreshed" });
  });

  it("reports an IPC-level manual refresh error", () => {
    expect(reduceIndexFeedback(null, { type: "manual-error", message: "IPC failed" }))
      .toEqual({ kind: "error", message: "IPC failed" });
  });
});
