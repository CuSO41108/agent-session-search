import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SidebarProps } from "./sidebar";
import { Sidebar } from "./sidebar";

const EMPTY_SIDEBAR_PROPS: SidebarProps = {
  language: "zh",
  sidebarSections: {
    remaining: false,
    views: false,
    environments: false,
    sources: false,
  },
  onToggleSection: () => undefined,
  indexStatus: null,
  refreshFeedback: null,
  onRefreshNow: () => undefined,
  stats: {
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
    range: {
      period: "today",
      since: null,
      until: 0,
    },
    previousTotal: null,
  },
  statsPeriod: "today",
  onStatsPeriodChange: () => undefined,
  statsFeedback: null,
  statsTrend: {
    period: "today",
    granularity: null,
    buckets: [],
  },
  statsTrendLoading: false,
  onEnsureStatsTrend: () => undefined,
  quotas: {
    generatedAt: "",
    providers: [],
  },
  quotaLoading: false,
  quotaFeedback: null,
  onRefreshQuotas: () => undefined,
  sidebarTree: [],
  collapsedProjectGroups: new Set(),
  collapsedTreeProjects: new Set(),
  onToggleProjectGroup: () => undefined,
  onToggleTreeProject: () => undefined,
  environmentId: "all",
  projectPath: undefined,
  projectEnvironmentId: undefined,
  tag: undefined,
  onSelectAllSessions: () => undefined,
  onSelectEnvironment: () => undefined,
  onSelectProject: () => undefined,
  onSelectTag: () => undefined,
  onDeleteTag: () => undefined,
  sourceFilters: [],
  source: "all",
  onSelectSource: () => undefined,
  visibility: "default",
  onSelectVisibility: () => undefined,
};

describe("Sidebar", () => {
  it("shows zero messages and zero tokens when there is no usage", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, EMPTY_SIDEBAR_PROPS));
    const metricsStart = html.indexOf('<div class="stats-metrics">');
    const metricsEnd = html.indexOf('<div class="stats-breakdown">');
    const metricsText = html.slice(metricsStart, metricsEnd).replace(/<[^>]+>/g, "");

    expect(metricsText).toBe("0消息0Token");
  });
});
