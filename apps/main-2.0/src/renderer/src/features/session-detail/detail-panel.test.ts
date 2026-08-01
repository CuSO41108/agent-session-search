import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RemoteSessionDetailSnapshot } from "../../../../core/remote-session-sync";
import type { SessionSearchResult, SessionTraceEvent, SessionTurnSummary } from "../../../../core/types";
import { SessionDetails, type SessionDetailsActions } from "../sessions/session-details";
import { conversationTimeline, filterConversationTimeline } from "./detail-panel";
import { SessionContextMenu } from "../sessions/session-context-menu";

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

function renderDetails(detail: SessionSearchResult = session): string {
  return renderToStaticMarkup(createElement(SessionDetails, {
    detail,
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
  it("keeps source-linked terminal lifecycle events outside the legacy message window", () => {
    const lifecycle: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-27T08:00:01.000Z",
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
        timestamp: "2026-07-27T08:00:09.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-1",
      },
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Reasoning",
        detail: "Checked the parser.",
        timestamp: "2026-07-27T08:00:03.000Z",
        eventType: "codex.reasoning_summary",
        status: "completed",
        sourceTurnId: "turn-1",
      },
      {
        index: 3,
        kind: "tool_call",
        source: "codex",
        title: "Read",
        detail: "src/parser.ts",
        timestamp: "2026-07-27T08:00:04.000Z",
        eventType: "codex.tool.read",
        status: "running",
        sourceTurnId: "turn-1",
      },
    ];
    const timeline = conversationTimeline([
      {
        role: "assistant",
        content: "done",
        timestamp: "2026-07-27T08:00:02.000Z",
        index: 0,
        sourceTurnId: "turn-1",
      },
    ], lifecycle);

    expect(timeline.map((item) => item.key)).toEqual([
      "message:0",
      "trace:2",
      "trace:3",
      "trace:1",
    ]);
    expect(filterConversationTimeline(timeline, "all", false).map((item) => item.key)).toEqual([
      "message:0",
      "trace:2",
      "trace:1",
    ]);
  });

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

  it("renders synchronized Turn summaries in the existing flat remote timeline", () => {
    const snapshot: RemoteSessionDetailSnapshot = {
      schemaVersion: 2,
      exportedAt: 10_000,
      session,
      messages: [{
        role: "assistant",
        content: "The synchronized answer",
        timestamp: "2026-07-27T08:00:03.000Z",
        index: 0,
        phase: "final_answer",
        sourceTurnId: "turn-1",
      }],
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-27T08:00:03.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: { durationMs: 3_000 },
      }],
    };
    const html = renderToStaticMarkup(createElement(SessionDetails, {
      detail: null,
      remoteDetail: { snapshot, query: "" },
      turns: [],
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

    expect(html).toContain("The synchronized answer");
    expect(html).toContain("Turn completed");
    expect(html).not.toContain("turn-accordion");
  });

  it("omits delete and remote-save actions for read-only Pi sessions", () => {
    const piSession = {
      ...session,
      sessionKey: "pi:session-a",
      rawId: "session-a",
      source: "pi-cli" as const,
    };

    expect(renderDetails()).toContain("保存到远程");
    expect(renderDetails()).toContain("删除");
    expect(renderDetails(piSession)).not.toContain("保存到远程");
    expect(renderDetails(piSession)).not.toContain("删除");
  });

  it("omits Pi deletion from the session context menu", () => {
    const html = renderToStaticMarkup(createElement(SessionContextMenu, {
      state: {
        x: 0,
        y: 0,
        session: {
          ...session,
          sessionKey: "pi:session-a",
          rawId: "session-a",
          source: "pi-cli",
        },
      },
      language: "zh",
      revealLabel: "访达",
      showMacActions: false,
      canResume: false,
      canMigrate: false,
      onRename: () => undefined,
      onAddTag: () => undefined,
      onSelectMultiple: () => undefined,
      onFavorite: () => undefined,
      onHide: () => undefined,
      onResume: () => undefined,
      onResumeIterm: () => undefined,
      onOpenApp: () => undefined,
      onMigrate: () => undefined,
      onCopyResume: () => undefined,
      onCopyMarkdown: () => undefined,
      onExportMarkdown: () => undefined,
      onExportJson: () => undefined,
      onDelete: () => undefined,
      onReveal: () => undefined,
    }));

    expect(html).toContain("多选");
    expect(html).not.toContain("删除会话");
  });
});
