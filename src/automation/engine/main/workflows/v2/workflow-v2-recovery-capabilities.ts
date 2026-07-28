import type { WorkflowTransactionState } from "../../../shared/workflow-v2/transaction";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { WorkflowWorkspaceConflictPreview, WorkflowWorkspaceDiffResult } from "./workflow-v2-workspace-transaction";

export interface WorkflowV2RecoveryWorkspaceInspection {
  workspaceAvailable: boolean;
  workspaceDiff?: WorkflowWorkspaceDiffResult;
  conflictDetails: WorkflowWorkspaceConflictPreview[];
  conflictPaths: string[];
}

export async function inspectWorkflowV2RecoveryWorkspace(input: {
  store: WorkflowV2StorePort | undefined;
  workflowId: string;
  runId: string;
  fallbackConflictPaths?: readonly string[];
}): Promise<WorkflowV2RecoveryWorkspaceInspection> {
  if (!input.store?.inspectWorkspaceTransaction) {
    return inspectFallbackConflicts(input, false);
  }
  let workspaceDiff: WorkflowWorkspaceDiffResult;
  try {
    workspaceDiff = await input.store.inspectWorkspaceTransaction({ workflowId: input.workflowId, runId: input.runId });
  } catch {
    return inspectFallbackConflicts(input, false);
  }
  const changedPaths = [...new Set([...workspaceDiff.created, ...workspaceDiff.modified, ...workspaceDiff.deleted])];
  if (changedPaths.length === 0) return { workspaceAvailable: true, workspaceDiff, conflictDetails: [], conflictPaths: [] };
  if (!input.store.inspectWorkspaceConflicts) return { workspaceAvailable: false, workspaceDiff, conflictDetails: [], conflictPaths: [...(input.fallbackConflictPaths ?? [])] };
  try {
    const inspected = await input.store.inspectWorkspaceConflicts({ workflowId: input.workflowId, runId: input.runId, paths: changedPaths });
    const conflictDetails = inspected.filter(isWorkflowV2UnresolvedWorkspaceConflict);
    return { workspaceAvailable: true, workspaceDiff, conflictDetails, conflictPaths: conflictDetails.map((detail) => detail.path) };
  } catch {
    return { workspaceAvailable: false, workspaceDiff, conflictDetails: [], conflictPaths: [...(input.fallbackConflictPaths ?? [])] };
  }
}

export async function canRollbackWorkflowV2CurrentSavepoint(input: {
  store: WorkflowV2StorePort | undefined;
  workflowId: string;
  runId: string;
  transaction: WorkflowTransactionState;
}): Promise<boolean> {
  const savepointId = input.transaction.currentSavepointId;
  if (!savepointId || !input.store?.restoreWorkspaceSavepoint || !input.store.inspectWorkspaceSavepointDiff) return false;
  try {
    await input.store.inspectWorkspaceSavepointDiff({ workflowId: input.workflowId, runId: input.runId, savepointId });
    return true;
  } catch {
    return false;
  }
}

async function inspectFallbackConflicts(input: {
  store: WorkflowV2StorePort | undefined;
  workflowId: string;
  runId: string;
  fallbackConflictPaths?: readonly string[];
}, workspaceAvailable: boolean): Promise<WorkflowV2RecoveryWorkspaceInspection> {
  const conflictPaths = [...(input.fallbackConflictPaths ?? [])];
  if (conflictPaths.length === 0 || !input.store?.inspectWorkspaceConflicts) {
    return { workspaceAvailable, conflictDetails: [], conflictPaths };
  }
  try {
    const conflictDetails = (await input.store.inspectWorkspaceConflicts({ workflowId: input.workflowId, runId: input.runId, paths: conflictPaths }))
      .filter(isWorkflowV2UnresolvedWorkspaceConflict);
    return { workspaceAvailable, conflictDetails, conflictPaths: conflictDetails.map((detail) => detail.path) };
  } catch {
    return { workspaceAvailable, conflictDetails: [], conflictPaths };
  }
}

function isWorkflowV2UnresolvedWorkspaceConflict(detail: WorkflowWorkspaceConflictPreview): boolean {
  const currentMatchesBaseline = sameWorkflowV2ConflictVersion(detail.current, detail.baseline);
  const currentMatchesIsolated = sameWorkflowV2ConflictVersion(detail.current, detail.isolated);
  return !currentMatchesBaseline && !currentMatchesIsolated;
}

function sameWorkflowV2ConflictVersion(
  left: WorkflowWorkspaceConflictPreview["current"],
  right: WorkflowWorkspaceConflictPreview["current"],
): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256 && left.size === right.size;
}
