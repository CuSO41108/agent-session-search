import { describe, expect, test, vi } from "vitest";
import type { WorkflowOperationRecord } from "../../../shared/workflow-v2/transaction";
import type { WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";
import { executeWorkflowV2BrokeredScript } from "./workflow-v2-brokered-script-executor";
import { WorkflowV2OperationBroker, type WorkflowTransactionalOperationAdapter } from "./workflow-v2-operation-broker";

function node(code: string): WorkflowV2ScriptNode {
  return { id: "brokered", kind: "script", title: "Brokered", execModel: "script", executionMode: "script", outputFields: [], script: { executable: { kind: "inline", language: "typescript", code }, parameters: [], capabilities: ["network_write"], managerRisk: { level: "dangerous", rationale: "Approved external write." }, effectMode: "brokered_external", idempotency: "keyed", stderrPolicy: "fail", compensationAdapter: "http" } };
}

function fixture(scriptNode: WorkflowV2ScriptNode) {
  const operations: WorkflowOperationRecord[] = [];
  const store: WorkflowV2StorePort = {
    persistRunState: async () => undefined,
    appendEvents: async () => undefined,
    readOperations: async () => structuredClone(operations),
    planOperation: async ({ record }) => { operations.push(structuredClone(record)); return structuredClone(record); },
    transitionOperation: async ({ operationId, state, updatedAt, receipt, error }) => {
      const operation = operations.find((item) => item.operationId === operationId)!;
      Object.assign(operation, { state, updatedAt, ...(receipt !== undefined ? { receipt } : {}), ...(error ? { error } : {}) });
      return structuredClone(operation);
    },
  };
  const apply = vi.fn(async () => ({ status: 200 }));
  const adapter: WorkflowTransactionalOperationAdapter = { adapterId: "http", prepare: async (input) => ({ adapterId: "http", plan: input.plan, prepared: input.plan, preparedAt: Date.now() }), apply, inspect: async () => "applied", compensate: async () => undefined };
  const broker = new WorkflowV2OperationBroker(store);
  broker.register(adapter);
  const capabilities = ["network_write"] as const;
  const workDir = "C:\\workspace";
  const inputs = {};
  const operationDigest = workflowV2ScriptOperationDigest({ workflowId: "workflow-1", graphVersion: 1, runId: "run-1", node: scriptNode, workDir, inputs });
  return { operations, store, broker, apply, request: { node: scriptNode, workDir, upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 1_000, inputs, authorization: { decision: "allow_once" as const, workflowId: "workflow-1", graphVersion: 1, runId: "run-1", nodeId: scriptNode.id, risk: "dangerous" as const, capabilities: [...capabilities], capabilityDigest: workflowV2ScriptCapabilityDigest(capabilities), operationDigest, approvalRequestId: "approval-1", attempt: 2 } } };
}

describe("executeWorkflowV2BrokeredScript", () => {
  test("persists planned/applying before applying a declarative HTTP operation", async () => {
    const scriptNode = node('return { operations: [{ kind: "http", reversible: true, plan: { mode: "strict_atomic", request: { url: "https://example.test/items", method: "POST" }, inspect: { url: "https://example.test/items/1", method: "GET" }, compensate: { url: "https://example.test/items/1", method: "DELETE" } } }] };');
    const testFixture = fixture(scriptNode);
    const output = await executeWorkflowV2BrokeredScript(testFixture.request, testFixture.store, testFixture.broker);
    expect(testFixture.apply).toHaveBeenCalledOnce();
    expect(testFixture.operations).toEqual([expect.objectContaining({ state: "applied", attempt: 2, adapterId: "http", compensationAdapter: "http", receipt: { status: 200 } })]);
    expect(output.acceptance.operationIds).toEqual([testFixture.operations[0]!.operationId]);
    expect(output.scriptReceipt.effectState).toBe("brokered");
    expect(output.outputs).not.toHaveProperty("operations");
  });

  test("does not expose fetch or process to the planning script", async () => {
    const scriptNode = node("return { operations: [], fetchType: typeof fetch, processType: typeof process }; ");
    const testFixture = fixture(scriptNode);
    await expect(executeWorkflowV2BrokeredScript(testFixture.request, testFixture.store, testFixture.broker)).rejects.toThrow("non-empty operations");
    expect(testFixture.apply).not.toHaveBeenCalled();
  });
});
