export type WorkflowTransactionMode = "strict_atomic" | "controlled" | "direct";
export type WorkflowTransactionStatus =
  | "active"
  | "waiting_for_user"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "partially_rolled_back"
  | "recovery_required";

export interface WorkflowTransactionCheckpointPolicy {
  id: string;
  title: string;
  afterNodeIds: string[];
  kind: "savepoint" | "commit";
  approval: "automatic" | "required";
}

export interface WorkflowTransactionPolicy {
  defaultMode: WorkflowTransactionMode;
  approvalMode: "batch" | "per_operation" | "user_choice";
  checkpoints: WorkflowTransactionCheckpointPolicy[];
  retentionDays: number;
  onUnknown: "pause";
  onConflict: "user_or_manager";
}

export interface ResolvedWorkflowTransactionPolicy {
  policy: WorkflowTransactionPolicy;
  compatibilityWarning?: string;
}

export function createStrictWorkflowTransactionPolicy(): WorkflowTransactionPolicy {
  return {
    defaultMode: "strict_atomic",
    approvalMode: "user_choice",
    checkpoints: [],
    retentionDays: 7,
    onUnknown: "pause",
    onConflict: "user_or_manager",
  };
}

export function createDirectWorkflowTransactionPolicy(): WorkflowTransactionPolicy {
  return {
    ...createStrictWorkflowTransactionPolicy(),
    defaultMode: "direct",
  };
}

export function resolveWorkflowTransactionPolicy(policy: WorkflowTransactionPolicy | undefined): ResolvedWorkflowTransactionPolicy {
  if (policy) return { policy: structuredClone(policy) };
  return {
    policy: createDirectWorkflowTransactionPolicy(),
    compatibilityWarning: "This workflow predates transaction governance and will run in direct mode without rollback guarantees.",
  };
}

export function workflowTransactionPreflightError(
  policy: WorkflowTransactionPolicy | undefined,
  capabilities: { workspaceIsolation?: boolean; externalOperationBroker?: boolean } = {},
): string | undefined {
  const mode = resolveWorkflowTransactionPolicy(policy).policy.defaultMode;
  if (mode === "direct") return undefined;
  if (mode === "strict_atomic") {
    return capabilities.workspaceIsolation
      ? undefined
      : "Workflow strict_atomic mode is unavailable until workspace isolation and transactional preflight are installed. Choose direct mode or complete the transaction runtime setup.";
  }
  return capabilities.externalOperationBroker
    ? undefined
    : "Workflow controlled mode is unavailable until the external operation broker and recovery approval flow are installed. Choose direct mode or complete the transaction runtime setup.";
}

export function workflowTransactionPolicyValidationErrors(
  policy: WorkflowTransactionPolicy,
  nodeIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (!transactionModes.has(policy.defaultMode)) errors.push("Workflow transaction policy has an invalid default mode.");
  if (!approvalModes.has(policy.approvalMode)) errors.push("Workflow transaction policy has an invalid approval mode.");
  if (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays <= 0) errors.push("Workflow transaction retentionDays must be a positive safe integer.");
  if (policy.onUnknown !== "pause") errors.push("Workflow transaction onUnknown must be pause.");
  if (policy.onConflict !== "user_or_manager") errors.push("Workflow transaction onConflict must be user_or_manager.");
  if (!Array.isArray(policy.checkpoints)) return [...errors, "Workflow transaction checkpoints must be an array."];
  const checkpointIds = new Set<string>();
  for (const checkpoint of policy.checkpoints) {
    if (!checkpoint || typeof checkpoint !== "object") {
      errors.push("Workflow transaction checkpoint must be an object.");
      continue;
    }
    const checkpointId = typeof checkpoint.id === "string" && checkpoint.id.trim() ? checkpoint.id : undefined;
    const checkpointLabel = checkpointId ?? "<invalid>";
    if (!checkpointId) errors.push("Workflow transaction checkpoint id must be a non-empty string.");
    else if (checkpointIds.has(checkpointId)) errors.push(`Workflow transaction checkpoint id ${checkpointId} is duplicated.`);
    else checkpointIds.add(checkpointId);
    if (typeof checkpoint.title !== "string" || !checkpoint.title.trim()) errors.push(`Workflow transaction checkpoint ${checkpointLabel} must have a title.`);
    if (checkpoint.kind !== "savepoint" && checkpoint.kind !== "commit") errors.push(`Workflow transaction checkpoint ${checkpoint.id} has an invalid kind.`);
    if (checkpoint.approval !== "automatic" && checkpoint.approval !== "required") errors.push(`Workflow transaction checkpoint ${checkpoint.id} has an invalid approval mode.`);
    if (!Array.isArray(checkpoint.afterNodeIds) || checkpoint.afterNodeIds.length === 0) {
      errors.push(`Workflow transaction checkpoint ${checkpoint.id} must reference at least one node.`);
    } else {
      for (const nodeId of checkpoint.afterNodeIds) {
        if (typeof nodeId !== "string" || !nodeId.trim()) errors.push(`Workflow transaction checkpoint ${checkpointLabel} contains an invalid node id.`);
        else if (!nodeIds.has(nodeId)) errors.push(`Workflow transaction checkpoint ${checkpointLabel} references missing node ${nodeId}.`);
      }
    }
  }
  return errors;
}

export interface WorkflowTransactionState {
  transactionId: string;
  mode: WorkflowTransactionMode;
  status: WorkflowTransactionStatus;
  baselineId: string;
  currentSavepointId?: string;
  operationCount: number;
  unknownOperationCount: number;
  irreversibleOperationCount: number;
  startedAt: number;
  updatedAt: number;
  retentionUntil: number;
}

export type WorkflowOperationKind = "file" | "http" | "message" | "git" | "database" | "other";
export type WorkflowOperationState = "planned" | "applying" | "applied" | "compensating" | "compensated" | "unknown";

export class WorkflowOperationTransitionError extends Error {
  readonly code = "WORKFLOW_OPERATION_INVALID_TRANSITION";

  constructor(
    readonly operationId: string,
    readonly from: WorkflowOperationState,
    readonly to: WorkflowOperationState,
  ) {
    super(`Workflow operation ${operationId} cannot transition from ${from} to ${to}.`);
    this.name = "WorkflowOperationTransitionError";
  }
}

export interface WorkflowOperationRecord {
  operationId: string;
  transactionId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  kind: WorkflowOperationKind;
  target: string;
  idempotencyKey: string;
  /** Digest of the unsanitized operation semantics; never contains the original request. */
  semanticDigest?: string;
  adapterId?: string;
  prepared?: unknown;
  state: WorkflowOperationState;
  reversible: boolean;
  compensationAdapter?: string;
  requestSummary?: unknown;
  receipt?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export const WORKFLOW_TRANSACTION_EVENT_TYPES = [
  "transaction_started",
  "baseline_frozen",
  "preflight_passed",
  "preflight_blocked",
  "operation_planned",
  "operation_started",
  "operation_applied",
  "operation_unknown",
  "savepoint_created",
  "commit_started",
  "commit_completed",
  "compensation_started",
  "compensation_completed",
  "recovery_required",
  "conflict_detected",
] as const;
export type WorkflowTransactionEventType = typeof WORKFLOW_TRANSACTION_EVENT_TYPES[number];

export function isWorkflowTransactionState(value: unknown): value is WorkflowTransactionState {
  if (!isRecord(value)) return false;
  return nonEmpty(value.transactionId)
    && transactionModes.has(value.mode as WorkflowTransactionMode)
    && transactionStatuses.has(value.status as WorkflowTransactionStatus)
    && nonEmpty(value.baselineId)
    && (value.currentSavepointId === undefined || nonEmpty(value.currentSavepointId))
    && nonNegativeInteger(value.operationCount)
    && nonNegativeInteger(value.unknownOperationCount)
    && nonNegativeInteger(value.irreversibleOperationCount)
    && (value.unknownOperationCount as number) <= (value.operationCount as number)
    && (value.irreversibleOperationCount as number) <= (value.operationCount as number)
    && timestamp(value.startedAt)
    && timestamp(value.updatedAt)
    && timestamp(value.retentionUntil)
    && value.startedAt <= value.updatedAt
    && value.updatedAt <= value.retentionUntil;
}

export function isWorkflowOperationRecord(value: unknown): value is WorkflowOperationRecord {
  if (!isRecord(value)) return false;
  return [value.operationId, value.transactionId, value.runId, value.nodeId, value.target, value.idempotencyKey].every(nonEmpty)
    && Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0
    && operationKinds.has(value.kind as WorkflowOperationKind)
    && operationStates.has(value.state as WorkflowOperationState)
    && (value.semanticDigest === undefined || nonEmpty(value.semanticDigest))
    && (value.adapterId === undefined || nonEmpty(value.adapterId))
    && typeof value.reversible === "boolean"
    && (value.compensationAdapter === undefined || nonEmpty(value.compensationAdapter))
    && (value.error === undefined || typeof value.error === "string")
    && timestamp(value.createdAt)
    && timestamp(value.updatedAt)
    && value.createdAt <= value.updatedAt;
}

export function canTransitionWorkflowOperation(from: WorkflowOperationState, to: WorkflowOperationState): boolean {
  return from === to || operationTransitions[from].has(to);
}

export function sanitizeWorkflowTransactionValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

export function sanitizeWorkflowOperationRecord(record: WorkflowOperationRecord): WorkflowOperationRecord {
  return {
    ...structuredClone(record),
    target: sanitizeString(record.target),
    ...(record.requestSummary !== undefined ? { requestSummary: sanitizeWorkflowTransactionValue(record.requestSummary) } : {}),
    ...(record.prepared !== undefined ? { prepared: sanitizeWorkflowTransactionValue(record.prepared) } : {}),
    ...(record.receipt !== undefined ? { receipt: sanitizeWorkflowTransactionValue(record.receipt) } : {}),
    ...(record.error !== undefined ? { error: sanitizeString(record.error) } : {}),
  };
}

const transactionModes = new Set<WorkflowTransactionMode>(["strict_atomic", "controlled", "direct"]);
const approvalModes = new Set<WorkflowTransactionPolicy["approvalMode"]>(["batch", "per_operation", "user_choice"]);
const transactionStatuses = new Set<WorkflowTransactionStatus>(["active", "waiting_for_user", "committing", "committed", "rolling_back", "rolled_back", "partially_rolled_back", "recovery_required"]);
const operationKinds = new Set<WorkflowOperationKind>(["file", "http", "message", "git", "database", "other"]);
const operationStates = new Set<WorkflowOperationState>(["planned", "applying", "applied", "compensating", "compensated", "unknown"]);
const operationTransitions: Record<WorkflowOperationState, ReadonlySet<WorkflowOperationState>> = {
  planned: new Set(["applying"]),
  applying: new Set(["applied", "unknown"]),
  applied: new Set(["compensating"]),
  compensating: new Set(["compensated", "unknown"]),
  compensated: new Set(),
  unknown: new Set(),
};
const sensitiveKeyPart = /(authorization|cookie|credential|password|passwd|secret|token|api.?key|private.?key)/i;

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return sanitized;
  }
  if (!isRecord(value)) return value;
  const sanitized = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKeyPart.test(key.replace(/[^a-z0-9]/gi, "")) ? "[REDACTED]" : sanitizeValue(item, seen),
  ]));
  seen.delete(value);
  return sanitized;
}

function sanitizeString(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(trimmed) as unknown, new WeakSet<object>()));
    } catch {
      // Continue with textual redaction when the value only resembles JSON.
    }
  }
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&][^=&#]*(?:authorization|credential|password|secret|token|key)[^=&#]*=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b((?:x[-_])?(?:api[-_]?key|auth[-_]?token|client[-_]?secret|authorization|cookie|password|private[-_]?key)\s*[:=]\s*)[^,;\r\n]+/gi, "$1[REDACTED]");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
