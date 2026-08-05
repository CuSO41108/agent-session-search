import type {
  WorkflowDraftState,
  WorkflowRunState,
  WorkflowStatus,
} from "../../../../automation/contracts";
import type { WorkflowSidebarItem } from "../../../../automation/engine/shared/workflow/draft";

export interface WorkbenchWorkflowItem {
  workflow: {
    workflowId: string;
    title: string;
  };
  nodeCount: number;
  status: WorkflowStatus;
  updatedAt: number;
}

const STATUS_PRIORITY: Record<WorkflowStatus, number> = {
  waiting_for_user: 0,
  running: 1,
  failed: 2,
  draft: 3,
  stopped: 4,
  completed: 5,
};

export function selectWorkbenchWorkflows(
  workflows: WorkflowDraftState[],
  runs: WorkflowRunState[],
  limit = 5,
): WorkbenchWorkflowItem[] {
  return workflows
    .map((workflow) => {
      const workflowRuns = runs
        .filter((run) => run.workflowId === workflow.workflowId)
        .sort((left, right) => right.startedAt - left.startedAt);
      const activeRun = workflowRuns.find((run) => run.status === "waiting_for_user" || run.status === "running");
      const latestRun = activeRun ?? workflowRuns[0];
      return {
        workflow: {
          workflowId: workflow.workflowId,
          title: workflow.title,
        },
        nodeCount: workflow.definition.nodes.length,
        status: activeRun?.status ?? workflow.status,
        updatedAt: Math.max(workflow.updatedAt, latestRun?.finishedAt ?? latestRun?.startedAt ?? 0),
      };
    })
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      return priority || right.updatedAt - left.updatedAt;
    })
    .slice(0, Math.max(0, limit));
}

export function selectWorkbenchWorkflowSummaries(
  workflows: WorkflowSidebarItem[],
  limit = 5,
): WorkbenchWorkflowItem[] {
  return workflows
    .map((workflow) => ({
      workflow: {
        workflowId: workflow.workflowId,
        title: workflow.title,
      },
      nodeCount: workflow.nodeCount,
      status: workflow.status,
      updatedAt: workflow.updatedAt,
    }))
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      return priority || right.updatedAt - left.updatedAt;
    })
    .slice(0, Math.max(0, limit));
}
