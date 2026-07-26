import { createHash } from "node:crypto";
import type { WorkflowTransactionMode } from "../../../shared/workflow-v2/transaction";
import type {
  WorkflowOperationInspection,
  WorkflowPreparedOperation,
  WorkflowTransactionalOperationAdapter,
} from "./workflow-v2-operation-broker";

export interface WorkflowHttpRequestPlan {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface WorkflowHttpOperationPlan {
  mode: WorkflowTransactionMode;
  request: WorkflowHttpRequestPlan;
  inspect?: WorkflowHttpRequestPlan;
  compensate?: WorkflowHttpRequestPlan;
  controlledApprovalDigest?: string;
}

export interface WorkflowHttpReceipt {
  status: number;
  responseDigest: string;
  idempotencyKey: string;
  remoteId?: string;
}

interface PreparedHttpOperation {
  request: WorkflowHttpRequestPlan;
  inspect?: WorkflowHttpRequestPlan;
  compensate?: WorkflowHttpRequestPlan;
  idempotencyKey: string;
}

export class WorkflowV2HttpOperationAdapter implements WorkflowTransactionalOperationAdapter<WorkflowHttpOperationPlan, WorkflowHttpReceipt> {
  readonly adapterId = "http";

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async prepare(input: Parameters<WorkflowTransactionalOperationAdapter<WorkflowHttpOperationPlan, WorkflowHttpReceipt>["prepare"]>[0]): Promise<WorkflowPreparedOperation<WorkflowHttpOperationPlan>> {
    const request = normalizedRequest(input.plan.request);
    const readOnly = request.method === "GET" || request.method === "HEAD";
    if (!readOnly && input.plan.mode === "strict_atomic" && (!input.plan.inspect || !input.plan.compensate)) {
      throw new Error("Strict atomic HTTP writes require both inspect and compensate requests.");
    }
    if (!readOnly && !input.plan.compensate) {
      if (input.plan.mode !== "controlled") throw new Error("Irreversible HTTP writes are only allowed in controlled mode.");
      if (!input.plan.controlledApprovalDigest) throw new Error("Controlled irreversible HTTP writes require explicit approval bound to the request digest.");
    }
    const requestDigest = workflowHttpRequestDigest(request);
    if (input.plan.controlledApprovalDigest && input.plan.controlledApprovalDigest !== requestDigest) {
      throw new Error("HTTP operation approval no longer matches the prepared request.");
    }
    return {
      adapterId: this.adapterId,
      plan: input.plan,
      prepared: {
        request,
        ...(input.plan.inspect ? { inspect: normalizedRequest(input.plan.inspect) } : {}),
        ...(input.plan.compensate ? { compensate: normalizedRequest(input.plan.compensate) } : {}),
        idempotencyKey: input.idempotencyKey,
      } satisfies PreparedHttpOperation,
      preparedAt: Date.now(),
    };
  }

  async apply(input: { prepared: WorkflowPreparedOperation<WorkflowHttpOperationPlan>; signal: AbortSignal }): Promise<WorkflowHttpReceipt> {
    const prepared = input.prepared.prepared as PreparedHttpOperation;
    const response = await this.execute(prepared.request, prepared.idempotencyKey, input.signal);
    if (!response.ok) throw new Error(`Workflow HTTP operation failed with status ${response.status}.`);
    const remoteId = response.headers.get("x-request-id") ?? response.headers.get("location") ?? undefined;
    return {
      status: response.status,
      responseDigest: semanticDigest({ status: response.status, contentLength: response.headers.get("content-length"), etag: response.headers.get("etag"), remoteId }),
      idempotencyKey: prepared.idempotencyKey,
      ...(remoteId ? { remoteId } : {}),
    };
  }

  async inspect(input: { prepared: WorkflowPreparedOperation<WorkflowHttpOperationPlan>; receipt?: WorkflowHttpReceipt; signal: AbortSignal }): Promise<WorkflowOperationInspection> {
    const prepared = input.prepared.prepared as PreparedHttpOperation;
    if (!prepared.inspect) return "unknown";
    try {
      const response = await this.execute(prepared.inspect, prepared.idempotencyKey, input.signal);
      if (response.status === 404) return "not_applied";
      if (response.ok) return "applied";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async compensate(input: { prepared: WorkflowPreparedOperation<WorkflowHttpOperationPlan>; receipt: WorkflowHttpReceipt; signal: AbortSignal }): Promise<void> {
    const prepared = input.prepared.prepared as PreparedHttpOperation;
    if (!prepared.compensate) throw new Error("Workflow HTTP operation has no compensation request.");
    const response = await this.execute(prepared.compensate, prepared.idempotencyKey, input.signal);
    if (!response.ok) throw new Error(`Workflow HTTP compensation failed with status ${response.status}.`);
  }

  private execute(request: WorkflowHttpRequestPlan, idempotencyKey: string, signal: AbortSignal): Promise<Response> {
    assertExecutableRequest(request);
    return this.fetchFn(request.url, {
      method: request.method,
      headers: { ...request.headers, "Idempotency-Key": idempotencyKey },
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal,
    });
  }
}

export interface WorkflowMessageDraft {
  channel: string;
  recipients: string[];
  title?: string;
  body: string;
  attachments: Array<{ name: string; digest: string }>;
  scheduledAt?: number;
}

export interface WorkflowMessageApproval {
  approvalId: string;
  actor: string;
  approvedAt: number;
  draftDigest: string;
}

export interface WorkflowMessagePlan {
  draft: WorkflowMessageDraft;
  approval: WorkflowMessageApproval;
}

export interface WorkflowMessageReceipt {
  providerMessageId: string;
  sentAt: number;
  irreversible: boolean;
}

export interface WorkflowMessageProvider {
  send(input: { draft: WorkflowMessageDraft; idempotencyKey: string; signal: AbortSignal }): Promise<WorkflowMessageReceipt>;
  inspect(input: { idempotencyKey: string; providerMessageId?: string; signal: AbortSignal }): Promise<WorkflowOperationInspection>;
  retract?(input: { providerMessageId: string; signal: AbortSignal }): Promise<void>;
}

interface PreparedMessageOperation {
  draft: WorkflowMessageDraft;
  approval: WorkflowMessageApproval;
  idempotencyKey: string;
}

export class WorkflowV2MessageOperationAdapter implements WorkflowTransactionalOperationAdapter<WorkflowMessagePlan, WorkflowMessageReceipt> {
  readonly adapterId = "message";

  constructor(private readonly provider: WorkflowMessageProvider) {}

  async prepare(input: Parameters<WorkflowTransactionalOperationAdapter<WorkflowMessagePlan, WorkflowMessageReceipt>["prepare"]>[0]): Promise<WorkflowPreparedOperation<WorkflowMessagePlan>> {
    const draft = normalizeDraft(input.plan.draft);
    if (!input.plan.approval.approvalId.trim() || !input.plan.approval.actor.trim()) throw new Error("Workflow message approval identity is required.");
    if (input.plan.approval.draftDigest !== workflowMessageDraftDigest(draft)) {
      throw new Error("Workflow message draft changed after approval and must be confirmed again.");
    }
    return { adapterId: this.adapterId, plan: input.plan, prepared: { draft, approval: structuredClone(input.plan.approval), idempotencyKey: input.idempotencyKey } satisfies PreparedMessageOperation, preparedAt: Date.now() };
  }

  async apply(input: { prepared: WorkflowPreparedOperation<WorkflowMessagePlan>; signal: AbortSignal }): Promise<WorkflowMessageReceipt> {
    const prepared = input.prepared.prepared as PreparedMessageOperation;
    const receipt = await this.provider.send({ draft: structuredClone(prepared.draft), idempotencyKey: prepared.idempotencyKey, signal: input.signal });
    if (!receipt.providerMessageId.trim() || !Number.isFinite(receipt.sentAt)) throw new Error("Workflow message provider returned a malformed receipt.");
    return receipt;
  }

  inspect(input: { prepared: WorkflowPreparedOperation<WorkflowMessagePlan>; receipt?: WorkflowMessageReceipt; signal: AbortSignal }): Promise<WorkflowOperationInspection> {
    const prepared = input.prepared.prepared as PreparedMessageOperation;
    return this.provider.inspect({ idempotencyKey: prepared.idempotencyKey, ...(input.receipt?.providerMessageId ? { providerMessageId: input.receipt.providerMessageId } : {}), signal: input.signal });
  }

  async compensate(input: { prepared: WorkflowPreparedOperation<WorkflowMessagePlan>; receipt: WorkflowMessageReceipt; signal: AbortSignal }): Promise<void> {
    if (input.receipt.irreversible || !this.provider.retract) throw new Error("Workflow message is irreversible; generate a correction proposal instead of claiming rollback.");
    await this.provider.retract({ providerMessageId: input.receipt.providerMessageId, signal: input.signal });
  }
}

export function workflowMessageDraftDigest(draft: WorkflowMessageDraft): string {
  return semanticDigest(normalizeDraft(draft));
}

export function workflowHttpRequestDigest(request: WorkflowHttpRequestPlan): string {
  return semanticDigest(normalizedRequest(request));
}

function normalizedRequest(request: WorkflowHttpRequestPlan): WorkflowHttpRequestPlan {
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Workflow HTTP operation only supports http and https URLs.");
  const method = request.method.trim().toUpperCase();
  if (!method) throw new Error("Workflow HTTP method is required.");
  return { url: url.toString(), method, ...(request.headers ? { headers: structuredClone(request.headers) } : {}), ...(request.body !== undefined ? { body: request.body } : {}) };
}

function assertExecutableRequest(request: WorkflowHttpRequestPlan): void {
  const values = [request.url, request.body, ...Object.values(request.headers ?? {})];
  if (values.some((value) => value?.includes("[REDACTED"))) {
    throw new Error("Workflow HTTP operation contains redacted credential data and must be re-authorized before execution.");
  }
}

function normalizeDraft(draft: WorkflowMessageDraft): WorkflowMessageDraft {
  const channel = draft.channel.trim();
  const recipients = [...new Set(draft.recipients.map((recipient) => recipient.trim()).filter(Boolean))].sort();
  if (!channel || recipients.length === 0 || !draft.body.trim()) throw new Error("Workflow message draft requires channel, recipient, and body.");
  const attachments = [...draft.attachments].map((attachment) => ({ name: attachment.name.trim(), digest: attachment.digest.trim() })).sort((left, right) => left.name.localeCompare(right.name));
  if (attachments.some((attachment) => !attachment.name || !attachment.digest)) throw new Error("Workflow message attachments require name and digest.");
  return { channel, recipients, ...(draft.title?.trim() ? { title: draft.title.trim() } : {}), body: draft.body, attachments, ...(draft.scheduledAt !== undefined ? { scheduledAt: draft.scheduledAt } : {}) };
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
