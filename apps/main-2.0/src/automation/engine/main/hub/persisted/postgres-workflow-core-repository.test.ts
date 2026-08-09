import { describe, expect, test } from "vitest";
import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import type { WorkflowDefinition, WorkflowRun } from "../../../shared/workflow/model";
import { PostgresWorkflowCoreRepository } from "./postgres-workflow-core-repository";

function definition(): WorkflowDefinition {
  return {
    id: "workflow",
    name: "Workflow",
    description: "Structured Workflow",
    inputs: [],
    nodes: [{
      id: "answer",
      kind: "agent",
      title: "Answer",
      goal: "Answer.",
      agentId: "agent",
      instructions: [],
      constraints: [],
      inputs: [],
      outputs: [{ key: "answer", name: "Answer", description: "Answer", type: "text", required: true }],
      acceptanceCriteria: [],
    }],
    createdAt: 10,
    updatedAt: 20,
  };
}

function run(status: WorkflowRun["status"] = "completed"): WorkflowRun {
  return {
    id: "run",
    workflowId: "workflow",
    definition: definition(),
    inputs: { question: "Why?" },
    status,
    nodeRuns: {
      answer: {
        nodeId: "answer",
        status: status === "running" ? "running" : "completed",
        attempt: 1,
        resolvedInputs: {},
        outputs: status === "running" ? undefined : { answer: "Because." },
        startedAt: 30,
        finishedAt: status === "running" ? undefined : 40,
      },
    },
    startedAt: 30,
    finishedAt: status === "running" ? undefined : 40,
  };
}

describe("PostgresWorkflowCoreRepository", () => {
  test("round trips structured definitions and complete node outputs", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database);

    await repository.saveDefinition(definition());
    await repository.saveRun(run());

    await expect(repository.listDefinitions()).resolves.toEqual([definition()]);
    await expect(repository.getRun("run")).resolves.toEqual(run());
    await database.close();
  });

  test("marks interrupted runs and active nodes failed on startup", async () => {
    const database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const repository = new PostgresWorkflowCoreRepository(database, () => 100);
    await repository.saveDefinition(definition());
    await repository.saveRun(run("running"));

    await repository.markInterruptedRunsFailed();

    const interrupted = await repository.getRun("run");
    expect(interrupted).toMatchObject({ status: "failed", finishedAt: 100 });
    expect(interrupted?.nodeRuns.answer).toMatchObject({
      status: "failed",
      finishedAt: 100,
      error: { code: "app_restarted", message: "The application restarted while this node was running." },
    });
    await database.close();
  });
});
