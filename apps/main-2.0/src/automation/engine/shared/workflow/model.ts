export type WorkflowValueType = "text" | "number" | "boolean" | "file" | "object" | "list";

export interface WorkflowInputDefinition {
  key: string;
  name: string;
  description: string;
  type: WorkflowValueType;
  required: boolean;
}

interface WorkflowNodeInputBase {
  key: string;
  name: string;
  description: string;
  required: boolean;
}

export type WorkflowNodeInput =
  | (WorkflowNodeInputBase & { source: "workflow"; workflowInputKey: string })
  | (WorkflowNodeInputBase & { source: "workspace"; path?: string })
  | (WorkflowNodeInputBase & { source: "node"; nodeId: string; outputKey: string })
  | (WorkflowNodeInputBase & { source: "literal"; value: unknown });

export interface WorkflowOutputField {
  key: string;
  name: string;
  description: string;
  type: WorkflowValueType;
  required: boolean;
  fields?: WorkflowOutputField[];
  item?: WorkflowOutputField;
}

export interface WorkflowNodeBase {
  id: string;
  kind: "agent" | "script" | "review" | "approval";
  title: string;
  goal: string;
  inputs: WorkflowNodeInput[];
  outputs: WorkflowOutputField[];
  acceptanceCriteria: string[];
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  kind: "agent";
  agentId: string;
  instructions: string[];
  constraints: string[];
}

export type WorkflowScriptRuntime = "bash" | "python" | "typescript";
export type WorkflowScriptPermission = "workspace_read" | "workspace_write" | "workspace_delete" | "network" | "process";

export interface WorkflowScriptNode extends WorkflowNodeBase {
  kind: "script";
  runtime: WorkflowScriptRuntime;
  source: string;
  timeoutSeconds: number;
  permissions: WorkflowScriptPermission[];
}

export interface WorkflowReviewCriterion {
  key: string;
  description: string;
}

export interface WorkflowReviewNode extends WorkflowNodeBase {
  kind: "review";
  agentId: string;
  instructions: string[];
  constraints: string[];
  targetNodeIds: string[];
  criteria: WorkflowReviewCriterion[];
  maxRevisions: number;
  onReject: "revise" | "stop";
}

export interface WorkflowApprovalOption {
  value: string;
  label: string;
  description: string;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  kind: "approval";
  message: string;
  options: WorkflowApprovalOption[];
  allowComment: boolean;
}

export type WorkflowNode = WorkflowAgentNode | WorkflowScriptNode | WorkflowReviewNode | WorkflowApprovalNode;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  inputs: WorkflowInputDefinition[];
  nodes: WorkflowNode[];
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";
export type WorkflowNodeRunStatus = "pending" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface WorkflowRunError {
  code: string;
  message: string;
  fieldPath?: string;
}

export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowNodeRunStatus;
  attempt: number;
  resolvedInputs?: Record<string, unknown>;
  revisionFeedback?: string[];
  outputs?: Record<string, unknown>;
  error?: WorkflowRunError;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  definition: WorkflowDefinition;
  inputs: Record<string, unknown>;
  status: WorkflowRunStatus;
  nodeRuns: Record<string, WorkflowNodeRun>;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowCoreSnapshot {
  definitions: WorkflowDefinition[];
  runs: WorkflowRun[];
}
