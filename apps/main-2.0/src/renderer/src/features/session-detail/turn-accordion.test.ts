import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";

async function loadTurnAccordion(): Promise<Record<string, any> | null> {
  try {
    return await import("./turn-accordion");
  } catch {
    return null;
  }
}

const summary: SessionTurnSummary = {
  id: "turn-1",
  turnIndex: 0,
  sourceMessageIndex: 0,
  synthetic: false,
  status: "completed",
  startedAt: "2026-07-24T08:00:00.000Z",
  endedAt: "2026-07-24T08:00:03.000Z",
  userPreview: "Inspect the failing test",
  assistantPreview: "I found the cause.",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  reasoningOutputTokens: 5,
  totalTokens: 165,
  errorCount: 0,
  toolNames: ["Read"],
  messageCount: 2,
  spanCount: 1,
};

const detail: SessionTurnDetail = {
  ...summary,
  messages: [
    {
      messageIndex: 0,
      sourceMessageIndex: 0,
      role: "user",
      content: "Inspect the failing test",
      timestamp: "2026-07-24T08:00:00.000Z",
    },
    {
      messageIndex: 1,
      sourceMessageIndex: 1,
      role: "assistant",
      content: "I found the cause.",
      timestamp: "2026-07-24T08:00:03.000Z",
    },
  ],
  spans: [
    {
      id: "span-1",
      parentSpanId: null,
      spanIndex: 0,
      kind: "tool",
      name: "Read",
      status: "completed",
      startedAt: "2026-07-24T08:00:01.000Z",
      endedAt: "2026-07-24T08:00:02.000Z",
      callId: "call-1",
      input: { path: "src/app.ts" },
      output: { text: "file contents" },
      error: null,
      attributes: {},
    },
  ],
};

describe("TurnAccordion", () => {
  it("keeps multiple Turn cards expanded until each is explicitly closed", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    let state = feature.createTurnAccordionState("session-a");
    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-2" });
    expect([...state.expandedTurnIds]).toEqual(["turn-1", "turn-2"]);

    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-1" });
    expect([...state.expandedTurnIds]).toEqual(["turn-2"]);
  });

  it("caches loaded detail and clears expansion state for another Session", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    let state = feature.createTurnAccordionState("session-a");
    state = feature.turnAccordionReducer(state, { type: "open", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "load-started", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "load-succeeded", turnId: "turn-1", detail });
    expect(state.detailsById["turn-1"]).toEqual(detail);
    expect(state.loadingTurnIds.has("turn-1")).toBe(false);

    state = feature.turnAccordionReducer(state, { type: "reset", sessionKey: "session-b" });
    expect(state.sessionKey).toBe("session-b");
    expect([...state.expandedTurnIds]).toEqual([]);
    expect(state.detailsById).toEqual({});
  });

  it("interleaves Turn messages and spans by observed time", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    expect(feature.buildTurnTimeline(detail).map((item: { key: string }) => item.key)).toEqual([
      "message:0",
      "span:span-1",
      "message:1",
    ]);
  });

  it("omits tool spans but keeps rich traces when tool calls are hidden", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    const detailWithReasoning: SessionTurnDetail = {
      ...detail,
      spans: [
        ...detail.spans,
        {
          id: "span-2",
          parentSpanId: null,
          spanIndex: 1,
          kind: "event",
          name: "Reasoning",
          status: "completed",
          startedAt: "2026-07-24T08:00:02.500Z",
          endedAt: "2026-07-24T08:00:02.500Z",
          callId: null,
          input: null,
          output: { text: "Checked the parser." },
          error: null,
          attributes: {
            traceKind: "event",
            eventType: "codex.reasoning_summary",
          },
        },
      ],
    };

    expect(feature.buildTurnTimeline(detailWithReasoning, false).map((item: { key: string }) => item.key)).toEqual([
      "message:0",
      "span:span-2",
      "message:1",
    ]);
  });

  it("renders every Turn collapsed by default", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    const html = renderToStaticMarkup(createElement(feature.TurnAccordion, {
      sessionKey: "session-a",
      turns: [summary],
      loading: false,
      matchedTurnId: null,
      query: "",
      language: "zh",
      onLoadTurn: async () => detail,
    }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Inspect the failing test");
    expect(html).not.toContain("file contents");
  });

  it("uses Session live state only for the last Turn without a lifecycle terminal", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    const renderStatus = (
      status: "running" | "completed" | "aborted" | "failed",
      live: boolean,
      sourceTurnId: string | null = "turn-1",
    ) =>
      renderToStaticMarkup(createElement(feature.TurnAccordion, {
        sessionKey: "session-a",
        turns: [{
          ...summary,
          status,
          sourceTurnId,
          durationMs: 3_250,
          timeToFirstTokenMs: 180,
          errorCount: 2,
          toolNames: ["Read", "Shell"],
        }],
        loading: false,
        live,
        matchedTurnId: null,
        query: "",
        language: "zh",
        onLoadTurn: async () => detail,
      }));

    const completedLive = renderStatus("completed", true);
    expect(completedLive).toContain('class="turn-status completed">已完成');
    expect(completedLive).not.toContain('class="turn-status running"');

    const abortedLive = renderStatus("aborted", true);
    expect(abortedLive).toContain('class="turn-status aborted">已中断');
    expect(abortedLive).not.toContain('class="turn-status running"');

    const failedLive = renderStatus("failed", true);
    expect(failedLive).toContain('class="turn-status failed">失败');
    expect(failedLive).not.toContain('class="turn-status running"');

    const runningLive = renderStatus("running", true);
    expect(runningLive).toContain('class="turn-status running">进行中');
    expect(runningLive).toContain("3.3s");
    expect(runningLive).toContain("TTFT 180ms");

    const runningClosed = renderStatus("running", false);
    expect(runningClosed).toContain('class="turn-status completed">已完成');
    expect(runningClosed).not.toContain('class="turn-status running"');

    const legacyCompletedLive = renderStatus("completed", true, null);
    expect(legacyCompletedLive).toContain('class="turn-status completed">已完成');
    expect(legacyCompletedLive).not.toContain('class="turn-status running"');
  });

  it("renders a turn context menu with only the migration command", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    const html = renderToStaticMarkup(createElement(feature.TurnMigrationContextMenu, {
      point: { x: 120, y: 80 },
      language: "zh",
      onMigrate: () => undefined,
    }));

    expect(html).toContain("迁移</button>");
    expect((html.match(/<button/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain("重命名");
    expect(html).not.toContain("删除");
  });
});
