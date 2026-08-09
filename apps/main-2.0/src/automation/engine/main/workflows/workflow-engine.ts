import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
} from "../../shared/workflow/model";
import { validateWorkflowNodeOutputs } from "../../shared/workflow/output";
import {
  deriveWorkflowRunStatus,
  invalidateWorkflowDownstream,
  readyWorkflowNodeIds,
} from "../../shared/workflow/scheduler";
import { validateWorkflowDefinition } from "../../shared/workflow/validation";

export interface WorkflowEngineStore {
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  saveRun(run: WorkflowRun): Promise<void>;
}

export interface WorkflowExecutionInput<N extends WorkflowNode = WorkflowNode> {
  run: WorkflowRun;
  node: N;
  resolvedInputs: Record<string, unknown>;
  signal: AbortSignal;
}

export interface WorkflowNodeExecutor<N extends WorkflowNode = WorkflowNode> {
  execute(input: WorkflowExecutionInput<N>): Promise<Record<string, unknown>>;
  cancel?(runId: string, nodeId: string): Promise<void>;
}

export interface WorkflowEngineOptions {
  store: WorkflowEngineStore;
  executors: Partial<Record<Exclude<WorkflowNode["kind"], "approval">, WorkflowNodeExecutor>>;
  createId: () => string;
  now?: () => number;
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}

function runError(error: unknown): { code: string; message: string } {
  return { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
}

export class WorkflowEngine {
  private readonly store: WorkflowEngineStore;
  private readonly executors: WorkflowEngineOptions["executors"];
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: WorkflowEngineOptions) {
    this.store = options.store;
    this.executors = options.executors;
    this.createId = options.createId;
    this.now = options.now ?? Date.now;
  }

  async start(definition: WorkflowDefinition, inputs: Record<string, unknown>): Promise<WorkflowRun> {
    const definitionIssues = validateWorkflowDefinition(definition);
    if (definitionIssues.length > 0) throw new Error(`Invalid Workflow definition: ${definitionIssues[0]!.path}: ${definitionIssues[0]!.message}`);
    for (const input of definition.inputs) {
      if (input.required && (!Object.hasOwn(inputs, input.key) || inputs[input.key] === undefined)) {
        throw new Error(`Required Workflow input ${input.key} is missing.`);
      }
    }
    const run: WorkflowRun = {
      id: this.createId(),
      workflowId: definition.id,
      definition: structuredClone(definition),
      inputs: structuredClone(inputs),
      status: "running",
      nodeRuns: Object.fromEntries(definition.nodes.map((node) => [node.id, {
        nodeId: node.id,
        status: "pending",
        attempt: 0,
      } satisfies WorkflowNodeRun])),
      startedAt: this.now(),
    };
    await this.store.saveRun(run);
    return this.drive(run);
  }

  async retryNode(runId: string, nodeId: string): Promise<WorkflowRun> {
    const current = await this.requiredRun(runId);
    if (!current.definition.nodes.some((node) => node.id === nodeId)) throw new Error(`Workflow node ${nodeId} does not exist.`);
    const next = invalidateWorkflowDownstream(current.definition, current, [nodeId]);
    await this.store.saveRun(next);
    return this.drive(next);
  }

  async resolveApproval(runId: string, nodeId: string, outputs: Record<string, unknown>): Promise<WorkflowRun> {
    const run = await this.requiredRun(runId);
    const node = run.definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== "approval") throw new Error(`Workflow approval node ${nodeId} does not exist.`);
    const state = run.nodeRuns[nodeId];
    if (state?.status !== "waiting") throw new Error(`Workflow approval node ${nodeId} is not waiting.`);
    const validationIssues = validateWorkflowNodeOutputs(node, outputs);
    if (validationIssues.length > 0) throw new Error(`${validationIssues[0]!.path}: ${validationIssues[0]!.message}`);
    if (typeof outputs.decision === "string" && !node.options.some((option) => option.value === outputs.decision)) {
      throw new Error("outputs.decision: Approval decision is not one of the declared options.");
    }
    state.status = "completed";
    state.outputs = structuredClone(outputs);
    state.finishedAt = this.now();
    delete state.error;
    run.status = "running";
    await this.store.saveRun(run);
    return this.drive(run);
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const run = await this.requiredRun(runId);
    this.controllers.get(runId)?.abort();
    await Promise.all(run.definition.nodes.map(async (node) => {
      if (run.nodeRuns[node.id]?.status !== "running") return;
      await this.executors[node.kind as Exclude<WorkflowNode["kind"], "approval">]?.cancel?.(runId, node.id);
    }));
    for (const state of Object.values(run.nodeRuns)) {
      if (state.status === "pending" || state.status === "ready" || state.status === "running" || state.status === "waiting") {
        state.status = "cancelled";
        state.finishedAt = this.now();
      }
    }
    run.status = "cancelled";
    run.finishedAt = this.now();
    await this.store.saveRun(run);
    return cloneRun(run);
  }

  private async requiredRun(runId: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Workflow Run ${runId} does not exist.`);
    return run;
  }

  private resolveInputs(run: WorkflowRun, node: WorkflowNode): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const input of node.inputs) {
      let value: unknown;
      if (input.source === "workflow") value = run.inputs[input.workflowInputKey];
      if (input.source === "literal") value = input.value;
      if (input.source === "workspace") value = input.path ?? ".";
      if (input.source === "node") value = run.nodeRuns[input.nodeId]?.outputs?.[input.outputKey];
      if (input.required && value === undefined) throw new Error(`Required node input ${node.id}.${input.key} is unavailable.`);
      resolved[input.key] = structuredClone(value);
    }
    return resolved;
  }

  private async drive(inputRun: WorkflowRun): Promise<WorkflowRun> {
    const run = inputRun;
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      while (!controller.signal.aborted) {
        const readyIds = readyWorkflowNodeIds(run.definition, run);
        if (readyIds.length === 0) break;

        const executable: Array<{ node: WorkflowNode; state: WorkflowNodeRun; resolvedInputs: Record<string, unknown>; executor: WorkflowNodeExecutor }> = [];
        for (const nodeId of readyIds) {
          const node = run.definition.nodes.find((candidate) => candidate.id === nodeId)!;
          const state = run.nodeRuns[nodeId]!;
          state.attempt += 1;
          state.startedAt = this.now();
          delete state.finishedAt;
          delete state.outputs;
          delete state.error;
          try {
            state.resolvedInputs = this.resolveInputs(run, node);
          } catch (error) {
            state.status = "failed";
            state.error = runError(error);
            state.finishedAt = this.now();
            continue;
          }
          if (node.kind === "approval") {
            state.status = "waiting";
            continue;
          }
          const executor = this.executors[node.kind];
          if (!executor) {
            state.status = "failed";
            state.error = { code: "executor_unavailable", message: `No ${node.kind} executor is configured.` };
            state.finishedAt = this.now();
            continue;
          }
          state.status = "running";
          executable.push({ node, state, resolvedInputs: state.resolvedInputs, executor });
        }
        await this.store.saveRun(run);

        const results = await Promise.all(executable.map(async (item) => {
          try {
            const outputs = await item.executor.execute({ run: cloneRun(run), node: item.node, resolvedInputs: item.resolvedInputs, signal: controller.signal });
            return { item, outputs } as const;
          } catch (error) {
            return { item, error } as const;
          }
        }));

        if (controller.signal.aborted) return this.requiredRun(run.id);
        for (const result of results) {
          const { state, node } = result.item;
          if ("error" in result) {
            state.status = "failed";
            state.error = runError(result.error);
            state.finishedAt = this.now();
            continue;
          }
          const validationIssues = validateWorkflowNodeOutputs(node, result.outputs);
          if (validationIssues.length > 0) {
            state.status = "failed";
            state.error = {
              code: "invalid_output",
              message: validationIssues[0]!.message,
              fieldPath: validationIssues[0]!.path,
            };
            state.finishedAt = this.now();
            continue;
          }
          state.status = "completed";
          state.outputs = structuredClone(result.outputs);
          state.finishedAt = this.now();
        }

        let revised = false;
        for (const result of results) {
          const { node, state } = result.item;
          if (node.kind !== "review" || state.status !== "completed" || state.outputs?.verdict !== "revise") continue;
          if (node.onReject === "revise" && state.attempt <= node.maxRevisions) {
            const next = invalidateWorkflowDownstream(run.definition, run, node.targetNodeIds);
            run.nodeRuns = next.nodeRuns;
            run.status = "running";
            revised = true;
          } else {
            state.status = "failed";
            state.error = { code: "review_rejected", message: String(state.outputs.feedback ?? "Review rejected the output.") };
          }
          break;
        }
        await this.store.saveRun(run);
        if (revised) continue;
      }

      run.status = deriveWorkflowRunStatus(run.definition, run);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") run.finishedAt = this.now();
      await this.store.saveRun(run);
      return cloneRun(run);
    } finally {
      if (this.controllers.get(run.id) === controller) this.controllers.delete(run.id);
    }
  }
}
