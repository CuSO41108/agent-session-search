import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { inspectWorkflowV2AgentCompletion } from "./workflow-v2-node-acceptance";

const node: WorkflowV2LLMNode = {
  id: "agent",
  kind: "task",
  title: "Agent",
  execModel: "llm",
  executionMode: "one-shot",
  prompt: "Run required tool",
  requiredTools: ["publish"],
  outputFields: [{ key: "result", required: true }],
};

function messages(events: Array<{ id: string; type: "tool_call" | "tool_result"; name: string; status?: string }>) {
  return [{ id: "message", role: "assistant" as const, content: "done", timestamp: 1, events: events.map((event) => ({
    id: event.id,
    type: event.type,
    name: event.name,
    content: event.type,
    timestamp: 1,
    metadata: { id: event.id, ...(event.status ? { status: event.status } : {}) },
  })) }];
}

describe("inspectWorkflowV2AgentCompletion", () => {
  test("rejects a required tool whose final text hides a failed result", () => {
    const report = inspectWorkflowV2AgentCompletion({ node, messages: messages([
      { id: "call-1", type: "tool_call", name: "publish" },
      { id: "call-1", type: "tool_result", name: "publish", status: "failed" },
    ]) });
    expect(report).toMatchObject({ outcome: "rejected", issues: expect.arrayContaining([expect.objectContaining({ code: "required_tool_failed" })]) });
  });

  test("retains a failed attempt but accepts a later paired success as degraded", () => {
    const report = inspectWorkflowV2AgentCompletion({ node, messages: messages([
      { id: "call-1", type: "tool_call", name: "publish" },
      { id: "call-1", type: "tool_result", name: "publish", status: "failed" },
      { id: "call-2", type: "tool_call", name: "publish" },
      { id: "call-2", type: "tool_result", name: "publish", status: "completed" },
    ]) });
    expect(report).toMatchObject({ outcome: "degraded", issues: [expect.objectContaining({ code: "tool_retry_recovered", severity: "warning" })] });
  });

  test("rejects tool history that cannot be paired by stable ID", () => {
    const report = inspectWorkflowV2AgentCompletion({ node: { ...node, requiredTools: [] }, messages: [{ id: "message", role: "assistant", content: "done", timestamp: 1, events: [{ id: "event", type: "tool_call", name: "read", content: "{}", timestamp: 1 }] }] });
    expect(report).toMatchObject({ outcome: "rejected", issues: [expect.objectContaining({ code: "tool_call_id_missing" })] });
  });

  test("rejects a paired result whose terminal status is unknown", () => {
    const report = inspectWorkflowV2AgentCompletion({ node, messages: messages([
      { id: "call-1", type: "tool_call", name: "publish" },
      { id: "call-1", type: "tool_result", name: "publish" },
    ]) });
    expect(report).toMatchObject({
      outcome: "rejected",
      issues: expect.arrayContaining([expect.objectContaining({ code: "tool_result_status_unknown" })]),
    });
  });
});
