import { describe, expect, it } from "vitest";
import type { IndexStatus } from "../../core/indexer";
import type { RefreshFeedback } from "./app-types";
import { completedIndexFeedback } from "./index-status-feedback";

function status(running: boolean, error: string | null): IndexStatus {
  return { running, indexed: 1, skipped: error ? 1 : 0, total: 2, lastIndexedAt: running ? null : 1, error };
}

describe("completedIndexFeedback", () => {
  it("notifies only once at completion and does not reopen a dismissed Toast during the same run", () => {
    let feedback: RefreshFeedback = null;
    const apply = (next: IndexStatus) => {
      const completed = completedIndexFeedback(next);
      if (completed !== undefined) feedback = completed;
    };

    apply(status(true, "intermediate failure"));
    expect(feedback).toBeNull();
    apply(status(false, "Codex session could not be indexed. See the application logs for details."));
    expect(feedback).toMatchObject({ kind: "error" });

    feedback = null;
    apply(status(true, "late intermediate failure"));
    expect(feedback).toBeNull();

    apply(status(false, null));
    expect(feedback).toBeNull();
  });
});
