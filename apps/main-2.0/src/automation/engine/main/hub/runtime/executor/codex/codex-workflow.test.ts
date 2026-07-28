import { describe, expect, it, vi } from "vitest";
import type { RuntimeWorkflowRequestContext } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeWorkflowExecutionOptions } from "../workflow/agent-executor-workflow-shared";

const codex = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; params: unknown }>,
}));

vi.mock("../../../../agents/codex/codex-rpc", () => ({
  CodexRpcClient: class {
    constructor(private readonly options: {
      onEvent: (event: {
        type: string;
        content?: string;
        name?: string;
      }) => void;
    }) {}

    async start(): Promise<void> {}

    async request(method: string, params: unknown): Promise<unknown> {
      codex.requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-7" } };
      if (method === "turn/start") {
        setTimeout(() => {
          this.options.onEvent({
            type: "tool_call",
            name: "shell_command",
            content: "npm test",
          });
          this.options.onEvent({ type: "completed", content: "done" });
        }, 0);
        return { turn: { id: "turn-7" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    }

    async shutdown(): Promise<void> {}
  },
}));

import { runCodexWorkflow } from "./codex-workflow";

describe("runCodexWorkflow", () => {
  it("returns the existing native Turn ID and forwards tool events", async () => {
    codex.requests.length = 0;
    const onEvent = vi.fn();
    const input: RuntimeWorkflowRequestContext = {
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "gpt-5" },
      requestId: "request-7",
      configuredAgentId: "builder",
      instructionScope: "agent",
      prompt: "Build",
      runtime: {
        id: "codex",
        label: "Codex",
        command: "codex",
        version: "1",
        available: true,
      },
      channelId: "codex-main",
      workDir: "/synthetic/repo",
      onEvent,
    };
    const options = {
      executables: { codex: "codex" },
      channelById: () => ({
        id: "codex-main",
        agentId: "codex",
        label: "Codex",
        models: [{ id: "gpt-5", label: "GPT-5" }],
      }),
    } as unknown as RuntimeWorkflowExecutionOptions;

    const result = await runCodexWorkflow(input, options);

    expect(result).toMatchObject({
      content: "done",
      executionReference: { sessionId: "thread-7", turnId: "turn-7" },
    });
    expect(codex.requests).toEqual([
      expect.objectContaining({ method: "thread/start" }),
      {
        method: "turn/start",
        params: expect.objectContaining({ threadId: "thread-7" }),
      },
    ]);
    expect(onEvent).toHaveBeenCalledWith({
      requestId: "request-7",
      type: "tool_call",
      name: "shell_command",
      content: "npm test",
    });
  });
});
