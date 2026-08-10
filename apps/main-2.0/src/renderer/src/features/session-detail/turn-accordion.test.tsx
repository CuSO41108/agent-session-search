// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

describe("TurnAccordion search match positioning", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

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
        { messageIndex: 0, sourceMessageIndex: 40, role: "user", content: "before", timestamp: turn.startedAt },
        { messageIndex: 1, sourceMessageIndex: 42, role: "assistant", content: "matched phrase", timestamp: turn.endedAt },
      ],
      spans: [],
    } satisfies SessionTurnDetail;
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
    const matchedMessage = container.querySelector('[data-message-index="42"]');
    expect(matchedMessage?.classList.contains("match-target")).toBe(true);
    expect(scrollIntoView.mock.instances).toContain(matchedMessage);
  });
});
