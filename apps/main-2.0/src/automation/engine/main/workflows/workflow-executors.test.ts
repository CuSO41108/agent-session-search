import { describe, expect, test, vi } from "vitest";
import type { WorkflowAgentNode, WorkflowRun, WorkflowScriptNode } from "../../shared/workflow/model";
import {
  createWorkflowNodeExecutors,
  type WorkflowAgentInvoker,
  type WorkflowScriptAuthorizer,
  type WorkflowScriptRunner,
} from "./workflow-executors";

const agentNode: WorkflowAgentNode = {
  id: "agent",
  kind: "agent",
  title: "Agent",
  goal: "Produce a summary.",
  agentId: "configured-agent",
  instructions: ["Read the input."],
  constraints: ["Do not invent facts."],
  inputs: [],
  outputs: [{ key: "summary", name: "Summary", description: "Final summary", type: "text", required: true }],
  acceptanceCriteria: ["Summary is grounded."],
};

function run(): WorkflowRun {
  return {
    id: "run",
    workflowId: "workflow",
    definition: { id: "workflow", name: "Workflow", description: "Workflow", inputs: [], nodes: [agentNode], createdAt: 1, updatedAt: 1 },
    inputs: {},
    status: "running",
    nodeRuns: { agent: { nodeId: "agent", status: "running", attempt: 1 } },
    events: [],
    startedAt: 1,
  };
}

describe("workflow node executors", () => {
  test("agent executor invokes the selected Agent with an assembled prompt and output schema", async () => {
    const invoke = vi.fn(async () => ({ summary: "Grounded summary" }));
    const agentInvoker: WorkflowAgentInvoker = { invoke };
    const executors = createWorkflowNodeExecutors({ agentInvoker });

    await expect(executors.agent.execute({ run: run(), node: agentNode, resolvedInputs: { source: "facts" }, workDir: "/workflow-project", signal: new AbortController().signal })).resolves.toEqual({ summary: "Grounded summary" });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "configured-agent",
      prompt: expect.stringContaining("# Expected outputs"),
      outputs: agentNode.outputs,
      workDir: "/workflow-project",
    }));
  });

  test("agent executor separates readable Runtime steps at tool-call boundaries", async () => {
    const onStream = vi.fn();
    const invoke = vi.fn(async (input: { onEvent?: (event: { type: string; content?: string; name?: string }) => void }) => {
      input.onEvent?.({ type: "meta", content: "internal setup" });
      input.onEvent?.({ type: "delta", content: "正在检查仓库。" });
      input.onEvent?.({ type: "tool_call", content: "rg --files", name: "Bash" });
      input.onEvent?.({ type: "delta", content: "接下来读取配置。" });
      input.onEvent?.({ type: "delta", content: "继续分析。" });
      return { summary: "Ready" };
    });
    const executors = createWorkflowNodeExecutors({
      agentInvoker: { invoke } as unknown as WorkflowAgentInvoker,
      onStream,
    } as never);

    await expect(executors.agent.execute({
      run: run(),
      node: agentNode,
      resolvedInputs: {},
      signal: new AbortController().signal,
    })).resolves.toEqual({ summary: "Ready" });

    expect(onStream).toHaveBeenCalledTimes(4);
    expect(onStream.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ runId: "run", nodeId: "agent", type: "started" }),
      expect.objectContaining({ runId: "run", nodeId: "agent", type: "delta", content: "正在检查仓库。" }),
      expect.objectContaining({ runId: "run", nodeId: "agent", type: "delta", content: "\n\n接下来读取配置。" }),
      expect.objectContaining({ runId: "run", nodeId: "agent", type: "delta", content: "继续分析。" }),
    ]);
  });

  test("script executor authorizes elevated permissions and passes inputs as stdin JSON", async () => {
    const scriptNode: WorkflowScriptNode = {
      id: "script",
      kind: "script",
      title: "Script",
      goal: "Transform input.",
      runtime: "python",
      source: "print('{}')",
      timeoutSeconds: 15,
      permissions: ["workspace_read", "network"],
      inputs: [],
      outputs: [{ key: "count", name: "Count", description: "Count", type: "number", required: true }],
      acceptanceCriteria: [],
    };
    const authorize = vi.fn(async () => true);
    const runScript = vi.fn(async () => ({ stdout: '{"count":3}\n', stderr: "" }));
    const scriptAuthorizer: WorkflowScriptAuthorizer = { authorize };
    const scriptRunner: WorkflowScriptRunner = { run: runScript };
    const executors = createWorkflowNodeExecutors({ agentInvoker: { invoke: async () => ({}) }, scriptAuthorizer, scriptRunner });

    await expect(executors.script.execute({ run: run(), node: scriptNode, resolvedInputs: { values: [1, 2, 3] }, workDir: "/workflow-project", signal: new AbortController().signal })).resolves.toEqual({ count: 3 });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", node: scriptNode, permissions: scriptNode.permissions }));
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "python",
      source: scriptNode.source,
      stdin: '{"values":[1,2,3]}',
      timeoutSeconds: 15,
      workDir: "/workflow-project",
    }));
  });

  test("script executor refuses execution when permission is rejected", async () => {
    const scriptNode: WorkflowScriptNode = {
      id: "script",
      kind: "script",
      title: "Script",
      goal: "Write output.",
      runtime: "bash",
      source: "echo '{}'",
      timeoutSeconds: 10,
      permissions: ["workspace_write"],
      inputs: [],
      outputs: [{ key: "value", name: "Value", description: "Value", type: "text", required: true }],
      acceptanceCriteria: [],
    };
    const runScript = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    const executors = createWorkflowNodeExecutors({
      agentInvoker: { invoke: async () => ({}) },
      scriptAuthorizer: { authorize: async () => false },
      scriptRunner: { run: runScript },
    });

    await expect(executors.script.execute({ run: run(), node: scriptNode, resolvedInputs: {}, signal: new AbortController().signal })).rejects.toThrow("Script permission was not approved");
    expect(runScript).not.toHaveBeenCalled();
  });

  test("script executor rejects non-object stdout", async () => {
    const scriptNode: WorkflowScriptNode = {
      id: "script",
      kind: "script",
      title: "Script",
      goal: "Return JSON.",
      runtime: "typescript",
      source: "console.log('[]')",
      timeoutSeconds: 10,
      permissions: ["workspace_read"],
      inputs: [],
      outputs: [{ key: "value", name: "Value", description: "Value", type: "text", required: true }],
      acceptanceCriteria: [],
    };
    const executors = createWorkflowNodeExecutors({
      agentInvoker: { invoke: async () => ({}) },
      scriptRunner: { run: async () => ({ stdout: "[]", stderr: "" }) },
    });

    await expect(executors.script.execute({ run: run(), node: scriptNode, resolvedInputs: {}, signal: new AbortController().signal })).rejects.toThrow("Script stdout must be one JSON object");
  });
});
