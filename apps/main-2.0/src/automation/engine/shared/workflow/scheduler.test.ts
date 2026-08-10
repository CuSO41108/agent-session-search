import { describe, expect, test } from "vitest";
import type { WorkflowAgentNode, WorkflowDefinition, WorkflowNodeRun, WorkflowRun } from "./model";
import {
  deriveWorkflowRunStatus,
  invalidateWorkflowDownstream,
  readyWorkflowNodeIds,
  workflowNodeDependencies,
} from "./scheduler";

function node(id: string, dependencies: string[] = []): WorkflowAgentNode {
  return {
    id,
    kind: "agent",
    title: id,
    goal: id,
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: dependencies.map((dependency) => ({
      source: "node",
      nodeId: dependency,
      outputKey: "value",
    })),
    outputs: [{ key: "value", name: "Value", description: "Value", type: "text", required: true }],
    acceptanceCriteria: [],
  };
}

const definition: WorkflowDefinition = {
  id: "graph",
  name: "Graph",
  description: "Parallel graph",
  inputs: [],
  nodes: [node("root"), node("left", ["root"]), node("right", ["root"]), node("final", ["left", "right"])],
  createdAt: 1,
  updatedAt: 1,
};

function nodeRun(nodeId: string, status: WorkflowNodeRun["status"]): WorkflowNodeRun {
  return { nodeId, status, attempt: status === "pending" ? 0 : 1, ...(status === "completed" ? { outputs: { value: nodeId } } : {}) };
}

function run(statuses: Record<string, WorkflowNodeRun["status"]>): WorkflowRun {
  return {
    id: "run",
    workflowId: definition.id,
    definition,
    inputs: {},
    status: "running",
    nodeRuns: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, nodeRun(id, status)])),
    events: [],
    startedAt: 1,
  };
}

describe("workflow scheduler", () => {
  test("derives dependencies from node input references", () => {
    expect(workflowNodeDependencies(definition.nodes[3]!)).toEqual(["left", "right"]);
  });

  test("returns independent ready branches after their dependency completes", () => {
    expect(readyWorkflowNodeIds(definition, run({ root: "completed", left: "pending", right: "pending", final: "pending" }))).toEqual(["left", "right"]);
  });

  test("does not schedule a node whose dependency failed", () => {
    expect(readyWorkflowNodeIds(definition, run({ root: "completed", left: "failed", right: "completed", final: "pending" }))).toEqual([]);
  });

  test("invalidates a retried node and every transitive downstream node", () => {
    const next = invalidateWorkflowDownstream(definition, run({ root: "completed", left: "completed", right: "completed", final: "completed" }), ["left"]);
    expect(next.nodeRuns.left).toEqual({ nodeId: "left", status: "pending", attempt: 1 });
    expect(next.nodeRuns.final).toEqual({ nodeId: "final", status: "pending", attempt: 1 });
    expect(next.nodeRuns.root?.status).toBe("completed");
    expect(next.nodeRuns.right?.status).toBe("completed");
  });

  test("derives waiting failed and completed run states", () => {
    expect(deriveWorkflowRunStatus(definition, run({ root: "completed", left: "waiting", right: "completed", final: "pending" }))).toBe("waiting");
    expect(deriveWorkflowRunStatus(definition, run({ root: "completed", left: "failed", right: "completed", final: "pending" }))).toBe("failed");
    expect(deriveWorkflowRunStatus(definition, run({ root: "completed", left: "completed", right: "completed", final: "completed" }))).toBe("completed");
  });
});
