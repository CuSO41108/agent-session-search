import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadDefaultSessions,
  loadDefaultSessionsAsyncIterator,
  loadWorkBuddySessionRows,
} from "./session-loader";
import type { LoadedSession } from "./types";

const temporaryHomes: string[] = [];

function temporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-workbuddy-v2-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

afterEach(() => {
  for (const homeDir of temporaryHomes.splice(0)) {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("WorkBuddy session loading", () => {
  it("discovers the optional source with messages, trace, normalized usage, and subagent linkage", async () => {
    const homeDir = temporaryHome();
    const projectsDir = path.join(homeDir, ".workbuddy", "projects");
    const parentPath = path.join(projectsDir, "project-a", "parent-actual.jsonl");
    writeJsonl(parentPath, [
      {
        type: "ai-title",
        aiTitle: "Quarterly research report",
        sessionId: "row-session-id-must-not-win",
        cwd: "/workspace/report",
        timestamp: 1_780_000_000_000,
      },
      {
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Create the quarterly report" }],
        sessionId: "row-session-id-must-not-win",
        cwd: "/workspace/report",
        timestamp: 1_779_999_999_000,
      },
      {
        id: "assistant-raw",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I'll inspect the source data." }],
        providerData: {
          messageId: "billing-1",
          rawUsage: {
            prompt_tokens: 99_999,
            completion_tokens: 999,
            prompt_cache_hit_tokens: 32_000,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 100,
            prompt_cache_write_tokens: 120,
            completion_thinking_tokens: 3,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
          usage: { inputTokens: 32_221, outputTokens: 10 },
        },
        cwd: "/workspace/report",
        timestamp: 1_780_000_002_000,
      },
      {
        id: "function-duplicate-billing",
        type: "function_call",
        name: "Read",
        callId: "call-1",
        arguments: JSON.stringify({ path: "data.csv" }),
        providerData: {
          messageId: "billing-1",
          rawUsage: {
            prompt_tokens: 99_999,
            completion_tokens: 999,
            prompt_cache_hit_tokens: 32_000,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 100,
            prompt_cache_write_tokens: 120,
            completion_thinking_tokens: 3,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
          usage: { inputTokens: 32_221, outputTokens: 10 },
        },
        timestamp: 1_780_000_002_100,
      },
      {
        id: "result-1",
        type: "function_call_result",
        callId: "call-1",
        output: { type: "text", text: "revenue,expense" },
        timestamp: 1_780_000_002_200,
      },
      {
        id: "function-usage",
        type: "function_call",
        name: "Analyze",
        callId: "call-2",
        arguments: { query: "quarterly totals" },
        providerData: {
          rawUsage: {
            prompt_tokens: 32_221,
            completion_tokens: 100,
            prompt_cache_hit_tokens: 32_000,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 100,
            prompt_cache_write_tokens: 120,
            completion_thinking_tokens: 20,
          },
        },
        timestamp: 1_780_000_003_000,
      },
      {
        id: "reasoning-camel-only",
        type: "reasoning",
        content: "usage-only reasoning record",
        providerData: {
          messageId: "camel-only",
          usage: { inputTokens: 20, outputTokens: 0 },
        },
        timestamp: 1_780_000_003_400,
      },
      {
        id: "reasoning-duplicate",
        type: "reasoning",
        content: "internal reasoning must not become a message",
        providerData: {
          messageId: "billing-1",
          rawUsage: {
            prompt_tokens: 99_999,
            completion_tokens: 999,
            prompt_cache_hit_tokens: 32_000,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 100,
            prompt_cache_write_tokens: 120,
            completion_thinking_tokens: 3,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
          usage: { inputTokens: 32_221, outputTokens: 10 },
        },
        timestamp: 1_780_000_003_500,
      },
      {
        id: "result-2",
        type: "function_call_result",
        callId: "call-2",
        output: JSON.stringify([{ type: "text", text: "totals calculated" }]),
        timestamp: 1_780_000_003_100,
      },
      {
        type: "reasoning",
        content: "usage without a stable response identifier must not be counted",
        providerData: { usage: { inputTokens: 9_999, outputTokens: 9_999 } },
        timestamp: 1_780_000_003_150,
      },
      {
        id: "shared-model-response-id",
        type: "function_call",
        name: "MustNotBecomeTrace",
        arguments: { path: "missing-call-id.txt" },
        timestamp: 1_780_000_003_200,
      },
      {
        id: "shared-model-response-id",
        type: "function_call_result",
        output: { type: "text", text: "missing callId" },
        timestamp: 1_780_000_003_300,
      },
      {
        id: "orphan-result",
        type: "function_call_result",
        callId: "unseen-call",
        output: { type: "text", text: "missing tool name" },
        timestamp: 1_780_000_003_350,
      },
      {
        id: "assistant-message-usage",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Report complete." }],
        message: {
          usage: {
            input_tokens: 40,
            output_tokens: 8,
            cache_read_input_tokens: 5,
          },
        },
        timestamp: 1_780_000_004_000,
      },
    ]);

    const subagentPath = path.join(
      projectsDir,
      "project-a",
      "parent-actual",
      "subagents",
      "agent-research.jsonl",
    );
    writeJsonl(subagentPath, [
      {
        type: "ai-title",
        aiTitle: "Research helper",
        sessionId: "unrelated-row-id",
        cwd: "/workspace/report",
        timestamp: 1_780_000_005_000,
      },
      {
        id: "sub-user",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Find supporting sources" }],
        cwd: "/workspace/report",
        timestamp: 1_780_000_005_100,
      },
    ]);

    writeJsonl(path.join(projectsDir, "subagents", "project-name.jsonl"), [
      {
        id: "project-name-user",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "A project directory may itself be named subagents" }],
        cwd: "/workspace/subagents-project",
        timestamp: 1_780_000_006_000,
      },
    ]);
    writeJsonl(path.join(projectsDir, "project-a", "nested", "ignored.jsonl"), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "must not be indexed" }], timestamp: 1_780_000_007_000 },
    ]);
    writeJsonl(path.join(projectsDir, "project-a", "parent-actual", "subagents", "not-agent.jsonl"), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "A subagent stem need not start with agent" }], cwd: "/workspace/report", timestamp: 1_780_000_008_000 },
    ]);
    writeJsonl(path.join(projectsDir, "project-a", "parent-actual", "subagents", "2025.01.01.jsonl"), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "A dotted subagent stem is valid" }], cwd: "/workspace/report", timestamp: 1_780_000_008_500 },
    ]);
    writeJsonl(path.join(projectsDir, "project-a", "2025.01.01.jsonl"), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "invalid dotted stem" }], timestamp: 1_780_000_009_000 },
    ]);

    expect(loadDefaultSessions({ homeDir }).some((item) => item.session.source === "workbuddy-cli")).toBe(false);

    const loaded = loadDefaultSessions({ homeDir, includeWorkBuddy: true })
      .filter((item) => item.session.source === "workbuddy-cli");
    expect(loaded.map((item) => item.session.rawId).sort()).toEqual([
      "parent-actual",
      "parent-actual:subagent:2025.01.01",
      "parent-actual:subagent:agent-research",
      "parent-actual:subagent:not-agent",
      "project-name",
    ]);

    const parent = loaded.find((item) => item.session.rawId === "parent-actual")!;
    expect(parent.session).toMatchObject({
      sessionKey: "workbuddy:parent-actual",
      source: "workbuddy-cli",
      projectPath: "/workspace/report",
      originalTitle: "Quarterly research report",
      firstQuestion: "Create the quarterly report",
      timestamp: 1_779_999_999_000,
      isSubagent: false,
      parentSessionId: null,
      tokenUsage: {
        inputTokens: 497,
        outputTokens: 118,
        cachedInputTokens: 64_005,
        cacheCreationInputTokens: 240,
        reasoningOutputTokens: 23,
        totalTokens: 64_883,
      },
    });
    expect(parent.messages.map(({ content }) => content)).toEqual([
      "Create the quarterly report",
      "I'll inspect the source data.",
      "Report complete.",
    ]);
    expect(parent.tokenEvents?.map(({ dedupeKey }) => dedupeKey).sort()).toEqual([
      "workbuddy:assistant-message-usage",
      "workbuddy:billing-1",
      "workbuddy:camel-only",
      "workbuddy:function-usage",
    ]);
    expect(parent.tokenEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dedupeKey: "workbuddy:billing-1",
        inputTokens: 221,
        outputTokens: 10,
        cachedInputTokens: 32_000,
        cacheCreationInputTokens: 120,
        reasoningOutputTokens: 3,
        totalTokens: 32_354,
      }),
      expect.objectContaining({
        dedupeKey: "workbuddy:camel-only",
        inputTokens: 20,
        cachedInputTokens: 0,
        totalTokens: 20,
      }),
      expect.objectContaining({
        dedupeKey: "workbuddy:function-usage",
        inputTokens: 221,
        outputTokens: 100,
        cachedInputTokens: 32_000,
        cacheCreationInputTokens: 120,
        reasoningOutputTokens: 20,
        totalTokens: 32_461,
      }),
    ]));
    expect(parent.traceEvents).toEqual([
      {
        index: 0,
        kind: "tool_call",
        source: "workbuddy",
        title: "Read · data.csv",
        detail: '{\n  "path": "data.csv"\n}',
        timestamp: "2026-05-28T20:26:42.100Z",
        callId: "call-1",
        eventType: "workbuddy.function_call",
        status: "running",
        attributes: { input: { path: "data.csv" } },
      },
      {
        index: 1,
        kind: "tool_result",
        source: "workbuddy",
        title: "Read result",
        detail: "revenue,expense",
        timestamp: "2026-05-28T20:26:42.200Z",
        callId: "call-1",
        eventType: "workbuddy.function_call_result",
        status: "completed",
        attributes: { output: { type: "text", text: "revenue,expense" } },
      },
      {
        index: 2,
        kind: "tool_call",
        source: "workbuddy",
        title: "Analyze · quarterly totals",
        detail: '{\n  "query": "quarterly totals"\n}',
        timestamp: "2026-05-28T20:26:43.000Z",
        callId: "call-2",
        eventType: "workbuddy.function_call",
        status: "running",
        attributes: { input: { query: "quarterly totals" } },
      },
      {
        index: 3,
        kind: "tool_result",
        source: "workbuddy",
        title: "Analyze result",
        detail: "totals calculated",
        timestamp: "2026-05-28T20:26:43.100Z",
        callId: "call-2",
        eventType: "workbuddy.function_call_result",
        status: "completed",
        attributes: { output: [{ type: "text", text: "totals calculated" }] },
      },
    ]);

    const subagent = loaded.find((item) => item.session.rawId === "parent-actual:subagent:agent-research")!;
    expect(subagent.session).toMatchObject({
      sessionKey: "workbuddy:parent-actual:subagent:agent-research",
      rawId: "parent-actual:subagent:agent-research",
      source: "workbuddy-cli",
      isSubagent: true,
      parentSessionId: "parent-actual",
      originalTitle: "Research helper",
    });
    expect(loaded
      .filter((item) => item.session.isSubagent)
      .map(({ session }) => ({
        sessionKey: session.sessionKey,
        rawId: session.rawId,
        parentSessionId: session.parentSessionId,
      }))
      .sort((left, right) => left.rawId.localeCompare(right.rawId)))
      .toEqual([
        {
          sessionKey: "workbuddy:parent-actual:subagent:2025.01.01",
          rawId: "parent-actual:subagent:2025.01.01",
          parentSessionId: "parent-actual",
        },
        {
          sessionKey: "workbuddy:parent-actual:subagent:agent-research",
          rawId: "parent-actual:subagent:agent-research",
          parentSessionId: "parent-actual",
        },
        {
          sessionKey: "workbuddy:parent-actual:subagent:not-agent",
          rawId: "parent-actual:subagent:not-agent",
          parentSessionId: "parent-actual",
        },
      ]);
    expect(loaded.find((item) => item.session.rawId === "project-name")?.session).toMatchObject({
      isSubagent: false,
      parentSessionId: null,
    });

    const asyncLoaded: LoadedSession[] = [];
    for await (const item of loadDefaultSessionsAsyncIterator({ homeDir, includeWorkBuddy: true })) {
      if (item.session.source === "workbuddy-cli") asyncLoaded.push(item);
    }
    expect(asyncLoaded.map((item) => item.session.sessionKey).sort()).toEqual(
      loaded.map((item) => item.session.sessionKey).sort(),
    );
  });

  it("rejects rows outside the strict WorkBuddy project layouts", () => {
    const homeDir = temporaryHome();
    const projectsDir = path.join(homeDir, ".workbuddy", "projects");
    const row = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "outside" }],
      timestamp: 1_780_000_000_000,
    };
    expect(loadWorkBuddySessionRows(path.join(projectsDir, "project", "empty.jsonl"), [], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(path.join(homeDir, "outside.jsonl"), [row], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(path.join(projectsDir, "project", "nested", "session.jsonl"), [row], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(
      path.join(projectsDir, "project", "parent", "subagents", ".jsonl"),
      [row],
      projectsDir,
    )).toBeNull();
    expect(loadWorkBuddySessionRows(path.join(projectsDir, "project", "2025.01.01.jsonl"), [row], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(
      path.join(projectsDir, "project", "parent", "subagents", "bad:name.jsonl"),
      [row],
      projectsDir,
    )?.session).toMatchObject({
      rawId: "parent:subagent:bad:name",
      parentSessionId: "parent",
      isSubagent: true,
    });
    const validPath = path.join(projectsDir, "project", "empty-session.jsonl");
    expect(loadWorkBuddySessionRows(validPath, [{ type: "ai-title", aiTitle: "Metadata only" }], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(validPath, [
      { type: "function_call", callId: "call-without-name", arguments: {} },
      { type: "function_call", name: "Read", arguments: {} },
    ], projectsDir)).toBeNull();
    expect(loadWorkBuddySessionRows(validPath, [{
      type: "reasoning",
      id: "usage-only",
      providerData: { usage: { inputTokens: 10, outputTokens: 5 } },
    }], projectsDir)).toBeNull();
  });
});
