import { describe, expect, test } from "vitest";
import { parseWorkflowV2GenerationReviewSubmission, workflowV2GenerationReviewPrompt } from "./workflow-v2-generation-review";

const definition = {
  workflowId: "review-contract",
  graphVersion: 1,
  objective: "Validate review submissions",
  nodes: [{
    id: "answer",
    kind: "answer",
    title: "Answer",
    execModel: "llm" as const,
    executionMode: "one-shot" as const,
    prompt: "Answer with evidence.",
    outputFields: [{ key: "answer", required: true }],
  }],
  edges: [],
};

describe("Workflow V2 generation Review submission", () => {
  test("requires human-readable review content in Simplified Chinese", () => {
    const prompt = workflowV2GenerationReviewPrompt({ definition, revision: 2 });

    expect(prompt).toContain("Write every human-readable review field in Simplified Chinese");
    expect(prompt).toContain("Keep protocol enums, exact node IDs, and object keys unchanged");
  });

  test("accepts the canonical MCP argument contract and binds the Revision", () => {
    expect(parseWorkflowV2GenerationReviewSubmission({
      definition,
      revision: 2,
      value: {
        verdict: "revise",
        summary: "One blocking issue",
        findings: [{
          severity: "blocking",
          nodeIds: ["answer"],
          summary: "Completion is underspecified",
          failurePath: "The node can return an answer without evidence.",
          requiredChange: "Require evidence in the node outputs.",
        }],
        scriptRisks: {},
        suggestions: [],
      },
    })).toMatchObject({ verdict: "revise", reviewedRevision: 2 });
  });

  test("reports the exact invalid MCP argument path", () => {
    expect(() => parseWorkflowV2GenerationReviewSubmission({
      definition,
      revision: 2,
      value: {
        verdict: "revise",
        summary: "Invalid severity",
        findings: [{ severity: "high", nodeIds: ["answer"], summary: "Issue", failurePath: "Failure", requiredChange: "Change" }],
        scriptRisks: {},
        suggestions: [],
      },
    })).toThrow(/findings\.0\.severity/);
  });
});
