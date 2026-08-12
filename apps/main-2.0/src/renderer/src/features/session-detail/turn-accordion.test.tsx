// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

describe("TurnAccordion search match positioning", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  const turn = {
    id: "turn-1",
    turnIndex: 0,
    sourceMessageIndex: 40,
    synthetic: false,
    status: "completed",
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: "2026-08-10T10:00:01.000Z",
    userPreview: "before",
    assistantPreview: "matched phrase",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: 2,
    spanCount: 0,
  } satisfies SessionTurnSummary;

  const detail = {
    ...turn,
    messages: [
      {
        messageIndex: 0,
        sourceMessageIndex: null,
        role: "user",
        content: "before",
        timestamp: turn.startedAt,
      },
      {
        messageIndex: 1,
        sourceMessageIndex: 42,
        role: "assistant",
        content: "matched phrase",
        timestamp: turn.endedAt,
      },
    ],
    spans: [],
  } satisfies SessionTurnDetail;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    scrollIntoView.mockReset();
  });

  it("opens the matching Turn and marks the exact matched message", async () => {
    const onLoadTurn = vi.fn(async () => detail);

    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:session-1"
          turns={[turn]}
          loading={false}
          matchedTurnId="turn-1"
          matchedMessageIndex={42}
          showTools
          query="matched phrase"
          language="en"
          onLoadTurn={onLoadTurn}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onLoadTurn).toHaveBeenCalledWith("turn-1");

    const matchedMessage = container.querySelector(
      '[data-message-index="42"]',
    );

    expect(matchedMessage?.classList.contains("match-target")).toBe(true);
    expect(scrollIntoView.mock.instances).toContain(matchedMessage);
  });

  it("does not mark messages with missing source indexes when no message matched", async () => {
    await act(async () => {
      root.render(
        <TurnAccordion
          sessionKey="codex:session-1"
          turns={[turn]}
          loading={false}
          matchedTurnId="turn-1"
          matchedMessageIndex={null}
          showTools
          query=""
          language="en"
          onLoadTurn={async () => detail}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".msg.match-target")).toBeNull();
  });
});

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

  it("shows parsed nested tools for Codex exec spans and falls back to the stable tool name", async () => {
    const turn: SessionTurnSummary = {
      id: "turn-exec",
      turnIndex: 0,
      sourceMessageIndex: 0,
      sourceTurnId: "turn-exec",
      synthetic: false,
      status: "completed",
      startedAt: "2026-08-12T04:00:00Z",
      endedAt: "2026-08-12T04:00:01Z",
      userPreview: "inspect tools",
      assistantPreview: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      toolNames: ["exec"],
      messageCount: 0,
      spanCount: 2,
    };
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spans: [
        {
          id: "span-parsed",
          parentSpanId: null,
          spanIndex: 0,
          kind: "tool",
          name: "exec",
          status: "completed",
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          callId: "call-parsed",
          input: null,
          output: null,
          error: null,
          attributes: {
            title: "exec · exec_command, web.run",
            nestedTools: ["exec_command", "web__run"],
          },
        },
        {
          id: "span-legacy",
          parentSpanId: null,
          spanIndex: 1,
          kind: "tool",
          name: "exec",
          status: "completed",
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          callId: "call-legacy",
          input: null,
          output: null,
          error: null,
          attributes: {
            title: "exec · raw script summary",
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        createElement(TurnAccordion, {
          sessionKey: "codex:exec-display",
          turns: [turn],
          loading: false,
          matchedTurnId: null,
          matchedMessageIndex: null,
          showTools: true,
          query: "",
          language: "en",
          onLoadTurn: async () => detail,
        }),
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click();
    });

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".msg-tool-summary strong")).toHaveLength(2);
    });
    const displayedNames = [...container.querySelectorAll(".msg-tool-summary strong")]
      .map((element) => element.textContent);
    expect(displayedNames).toHaveLength(2);
    expect(displayedNames).toEqual(expect.arrayContaining(["exec · exec_command, web.run", "exec"]));
    expect(turn.toolNames).toEqual(["exec"]);
  });

  it("renders a bounded preview before expanding a large span output", async () => {
    const compactOutput =
      `compact-payload:\n${"readable compact output ".repeat(500)}`;
    const toolOutput =
      `tool-payload:\n${"readable tool output ".repeat(500)}`;

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
      spans: [
        {
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
          attributes: {
            eventType: "codex.context.compaction",
          },
        },
        {
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
          attributes: {
            eventType: "codex.tool.result",
          },
        },
      ],
    };

    await act(async () => {
      root.render(
        createElement(TurnAccordion, {
          sessionKey: "codex:compact",
          turns: [turn],
          loading: false,
          matchedTurnId: null,
          matchedMessageIndex: null,
          showTools: true,
          query: "",
          language: "en",
          onLoadTurn: async () => detail,
        }),
      );
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".turn-card-summary")
        ?.click();
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector(".msg-tool-payload pre"),
      ).not.toBeNull();
    });

    const payloads = [
      ...container.querySelectorAll<HTMLElement>(".msg-tool-payload"),
    ];

    const compactPayload = payloads.find((payload) =>
      payload
        .querySelector("pre")
        ?.textContent?.startsWith("compact-payload:"),
    );

    const preview =
      compactPayload?.querySelector("pre")?.textContent ?? "";

    expect(preview.length).toBeLessThan(compactOutput.length);
    expect(preview).toContain("...(truncated)");

    const expand =
      compactPayload?.querySelector<HTMLButtonElement>("button");

    expect(expand?.textContent).toContain("Show full detail");
    expect(expand).toBeDefined();

    await act(async () => {
      expand?.click();
    });

    expect(
      compactPayload?.querySelector("pre")?.textContent,
    ).toBe(compactOutput);

    const toolPayload = payloads.find((payload) =>
      payload
        .querySelector("pre")
        ?.textContent?.startsWith("tool-payload:"),
    );

    expect(
      toolPayload?.querySelector("pre")?.textContent,
    ).toBe(toolOutput);

    expect(toolPayload?.querySelector("button")).toBeNull();
  });
});
