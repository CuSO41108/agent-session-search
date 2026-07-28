import { describe, expect, test } from "vitest";
import {
  canTransitionWorkflowOperation,
  createDirectWorkflowTransactionPolicy,
  createStrictWorkflowTransactionPolicy,
  isWorkflowTransactionState,
  resolveWorkflowTransactionPolicy,
  sanitizeWorkflowOperationRecord,
  workflowTransactionPreflightError,
  workflowTransactionPolicyValidationErrors,
} from "./transaction";

describe("workflow transaction contracts", () => {
  test("maps legacy definitions to direct mode with an explicit warning", () => {
    const resolved = resolveWorkflowTransactionPolicy(undefined);
    expect(resolved.policy.defaultMode).toBe("direct");
    expect(resolved.compatibilityWarning).toContain("without rollback guarantees");
    expect(createStrictWorkflowTransactionPolicy().defaultMode).toBe("strict_atomic");
    expect(createDirectWorkflowTransactionPolicy().defaultMode).toBe("direct");
    expect(workflowTransactionPreflightError(undefined)).toBeUndefined();
    expect(workflowTransactionPreflightError(createStrictWorkflowTransactionPolicy())).toContain("durable transaction ledger");
    expect(workflowTransactionPreflightError(createStrictWorkflowTransactionPolicy(), { durableLedger: true })).toContain("recovery approval surface");
    expect(workflowTransactionPreflightError(createStrictWorkflowTransactionPolicy(), { durableLedger: true, recoveryApproval: true })).toContain("workspace isolation");
    expect(workflowTransactionPreflightError(createStrictWorkflowTransactionPolicy(), { workspaceIsolation: true, durableLedger: true, recoveryApproval: true })).toBeUndefined();
    expect(workflowTransactionPreflightError({ ...createDirectWorkflowTransactionPolicy(), defaultMode: "controlled" }, { durableLedger: true, recoveryApproval: true })).toContain("operation broker");
    expect(isWorkflowTransactionState({
      transactionId: "transaction-1",
      mode: "direct",
      status: "active",
      baselineId: "baseline-1",
      operationCount: 0,
      unknownOperationCount: 1,
      irreversibleOperationCount: 0,
      startedAt: 1,
      updatedAt: 1,
      retentionUntil: 2,
    })).toBe(false);
  });

  test("validates checkpoint identities and node references", () => {
    const policy = createStrictWorkflowTransactionPolicy();
    policy.checkpoints = [{ id: "review", title: "Review", afterNodeIds: ["missing"], kind: "commit", approval: "required" }];
    expect(workflowTransactionPolicyValidationErrors(policy, new Set(["build"]))).toContain(
      "Workflow transaction checkpoint review references missing node missing.",
    );
    expect(() => workflowTransactionPolicyValidationErrors({
      ...policy,
      checkpoints: [{ id: 1, title: null, afterNodeIds: [null], kind: "commit", approval: "required" }],
    } as never, new Set(["build"]))).not.toThrow();
    expect(workflowTransactionPolicyValidationErrors({
      ...policy,
      checkpoints: [{ id: 1, title: null, afterNodeIds: [null], kind: "commit", approval: "required" }],
    } as never, new Set(["build"]))).toEqual(expect.arrayContaining([
      "Workflow transaction checkpoint id must be a non-empty string.",
      "Workflow transaction checkpoint <invalid> must have a title.",
      "Workflow transaction checkpoint <invalid> contains an invalid node id.",
    ]));
  });

  test("redacts credentials from operation summaries, receipts, errors, and targets", () => {
    const sanitized = sanitizeWorkflowOperationRecord({
      operationId: "operation-1",
      transactionId: "transaction-1",
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      kind: "http",
      target: "https://example.test/send?client_secret=plain-text",
      idempotencyKey: "key-1",
      state: "planned",
      reversible: true,
      requestSummary: { headers: { Authorization: "Bearer abc.def", cookie: "session=secret", "X-Api-Key": "x-api-value" }, password: "plain", clientSecret: "client-secret-value" },
      receipt: { access_token: "plain", message: "Authorization: Bearer abc", rawBody: JSON.stringify({ password: "json-password", nested: { client_secret: "json-secret" } }) },
      error: "request failed with Authorization: secret value containing spaces; retry stopped",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(JSON.stringify(sanitized)).not.toContain("plain-text");
    expect(JSON.stringify(sanitized)).not.toContain("abc.def");
    expect(JSON.stringify(sanitized)).not.toContain("session=secret");
    expect(JSON.stringify(sanitized)).not.toContain("x-api-value");
    expect(JSON.stringify(sanitized)).not.toContain("client-secret-value");
    expect(JSON.stringify(sanitized)).not.toContain("json-password");
    expect(JSON.stringify(sanitized)).not.toContain("json-secret");
    expect(JSON.stringify(sanitized)).not.toContain("secret value containing spaces");
    expect(sanitized.target).toContain("[REDACTED]");
  });

  test("keeps unknown terminal and rejects illegal ledger jumps", () => {
    expect(canTransitionWorkflowOperation("planned", "applying")).toBe(true);
    expect(canTransitionWorkflowOperation("planned", "applied")).toBe(false);
    expect(canTransitionWorkflowOperation("unknown", "applied")).toBe(false);
  });
});
