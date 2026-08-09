import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowRun } from "../../automation/engine/shared/workflow/model";
import type { WorkflowEngine } from "../../automation/engine/main/workflows/workflow-engine";
import { parseWorkflowAgentOutputs, WorkflowCoreService } from "./workflow-core-service";

function definition(agentId = "agent"): WorkflowDefinition {
  return {
    id: "workflow",
    name: "Workflow",
    description: "Workflow description",
    inputs: [],
    nodes: [{
      id: "answer",
      kind: "agent",
      title: "Answer",
      goal: "Answer.",
      agentId,
      instructions: [],
      constraints: [],
      inputs: [],
      outputs: [{ key: "answer", name: "Answer", description: "Answer", type: "text", required: true }],
      acceptanceCriteria: [],
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WorkflowCoreService", () => {
  test("parses fenced structured Agent outputs", () => {
    expect(parseWorkflowAgentOutputs("```json\n{\"answer\":\"Because.\"}\n```"))
      .toEqual({ answer: "Because." });
    expect(() => parseWorkflowAgentOutputs("[]")).toThrow("one JSON object");
  });

  test("saves valid definitions and exposes a fresh snapshot", async () => {
    const definitions: WorkflowDefinition[] = [];
    const repository = {
      listDefinitions: async () => structuredClone(definitions),
      listRuns: async () => [],
      getDefinition: async (id: string) => definitions.find((item) => item.id === id),
      saveDefinition: async (value: WorkflowDefinition) => { definitions.splice(0, definitions.length, structuredClone(value)); },
      deleteDefinition: async () => undefined,
      markInterruptedRunsFailed: async () => undefined,
    };
    const service = new WorkflowCoreService({
      repository,
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await service.saveDefinition(definition());
    await expect(service.snapshot()).resolves.toEqual({ definitions: [definition()], runs: [] });
  });

  test("rejects definitions that reference an unknown Agent", async () => {
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [],
        listRuns: async () => [],
        getDefinition: async () => undefined,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.saveDefinition(definition("missing"))).rejects.toThrow("nodes.answer.agentId: Configured agent does not exist");
  });

  test("starts the saved frozen definition through the engine", async () => {
    const saved = definition();
    const completed = { id: "run", workflowId: saved.id, definition: saved, inputs: {}, status: "completed", nodeRuns: {}, startedAt: 1, finishedAt: 2 } satisfies WorkflowRun;
    const start = async (value: WorkflowDefinition, inputs: Record<string, unknown>) => {
      expect(value).toEqual(saved);
      expect(inputs).toEqual({});
      return completed;
    };
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [saved],
        listRuns: async () => [],
        getDefinition: async () => saved,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: { start } as unknown as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.startRun(saved.id, {})).resolves.toEqual(completed);
  });
});
