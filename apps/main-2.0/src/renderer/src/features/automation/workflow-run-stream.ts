import type { WorkflowRunStreamEvent } from "../../../../automation/engine/shared/workflow/model";

export type WorkflowRunStreamState = Record<string, string>;

export function workflowRunStreamKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

export function reduceWorkflowRunStream(
  state: WorkflowRunStreamState,
  event: WorkflowRunStreamEvent,
): WorkflowRunStreamState {
  const key = workflowRunStreamKey(event.runId, event.nodeId);
  return {
    ...state,
    [key]: event.type === "started" ? "" : `${state[key] ?? ""}${event.content}`,
  };
}
