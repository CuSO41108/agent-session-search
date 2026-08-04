// @vitest-environment happy-dom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../../core/types";
import type { SidebarProps } from "./sidebar";
import { Sidebar } from "./sidebar";

const EMPTY_SIDEBAR_PROPS: SidebarProps = {
  language: "zh",
  sidebarSections: {
    remaining: false,
    views: false,
    environments: false,
    sources: false,
    projects: false,
    tags: false,
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
  });

  it("shows zero messages and zero tokens when there is no usage", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, EMPTY_SIDEBAR_PROPS));
    const metricsStart = html.indexOf('<div class="stats-metrics">');
    const metricsEnd = html.indexOf('<div class="stats-breakdown">');
    const metricsText = html.slice(metricsStart, metricsEnd).replace(/<[^>]+>/g, "");

    expect(metricsText).toBe("0消息0Token");
  });

  it("limits the initial project tree and reveals more projects on demand", async () => {
    const projects = Array.from({ length: 65 }, (_, index): ProjectSummary & { tags: string[] } => ({
      path: `/projects/project-${index}`,
      label: `project-${index}`,
      labelKind: "path",
      labelSuffix: null,
      sessionCount: 1,
      environmentId: "local",
      environmentLabel: "Local",
      createdAt: index,
      lastActivityAt: index,
      tags: [],
    }));
    const props: SidebarProps = {
      ...EMPTY_SIDEBAR_PROPS,
      sidebarSections: { ...EMPTY_SIDEBAR_PROPS.sidebarSections, environments: true },
      sidebarTree: [{ environment: null, projects }],
    };

    await act(async () => root.render(createElement(Sidebar, props)));

    expect(container.querySelectorAll(".tree-proj-row")).toHaveLength(30);
    const loadMore = container.querySelector<HTMLButtonElement>(".tree-project-more");
    expect(loadMore?.textContent).toContain("再显示 30 个项目");

    await act(async () => loadMore?.click());

    expect(container.querySelectorAll(".tree-proj-row")).toHaveLength(60);
    expect(container.querySelector<HTMLButtonElement>(".tree-project-more")?.textContent)
      .toContain("再显示 5 个项目");
  });

  it("keeps the selected project visible outside the first project page", () => {
    const projects = Array.from({ length: 65 }, (_, index): ProjectSummary & { tags: string[] } => ({
      path: `/projects/project-${index}`,
      label: `project-${index}`,
      labelKind: "path",
      labelSuffix: null,
      sessionCount: 1,
      environmentId: "local",
      environmentLabel: "Local",
      createdAt: index,
      lastActivityAt: index,
      tags: [],
    }));
    const html = renderToStaticMarkup(createElement(Sidebar, {
      ...EMPTY_SIDEBAR_PROPS,
      sidebarSections: { ...EMPTY_SIDEBAR_PROPS.sidebarSections, environments: true },
      sidebarTree: [{ environment: null, projects }],
      projectPath: "/projects/project-64",
      projectEnvironmentId: "local",
    }));

    expect(html).toContain("project-0");
    expect(html).not.toContain("project-30");
    expect(html).toContain("project-64");
  });
});
