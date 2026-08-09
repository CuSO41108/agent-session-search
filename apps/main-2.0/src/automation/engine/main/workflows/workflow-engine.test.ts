import { describe, expect, test } from "vitest";
import type {
  WorkflowAgentNode,
  WorkflowApprovalNode,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowReviewNode,
  WorkflowRun,
} from "../../shared/workflow/model";
import {
  WorkflowEngine,
  type WorkflowEngineStore,
  type WorkflowExecutionInput,
  type WorkflowNodeExecutor,
} from "./workflow-engine";

function output(key = "value") {
  return { key, name: key, description: `${key} output`, type: "text" as const, required: true };
}

function agent(id: string, dependencies: string[] = []): WorkflowAgentNode {
  return {
    id,
    kind: "agent",
    title: id,
    goal: id,
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: dependencies.map((dependency) => ({
      key: dependency,
      name: dependency,
      description: dependency,
      required: true,
      source: "node" as const,
      nodeId: dependency,
      outputKey: "value",
    })),
    outputs: [output()],
    acceptanceCriteria: [],
  };
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return { id: "workflow", name: "Workflow", description: "Test workflow", inputs: [], nodes, createdAt: 1, updatedAt: 1 };
}

class MemoryStore implements WorkflowEngineStore {
  readonly runs = new Map<string, WorkflowRun>();

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }
}

function executor(run: (input: WorkflowExecutionInput<WorkflowNode>) => Promise<Record<string, unknown>>): WorkflowNodeExecutor {
  return { execute: run };
}

function engine(store: MemoryStore, execute: WorkflowNodeExecutor, ids = ["run-1"]): WorkflowEngine {
  return new WorkflowEngine({
    store,
    executors: { agent: execute, review: execute, script: execute },
    createId: () => ids.shift() ?? "run-next",
    now: (() => { let value = 10; return () => value++; })(),
  });
}

describe("WorkflowEngine", () => {
  test("executes ready branches in parallel and resolves exact upstream fields", async () => {
    const store = new MemoryStore();
    let active = 0;
    let peak = 0;
    const seenInputs = new Map<string, Record<string, unknown>>();
    const runtime = engine(store, executor(async ({ node, resolvedInputs }) => {
      seenInputs.set(node.id, resolvedInputs);
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { value: node.id };
    }));

    const run = await runtime.start(definition([
      agent("root"),
      agent("left", ["root"]),
      agent("right", ["root"]),
      agent("final", ["left", "right"]),
    ]), {});

    expect(run.status).toBe("completed");
    expect(peak).toBe(2);
    expect(seenInputs.get("final")).toEqual({ left: "left", right: "right" });
  });

  test("fails invalid node output and leaves its dependent branch pending", async () => {
    const store = new MemoryStore();
    const runtime = engine(store, executor(async ({ node }) => node.id === "left" ? {} : { value: node.id }));

    const run = await runtime.start(definition([
      agent("root"),
      agent("left", ["root"]),
      agent("right", ["root"]),
      agent("final", ["left", "right"]),
    ]), {});

    expect(run.status).toBe("failed");
    expect(run.nodeRuns.left?.error).toMatchObject({ code: "invalid_output", fieldPath: "outputs.value" });
    expect(run.nodeRuns.right?.status).toBe("completed");
    expect(run.nodeRuns.final?.status).toBe("pending");
  });

  test("waits at an approval node and resumes with named decision outputs", async () => {
    const store = new MemoryStore();
    const approval: WorkflowApprovalNode = {
      id: "approval",
      kind: "approval",
      title: "Approval",
      goal: "Choose.",
      message: "Continue?",
      options: [
        { value: "yes", label: "Yes", description: "Continue." },
        { value: "no", label: "No", description: "Stop." },
      ],
      allowComment: true,
      inputs: [],
      outputs: [output("decision"), output("comment")],
      acceptanceCriteria: [],
    };
    const downstream = agent("downstream");
    downstream.inputs = [{
      key: "decision",
      name: "Decision",
      description: "Approval decision",
      required: true,
      source: "node",
      nodeId: "approval",
      outputKey: "decision",
    }];
    const runtime = engine(store, executor(async ({ node, resolvedInputs }) => ({ value: `${node.id}:${resolvedInputs.decision}` })));

    const waiting = await runtime.start(definition([approval, downstream]), {});
    expect(waiting.status).toBe("waiting");
    expect(waiting.nodeRuns.approval?.status).toBe("waiting");

    const completed = await runtime.resolveApproval(waiting.id, "approval", { decision: "yes", comment: "Ship it." });
    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns.downstream?.outputs).toEqual({ value: "downstream:yes" });
  });

  test("review revise reruns its target and affected downstream before passing", async () => {
    const store = new MemoryStore();
    const draft = agent("draft");
    const review: WorkflowReviewNode = {
      id: "review",
      kind: "review",
      title: "Review",
      goal: "Review draft.",
      agentId: "reviewer",
      instructions: [],
      constraints: [],
      targetNodeIds: ["draft"],
      criteria: [{ key: "quality", description: "Good quality." }],
      maxRevisions: 1,
      onReject: "revise",
      inputs: [{ key: "draft", name: "Draft", description: "Draft", required: true, source: "node", nodeId: "draft", outputKey: "value" }],
      outputs: [
        output("verdict"),
        { key: "criteriaResults", name: "Criteria", description: "Results", type: "list", required: true, item: output("criterion") },
        output("feedback"),
      ],
      acceptanceCriteria: [],
    };
    let reviewAttempts = 0;
    const runtime = engine(store, executor(async ({ node }) => {
      if (node.kind !== "review") return { value: `${node.id}-${reviewAttempts}` };
      reviewAttempts += 1;
      return { verdict: reviewAttempts === 1 ? "revise" : "pass", criteriaResults: [], feedback: "Improve it." };
    }));

    const run = await runtime.start(definition([draft, review]), {});
    expect(run.status).toBe("completed");
    expect(run.nodeRuns.draft?.attempt).toBe(2);
    expect(run.nodeRuns.review?.attempt).toBe(2);
    expect(reviewAttempts).toBe(2);
  });

  test("manual retry keeps valid upstream output and reruns the failed node plus downstream", async () => {
    const store = new MemoryStore();
    let fail = true;
    const calls: string[] = [];
    const runtime = engine(store, executor(async ({ node }) => {
      calls.push(node.id);
      if (node.id === "middle" && fail) throw new Error("broken");
      return { value: node.id };
    }));

    const failed = await runtime.start(definition([agent("root"), agent("middle", ["root"]), agent("final", ["middle"])]), {});
    fail = false;
    const completed = await runtime.retryNode(failed.id, "middle");

    expect(completed.status).toBe("completed");
    expect(calls.filter((id) => id === "root")).toHaveLength(1);
    expect(calls.filter((id) => id === "middle")).toHaveLength(2);
    expect(calls.filter((id) => id === "final")).toHaveLength(1);
  });
});
