import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowV2Definition } from "../../../../shared/workflow-v2/definition";
import { addWorkflowReviewGate, removeWorkflowReviewGate, updateWorkflowReviewGate, WorkflowDraftEditorDialog } from "./WorkflowDraftEditorDialog";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "wf-editor",
    graphVersion: 1,
    objective: "Review a result",
    nodes: [{ id: "answer", kind: "agent", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: "executor", prompt: "Answer", outputFields: [{ key: "answer" }] }],
    edges: [],
  };
}

describe("Workflow Draft Review Gate editing", () => {
  test("adds at most one attached Gate per target and removes it without changing the node", () => {
    const added = addWorkflowReviewGate(definition(), "answer", "reviewer");
    expect(added.reviewGates).toEqual([expect.objectContaining({ targetNodeId: "answer", configuredAgentId: "reviewer", maxQualityRetries: 2 })]);
    expect(addWorkflowReviewGate(added, "answer", "other").reviewGates).toHaveLength(1);
    const updated = updateWorkflowReviewGate(added, added.reviewGates![0]!.id, (gate) => { gate.reviewLevel = "high"; });
    expect(updated.reviewGates![0]!.reviewLevel).toBe("high");
    const removed = removeWorkflowReviewGate(updated, updated.reviewGates![0]!.id);
    expect(removed.reviewGates).toEqual([]);
    expect(removed.nodes).toEqual(definition().nodes);
  });

  test("hides Review Gate controls while the Runtime Review setting is disabled", () => {
    const configuredAgents = [{ id: "reviewer", name: "Reviewer", description: "", runtimeAgentId: "codex" as const, channelId: "channel", modelId: "model", tags: [], createdAt: 1, updatedAt: 1 }];
    const disabled = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={definition()} configuredAgents={configuredAgents} runtimeReviewEnabled={false} onSave={() => undefined} onClose={() => undefined} />);
    const enabled = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={definition()} configuredAgents={configuredAgents} runtimeReviewEnabled onSave={() => undefined} onClose={() => undefined} />);

    expect(disabled).not.toContain("Runtime Review Gates");
    expect(enabled).toContain("Runtime Review Gates");
    expect(enabled).toContain("Add Review Gate for Answer");
  });
});
