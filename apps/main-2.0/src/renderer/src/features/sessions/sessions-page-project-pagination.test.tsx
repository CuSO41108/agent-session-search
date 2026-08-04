// @vitest-environment happy-dom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../../core/types";
import {
  SessionsPage,
  type SessionsPageActions,
  type SessionsPageModel,
} from "./sessions-page";

const noop = () => undefined;

function createProjects(count: number): Array<ProjectSummary & { tags: string[] }> {
  return Array.from({ length: count }, (_, index) => ({
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
}

function createModel(projects: Array<ProjectSummary & { tags: string[] }>): SessionsPageModel {
  return {
    language: "zh",
    indexStatus: null,
    sessionTotalCount: 0,
    sidebarSections: {
      remaining: false,
      views: false,
      environments: true,
      sources: false,
    },
    environmentId: "all",
    sidebarTree: [{ environment: null, projects }],
    collapsedProjectGroups: new Set(),
    expandedTreeProjects: new Set(),
    source: "all",
    sourceFilters: [],
    visibility: "default",
    searchRef: createRef<HTMLInputElement>(),
    searchPlaceholder: "搜索会话",
    query: "",
    activeScopeFilters: [],
    liveStatus: "all",
    customDateRange: null,
    dateRange: "all",
    aiAssistantOpen: false,
    remoteSessionsOpen: false,
    selected: null,
    sessions: [],
    hasMoreSessions: false,
    pageSize: 30,
    liveSessionKeys: new Set(),
    liveDetectionFailed: false,
    bulkSelectionActive: false,
    bulkSelectedKeys: new Set(),
  };
}

const actions: SessionsPageActions = {
  refresh: noop,
  toggleSidebarSection: noop,
  selectAllSessions: noop,
  toggleEnvironment: noop,
  selectEnvironment: noop,
  toggleProject: noop,
  selectProject: noop,
  toggleProjectTag: noop,
  deleteTag: noop,
  setSource: noop,
  setVisibility: noop,
  search: noop,
  setLiveStatus: noop,
  clearCustomDateRange: noop,
  setDateRange: noop,
  openAiAssistant: noop,
  openRemoteSessions: noop,
  selectSession: noop,
  openSession: noop,
  openMatch: noop,
  renameSession: noop,
  toggleFavorite: noop,
  openContextMenu: noop,
  loadMore: noop,
  toggleBulkSession: noop,
  toggleLoadedSelection: noop,
  exitBulkSelection: noop,
  selectAllMatching: noop,
  deleteSelected: noop,
  openDateCleanup: noop,
  openOrphanCleanup: noop,
};

describe("SessionsPage project pagination", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { platform: "darwin" },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders projects in bounded pages", async () => {
    await act(async () => root.render(createElement(SessionsPage, {
      model: createModel(createProjects(65)),
      actions,
    })));

    expect(container.querySelectorAll(".tree-proj-row")).toHaveLength(30);
    const loadMore = container.querySelector<HTMLButtonElement>(".tree-project-more");
    expect(loadMore?.textContent).toContain("再显示 30 个项目");

    await act(async () => loadMore?.click());

    expect(container.querySelectorAll(".tree-proj-row")).toHaveLength(60);
    expect(container.querySelector<HTMLButtonElement>(".tree-project-more")?.textContent)
      .toContain("再显示 5 个项目");
  });

  it("keeps the selected project visible outside the first page", async () => {
    const model = createModel(createProjects(65));
    model.projectPath = "/projects/project-64";
    model.projectEnvironmentId = "local";

    await act(async () => root.render(createElement(SessionsPage, { model, actions })));

    expect(container.querySelectorAll(".tree-proj-row")).toHaveLength(31);
    expect(container.querySelector('[title="/projects/project-64"]')).not.toBeNull();
    expect(container.querySelector('[title="/projects/project-30"]')).toBeNull();
  });
});
