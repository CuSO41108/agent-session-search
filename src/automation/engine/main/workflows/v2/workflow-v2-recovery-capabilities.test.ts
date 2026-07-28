import { describe, expect, test, vi } from "vitest";
import type { WorkflowTransactionState } from "../../../shared/workflow-v2/transaction";
import { canRollbackWorkflowV2CurrentSavepoint, inspectWorkflowV2RecoveryWorkspace } from "./workflow-v2-recovery-capabilities";

const transaction: WorkflowTransactionState = {
  transactionId: "transaction-1", mode: "strict_atomic", status: "waiting_for_user", baselineId: "baseline-1",
  currentSavepointId: "savepoint-1", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0,
  startedAt: 1, updatedAt: 2, retentionUntil: 3,
};

describe("workflow recovery capabilities", () => {
  test("offers savepoint rollback only after the persisted snapshot can be inspected", async () => {
    const inspectWorkspaceSavepointDiff = vi.fn(async () => ({ created: [], modified: [], deleted: [], evidenceDigest: "digest" }));
    const available = await canRollbackWorkflowV2CurrentSavepoint({
      store: { persistRunState: async () => undefined, appendEvents: async () => undefined, restoreWorkspaceSavepoint: async () => undefined, inspectWorkspaceSavepointDiff },
      workflowId: "workflow-1", runId: "run-1", transaction,
    });

    expect(available).toBe(true);
    expect(inspectWorkspaceSavepointDiff).toHaveBeenCalledWith({ workflowId: "workflow-1", runId: "run-1", savepointId: "savepoint-1" });
  });

  test("fails closed when savepoint materials are missing or malformed", async () => {
    const available = await canRollbackWorkflowV2CurrentSavepoint({
      store: { persistRunState: async () => undefined, appendEvents: async () => undefined, restoreWorkspaceSavepoint: async () => undefined, inspectWorkspaceSavepointDiff: async () => { throw new Error("snapshot missing"); } },
      workflowId: "workflow-1", runId: "run-1", transaction,
    });

    expect(available).toBe(false);
  });

  test("rediscovers unresolved conflicts across every changed workspace path", async () => {
    const inspection = await inspectWorkflowV2RecoveryWorkspace({
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        inspectWorkspaceTransaction: async () => ({ created: [], modified: ["result.txt", "same.txt"], deleted: [], evidenceDigest: "digest" }),
        inspectWorkspaceConflicts: async () => [
          { path: "result.txt", baseline: { exists: true, sha256: "base", size: 1 }, isolated: { exists: true, sha256: "workflow", size: 2 }, current: { exists: true, sha256: "user", size: 3 } },
          { path: "same.txt", baseline: { exists: true, sha256: "base", size: 1 }, isolated: { exists: true, sha256: "same", size: 2 }, current: { exists: true, sha256: "same", size: 2 } },
        ],
      },
      workflowId: "workflow-1",
      runId: "run-1",
    });

    expect(inspection).toMatchObject({ workspaceAvailable: true, conflictPaths: ["result.txt"], conflictDetails: [{ path: "result.txt" }] });
  });

  test("fails closed when changed paths cannot be inspected for conflicts", async () => {
    const inspection = await inspectWorkflowV2RecoveryWorkspace({
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        inspectWorkspaceTransaction: async () => ({ created: [], modified: ["result.txt"], deleted: [], evidenceDigest: "digest" }),
        inspectWorkspaceConflicts: async () => { throw new Error("workspace scan failed"); },
      },
      workflowId: "workflow-1",
      runId: "run-1",
      fallbackConflictPaths: ["known.txt"],
    });

    expect(inspection).toEqual({ workspaceAvailable: false, workspaceDiff: { created: [], modified: ["result.txt"], deleted: [], evidenceDigest: "digest" }, conflictDetails: [], conflictPaths: ["known.txt"] });
  });
});
