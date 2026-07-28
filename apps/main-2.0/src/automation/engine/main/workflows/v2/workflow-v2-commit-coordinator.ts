import { createHash } from "node:crypto";
import type {
  WorkflowCommitPlan,
  WorkflowCommitPlanApproval,
  WorkflowCommitPlanStep,
  WorkflowOperationRecord,
  WorkflowTransactionStatus,
} from "../../../shared/workflow-v2/transaction";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { WorkflowV2RecoveryOperationBroker } from "../workflow-runtime-ports";

export interface WorkflowCommitCoordinatorResult {
  status: Extract<WorkflowTransactionStatus, "committed" | "waiting_for_user" | "rolled_back" | "partially_rolled_back" | "recovery_required">;
  appliedOperationIds: string[];
  workspaceApplied: string[];
  conflicts: string[];
  error?: string;
}

export class WorkflowV2CommitCoordinator {
  constructor(
    private readonly store: WorkflowV2StorePort,
    private readonly broker: WorkflowV2RecoveryOperationBroker,
  ) {}

  async createPlan(input: {
    workflowId: string;
    runId: string;
    transactionId: string;
    operationIds: readonly string[];
    includeWorkspace: boolean;
    approval?: WorkflowCommitPlanApproval;
    now?: number;
  }): Promise<WorkflowCommitPlan> {
    const plan = await this.previewPlan(input);
    return this.store.persistCommitPlan!(plan);
  }

  async previewPlan(input: {
    workflowId: string;
    runId: string;
    transactionId: string;
    operationIds: readonly string[];
    includeWorkspace: boolean;
    approval?: WorkflowCommitPlanApproval;
    now?: number;
  }): Promise<WorkflowCommitPlan> {
    this.assertStoreCapabilities();
    const operations = await this.store.readOperations!(input.workflowId, input.runId);
    const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
    const selected = input.operationIds.map((operationId) => {
      const operation = operationById.get(operationId);
      if (!operation) throw new Error(`Workflow commit plan references missing operation ${operationId}.`);
      if (operation.transactionId !== input.transactionId) throw new Error("Workflow commit plan operation belongs to a different transaction.");
      if (operation.state !== "planned" && operation.state !== "applied") throw new Error(`Workflow commit plan operation ${operationId} is not prepared for commit.`);
      return operation;
    });
    const reversible = selected.filter((operation) => operation.reversible);
    const irreversible = selected.filter((operation) => !operation.reversible);
    const steps: WorkflowCommitPlanStep[] = [];
    for (const operation of reversible) appendOperationStep(steps, operation, "reversible_external");
    if (input.includeWorkspace) {
      if (!this.store.inspectWorkspaceTransaction) throw new Error("Workflow commit coordinator requires workspace diff inspection.");
      const diff = await this.store.inspectWorkspaceTransaction({ workflowId: input.workflowId, runId: input.runId });
      if (!diff.evidenceDigest?.trim()) throw new Error("Workflow commit coordinator requires content-bound workspace evidence.");
      appendStep(steps, { stepId: "workspace", kind: "workspace", evidenceDigest: diff.evidenceDigest });
    }
    for (const operation of irreversible) appendOperationStep(steps, operation, "irreversible_external");
    if (steps.length === 0) throw new Error("Workflow commit plan must contain at least one step.");
    const createdAt = input.now ?? Date.now();
    const planDigest = workflowCommitPlanDigest({ transactionId: input.transactionId, workflowId: input.workflowId, runId: input.runId, steps });
    if (input.approval && input.approval.evidenceDigest !== planDigest) throw new Error("Workflow commit approval does not match the immutable commit plan.");
    const plan: WorkflowCommitPlan = {
      schemaVersion: 1,
      commitPlanId: `commit-plan:${input.transactionId}:${planDigest.slice(0, 16)}`,
      transactionId: input.transactionId,
      workflowId: input.workflowId,
      runId: input.runId,
      planDigest,
      createdAt,
      steps,
      ...(input.approval ? { approval: structuredClone(input.approval) } : {}),
    };
    return plan;
  }

  async commit(input: { workflowId: string; runId: string; signal?: AbortSignal }): Promise<WorkflowCommitCoordinatorResult> {
    this.assertStoreCapabilities();
    const plan = await this.store.readCommitPlan!(input.workflowId, input.runId);
    if (!plan) throw new Error("Workflow commit plan was not found.");
    const expectedDigest = workflowCommitPlanDigest(plan);
    if (expectedDigest !== plan.planDigest) throw new Error("Workflow commit plan digest does not match its immutable steps.");
    await this.assertCurrentPlanEvidence(plan);
    const appliedOperationIds: string[] = [];
    const reversibleAppliedIds: string[] = [];
    const workspaceApplied: string[] = [];
    let irreversibleApplied = false;
    let externalOperationUncertain = false;
    let workspaceCommitStarted = false;
    try {
      for (const step of plan.steps) {
        if (step.kind === "workspace") {
          if (!this.store.commitWorkspaceTransaction) throw new Error("Workflow commit coordinator requires workspace commit support.");
          await this.assertWorkspaceStepEvidence(plan, step);
          workspaceCommitStarted = true;
          const result = await this.store.commitWorkspaceTransaction({ workflowId: plan.workflowId, runId: plan.runId });
          if (result.conflicts.length > 0) {
            return { status: "waiting_for_user", appliedOperationIds, workspaceApplied, conflicts: result.conflicts };
          }
          workspaceApplied.push(...result.applied);
          continue;
        }
        if (!step.operationId) throw new Error(`Workflow commit step ${step.stepId} is missing operationId.`);
        if (!this.broker.applyPrepared) throw new Error("Workflow commit coordinator requires external operation apply support.");
        if (step.kind === "irreversible_external" && !plan.approval) throw new Error("Irreversible workflow commit steps require approval bound to the commit plan.");
        try {
          await this.broker.applyPrepared({ workflowId: plan.workflowId, runId: plan.runId, operationId: step.operationId, ...(input.signal ? { signal: input.signal } : {}) });
        } catch (error) {
          const operation = (await this.store.readOperations!(plan.workflowId, plan.runId)).find((candidate) => candidate.operationId === step.operationId);
          if (operation?.state !== "applying" && operation?.state !== "unknown") throw error;
          try {
            const inspection = await this.broker.inspect({ workflowId: plan.workflowId, runId: plan.runId, operationId: step.operationId, ...(input.signal ? { signal: input.signal } : {}) });
            if (inspection !== "applied") {
              externalOperationUncertain = inspection === "unknown";
              throw error;
            }
          } catch (inspectionError) {
            if (inspectionError !== error) externalOperationUncertain = true;
            throw inspectionError;
          }
        }
        appliedOperationIds.push(step.operationId);
        if (step.kind === "reversible_external") reversibleAppliedIds.push(step.operationId);
        else irreversibleApplied = true;
      }
      return { status: "committed", appliedOperationIds, workspaceApplied, conflicts: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const compensation = await this.broker.compensateRun({ workflowId: plan.workflowId, runId: plan.runId, operationIds: reversibleAppliedIds, ...(input.signal ? { signal: input.signal } : {}) });
      let workspaceRecoveryFailed = false;
      if (workspaceCommitStarted && this.store.rollbackWorkspaceTransaction) {
        try {
          const rollback = await this.store.rollbackWorkspaceTransaction({ workflowId: plan.workflowId, runId: plan.runId });
          workspaceRecoveryFailed = rollback.conflicts.length > 0;
        } catch {
          workspaceRecoveryFailed = true;
        }
      }
      const status = compensation.failed || externalOperationUncertain || workspaceRecoveryFailed
        ? "recovery_required"
        : irreversibleApplied || compensation.skipped.length > 0
          ? "partially_rolled_back"
          : "rolled_back";
      return { status, appliedOperationIds, workspaceApplied, conflicts: [], error: message };
    }
  }

  private assertStoreCapabilities(): void {
    if (!this.store.readOperations || !this.store.persistCommitPlan || !this.store.readCommitPlan) {
      throw new Error("Workflow commit coordinator requires durable operations and immutable commit-plan storage.");
    }
  }

  private async assertCurrentPlanEvidence(plan: WorkflowCommitPlan): Promise<void> {
    const operations = await this.store.readOperations!(plan.workflowId, plan.runId);
    const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
    for (const step of plan.steps) {
      if (step.kind === "workspace") {
        await this.assertWorkspaceStepEvidence(plan, step);
        continue;
      }
      if (!step.operationId) throw new Error(`Workflow commit step ${step.stepId} is missing operationId.`);
      const operation = operationById.get(step.operationId);
      if (!operation || operation.transactionId !== plan.transactionId || !operation.semanticDigest || !step.evidenceDigest || operation.semanticDigest !== step.evidenceDigest) {
        throw new Error(`Workflow operation ${step.operationId} changed after the commit plan was frozen; refresh the plan and approval.`);
      }
    }
  }

  private async assertWorkspaceStepEvidence(plan: WorkflowCommitPlan, step: WorkflowCommitPlanStep): Promise<void> {
    if (!this.store.inspectWorkspaceTransaction) throw new Error("Workflow commit coordinator requires workspace diff inspection.");
    const current = await this.store.inspectWorkspaceTransaction({ workflowId: plan.workflowId, runId: plan.runId });
    if (!current.evidenceDigest?.trim() || current.evidenceDigest !== step.evidenceDigest) {
      throw new Error("Workflow workspace content changed after the commit plan was frozen; refresh the plan and approval.");
    }
  }
}

export function workflowCommitPlanDigest(input: Pick<WorkflowCommitPlan, "transactionId" | "workflowId" | "runId" | "steps">): string {
  return digest({ transactionId: input.transactionId, workflowId: input.workflowId, runId: input.runId, steps: input.steps });
}

function appendOperationStep(steps: WorkflowCommitPlanStep[], operation: WorkflowOperationRecord, kind: "reversible_external" | "irreversible_external"): void {
  appendStep(steps, {
    stepId: `operation:${operation.operationId}`,
    kind,
    operationId: operation.operationId,
    evidenceDigest: operation.semanticDigest,
    ...(operation.compensationAdapter ? { compensationAdapter: operation.compensationAdapter } : {}),
  });
}

function appendStep(steps: WorkflowCommitPlanStep[], step: Omit<WorkflowCommitPlanStep, "order" | "prerequisites">): void {
  steps.push({ ...step, order: steps.length, prerequisites: steps.length > 0 ? [steps.at(-1)!.stepId] : [] });
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
