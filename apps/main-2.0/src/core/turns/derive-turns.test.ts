import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionTraceEvent, TokenUsageEvent } from "../types";
import { loadCodexSessionRows } from "../session-loader";
import { deriveSessionTimeline, TURN_DERIVATION_VERSION } from "./derive-turns";

const messages: SessionMessage[] = [
  {
    role: "user",
    content: "Find the failing test",
    timestamp: "2026-07-23T10:00:00.000Z",
    index: 0,
  },
  {
    role: "assistant",
    content: "I will inspect the test output.",
    timestamp: "2026-07-23T10:00:01.000Z",
    index: 1,
  },
  {
    role: "user",
    content: "Fix it",
    timestamp: "2026-07-23T10:01:00.000Z",
    index: 2,
  },
  {
    role: "assistant",
    content: "The test now passes.",
    timestamp: "2026-07-23T10:01:04.000Z",
    index: 3,
  },
];

const traceEvents: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell · npm test",
    detail: "{\"command\":\"npm test\"}",
    timestamp: "2026-07-23T10:00:02.000Z",
    callId: "call-1",
    status: "unknown",
  },
  {
    index: 1,
    kind: "tool_result",
    source: "codex",
    title: "tool output",
    detail: "1 test failed",
    timestamp: "2026-07-23T10:00:05.000Z",
    callId: "call-1",
    status: "failed",
  },
  {
    index: 2,
    kind: "event",
    source: "codex",
    title: "apply_patch",
    detail: "updated the assertion",
    timestamp: "2026-07-23T10:01:02.000Z",
    eventType: "patch_apply_end",
    status: "completed",
  },
];

const tokenEvents: TokenUsageEvent[] = [
  {
    timestamp: Date.parse("2026-07-23T10:00:06.000Z"),
    dedupeKey: "usage-1",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  },
  {
    timestamp: Date.parse("2026-07-23T10:01:05.000Z"),
    dedupeKey: "usage-2",
    inputTokens: 80,
    outputTokens: 10,
    cachedInputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: 110,
  },
];

describe("deriveSessionTimeline", () => {
  it("groups by Codex source turn id and projects lifecycle without creating spans", () => {
    const sourceMessages: SessionMessage[] = [
      {
        role: "user",
        content: "first",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-a",
      },
      {
        role: "user",
        content: "second",
        timestamp: "2026-07-30T08:00:00.500Z",
        index: 1,
        sourceTurnId: "turn-b",
      },
      {
        role: "assistant",
        content: "first done",
        timestamp: "2026-07-30T08:00:02.000Z",
        index: 2,
        sourceTurnId: "turn-a",
        phase: "final_answer",
      },
    ];
    const lifecycle: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-a",
        attributes: { startedAt: "2026-07-30T08:00:00.000Z" },
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-30T08:00:03.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-a",
        attributes: {
          endedAt: "2026-07-30T08:00:03.000Z",
          durationMs: 3_000,
          timeToFirstTokenMs: 125,
        },
      },
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Turn aborted",
        detail: "replaced",
        timestamp: "2026-07-30T08:00:01.000Z",
        eventType: "codex.turn.aborted",
        status: "aborted",
        sourceTurnId: "turn-b",
        attributes: { abortReason: "replaced", durationMs: 500 },
      },
    ];

    const timeline = deriveSessionTimeline({
      sessionKey: "codex:source-turns",
      messages: sourceMessages,
      traceEvents: lifecycle,
      codexIncrementalState: {
        historyMode: "paginated",
        messageProvenance: [
          { messageIndex: 0, sourceRecordId: "response_item:user-a" },
          { messageIndex: 1, sourceRecordId: "response_item:user-b" },
          { messageIndex: 2, sourceRecordId: "response_item:answer-a" },
        ],
        activeTurnIds: [],
      },
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      sourceMessageIndex: 0,
      sourceTurnId: "turn-a",
      status: "completed",
      durationMs: 3_000,
      timeToFirstTokenMs: 125,
      spans: [],
    });
    expect(timeline.turns[0].messages[1].metadata).toEqual({
      sourceTurnId: "turn-a",
      phase: "final_answer",
      codex: { sourceItemId: "response_item:answer-a" },
    });
    expect(timeline.turns[1]).toMatchObject({
      sourceMessageIndex: 1,
      sourceTurnId: "turn-b",
      status: "aborted",
      durationMs: 500,
      abortReason: "replaced",
      spans: [],
    });
    expect(timeline.turns[0].id).toBe(
      deriveSessionTimeline({
        sessionKey: "codex:source-turns",
        messages: sourceMessages.map((message) => ({ ...message, sourceTurnId: null })),
      }).turns[0].id,
    );
  });

  it("keeps a started Codex Turn running until a lifecycle terminal arrives", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:active-turn",
      messages: [{
        role: "user",
        content: "keep working",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-active",
      }],
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-active",
      }],
      codexIncrementalState: {
        historyMode: "paginated",
        messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:user-active" }],
        activeTurnIds: ["turn-active"],
      },
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0].status).toBe("running");
  });

  it("retains rolled-back token usage without creating a token-only Turn", () => {
    const loaded = loadCodexSessionRows("/tmp/codex-token-only-rollback.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-30T09:00:00Z",
        payload: { id: "codex-token-only-rollback", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:01Z",
        payload: { type: "task_started", turn_id: "turn-rolled" },
      },
      {
        type: "response_item",
        timestamp: "2026-07-30T09:00:02Z",
        payload: {
          type: "message",
          id: "user-rolled",
          role: "user",
          content: [{ type: "input_text", text: "撤销这轮" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-rolled" },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:03Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:04Z",
        payload: { type: "turn_aborted", turn_id: "turn-rolled", reason: "interrupted" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-30T09:00:05Z",
        payload: { type: "thread_rolled_back", num_turns: 1 },
      },
    ]);
    if (!loaded) throw new Error("Expected the rolled-back Codex fixture to load.");

    const timeline = deriveSessionTimeline({
      sessionKey: loaded.session.sessionKey,
      messages: loaded.messages,
      traceEvents: loaded.traceEvents,
      tokenEvents: loaded.tokenEvents,
      codexIncrementalState: loaded.codexIncrementalState,
    });

    expect(loaded.tokenEvents).toHaveLength(1);
    expect(loaded.session.tokenUsage?.totalTokens).toBe(11);
    expect(timeline.turns).toEqual([]);
  });

  it("creates one searchable Turn per user request and pairs tool calls with their results", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:test",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: 0,
      synthetic: false,
      status: "failed",
      userText: "Find the failing test",
      assistantText: "I will inspect the test output.",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 175,
      errorCount: 1,
      toolNames: ["shell"],
      derivationVersion: TURN_DERIVATION_VERSION,
    });
    expect(timeline.turns[0].searchText).toBe(
      "Find the failing test\n\nI will inspect the test output.",
    );
    expect(timeline.turns[0].toolText).toContain("1 test failed");
    expect(timeline.turns[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(timeline.turns[0].spans).toHaveLength(1);
    expect(timeline.turns[0].spans[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      status: "failed",
      callId: "call-1",
      input: { text: "{\"command\":\"npm test\"}" },
      output: { text: "1 test failed" },
    });

    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 2,
      status: "completed",
      userText: "Fix it",
      assistantText: "The test now passes.",
      totalTokens: 110,
      toolNames: ["apply_patch"],
    });
  });

  it("keeps preamble events in a synthetic Turn instead of attributing them to the first request", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:preamble",
      messages: [messages[0]],
      traceEvents: [{
        ...traceEvents[2],
        index: 0,
        timestamp: "2026-07-23T09:59:00.000Z",
      }],
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      toolNames: ["apply_patch"],
    });
    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 0,
      synthetic: false,
      userText: "Find the failing test",
    });
  });

  it("creates a synthetic Turn when a transcript has no user message", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "claude:assistant-only",
      messages: [{
        role: "assistant",
        content: "Background task finished",
        timestamp: "",
        index: 4,
      }],
      traceEvents: [],
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      assistantText: "Background task finished",
    });
  });

  it("projects a completed paginated tool item into one span with structured input and output", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:completed-tool",
      messages: [{
        role: "user",
        content: "list files",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-1",
      }],
      traceEvents: [{
        index: 0,
        kind: "tool_result",
        source: "codex",
        title: "shell · ls",
        detail: "input and output preview",
        timestamp: "2026-07-30T08:00:02.000Z",
        callId: "command-1",
        eventType: "codex.command_execution",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: {
          startedAt: "2026-07-30T08:00:01.000Z",
          endedAt: "2026-07-30T08:00:02.000Z",
          input: { command: "ls" },
          output: { stdout: "file.txt", exitCode: 0 },
        },
      }],
    });

    expect(timeline.turns[0].spans).toMatchObject([{
      callId: "command-1",
      status: "completed",
      startedAt: "2026-07-30T08:00:01.000Z",
      endedAt: "2026-07-30T08:00:02.000Z",
      input: { command: "ls" },
      output: { stdout: "file.txt", exitCode: 0 },
    }]);
  });

  it("keeps rich Codex traces visible without counting them as tool names", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:rich-traces",
      messages: [{
        role: "user",
        content: "review this",
        timestamp: "2026-07-30T08:00:00.000Z",
        index: 0,
        sourceTurnId: "turn-1",
      }],
      traceEvents: [
        {
          index: 0,
          kind: "event",
          source: "codex",
          title: "Reasoning summary",
          detail: "Checked the parser boundary",
          timestamp: "2026-07-30T08:00:01.000Z",
          eventType: "codex.reasoning_summary",
          status: "completed",
          sourceTurnId: "turn-1",
        },
        {
          index: 1,
          kind: "event",
          source: "codex",
          title: "Plan",
          detail: "Run focused tests",
          timestamp: "2026-07-30T08:00:02.000Z",
          eventType: "codex.plan",
          status: "completed",
          sourceTurnId: "turn-1",
        },
      ],
    });

    expect(timeline.turns[0].spans).toHaveLength(2);
    expect(timeline.turns[0].errorCount).toBe(0);
    expect(timeline.turns[0].toolNames).toEqual([]);
  });

  it("generates stable identifiers independent of input array order", () => {
    const sameTimeTokenEvents = tokenEvents.map((event) => ({
      ...event,
      timestamp: tokenEvents[0].timestamp,
    }));
    const first = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages,
      traceEvents,
      tokenEvents: sameTimeTokenEvents,
    });
    const reordered = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages: [...messages].reverse(),
      traceEvents: [...traceEvents].reverse(),
      tokenEvents: [...sameTimeTokenEvents].reverse(),
    });

    expect(reordered).toEqual(first);
  });

  it("preserves every source item as an ordered raw event", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:raw",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.rawEvents).toHaveLength(messages.length + traceEvents.length + tokenEvents.length);
    expect(timeline.rawEvents.map((event) => event.eventIndex)).toEqual(
      timeline.rawEvents.map((_, index) => index),
    );
    expect(new Set(timeline.rawEvents.map((event) => event.eventId)).size).toBe(timeline.rawEvents.length);
    expect(timeline.rawEvents.map((event) => event.kind)).toEqual([
      "message",
      "message",
      "trace",
      "trace",
      "token",
      "message",
      "trace",
      "message",
      "token",
    ]);
  });

  it("assigns large trace histories without rescanning every Turn", () => {
    const startedAt = Date.parse("2026-07-23T10:00:00.000Z");
    const manyMessages = Array.from({ length: 800 }, (_, index): SessionMessage => ({
      role: "user",
      content: `request ${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      index,
    }));
    const manyTraceEvents = Array.from({ length: 8_000 }, (_, index): SessionTraceEvent => ({
      index,
      kind: "event",
      source: "codex",
      title: "progress",
      detail: "",
      timestamp: new Date(startedAt + (index % manyMessages.length) * 1_000 + 1).toISOString(),
      status: "completed",
    }));

    const before = performance.now();
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:large",
      messages: manyMessages,
      traceEvents: manyTraceEvents,
    });

    expect(timeline.turns).toHaveLength(manyMessages.length);
    expect(timeline.rawEvents).toHaveLength(manyMessages.length + manyTraceEvents.length);
    expect(performance.now() - before).toBeLessThan(1_500);
  });
});
