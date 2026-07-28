import type { TaskRun } from "../../../shared/types";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2NodeAcceptanceIssue, WorkflowV2NodeAcceptanceReport } from "../../../shared/workflow-v2/packets";
import type { WorkflowOperationRecord } from "../../../shared/workflow-v2/transaction";

export function inspectWorkflowV2AgentCompletion(input: {
  node: WorkflowV2LLMNode;
  messages: TaskRun["messages"];
  changedPaths?: readonly string[];
  operations?: readonly WorkflowOperationRecord[];
}): WorkflowV2NodeAcceptanceReport {
  const issues: WorkflowV2NodeAcceptanceIssue[] = [];
  const calls = new Map<string, { name: string }>();
  const successfulToolNames: string[] = [];
  const failedToolNames: string[] = [];
  const events = input.messages.flatMap((message) => message.events ?? [])
    .filter((event) => event.type === "tool_call" || event.type === "tool_result");

  for (const event of events) {
    const callId = stableToolCallId(event.metadata);
    const name = event.name?.trim() || "<unnamed>";
    if (!callId) {
      issues.push({ code: "tool_call_id_missing", severity: "error", detail: `${event.type} ${name} has no stable tool-call ID.` });
      continue;
    }
    if (event.type === "tool_call") {
      if (calls.has(callId)) issues.push({ code: "tool_call_id_duplicate", severity: "error", detail: `Tool-call ID ${callId} was used more than once.` });
      else calls.set(callId, { name });
      continue;
    }
    const call = calls.get(callId);
    if (!call) {
      issues.push({ code: "tool_result_unpaired", severity: "error", detail: `Tool result ${name} has no matching call for ID ${callId}.` });
      continue;
    }
    calls.delete(callId);
    if (call.name !== name && call.name !== "<unnamed>" && name !== "<unnamed>") {
      issues.push({ code: "tool_name_mismatch", severity: "error", detail: `Tool-call ID ${callId} changed name from ${call.name} to ${name}.` });
      continue;
    }
    const resultStatus = toolResultStatus(event.metadata);
    if (resultStatus === "failed") failedToolNames.push(call.name);
    else if (resultStatus === "success") successfulToolNames.push(call.name);
    else issues.push({ code: "tool_result_status_unknown", severity: "error", detail: `Tool result ${name} (${callId}) has no authoritative terminal status.` });
  }

  for (const [callId, call] of calls) {
    issues.push({ code: "tool_result_missing", severity: "error", detail: `Tool call ${call.name} (${callId}) has no terminal result.` });
  }
  for (const requiredTool of input.node.requiredTools ?? []) {
    if (!successfulToolNames.some((name) => toolNameMatches(name, requiredTool))) {
      const failed = failedToolNames.some((name) => toolNameMatches(name, requiredTool));
      issues.push({
        code: failed ? "required_tool_failed" : "required_tool_missing",
        severity: "error",
        detail: `Required tool ${requiredTool} did not produce a successful paired result.`,
      });
    }
  }
  for (const failedName of failedToolNames) {
    if (successfulToolNames.some((name) => toolNameMatches(name, failedName))) {
      issues.push({ code: "tool_retry_recovered", severity: "warning", detail: `Tool ${failedName} failed before a later successful call.` });
    } else if (!(input.node.requiredTools ?? []).some((required) => toolNameMatches(failedName, required))) {
      issues.push({ code: "tool_failed", severity: "warning", detail: `Tool ${failedName} failed and was retained in the audit history.` });
    }
  }

  const operations = input.operations ?? [];
  for (const operation of operations) {
    if (operation.state !== "applied") {
      issues.push({ code: "operation_not_applied", severity: "error", detail: `Operation ${operation.operationId} is ${operation.state}, not applied.` });
    } else if (operation.receipt === undefined) {
      issues.push({ code: "operation_receipt_missing", severity: "error", detail: `Applied operation ${operation.operationId} has no receipt.` });
    }
  }
  return {
    outcome: issues.some((issue) => issue.severity === "error") ? "rejected" : issues.length > 0 ? "degraded" : "clean",
    issues,
    changedPaths: [...new Set(input.changedPaths ?? [])].sort(),
    operationIds: operations.map((operation) => operation.operationId),
  };
}

function stableToolCallId(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.id ?? metadata?.toolCallId ?? metadata?.callId ?? metadata?.call_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toolResultStatus(metadata: Record<string, unknown> | undefined): "success" | "failed" | "unknown" {
  const status = typeof metadata?.status === "string" ? metadata.status.toLowerCase() : "";
  if (status === "completed" || status === "success" || status === "succeeded") return "success";
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  return "unknown";
}

function toolNameMatches(actual: string, required: string): boolean {
  return actual === required || actual.endsWith(`__${required}`);
}
