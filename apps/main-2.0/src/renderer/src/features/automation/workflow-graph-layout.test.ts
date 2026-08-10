import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowNode } from "../../../../automation/engine/shared/workflow/model";
import { layoutWorkflowNodes } from "./workflow-graph-layout";

function node(id: string, dependencies: string[] = [], position?: { x: number; y: number }): WorkflowNode {
  return {
    id,
    kind: "agent",
    title: id,
    goal: id,
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: dependencies.map((dependency) => ({
      source: "node", nodeId: dependency, outputKey: "result",
    })),
    outputs: [{ key: "result", name: "Result", description: "Result", type: "text", required: true }],
    acceptanceCriteria: [],
    ...(position ? { position } : {}),
  };
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return { id: "workflow", name: "Workflow", description: "Workflow", inputs: [], nodes, createdAt: 1, updatedAt: 1 };
}

describe("layoutWorkflowNodes", () => {
  test("lays out dependency layers from left to right and branches vertically", () => {
    const positions = layoutWorkflowNodes(definition([
      node("source"), node("branchA", ["source"]), node("branchB", ["source"]), node("final", ["branchA", "branchB"]),
    ]));

    expect(positions.source!.x).toBeLessThan(positions.branchA!.x);
    expect(positions.branchA!.x).toBe(positions.branchB!.x);
    expect(positions.branchA!.y).not.toBe(positions.branchB!.y);
    expect(positions.branchA!.x).toBeLessThan(positions.final!.x);
  });

  test("keeps every manually saved position", () => {
    const positions = layoutWorkflowNodes(definition([
      node("source", [], { x: 91, y: 42 }),
      node("final", ["source"], { x: 501, y: 242 }),
    ]));

    expect(positions).toEqual({ source: { x: 91, y: 42 }, final: { x: 501, y: 242 } });
  });
});
