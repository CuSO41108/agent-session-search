// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

describe("TurnAccordion span payloads", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders a bounded preview before expanding a large span output", async () => {
    const compactOutput = `compact-payload:\n${"readable compact output ".repeat(500)}`;
    const toolOutput = `tool-payload:\n${"readable tool output ".repeat(500)}`;
    const turn: SessionTurnSummary = {
      id: "turn-1",
      turnIndex: 0,
      sourceMessageIndex: 0,
      sourceTurnId: "turn-1",
      synthetic: false,
      status: "completed",
      startedAt: "2026-08-10T00:00:00Z",
      endedAt: "2026-08-10T00:00:01Z",
      userPreview: "compact session",
      assistantPreview: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: [],
      messageCount: 0,
      spanCount: 2,
    };
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spans: [{
        id: "span-1",
        parentSpanId: null,
        spanIndex: 0,
        kind: "event",
        name: "Context compacted",
        status: "completed",
        startedAt: "2026-08-10T00:00:01Z",
        endedAt: "2026-08-10T00:00:01Z",
        callId: null,
        input: null,
        output: { text: compactOutput },
        error: null,
        attributes: { eventType: "codex.context.compaction" },
      }, {
        id: "span-2",
        parentSpanId: null,
        spanIndex: 1,
        kind: "tool",
        name: "exec",
        status: "completed",
        startedAt: "2026-08-10T00:00:01Z",
        endedAt: "2026-08-10T00:00:01Z",
        callId: "call-1",
        input: null,
        output: { text: toolOutput },
        error: null,
        attributes: { eventType: "codex.tool.result" },
      }],
    };

    await act(async () => root.render(createElement(TurnAccordion, {
      sessionKey: "codex:compact",
      turns: [turn],
      loading: false,
      matchedTurnId: null,
      showTools: true,
      query: "",
      language: "en",
      onLoadTurn: async () => detail,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click());
    await vi.waitFor(() => expect(container.querySelector(".msg-tool-payload pre")).not.toBeNull());

    const payloads = [...container.querySelectorAll<HTMLElement>(".msg-tool-payload")];
    const compactPayload = payloads.find((payload) => (
      payload.querySelector("pre")?.textContent?.startsWith("compact-payload:")
    ));
    const preview = compactPayload?.querySelector("pre")?.textContent ?? "";
    expect(preview.length).toBeLessThan(compactOutput.length);
    expect(preview).toContain("...(truncated)");

    const expand = compactPayload?.querySelector<HTMLButtonElement>("button");
    expect(expand?.textContent).toContain("Show full detail");
    expect(expand).toBeDefined();
    await act(async () => expand?.click());
    expect(compactPayload?.querySelector("pre")?.textContent).toBe(compactOutput);

    const toolPayload = payloads.find((payload) => (
      payload.querySelector("pre")?.textContent?.startsWith("tool-payload:")
    ));
    expect(toolPayload?.querySelector("pre")?.textContent).toBe(toolOutput);
    expect(toolPayload?.querySelector("button")).toBeNull();
  });
});
