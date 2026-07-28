import { describe, expect, test } from "vitest";
import type { WorkflowRunState } from "../../../shared/types";
import { cloneWorkflowRun, cloneWorkflowRunProgressItem } from "./agent-hub-workflow-clone";

describe("workflow progress cloning", () => {
  test("preserves and deep-clones script input requests", () => {
    const inputRequest = {
      kind: "script_parameters" as const,
      parameters: [{
        key: "text",
        label: "输入内容",
        location: "stdin" as const,
        valueType: "string" as const,
        source: "user" as const,
        required: true,
      }],
    };

    const cloned = cloneWorkflowRunProgressItem({
      nodeId: "echo-input",
      title: "原样输出用户输入",
      status: "awaiting_input",
      detail: "Waiting for 输入内容",
      inputRequest,
      outputs: { output: "hello" },
      messages: [{ id: "message-1", role: "assistant", content: "hello", at: 1 }],
    });

    expect(cloned.inputRequest).toEqual(inputRequest);
    expect(cloned.inputRequest).not.toBe(inputRequest);
    expect(cloned.inputRequest?.kind === "script_parameters" ? cloned.inputRequest.parameters[0] : undefined).not.toBe(inputRequest.parameters[0]);
    expect(cloned.outputs).toEqual({ output: "hello" });
    expect(cloned.messages).toEqual([{ id: "message-1", role: "assistant", content: "hello", at: 1 }]);
    expect(cloned.messages).not.toBeUndefined();
  });

  test("preserves durable transaction recovery facts in public run snapshots", () => {
    const run = {
      runId: "run-1",
      workflowId: "workflow-1",
      status: "waiting_for_user",
      triggerSource: "recovery",
      configurationSnapshot: { configuredAgentId: "agent-1", runtimeId: "api" },
      workflowV2Plan: { workflowId: "workflow-1", graphVersion: 1, definition: { nodes: [] }, nodes: [] },
      progress: [{ nodeId: "node-1", title: "Node", status: "paused", acceptance: { outcome: "degraded", issues: [], changedPaths: [], operationIds: [] }, scriptReceipt: { exitCode: 1, signal: null, timedOut: false, stderrSummary: "error", stdoutDigest: "digest", operationDigest: "operation-digest", effectState: "unknown" } }],
      events: [],
      contextDocument: "",
      transaction: { transactionId: "transaction-1", mode: "strict_atomic", status: "recovery_required", baselineId: "baseline-1", operationCount: 0, unknownOperationCount: 0, irreversibleOperationCount: 0, startedAt: 1, updatedAt: 2, retentionUntil: 3 },
      operations: [],
      recovery: { generatedAt: 2, transactionId: "transaction-1", status: "recovery_required", blockers: ["review"], conflicts: [], conflictDetails: [], changedPaths: [], pendingNodeIds: [], uncertainNodeIds: [], cancelledNodeIds: [], cancellingNodeIds: [], notStartedNodeIds: [], availableActions: ["keep_state"], managerRecommendation: { source: "agent", generatedAt: 2, transactionId: "transaction-1", recommendedAction: "keep_state", rationale: "Review", compensationOperationIds: [], manualSteps: [], riskComparison: [], conflictCandidates: [] } },
      recoveryDecisions: [{ decisionId: "decision-1", transactionId: "transaction-1", action: "keep_state", actor: "user", reason: "Review", operationIds: [], decidedAt: 2 }],
      startedAt: 1,
      finishedAt: undefined,
      lastError: undefined,
    } as unknown as WorkflowRunState;

    const cloned = cloneWorkflowRun(run);

    expect(cloned).toMatchObject({ triggerSource: "recovery", configurationSnapshot: { runtimeId: "api" }, transaction: { status: "recovery_required" }, recovery: { managerRecommendation: { source: "agent" } }, recoveryDecisions: [{ decisionId: "decision-1" }], progress: [{ acceptance: { outcome: "degraded" }, scriptReceipt: { effectState: "unknown" } }] });
    expect(cloned.recovery).not.toBe(run.recovery);
  });
});
