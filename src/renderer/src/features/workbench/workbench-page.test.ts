import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionStats } from "../../../../core/types";
import {
  DEFAULT_WORKBENCH_CARD_ORDER,
  WorkbenchPage,
  normalizeWorkbenchCardOrder,
  reorderWorkbenchCard,
  type WorkbenchPageProps,
} from "./workbench-page";

const EMPTY_STATS: SessionStats = {
  total: {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  bySource: [],
  dailyTokenUsage: [],
  previousTotal: null,
  range: { period: "today", since: null, until: 0 },
};

function props(overrides: Partial<WorkbenchPageProps> = {}): WorkbenchPageProps {
  return {
    stats: EMPTY_STATS,
    statsPeriod: "today",
    statsRefreshing: false,
    statsFeedback: null,
    quotas: {
      generatedAt: "2026-07-24T00:00:00.000Z",
      providers: [{
        provider: "codex",
        displayName: "Codex",
        status: "supported",
        quotas: [],
      }],
      hiddenProviders: ["claude-code"],
    },
    quotaLoading: false,
    quotaFeedback: null,
    sessions: [],
    sessionQuery: "",
    liveSessionKeys: new Set(),
    liveDetectionFailed: false,
    platform: "darwin",
    language: "zh",
    onStatsPeriodChange: () => undefined,
    onRefreshStats: () => undefined,
    onRefreshQuotas: () => undefined,
    onOpenSettings: () => undefined,
    onSearchSessions: () => undefined,
    onOpenSession: () => undefined,
    onResumeSession: () => undefined,
    onShowSessions: () => undefined,
    onSelectTrendDay: () => undefined,
    workflows: [],
    workflowsLoading: false,
    workflowsError: null,
    onOpenWorkflow: () => undefined,
    onNewWorkflow: () => undefined,
    onShowWorkflows: () => undefined,
    runtimes: [],
    runtimeChannels: [],
    configuredAgents: [],
    mcpServers: [],
    onShowRuntimes: () => undefined,
    onShowMcp: () => undefined,
    onShowChat: () => undefined,
    ...overrides,
  };
}

describe("WorkbenchPage quotas", () => {
  it("does not render a provider hidden in settings", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props()));

    expect(html).toContain("Codex");
    expect(html).not.toContain("Claude Code");
  });

  it("explains when every quota provider is hidden", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props({
      quotas: {
        generatedAt: "2026-07-24T00:00:00.000Z",
        providers: [],
        hiddenProviders: ["codex", "claude-code"],
      },
    })));

    expect(html).not.toContain("<strong>Codex</strong>");
    expect(html).not.toContain("<strong>Claude Code</strong>");
    expect(html).toContain("额度已在设置中隐藏");
  });
});

describe("WorkbenchPage cards", () => {
  it("shows Session, Workflow, Runtime, MCP, and Chat entries with an explicit layout mode", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props()));

    expect(html).toContain("调整布局");
    for (const cardId of DEFAULT_WORKBENCH_CARD_ORDER) {
      expect(html).toContain(`data-card-id="${cardId}"`);
    }
    expect(html).toContain(">Runtime<");
    expect(html).toContain(">MCP<");
    expect(html).toContain(">Chat<");
  });

  it("normalizes persisted layouts and moves a card without losing any entries", () => {
    expect(normalizeWorkbenchCardOrder(["chat", "sessions", "unknown", "chat"]))
      .toEqual(["chat", "sessions", "workflows", "runtimes", "mcp"]);
    expect(reorderWorkbenchCard(DEFAULT_WORKBENCH_CARD_ORDER, "chat", "sessions"))
      .toEqual(["chat", "sessions", "workflows", "runtimes", "mcp"]);
  });
});
