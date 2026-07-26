import { describe, expect, test, vi } from "vitest";
import type { WorkflowCommitPlan, WorkflowOperationRecord } from "../../../shared/workflow-v2/transaction";
import { WorkflowV2CommitCoordinator } from "./workflow-v2-commit-coordinator";

function operation(input: { id: string; reversible: boolean; state?: WorkflowOperationRecord["state"] }): WorkflowOperationRecord {
  return {
    operationId: input.id,
    transactionId: "transaction-1",
    runId: "run-1",
    nodeId: input.id,
    attempt: 1,
    kind: "http",
    target: `https://example.test/${input.id}`,
    idempotencyKey: `key-${input.id}`,
    semanticDigest: `digest-${input.id}`,
    adapterId: "http",
    prepared: { plan: {}, value: {} },
    state: input.state ?? "planned",
    reversible: input.reversible,
    ...(input.reversible ? { compensationAdapter: "http" } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixture(input: { conflicts?: string[]; compensationFails?: boolean } = {}) {
  let commitPlan: WorkflowCommitPlan | undefined;
  const operations = [operation({ id: "irreversible", reversible: false }), operation({ id: "reversible", reversible: true })];
  const store = {
    readOperations: async () => structuredClone(operations),
    inspectWorkspaceTransaction: async () => ({ created: ["result.txt"], modified: [], deleted: [] }),
    persistCommitPlan: async (plan: WorkflowCommitPlan) => { commitPlan = structuredClone(plan); return structuredClone(plan); },
    readCommitPlan: async () => commitPlan ? structuredClone(commitPlan) : undefined,
    commitWorkspaceTransaction: async () => ({ applied: input.conflicts?.length ? [] : ["result.txt"], conflicts: input.conflicts ?? [] }),
  };
  const broker = {
    applyPrepared: vi.fn(async (_input: { operationId: string }) => ({ ok: true })),
    inspect: vi.fn(async (_input: { operationId: string }): Promise<"applied" | "not_applied" | "unknown"> => "unknown"),
    compensateRun: vi.fn(async (_input: { operationIds?: readonly string[] }) => input.compensationFails
      ? { compensated: [], skipped: [], failed: { operationId: "reversible", error: "compensation failed" } }
      : { compensated: ["reversible"], skipped: [] }),
  };
  return { store, broker, operations, getPlan: () => commitPlan };
}

describe("WorkflowV2CommitCoordinator", () => {
  test("freezes reversible operations before workspace and irreversible operations last", async () => {
    const value = fixture();
    const coordinator = new WorkflowV2CommitCoordinator(value.store as never, value.broker as never);
    const preview = await coordinator.previewPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["irreversible", "reversible"], includeWorkspace: true, now: 10 });
    expect(preview.steps.map((step) => step.kind)).toEqual(["reversible_external", "workspace", "irreversible_external"]);
    const plan = await coordinator.createPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["irreversible", "reversible"], includeWorkspace: true, approval: { actor: "operator", approvedAt: 11, evidenceDigest: preview.planDigest }, now: 10 });
    expect(plan.approval?.evidenceDigest).toBe(plan.planDigest);

    await expect(coordinator.commit({ workflowId: "workflow-1", runId: "run-1" })).resolves.toMatchObject({ status: "committed", workspaceApplied: ["result.txt"] });
    expect(value.broker.applyPrepared.mock.calls.map((call) => call[0].operationId)).toEqual(["reversible", "irreversible"]);
  });

  test("compensates reversible external operations and preserves workspace on conflict", async () => {
    const value = fixture({ conflicts: ["result.txt"] });
    const coordinator = new WorkflowV2CommitCoordinator(value.store as never, value.broker as never);
    await coordinator.createPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["reversible"], includeWorkspace: true, now: 10 });

    await expect(coordinator.commit({ workflowId: "workflow-1", runId: "run-1" })).resolves.toMatchObject({ status: "waiting_for_user", conflicts: ["result.txt"] });
    expect(value.broker.compensateRun).toHaveBeenCalledWith(expect.objectContaining({ operationIds: ["reversible"] }));
  });

  test("reports recovery required when conflict compensation fails", async () => {
    const value = fixture({ conflicts: ["result.txt"], compensationFails: true });
    const coordinator = new WorkflowV2CommitCoordinator(value.store as never, value.broker as never);
    await coordinator.createPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["reversible"], includeWorkspace: true, now: 10 });

    await expect(coordinator.commit({ workflowId: "workflow-1", runId: "run-1" })).resolves.toMatchObject({ status: "recovery_required", error: "compensation failed" });
  });

  test("inspects an uncertain external step and resumes without applying it twice", async () => {
    const value = fixture();
    const coordinator = new WorkflowV2CommitCoordinator(value.store as never, value.broker as never);
    await coordinator.createPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["reversible"], includeWorkspace: true, now: 10 });
    value.operations[1]!.state = "applying";
    value.broker.applyPrepared.mockRejectedValueOnce(new Error("Workflow operation is already applying."));
    value.broker.inspect.mockResolvedValueOnce("applied");

    await expect(coordinator.commit({ workflowId: "workflow-1", runId: "run-1" })).resolves.toMatchObject({ status: "committed", appliedOperationIds: ["reversible"] });
    expect(value.broker.applyPrepared).toHaveBeenCalledTimes(1);
    expect(value.broker.inspect).toHaveBeenCalledWith(expect.objectContaining({ operationId: "reversible" }));
  });

  test("never reports rolled back while an external step remains unknown", async () => {
    const value = fixture();
    const coordinator = new WorkflowV2CommitCoordinator(value.store as never, value.broker as never);
    await coordinator.createPlan({ workflowId: "workflow-1", runId: "run-1", transactionId: "transaction-1", operationIds: ["reversible"], includeWorkspace: false, now: 10 });
    value.operations[1]!.state = "unknown";
    value.broker.applyPrepared.mockRejectedValueOnce(new Error("Workflow operation has unknown remote state."));
    await expect(coordinator.commit({ workflowId: "workflow-1", runId: "run-1" })).resolves.toMatchObject({ status: "recovery_required" });
  });
});
