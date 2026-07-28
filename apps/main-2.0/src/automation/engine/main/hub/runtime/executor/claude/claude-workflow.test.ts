import { describe, expect, it, vi } from "vitest";
import { claudeRuntimeStateCodec } from "../../../../agents/claude/claude-runtime-state-codec";
import type { RuntimeWorkflowRequestContext } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeWorkflowExecutionOptions } from "../workflow/agent-executor-workflow-shared";
import { runClaudeWorkflow } from "./claude-workflow";

describe("runClaudeWorkflow", () => {
  it("returns the native Session reference and forwards tool events", async () => {
    const onEvent = vi.fn();
    const runtimeConversation = claudeRuntimeStateCodec.encodeConversation({
      native: { sessionId: "claude-session-7" },
    });
    const input: RuntimeWorkflowRequestContext = {
      runtimeId: "claude",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "claude-sonnet-4-5" },
      requestId: "request-7",
      configuredAgentId: "builder",
      instructionScope: "agent",
      prompt: "Build",
      runtime: {
        id: "claude",
        label: "Claude",
        command: "claude",
        version: "1",
        available: true,
      },
      channelId: "claude-main",
      workDir: "/synthetic/repo",
      agentRecallMcp: { studioToken: "studio-scope" },
      onEvent,
    };
    const options = {
      executables: { claude: "claude" },
      channelById: () => ({
        id: "claude-main",
        agentId: "claude",
        label: "Claude",
        models: [{ id: "claude-sonnet-4-5", label: "Sonnet" }],
      }),
    } as unknown as RuntimeWorkflowExecutionOptions;

    const result = await runClaudeWorkflow(input, options, async (request) => {
      expect(request.studioMcpEnabled).toBe(true);
      request.onEvent({
        type: "tool_call",
        name: "Read",
        content: "{\"path\":\"README.md\"}",
      });
      request.onEvent({ type: "runtime_conversation", runtimeConversation });
      request.onEvent({ type: "completed", content: "done" });
    });

    expect(result).toMatchObject({
      content: "done",
      runtimeConversation,
      executionReference: { sessionId: "claude-session-7" },
    });
    expect(onEvent).toHaveBeenCalledWith({
      requestId: "request-7",
      type: "tool_call",
      name: "Read",
      content: "{\"path\":\"README.md\"}",
    });
  });
});
