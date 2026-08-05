import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractClaudeContextComponents,
  extractCodexContextComponents,
  extractSessionContextComponents,
  truncateContextText,
} from "./session-context-components";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-context-components-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJsonLines(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("session context components", () => {
  it("extracts Codex base instructions, developer messages, and tool names", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "rollout.jsonl");
    writeJsonLines(filePath, [
      {
        type: "session_meta",
        payload: {
          base_instructions: { text: "Follow repository rules." },
          dynamic_tools: [{
            Function: {
              name: "lookup",
              description: "Look up a record",
              inputSchema: { type: "object" },
            },
          }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Memory: prefer concise answers." }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the status?" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "Sandbox permissions: read-only." }],
        },
      },
    ]);

    const components = await extractCodexContextComponents(filePath);
    expect(components.map((item) => item.kind)).toEqual([
      "system_instructions",
      "developer_instructions",
      "tool_inventory",
    ]);
    expect(components[0]?.text).toBe("Follow repository rules.");
    expect(components[1]?.text).toContain("Memory: prefer concise answers.");
    expect(components[1]?.text).toContain("Sandbox permissions: read-only.");
    expect(components[1]?.note).toMatch(/不是用户提示词/);
    expect(components[1]?.text).not.toContain("What is the status?");
    expect(components[2]?.items).toEqual(["lookup"]);
    expect(components[2]?.sourceHint).toBe("session_meta.dynamic_tools");
  });

  it("infers Codex tool inventory from tool calls when dynamic_tools is absent", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "rollout-no-dynamic-tools.jsonl");
    writeJsonLines(filePath, [
      {
        type: "session_meta",
        payload: {
          base_instructions: "You are Codex.",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Keep answers short." }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call_1",
          status: "completed",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait",
          call_id: "call_2",
          arguments: "{}",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "mcp_1",
          invocation: { server: "mem0", tool: "search_memories", arguments: {} },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call_3",
          status: "completed",
        },
      },
    ]);

    const components = await extractCodexContextComponents(filePath);
    expect(components.map((item) => item.kind)).toEqual([
      "system_instructions",
      "developer_instructions",
      "tool_inventory",
    ]);
    const tools = components.find((item) => item.kind === "tool_inventory");
    expect(tools?.items).toEqual(["exec", "mem0/search_memories", "wait"]);
    expect(tools?.sourceHint).toBe("response_item/event_msg tool calls");
    expect(tools?.note).toMatch(/tool call 反推/);
  });

  it("still collects later Codex tool calls after developer text budget is full", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "rollout-tools-after-budget.jsonl");
    const huge = "D".repeat(48_000);
    writeJsonLines(filePath, [
      {
        type: "session_meta",
        payload: { base_instructions: "Keep it short." },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: huge }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call_late",
        },
      },
    ]);

    const components = await extractCodexContextComponents(filePath);
    expect(components.find((item) => item.kind === "tool_inventory")?.items).toEqual(["exec"]);
  });

  it("extracts Claude attachment listings without fabricating system prompts", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "session.jsonl");
    writeJsonLines(filePath, [
      {
        type: "attachment",
        attachment: {
          type: "skill_listing",
          content: "- `/commit`: Create a commit\n- `/review`: Review changes",
          skillCount: 2,
          isInitial: true,
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "mcp_instructions_delta",
          addedNames: ["github"],
          addedBlocks: ["Use GitHub MCP carefully."],
          removedNames: [],
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "deferred_tools_delta",
          addedNames: ["Bash", "Read"],
          addedLines: [],
          removedNames: [],
        },
      },
      {
        type: "attachment",
        attachment: {
          type: "agent_listing_delta",
          addedTypes: ["Explore"],
          addedLines: ["Explore: general research agent"],
          removedTypes: [],
          isInitial: true,
        },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const components = await extractClaudeContextComponents(filePath);
    expect(components.map((item) => item.kind)).toEqual([
      "skill_listing",
      "mcp_instructions",
      "deferred_tools",
      "agent_listing",
    ]);
    expect(components.find((item) => item.kind === "skill_listing")?.items).toEqual(["commit", "review"]);
    expect(components.find((item) => item.kind === "mcp_instructions")?.items).toEqual(["github"]);
    expect(components.find((item) => item.kind === "mcp_instructions")?.text).toContain("GitHub MCP");
    expect(components.find((item) => item.kind === "deferred_tools")?.items).toEqual(["Bash", "Read"]);
    expect(components.find((item) => item.kind === "agent_listing")?.items).toEqual(["Explore"]);
    expect(components.every((item) => item.kind !== "system_instructions")).toBe(true);
  });

  it("marks missing local files as source_unavailable and skips unsupported sources", async () => {
    const missing = await extractSessionContextComponents({
      source: "codex-cli",
      filePath: path.join(temporaryDirectory(), "missing.jsonl"),
    });
    expect(missing.status).toBe("source_unavailable");
    expect(missing.components).toEqual([]);

    const remote = await extractSessionContextComponents({
      source: "claude-cli",
      filePath: "/tmp/does-not-matter.jsonl",
      sourceAvailable: false,
    });
    expect(remote.status).toBe("source_unavailable");

    const unsupported = await extractSessionContextComponents({
      source: "hermes",
      filePath: path.join(temporaryDirectory(), "unused.jsonl"),
    });
    expect(unsupported.status).toBe("unsupported");
  });

  it("truncates long text previews for UI safety", () => {
    const text = "a".repeat(20);
    expect(truncateContextText(text, 10)).toEqual({
      preview: `${"a".repeat(10)}\n…`,
      truncated: true,
    });
  });

  it("caps oversized Codex developer text and stops after the budget", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "rollout-huge.jsonl");
    const huge = "D".repeat(30_000);
    writeJsonLines(filePath, [
      {
        type: "session_meta",
        payload: { base_instructions: "Keep it short.", dynamic_tools: [] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: huge }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: huge }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "should-not-appear-after-budget" }],
        },
      },
    ]);

    const components = await extractCodexContextComponents(filePath);
    const developer = components.find((item) => item.kind === "developer_instructions");
    expect(developer?.text?.length).toBeLessThanOrEqual(48_000 + 2);
    expect(developer?.text).not.toContain("should-not-appear-after-budget");
    expect(developer?.note).toMatch(/截断/);
  });

  it("caches repeated extracts for the same file mtime", async () => {
    const root = temporaryDirectory();
    const filePath = path.join(root, "rollout.jsonl");
    writeJsonLines(filePath, [
      {
        type: "session_meta",
        payload: { base_instructions: "cached once", dynamic_tools: [] },
      },
    ]);

    const first = await extractSessionContextComponents({ source: "codex-cli", filePath });
    const second = await extractSessionContextComponents({ source: "codex-cli", filePath });
    expect(second).toEqual(first);
    expect(first.components[0]?.text).toBe("cached once");
  });
});
