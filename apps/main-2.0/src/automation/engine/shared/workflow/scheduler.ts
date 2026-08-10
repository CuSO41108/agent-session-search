import type { WorkflowDefinition, WorkflowNode, WorkflowNodeRun, WorkflowRun, WorkflowRunStatus } from "./model";

export function workflowNodeDependencies(node: WorkflowNode): string[] {
  return [...new Set(node.inputs.filter((input) => input.source === "node").map((input) => input.nodeId))];
}

export function readyWorkflowNodeIds(definition: WorkflowDefinition, run: WorkflowRun): string[] {
  return definition.nodes
    .filter((node) => {
      const state = run.nodeRuns[node.id];
      if (!state || (state.status !== "pending" && state.status !== "ready")) return false;
      return workflowNodeDependencies(node).every((dependency) => run.nodeRuns[dependency]?.status === "completed");
    })
    .map((node) => node.id);
}

function downstreamNodeIds(definition: WorkflowDefinition, startingNodeIds: readonly string[]): Set<string> {
  const affected = new Set(startingNodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of definition.nodes) {
      if (affected.has(node.id)) continue;
      if (workflowNodeDependencies(node).some((dependency) => affected.has(dependency))) {
        affected.add(node.id);
        changed = true;
      }
    }
  }
  return affected;
}

export function invalidateWorkflowDownstream(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  startingNodeIds: readonly string[],
): WorkflowRun {
  const affected = downstreamNodeIds(definition, startingNodeIds);
  const nodeRuns = Object.fromEntries(Object.entries(run.nodeRuns).map(([nodeId, state]) => {
    if (!affected.has(nodeId)) return [nodeId, { ...state }];
    const reset: WorkflowNodeRun = { nodeId, status: "pending", attempt: state.attempt };
    return [nodeId, reset];
  }));
  return { ...run, status: "running", nodeRuns, finishedAt: undefined };
}

export function deriveWorkflowRunStatus(definition: WorkflowDefinition, run: WorkflowRun): WorkflowRunStatus {
  const states = definition.nodes.map((node) => run.nodeRuns[node.id]?.status ?? "pending");
  if (states.length > 0 && states.every((status) => status === "completed")) return "completed";
  if (states.some((status) => status === "waiting")) return "waiting";
  if (states.length > 0 && states.every((status) => status === "cancelled" || status === "completed")) return "cancelled";
  if (states.some((status) => status === "running" || status === "ready")) return "running";
  if (readyWorkflowNodeIds(definition, run).length > 0) return "running";
  if (states.some((status) => status === "failed")) return "failed";
  return "running";
}
