import { describe, expect, test } from "vitest";
import type { WorkflowDraftState } from "../../../shared/types";
import { runWorkflowGenerationReviewLifecycle } from "./workflow-generation-review-service";

function workflowDraft(): WorkflowDraftState {
  const definition = {
    workflowId: "review-trace-workflow",
    graphVersion: 1,
    objective: "Produce a reviewed answer",
    nodes: [{
      id: "answer",
      kind: "answer",
      title: "Answer",
      execModel: "llm" as const,
      executionMode: "one-shot" as const,
      prompt: "Answer the question",
      outputFields: [{ key: "answer", required: true }],
    }],
    edges: [],
  };
  return {
    workflowId: definition.workflowId,
    sourceType: "user",
    topologyLocked: false,
    title: "Review trace",
    status: "draft",
    revision: 3,
    configuredAgentId: "worker",
    modelId: "worker-model",
    reviewerConfiguredAgentId: "reviewer",
    reviewerModelId: "reviewer-model",
    objective: definition.objective,
    definition,
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "",
    contextDocument: "",
    runIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workflow generation review lifecycle", () => {
  test("publishes and retains the request, tool activity, and final response", async () => {
    let current = workflowDraft();
    await runWorkflowGenerationReviewLifecycle({
      workflow: current,
      askReviewer: async (_prompt, onEvent) => {
        onEvent?.({ requestId: "request-1", type: "tool_call", name: "read_file", content: "Read workflow evidence" });
        onEvent?.({ requestId: "request-1", type: "tool_result", name: "read_file", content: "Evidence loaded" });
        return {
          content: JSON.stringify({ verdict: "approve", reviewedRevision: 3, summary: "Ready", findings: [], scriptRisks: {}, suggestions: [] }),
        };
      },
      publish: (workflow) => { current = workflow; },
      current: () => current,
      flush: async () => undefined,
      clone: (workflow) => structuredClone(workflow),
    });

    expect(current.generationReview?.status).toBe("approved");
    expect(current.generationReview?.trace?.map((entry) => entry.kind)).toEqual([
      "request",
      "tool_call",
      "tool_result",
      "response",
    ]);
    expect(current.generationReview?.trace?.[0]?.content).toContain("Revision: 3");
    expect(current.generationReview?.trace?.at(-1)?.content).toContain('"verdict":"approve"');
  });
});
