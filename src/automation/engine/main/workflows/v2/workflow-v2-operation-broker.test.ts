import { describe, expect, test } from "vitest";
import type { WorkflowOperationRecord } from "../../../shared/workflow-v2/transaction";
import { WorkflowV2OperationBroker, type WorkflowTransactionalOperationAdapter } from "./workflow-v2-operation-broker";

function fakeStore(options: { failAppliedTransition?: boolean } = {}) {
  const operations: WorkflowOperationRecord[] = [];
  const store = {
    operations,
    planOperation: async ({ record }: { workflowId: string; record: WorkflowOperationRecord }) => {
      const existing = operations.find((item) => item.operationId === record.operationId || item.idempotencyKey === record.idempotencyKey);
      if (existing) return structuredClone(existing);
      operations.push(structuredClone(record));
      return structuredClone(record);
    },
    transitionOperation: async ({ operationId, state, updatedAt, receipt, error }: { workflowId: string; runId: string; operationId: string; state: WorkflowOperationRecord["state"]; updatedAt: number; receipt?: unknown; error?: string }) => {
      const operation = operations.find((item) => item.operationId === operationId);
      if (!operation) throw new Error("missing operation");
      if (state === "applied" && options.failAppliedTransition) throw new Error("receipt persistence failed");
      operation.state = state;
      operation.updatedAt = updatedAt;
      if (receipt !== undefined) operation.receipt = structuredClone(receipt);
      if (error !== undefined) operation.error = error;
      return structuredClone(operation);
    },
    readOperations: async () => structuredClone(operations),
    resolveUnknownOperation: async ({ operationId, verifiedState, updatedAt, evidence }: { workflowId: string; runId: string; operationId: string; verifiedState: "applied" | "compensated"; actor: string; reason: string; updatedAt: number; evidence?: unknown }) => {
      const operation = operations.find((item) => item.operationId === operationId);
      if (!operation) throw new Error("missing operation");
      operation.state = verifiedState;
      operation.updatedAt = updatedAt;
      operation.receipt = evidence;
      return structuredClone(operation);
    },
  };
  return store;
}

function adapter(input: { apply?: (prepared: unknown) => Promise<unknown>; inspect?: () => Promise<"applied" | "not_applied" | "unknown">; compensate?: (prepared: unknown) => Promise<void> }) {
  const calls: string[] = [];
  const value: WorkflowTransactionalOperationAdapter<{ url: string }, { id: string }> = {
    adapterId: "http-test",
    prepare: async ({ plan }) => {
      calls.push("prepare");
      return { adapterId: "http-test", plan, prepared: { url: plan.url }, preparedAt: Date.now() };
    },
    apply: async ({ prepared }) => {
      calls.push("apply");
      return input.apply ? await input.apply(prepared.prepared) as { id: string } : { id: "remote-1" };
    },
    inspect: async () => {
      calls.push("inspect");
      return input.inspect ? input.inspect() : "unknown";
    },
    compensate: async ({ prepared }) => {
      calls.push("compensate");
      await input.compensate?.(prepared.prepared);
    },
  };
  return { value, calls };
}

describe("WorkflowV2OperationBroker", () => {
  test("prepares durably without applying until the coordinator advances the plan", async () => {
    const store = fakeStore();
    const testAdapter = adapter({});
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const input = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, kind: "http" as const, target: "https://example.test", plan: { url: "https://example.test" }, adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };

    const prepared = await broker.prepare(input);
    expect(prepared.state).toBe("planned");
    expect(testAdapter.calls).toEqual(["prepare"]);
    await broker.applyPrepared({ workflowId: "workflow-1", runId: "run-1", operationId: prepared.operationId });
    expect(testAdapter.calls).toEqual(["prepare", "apply"]);
  });

  test("persists planned before apply and blocks duplicate idempotency keys", async () => {
    const store = fakeStore();
    const testAdapter = adapter({});
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const input = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, kind: "http" as const, target: "https://example.test", plan: { url: "https://example.test" }, adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };

    await expect(broker.apply(input)).resolves.toEqual({ id: "remote-1" });
    await expect(broker.apply(input)).resolves.toEqual({ id: "remote-1" });
    expect(testAdapter.calls).toEqual(["prepare", "apply"]);
    expect(store.operations[0]).toMatchObject({ state: "applied", idempotencyKey: expect.stringContaining("http-test") });
  });

  test("keeps apply failures unknown until inspect proves remote application", async () => {
    const store = fakeStore();
    const testAdapter = adapter({ apply: async () => { throw new Error("receipt write failed"); }, inspect: async () => "applied" });
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const input = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, kind: "http" as const, target: "https://example.test", plan: { url: "https://example.test" }, adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };

    await expect(broker.apply(input)).rejects.toThrow("receipt write failed");
    expect(store.operations[0]?.state).toBe("unknown");
    await expect(broker.inspect({ workflowId: "workflow-1", runId: "run-1", operationId: store.operations[0]!.operationId })).resolves.toBe("applied");
    expect(store.operations[0]?.state).toBe("applied");
  });

  test("leaves applying durable when receipt persistence fails so recovery inspects before retry", async () => {
    const options = { failAppliedTransition: true };
    const store = fakeStore(options);
    const testAdapter = adapter({ inspect: async () => "applied" });
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const input = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, kind: "http" as const, target: "https://example.test", plan: { url: "https://example.test" }, adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };

    await expect(broker.apply(input)).rejects.toThrow("receipt persistence failed");
    expect(store.operations[0]?.state).toBe("applying");
    options.failAppliedTransition = false;
    await expect(broker.inspect({ workflowId: "workflow-1", runId: "run-1", operationId: store.operations[0]!.operationId })).resolves.toBe("applied");
    expect(testAdapter.calls.filter((call) => call === "apply")).toHaveLength(1);
  });

  test("keeps the operation unknown when inspection itself fails", async () => {
    const store = fakeStore();
    const testAdapter = adapter({
      apply: async () => { throw new Error("remote result unavailable"); },
      inspect: async () => { throw new Error("inspection unavailable"); },
    });
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const input = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, kind: "http" as const, target: "https://example.test", plan: { url: "https://example.test" }, adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };

    await expect(broker.apply(input)).rejects.toThrow("remote result unavailable");
    await expect(broker.inspect({ workflowId: "workflow-1", runId: "run-1", operationId: store.operations[0]!.operationId })).resolves.toBe("unknown");
    expect(store.operations[0]).toMatchObject({ state: "unknown", error: "inspection unavailable" });
  });

  test("compensates applied operations in reverse order", async () => {
    const store = fakeStore();
    const testAdapter = adapter({});
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const base = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", kind: "http" as const, target: "https://example.test", adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };
    await broker.apply({ ...base, nodeId: "node-1", attempt: 1, plan: { url: "https://example.test/1" } });
    await broker.apply({ ...base, nodeId: "node-2", attempt: 1, plan: { url: "https://example.test/2" } });
    const result = await broker.compensateRun({ workflowId: "workflow-1", runId: "run-1" });
    expect(result.failed).toBeUndefined();
    expect(result.compensated).toEqual([store.operations[1]!.operationId, store.operations[0]!.operationId]);
    expect(testAdapter.calls.filter((call) => call === "compensate")).toHaveLength(2);
  });

  test("stops reverse compensation immediately after the first failure", async () => {
    const store = fakeStore();
    let compensationCalls = 0;
    const testAdapter = adapter({ compensate: async () => { compensationCalls += 1; throw new Error("compensation failed"); } });
    const broker = new WorkflowV2OperationBroker(store as never);
    broker.register(testAdapter.value);
    const base = { workflowId: "workflow-1", transactionId: "transaction-1", runId: "run-1", kind: "http" as const, target: "https://example.test", adapterId: "http-test", reversible: true, compensationAdapter: "http-test" };
    await broker.apply({ ...base, nodeId: "node-1", attempt: 1, plan: { url: "https://example.test/1" } });
    await broker.apply({ ...base, nodeId: "node-2", attempt: 1, plan: { url: "https://example.test/2" } });

    const result = await broker.compensateRun({ workflowId: "workflow-1", runId: "run-1" });
    expect(result.failed?.operationId).toBe(store.operations[1]!.operationId);
    expect(compensationCalls).toBe(1);
    expect(store.operations[0]?.state).toBe("applied");
    expect(store.operations[1]?.state).toBe("unknown");
  });
});
