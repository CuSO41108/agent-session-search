import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionSearchResult, SessionTurnSummary } from "../../../../core/types";
import { SessionDetails, type SessionDetailsActions } from "../sessions/session-details";

const session: SessionSearchResult = {
  sessionKey: "codex:session-a",
  rawId: "session-a",
  source: "codex-cli",
  projectPath: "/work/agent-recall",
  filePath: "/fixtures/session-a.jsonl",
  originalTitle: "Investigate the session",
  firstQuestion: "Inspect the trajectory",
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
  displayTitle: "Investigate the session",
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

const turn: SessionTurnSummary = {
  id: "turn-1",
  turnIndex: 0,
  sourceMessageIndex: 0,
  synthetic: false,
  status: "completed",
  startedAt: "2026-07-27T08:00:00.000Z",
  endedAt: "2026-07-27T08:00:03.000Z",
  userPreview: "Inspect the trajectory",
  assistantPreview: "The trajectory is ready.",
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

const actions: SessionDetailsActions = {
  loadTurn: async () => null,
  closeLocal: () => undefined,
  closeRemote: () => undefined,
  rename: () => undefined,
  addTag: () => undefined,
  removeTag: () => undefined,
  toggleFavorite: () => undefined,
  summarize: () => undefined,
  resume: () => undefined,
  resumeInIterm: () => undefined,
  migrate: () => undefined,
  uploadRemote: () => undefined,
  copyResume: () => undefined,
  copyMarkdown: () => undefined,
  exportMarkdown: () => undefined,
  exportJson: () => undefined,
  copyPlain: () => undefined,
  deleteSession: () => undefined,
  reveal: () => undefined,
};

function renderDetails(): string {
  return renderToStaticMarkup(createElement(SessionDetails, {
    detail: session,
    remoteDetail: null,
    turns: [turn],
    turnsLoading: false,
    matchedTurnId: null,
    actionStatus: null,
    query: "",
    liveState: "closed",
    language: "zh",
    revealLabel: "访达",
    showItermAction: false,
    summarizing: false,
    actions,
  }));
}

describe("Session detail trajectory controls", () => {
  it("keeps trajectory controls outside the scrollable conversation body", () => {
    const html = renderDetails();
    const toolbarIndex = html.indexOf('class="detail-timeline-toolbar"');
    const bodyIndex = html.indexOf('class="detail-body"');

    expect(toolbarIndex).toBeGreaterThan(-1);
    expect(toolbarIndex).toBeLessThan(bodyIndex);
  });

  it("shows an explicit tool-call visibility state", () => {
    const html = renderDetails();

    expect(html).toContain("工具调用");
    expect(html).toContain("已隐藏");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-pressed="false"');
  });
});
