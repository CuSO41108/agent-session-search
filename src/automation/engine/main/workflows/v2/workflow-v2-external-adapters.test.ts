import { describe, expect, test, vi } from "vitest";
import {
  WorkflowV2HttpOperationAdapter,
  WorkflowV2MessageOperationAdapter,
  workflowHttpRequestDigest,
  workflowMessageDraftDigest,
  type WorkflowMessageDraft,
} from "./workflow-v2-external-adapters";

const prepareContext = { transactionId: "transaction-1", runId: "run-1", nodeId: "node-1", attempt: 1, idempotencyKey: "idempotency-1", signal: new AbortController().signal };

describe("Workflow V2 external operation adapters", () => {
  test("binds HTTP writes to idempotency and requires inspect plus compensation in strict mode", async () => {
    const fetchFn = vi.fn(async () => new Response("ok", { status: 201, headers: { "x-request-id": "remote-1" } }));
    const adapter = new WorkflowV2HttpOperationAdapter(fetchFn as typeof fetch);
    await expect(adapter.prepare({ ...prepareContext, plan: { mode: "strict_atomic", request: { url: "https://example.test/items", method: "POST", body: "{}" } } })).rejects.toThrow("inspect and compensate");
    await expect(adapter.prepare({ ...prepareContext, plan: { mode: "direct", request: { url: "https://example.test/items", method: "POST", body: "{}" } } })).rejects.toThrow("only allowed in controlled mode");
    const prepared = await adapter.prepare({
      ...prepareContext,
      plan: {
        mode: "strict_atomic",
        request: { url: "https://example.test/items", method: "POST", headers: { Authorization: "Bearer secret" }, body: "{}" },
        inspect: { url: "https://example.test/items/by-key", method: "GET" },
        compensate: { url: "https://example.test/items/by-key", method: "DELETE" },
      },
    });
    await expect(adapter.apply({ prepared, signal: prepareContext.signal })).resolves.toMatchObject({ status: 201, remoteId: "remote-1", idempotencyKey: "idempotency-1" });
    expect(fetchFn).toHaveBeenCalledWith("https://example.test/items", expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "idempotency-1" }) }));

    const controlledRequest = { url: "https://example.test/publish", method: "POST", body: "approved" };
    const controlledApprovalDigest = workflowHttpRequestDigest(controlledRequest);
    await expect(adapter.prepare({ ...prepareContext, plan: { mode: "controlled", request: controlledRequest, controlledApprovalDigest } })).resolves.toMatchObject({ adapterId: "http" });
    await expect(adapter.prepare({ ...prepareContext, plan: { mode: "controlled", request: { ...controlledRequest, body: "changed" }, controlledApprovalDigest } })).rejects.toThrow("no longer matches");
  });

  test("never sends redacted recovery credentials to an HTTP endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));
    const adapter = new WorkflowV2HttpOperationAdapter(fetchFn as typeof fetch);
    const request = { url: "https://example.test/items", method: "POST", headers: { Authorization: "[REDACTED]" }, body: "{}" };
    const prepared = await adapter.prepare({
      ...prepareContext,
      plan: {
        mode: "strict_atomic",
        request,
        inspect: { url: "https://example.test/items/by-key", method: "GET" },
        compensate: { url: "https://example.test/items/by-key", method: "DELETE" },
      },
    });

    await expect(adapter.apply({ prepared, signal: prepareContext.signal })).rejects.toThrow("re-authorized");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("invalidates message approval after any bound draft field changes", async () => {
    const provider = { send: vi.fn(), inspect: vi.fn(async () => "unknown" as const) };
    const adapter = new WorkflowV2MessageOperationAdapter(provider);
    const draft: WorkflowMessageDraft = { channel: "email", recipients: ["user@example.test"], title: "Status", body: "Ready", attachments: [], scheduledAt: 10 };
    const approval = { approvalId: "approval-1", actor: "operator", approvedAt: 1, draftDigest: workflowMessageDraftDigest(draft) };
    await expect(adapter.prepare({ ...prepareContext, plan: { draft, approval } })).resolves.toMatchObject({ adapterId: "message" });
    await expect(adapter.prepare({ ...prepareContext, plan: { draft: { ...draft, body: "Changed" }, approval } })).rejects.toThrow("changed after approval");
  });

  test("does not claim irreversible messages were compensated", async () => {
    const provider = { send: vi.fn(), inspect: vi.fn(async () => "applied" as const) };
    const adapter = new WorkflowV2MessageOperationAdapter(provider);
    const draft: WorkflowMessageDraft = { channel: "chat", recipients: ["room-1"], body: "Published", attachments: [] };
    const prepared = await adapter.prepare({ ...prepareContext, plan: { draft, approval: { approvalId: "approval-1", actor: "operator", approvedAt: 1, draftDigest: workflowMessageDraftDigest(draft) } } });
    await expect(adapter.compensate({ prepared, receipt: { providerMessageId: "message-1", sentAt: 2, irreversible: true }, signal: prepareContext.signal })).rejects.toThrow("irreversible");
  });
});
