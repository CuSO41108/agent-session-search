// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSearchResult, SessionTraceEvent } from "../../../../core/types";
import { conversationTimeline, DetailPanel, filterConversationTimeline } from "./detail-panel";

const styles = readFileSync(resolve("src/renderer/src/styles.css"), "utf8");
const noop = () => undefined;
const session: SessionSearchResult = {
  sessionKey: "codex:session-a",
  rawId: "session-a",
  source: "codex-cli",
  projectPath: "/work/agent-recall",
  filePath: "/fixtures/session-a.jsonl",
  originalTitle: "Investigate search",
  firstQuestion: "Find the matching messages",
  timestamp: 1_000,
  fileMtimeMs: 1_000,
  fileSize: 100,
  prUrl: null,
  prNumber: null,
  environmentId: "local",
  environmentKind: "local",
  environmentLabel: "Local",
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  customTitle: null,
  displayTitle: "Investigate search",
  favorited: false,
  hidden: false,
  tags: [],
  matchSnippet: null,
  lastOpenedAt: null,
  lastResumedAt: null,
  lastActivityAt: 1_000,
  messageCount: 2,
  aiSummary: null,
  aiSummaryStale: false,
};

const props: ComponentProps<typeof DetailPanel> = {
  session,
  messages: [
    { role: "user", content: "needle one", timestamp: "2026-07-29T00:00:00.000Z", index: 0 },
    { role: "assistant", content: "needle two", timestamp: "2026-07-29T00:00:01.000Z", index: 1 },
  ],
  matchedContextMessages: [],
  matchedMessageIndex: null,
  traceEvents: [],
  loading: false,
  actionStatus: null,
  query: "",
  liveState: "closed",
  language: "zh",
  revealLabel: "访达",
  showItermAction: false,
  messagePageSize: 100,
  olderMessageCount: 0,
  onClose: noop,
  onShowMore: noop,
  onRename: noop,
  onAddTag: noop,
  onRemoveTag: noop,
  onFavorite: noop,
  onSummarize: noop,
  summarizing: false,
  canResume: false,
  canMigrate: false,
  migrationTitle: "",
  onResume: noop,
  onResumeIterm: noop,
  onMigrate: noop,
  onCopyResume: noop,
  onCopyMarkdown: noop,
  onExportMarkdown: noop,
  onExportJson: noop,
  onCopyPlain: noop,
  onDelete: noop,
  onReveal: noop,
  sessionFamily: { parent: null, children: [], truncated: false },
};

describe("detail panel conversation search", () => {
  let container: HTMLDivElement;
  let root: Root;
  let styleElement: HTMLStyleElement;

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Reflect.set(Element.prototype, "scrollIntoView", vi.fn());
    Reflect.set(HTMLElement.prototype, "scrollTo", vi.fn());
    Reflect.set(HTMLElement.prototype, "scrollBy", vi.fn());
    styleElement = document.createElement("style");
    styleElement.textContent = styles;
    document.head.append(styleElement);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(DetailPanel, props)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    styleElement.remove();
    container.remove();
  });

  async function openConversationSearch(): Promise<HTMLInputElement> {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
      }));
    });
    const input = container.querySelector<HTMLInputElement>(".panel-search-input");
    expect(input).not.toBeNull();
    return input!;
  }

  it("keeps the search bar pinned while navigating matches", async () => {
    await openConversationSearch();

    const bar = container.querySelector<HTMLElement>(".panel-search-bar");
    expect(bar).not.toBeNull();
    expect(getComputedStyle(bar!).position).toBe("sticky");
    expect(getComputedStyle(bar!).top).toBe("0px");
  });

  it("refocuses the existing search input when the shortcut is pressed again", async () => {
    const input = await openConversationSearch();
    const closeButton = container.querySelector<HTMLButtonElement>(".panel-search-close");
    closeButton!.focus();
    expect(document.activeElement).toBe(closeButton);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
      }));
    });

    expect(document.activeElement).toBe(input);
  });

  it("hides lifecycle starts but keeps a terminal lifecycle event after the final message", () => {
    const lifecycle: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-29T00:00:00.500Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-1",
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-29T00:00:05.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-1",
      },
    ];

    const timeline = conversationTimeline(props.messages, lifecycle);
    expect(timeline.map((item) => item.key)).toEqual([
      "message:0",
      "message:1",
      "trace:1",
    ]);
    expect(filterConversationTimeline(timeline, "all", false).map((item) => item.key)).toContain("trace:1");
  });

  it("labels commentary while leaving final answers unchanged", async () => {
    await act(async () => root.render(createElement(DetailPanel, {
      ...props,
      messages: [
        {
          role: "assistant",
          content: "checking",
          timestamp: "2026-07-29T00:00:00.000Z",
          index: 0,
          phase: "commentary",
        },
        {
          role: "assistant",
          content: "done",
          timestamp: "2026-07-29T00:00:01.000Z",
          index: 1,
          phase: "final_answer",
        },
      ],
    })));

    expect(container.querySelectorAll(".message.commentary")).toHaveLength(1);
    expect(container.querySelector(".message-phase")?.textContent).toBe("过程说明");
  });

  it("renders an accessible lifecycle status label even when tools are hidden", async () => {
    await act(async () => root.render(createElement(DetailPanel, {
      ...props,
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-29T00:00:03.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-1",
      }],
    })));

    expect(container.querySelector(".trace-status-label")?.textContent).toBe("已完成");
  });
});
