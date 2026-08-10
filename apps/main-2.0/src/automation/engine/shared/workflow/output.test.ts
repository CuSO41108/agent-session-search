import { describe, expect, test } from "vitest";
import type { WorkflowAgentNode, WorkflowOutputField, WorkflowReviewNode } from "./model";
import { validateWorkflowNodeOutputs } from "./output";

function field(key: string, type: WorkflowOutputField["type"], extra: Partial<WorkflowOutputField> = {}): WorkflowOutputField {
  return { key, name: key, description: `${key} output`, type, required: true, ...extra };
}

function agent(outputs: WorkflowOutputField[]): WorkflowAgentNode {
  return {
    id: "node",
    kind: "agent",
    title: "Node",
    goal: "Produce outputs.",
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: [],
    outputs,
    acceptanceCriteria: [],
  };
}

describe("validateWorkflowNodeOutputs", () => {
  test("accepts declared scalar object and list values", () => {
    const node = agent([
      field("count", "number"),
      field("metadata", "object"),
      field("items", "list"),
    ]);

    expect(validateWorkflowNodeOutputs(node, {
      count: 2,
      metadata: { verified: true },
      items: ["one", "two"],
    })).toEqual([]);
  });

  test("reports missing required and undeclared fields", () => {
    const issues = validateWorkflowNodeOutputs(agent([field("summary", "text")]), { extra: "value" });
    expect(issues).toContainEqual({ path: "outputs.summary", message: "Required output is missing." });
    expect(issues).toContainEqual({ path: "outputs.extra", message: "Output field is not declared by the node." });
  });

  test("validates flat object and list output types without nested schemas", () => {
    const node = agent([field("metadata", "object"), field("items", "list")]);
    expect(validateWorkflowNodeOutputs(node, { metadata: [], items: {} })).toEqual([
      { path: "outputs.metadata", message: "Expected object output." },
      { path: "outputs.items", message: "Expected list output." },
    ]);
  });

  test.each(["/tmp/result.txt", "../result.txt", "nested/../../result.txt"])("rejects unsafe file output %s", (value) => {
    expect(validateWorkflowNodeOutputs(agent([field("file", "file")]), { file: value })).toContainEqual({
      path: "outputs.file",
      message: "File output must be a safe relative path inside the Run output directory.",
    });
  });

  test("restricts review verdict values", () => {
    const node: WorkflowReviewNode = {
      ...agent([field("verdict", "text"), field("criteriaResults", "list"), field("feedback", "text")]),
      kind: "review",
      agentId: "reviewer",
      instructions: [],
      constraints: [],
      targetNodeIds: ["target"],
      criteria: [],
      maxRevisions: 1,
      onReject: "revise",
    };

    expect(validateWorkflowNodeOutputs(node, { verdict: "maybe", criteriaResults: [], feedback: "" })).toContainEqual({
      path: "outputs.verdict",
      message: "Review verdict must be pass or revise.",
    });
  });
});
