import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "./definition";
import { validateWorkflowV2Definition } from "./validation";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "review-validation",
    graphVersion: 1,
    objective: "Validate Review settings",
    reviewEnabled: false,
    nodes: [{
      id: "result",
      kind: "agent",
      title: "Result",
      execModel: "llm",
      executionMode: "one-shot",
      prompt: "Return a result.",
      outputFields: [{ key: "result", required: true }],
    }],
    edges: [],
  };
}

describe("Workflow V2 Review definition validation", () => {
  test("requires judge dimensions for every reviewed node", () => {
    const value = definition();
    value.nodes[0]!.reviewLevel = "high";
    expect(validateWorkflowV2Definition(value).errors).toContain("Workflow V2 reviewed node result must declare at least one judge dimension.");
  });

  test("accepts Review settings for script and reviewer-role nodes", () => {
    const value = definition();
    value.reviewEnabled = true;
    value.nodes[0] = {
      ...value.nodes[0]!,
      role: "reviewer",
      reviewLevel: "medium",
      reviewMaxRetries: 2,
      judgeDimensions: [{ key: "quality", description: "The result must meet the Workflow objective." }],
    };
    expect(validateWorkflowV2Definition(value)).toMatchObject({ valid: true, errors: [] });
  });
});
