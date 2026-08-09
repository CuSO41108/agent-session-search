import type {
  WorkflowAgentNode,
  WorkflowOutputField,
  WorkflowReviewNode,
  WorkflowScriptNode,
  WorkflowScriptPermission,
  WorkflowScriptRuntime,
} from "../../shared/workflow/model";
import { assembleWorkflowNodePrompt } from "../../shared/workflow/prompt";
import type { WorkflowNodeExecutor } from "./workflow-engine";

export interface WorkflowAgentInvoker {
  invoke(input: {
    runId: string;
    nodeId: string;
    agentId: string;
    prompt: string;
    outputs: WorkflowOutputField[];
    signal: AbortSignal;
  }): Promise<Record<string, unknown>>;
}

export interface WorkflowScriptAuthorizer {
  authorize(input: {
    runId: string;
    node: WorkflowScriptNode;
    permissions: WorkflowScriptPermission[];
    signal: AbortSignal;
  }): Promise<boolean>;
}

export interface WorkflowScriptRunner {
  run(input: {
    runId: string;
    nodeId: string;
    runtime: WorkflowScriptRuntime;
    source: string;
    stdin: string;
    timeoutSeconds: number;
    permissions: WorkflowScriptPermission[];
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string }>;
  cancel?(runId: string, nodeId: string): Promise<void>;
}

export interface WorkflowNodeExecutorDependencies {
  agentInvoker: WorkflowAgentInvoker;
  scriptAuthorizer?: WorkflowScriptAuthorizer;
  scriptRunner?: WorkflowScriptRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createAgentExecutor<N extends WorkflowAgentNode | WorkflowReviewNode>(
  agentInvoker: WorkflowAgentInvoker,
): WorkflowNodeExecutor<N> {
  return {
    async execute({ run, node, resolvedInputs, signal }) {
      return agentInvoker.invoke({
        runId: run.id,
        nodeId: node.id,
        agentId: node.agentId,
        prompt: assembleWorkflowNodePrompt({ node, resolvedInputs }),
        outputs: structuredClone(node.outputs),
        signal,
      });
    },
  };
}

function needsAuthorization(permissions: WorkflowScriptPermission[]): boolean {
  return permissions.some((permission) => permission !== "workspace_read");
}

function parseScriptOutput(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Script stdout must be one JSON object: ${message}`);
  }
  if (!isRecord(value)) throw new Error("Script stdout must be one JSON object.");
  return value;
}

function createScriptExecutor(
  scriptRunner: WorkflowScriptRunner | undefined,
  scriptAuthorizer: WorkflowScriptAuthorizer | undefined,
): WorkflowNodeExecutor<WorkflowScriptNode> {
  return {
    async execute({ run, node, resolvedInputs, signal }) {
      if (!scriptRunner) throw new Error("Script execution is unavailable.");
      if (needsAuthorization(node.permissions)) {
        if (!scriptAuthorizer) throw new Error("Script permission approval is unavailable.");
        const approved = await scriptAuthorizer.authorize({ runId: run.id, node, permissions: node.permissions, signal });
        if (!approved) throw new Error("Script permission was not approved.");
      }
      const result = await scriptRunner.run({
        runId: run.id,
        nodeId: node.id,
        runtime: node.runtime,
        source: node.source,
        stdin: JSON.stringify(resolvedInputs),
        timeoutSeconds: node.timeoutSeconds,
        permissions: node.permissions,
        signal,
      });
      return parseScriptOutput(result.stdout);
    },
    async cancel(runId, nodeId) {
      await scriptRunner?.cancel?.(runId, nodeId);
    },
  };
}

export function createWorkflowNodeExecutors(dependencies: WorkflowNodeExecutorDependencies): {
  agent: WorkflowNodeExecutor<WorkflowAgentNode>;
  review: WorkflowNodeExecutor<WorkflowReviewNode>;
  script: WorkflowNodeExecutor<WorkflowScriptNode>;
} {
  return {
    agent: createAgentExecutor(dependencies.agentInvoker),
    review: createAgentExecutor(dependencies.agentInvoker),
    script: createScriptExecutor(dependencies.scriptRunner, dependencies.scriptAuthorizer),
  };
}
