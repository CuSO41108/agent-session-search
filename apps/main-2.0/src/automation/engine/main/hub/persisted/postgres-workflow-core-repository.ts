import type { PostgresDatabase, PostgresQueryable } from "../../../../../core/postgres/database";
import type { WorkflowDefinition, WorkflowNodeRun, WorkflowRun } from "../../../shared/workflow/model";
import type { WorkflowEngineStore } from "../../workflows/workflow-engine";
import { asRecord } from "./persisted-values";
import { jsonParameter, postgresJson, postgresTime } from "./postgres-values";

function optionalTime(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : postgresTime(value);
}

function mapDefinition(value: unknown): WorkflowDefinition {
  return structuredClone(postgresJson(value) as WorkflowDefinition);
}

function mapNodeRun(value: unknown): WorkflowNodeRun {
  const row = asRecord(value);
  const result: WorkflowNodeRun = {
    nodeId: String(row.node_id),
    status: String(row.status) as WorkflowNodeRun["status"],
    attempt: Number(row.attempt),
  };
  if (row.resolved_inputs !== null && row.resolved_inputs !== undefined) result.resolvedInputs = postgresJson(row.resolved_inputs) as Record<string, unknown>;
  if (row.outputs !== null && row.outputs !== undefined) result.outputs = postgresJson(row.outputs) as Record<string, unknown>;
  if (row.error !== null && row.error !== undefined) result.error = postgresJson(row.error) as WorkflowNodeRun["error"];
  const startedAt = optionalTime(row.started_at);
  const finishedAt = optionalTime(row.finished_at);
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (finishedAt !== undefined) result.finishedAt = finishedAt;
  return result;
}

export class PostgresWorkflowCoreRepository implements WorkflowEngineStore {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    const result = await this.database.query("select definition from agent_recall.workflows order by created_at, id");
    return result.rows.map((row) => mapDefinition(row.definition));
  }

  async getDefinition(workflowId: string): Promise<WorkflowDefinition | undefined> {
    const result = await this.database.query("select definition from agent_recall.workflows where id = $1", [workflowId]);
    return result.rows[0] ? mapDefinition(result.rows[0].definition) : undefined;
  }

  async saveDefinition(definition: WorkflowDefinition): Promise<void> {
    await this.database.query(
      `insert into agent_recall.workflows (id, name, description, definition, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (id) do update set
         name = excluded.name,
         description = excluded.description,
         definition = excluded.definition,
         updated_at = excluded.updated_at`,
      [definition.id, definition.name, definition.description, jsonParameter(definition), new Date(definition.createdAt), new Date(definition.updatedAt)],
    );
  }

  async deleteDefinition(workflowId: string): Promise<void> {
    await this.database.query("delete from agent_recall.workflows where id = $1", [workflowId]);
  }

  async listRuns(workflowId?: string): Promise<WorkflowRun[]> {
    const result = workflowId
      ? await this.database.query("select * from agent_recall.workflow_runs where workflow_id = $1 order by started_at desc, id", [workflowId])
      : await this.database.query("select * from agent_recall.workflow_runs order by started_at desc, id");
    return Promise.all(result.rows.map((row) => this.loadRun(row)));
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    const result = await this.database.query("select * from agent_recall.workflow_runs where id = $1", [runId]);
    return result.rows[0] ? this.loadRun(result.rows[0]) : undefined;
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await this.database.transaction(async (database) => {
      await database.query(
        `insert into agent_recall.workflow_runs (id, workflow_id, definition, inputs, status, started_at, finished_at)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
         on conflict (id) do update set
           definition = excluded.definition,
           inputs = excluded.inputs,
           status = excluded.status,
           finished_at = excluded.finished_at`,
        [run.id, run.workflowId, jsonParameter(run.definition), jsonParameter(run.inputs), run.status, new Date(run.startedAt), run.finishedAt === undefined ? null : new Date(run.finishedAt)],
      );
      await database.query("delete from agent_recall.workflow_node_runs where run_id = $1", [run.id]);
      for (const nodeRun of Object.values(run.nodeRuns)) await this.insertNodeRun(database, run.id, nodeRun);
    });
  }

  async markInterruptedRunsFailed(): Promise<void> {
    const finishedAt = new Date(this.now());
    await this.database.transaction(async (database) => {
      await database.query(
        `update agent_recall.workflow_node_runs
         set status = 'failed',
             error = $1::jsonb,
             finished_at = $2
         where status in ('ready', 'running', 'waiting')`,
        [jsonParameter({ code: "app_restarted", message: "The application restarted while this node was running." }), finishedAt],
      );
      await database.query(
        `update agent_recall.workflow_runs
         set status = 'failed', finished_at = $1
         where status in ('running', 'waiting')`,
        [finishedAt],
      );
    });
  }

  private async loadRun(rowValue: unknown): Promise<WorkflowRun> {
    const row = asRecord(rowValue);
    const runId = String(row.id);
    const nodeRows = await this.database.query("select * from agent_recall.workflow_node_runs where run_id = $1 order by node_id", [runId]);
    const nodeRuns = nodeRows.rows.map(mapNodeRun);
    const run: WorkflowRun = {
      id: runId,
      workflowId: String(row.workflow_id),
      definition: mapDefinition(row.definition),
      inputs: postgresJson(row.inputs) as Record<string, unknown>,
      status: String(row.status) as WorkflowRun["status"],
      nodeRuns: Object.fromEntries(nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun])),
      startedAt: postgresTime(row.started_at),
    };
    const finishedAt = optionalTime(row.finished_at);
    if (finishedAt !== undefined) run.finishedAt = finishedAt;
    return run;
  }

  private async insertNodeRun(database: PostgresQueryable, runId: string, nodeRun: WorkflowNodeRun): Promise<void> {
    await database.query(
      `insert into agent_recall.workflow_node_runs (
         run_id, node_id, status, attempt, resolved_inputs, outputs, error, started_at, finished_at
       ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        runId,
        nodeRun.nodeId,
        nodeRun.status,
        nodeRun.attempt,
        jsonParameter(nodeRun.resolvedInputs),
        jsonParameter(nodeRun.outputs),
        jsonParameter(nodeRun.error),
        nodeRun.startedAt === undefined ? null : new Date(nodeRun.startedAt),
        nodeRun.finishedAt === undefined ? null : new Date(nodeRun.finishedAt),
      ],
    );
  }
}
