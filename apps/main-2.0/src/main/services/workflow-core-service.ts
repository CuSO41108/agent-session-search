import type {
  WorkflowCoreSnapshot,
  WorkflowDefinition,
  WorkflowRun,
} from "../../automation/engine/shared/workflow/model";
import { validateWorkflowDefinition } from "../../automation/engine/shared/workflow/validation";
import type { WorkflowEngine } from "../../automation/engine/main/workflows/workflow-engine";

export function parseWorkflowAgentOutputs(content: string): Record<string, unknown> {
  const normalized = content.trim();
  const fenced = normalized.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1]?.trim() ?? normalized) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent output must be one JSON object: ${message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent output must be one JSON object.");
  }
  return value as Record<string, unknown>;
}

export interface WorkflowCoreRepository {
  listDefinitions(): Promise<WorkflowDefinition[]>;
  listRuns(workflowId?: string): Promise<WorkflowRun[]>;
  getDefinition(workflowId: string): Promise<WorkflowDefinition | undefined>;
  saveDefinition(definition: WorkflowDefinition): Promise<void>;
  deleteDefinition(workflowId: string): Promise<void>;
  markInterruptedRunsFailed(): Promise<void>;
}

export class WorkflowCoreService {
  constructor(private readonly dependencies: {
    repository: WorkflowCoreRepository;
    engine: WorkflowEngine;
    configuredAgentIds: () => ReadonlySet<string>;
  }) {}

  async initialize(): Promise<void> {
    await this.dependencies.repository.markInterruptedRunsFailed();
  }

  async snapshot(workflowId?: string): Promise<WorkflowCoreSnapshot> {
    const [definitions, runs] = await Promise.all([
      this.dependencies.repository.listDefinitions(),
      this.dependencies.repository.listRuns(workflowId),
    ]);
    return { definitions, runs };
  }

  async saveDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const issues = validateWorkflowDefinition(definition, this.dependencies.configuredAgentIds());
    if (issues.length > 0) throw new Error(`${issues[0]!.path}: ${issues[0]!.message}`);
    await this.dependencies.repository.saveDefinition(definition);
    return structuredClone(definition);
  }

  async deleteDefinition(workflowId: string): Promise<void> {
    await this.dependencies.repository.deleteDefinition(workflowId);
  }

  async startRun(workflowId: string, inputs: Record<string, unknown>): Promise<WorkflowRun> {
    const definition = await this.dependencies.repository.getDefinition(workflowId);
    if (!definition) throw new Error(`Workflow ${workflowId} does not exist.`);
    return this.dependencies.engine.start(definition, inputs);
  }

  retryNode(runId: string, nodeId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.retryNode(runId, nodeId);
  }

  resolveApproval(runId: string, nodeId: string, outputs: Record<string, unknown>): Promise<WorkflowRun> {
    return this.dependencies.engine.resolveApproval(runId, nodeId, outputs);
  }

  cancelRun(runId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.cancel(runId);
  }
}
