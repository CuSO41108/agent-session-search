// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionSearchResult,
} from "../../core/types";

const harness = vi.hoisted(() => ({
  listener: null as ((sessionKey: string) => void) | null,
  migrationListener: null as ((progress: SessionMigrationProgress) => void) | null,
  getSession: vi.fn(),
  openLocal: vi.fn(),
  setSelectedKey: vi.fn(),
  sessionsPage: vi.fn((_props: unknown) => null),
  remoteSessionsDialog: vi.fn((_props: unknown) => null),
  loadCatalog: vi.fn(async () => undefined),
  loadWorkbenchSessions: vi.fn(async () => undefined),
  loadStats: vi.fn(async () => undefined),
  automationApi: { listMcpServers: vi.fn(async () => []) },
  automationSnapshot: {
    workflowStore: { workflows: [], runs: [] },
    channels: [],
  },
  workflowSidebar: { workflows: [] },
  skillsSnapshot: { skills: [] },
}));

vi.mock("./components/app-navigation", () => ({ AppNavigation: () => null }));
vi.mock("./features/workbench/workbench-page", () => ({ WorkbenchPage: () => null }));
vi.mock("./features/sessions/sessions-page", () => ({ SessionsPage: harness.sessionsPage }));
vi.mock("./features/remote-sessions/remote-sessions-dialog", () => ({
  RemoteSessionsDialog: harness.remoteSessionsDialog,
}));
vi.mock("./features/search/use-main-search-shortcut", () => ({ useMainSearchShortcut: () => undefined }));

vi.mock("./features/sessions/use-session-detail", () => ({
  useSessionDetail: () => ({
    detail: null,
    remoteDetail: null,
    turns: [],
    turnsLoading: false,
    matchedTurnId: null,
    matchedMessageIndex: null,
    openLocal: harness.openLocal,
    closeLocal: vi.fn(),
    openRemote: vi.fn(),
    closeRemote: vi.fn(),
    refreshLocal: vi.fn(),
    applyUpdatedLocal: vi.fn(),
  }),
}));

vi.mock("./features/sessions/use-session-catalog", () => ({
  useSessionCatalog: () => ({
    query: "",
    setQuery: vi.fn(),
    source: "all",
    setSource: vi.fn(),
    environmentId: "all",
    setEnvironmentId: vi.fn(),
    tag: undefined,
    setTag: vi.fn(),
    projectPath: "",
    projectEnvironmentId: null,
    visibility: "visible",
    setVisibility: vi.fn(),
    dateRange: "30d",
    setDateRange: vi.fn(),
    customDateRange: null,
    setCustomDateRange: vi.fn(),
    liveStatus: "all",
    setLiveStatus: vi.fn(),
    sessionTotalCount: 0,
    displayedResults: [],
    selectedKey: null,
    setSelectedKey: harness.setSelectedKey,
    selected: null,
    searchRef: { current: null },
    liveSessionKeys: new Set<string>(),
    liveDetectionFailed: false,
    load: harness.loadCatalog,
    currentPage: 1,
    totalPages: 1,
    goToPage: vi.fn(),
    searchAllMatching: vi.fn(async () => []),
    clearProjectFilter: vi.fn(),
    clearProjectScopeFilter: vi.fn(),
    clearEnvironmentScopeFilter: vi.fn(),
    selectEnvironment: vi.fn(),
    selectProject: vi.fn(),
  }),
}));

vi.mock("./features/workbench/use-workbench-overview", () => ({
  useWorkbenchOverview: () => ({
    query: "",
    setQuery: vi.fn(),
    sessions: [],
    stats: null,
    statsPeriod: "30d",
    setStatsPeriod: vi.fn(),
    statsRefreshing: false,
    statsFeedback: null,
    quotas: [],
    quotaLoading: false,
    quotaFeedback: null,
    liveSessions: null,
    loadSessions: harness.loadWorkbenchSessions,
    loadStats: harness.loadStats,
    refreshStats: vi.fn(),
    loadQuotas: vi.fn(),
    refreshLiveSessions: vi.fn(async () => undefined),
  }),
}));

vi.mock("./features/remote-sessions/use-remote-sessions-cache", () => ({
  useRemoteSessionsCache: () => ({
    cache: {
      status: null,
      items: [],
      initialized: true,
      loading: false,
      refreshing: false,
      error: null,
      uploadTasks: {},
      uploadBatch: null,
      deleteTasks: {},
      deleteBatch: null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    queueUploads: vi.fn(),
    queueDeletions: vi.fn(),
  }),
}));

vi.mock("./features/skills/use-skills-controller", () => ({
  useSkillsController: () => ({
    snapshot: harness.skillsSnapshot,
    loading: false,
    feedback: null,
    load: vi.fn(),
    ensureLoaded: vi.fn(),
    copySetupSql: vi.fn(),
    fetchVersion: vi.fn(),
    installRemote: vi.fn(),
    deleteSkill: vi.fn(),
    upload: vi.fn(),
    uploadSelected: vi.fn(),
    syncSnapshot: vi.fn(),
  }),
}));

vi.mock("./features/automation/automation-provider", () => ({
  useAutomation: () => ({
    detailsLoaded: true,
    snapshot: harness.automationSnapshot,
    workflowSidebar: harness.workflowSidebar,
    workflowSidebarLoading: false,
    loading: false,
    error: null,
    api: harness.automationApi,
    ensureDetailsLoaded: vi.fn(async () => undefined),
    setSnapshot: vi.fn(),
  }),
}));

describe("external session opening", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function finishRemoteRestore(result: SessionMigrationResult): Promise<void> {
    const sessionsProps = harness.sessionsPage.mock.calls.at(-1)?.[0] as {
      actions: { openRemoteSessions: () => void };
    };
    await act(async () => sessionsProps.actions.openRemoteSessions());
    const remoteProps = harness.remoteSessionsDialog.mock.calls.at(-1)?.[0] as {
      onRestored: (result: SessionMigrationResult) => void;
    };
    await act(async () => {
      remoteProps.onRestored(result);
      harness.migrationListener?.({
        sessionKey: "codex:restored-session",
        target: "codex",
        stage: "launching",
      });
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const sessionSearch = {
      platform: "win32",
      onOpenSession: (listener: (sessionKey: string) => void) => {
        harness.listener = listener;
        return () => {
          if (harness.listener === listener) harness.listener = null;
        };
      },
      onIndexStatus: () => vi.fn(),
      onFocusSearch: () => vi.fn(),
      onOpenSettings: () => vi.fn(),
      onAppUpdateStatus: () => vi.fn(),
      onAppUpdateProgress: () => vi.fn(),
      onEnvironmentsUpdated: () => vi.fn(),
      onMigrationProgress: (listener: (progress: SessionMigrationProgress) => void) => {
        harness.migrationListener = listener;
        return () => {
          if (harness.migrationListener === listener) harness.migrationListener = null;
        };
      },
      getIndexStatus: vi.fn(async () => ({ running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null })),
      getAppUpdateStatus: vi.fn(async () => null),
      getSettings: vi.fn(async () => null),
      setInterfaceZoomFactor: vi.fn(async () => undefined),
      getSessionSyncHookStatus: vi.fn(async () => null),
      getSkillEvalFindingCounts: vi.fn(async () => ({})),
      listTags: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      listEnvironments: vi.fn(async () => []),
      listTagsByProject: vi.fn(async () => []),
      listSkills: vi.fn(async () => ({ skills: [] })),
      getOpenVikingMemorySnapshot: vi.fn(async () => null),
      getSession: harness.getSession,
      teamChat: { listRooms: vi.fn(async () => []) },
    };
    Reflect.set(window, "sessionSearch", sessionSearch);
    const { App } = await import("./App");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(App)));
  });

  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("switches to Session, selects the requested key, and opens its detail", async () => {
    const session = {
      sessionKey: "codex:quick-search-result",
      source: "codex-cli",
      displayTitle: "Quick search result",
    } as SessionSearchResult;
    harness.getSession.mockResolvedValue(session);

    await act(async () => {
      harness.listener?.(session.sessionKey);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.sessionsPage).toHaveBeenCalled();
    expect(harness.setSelectedKey).toHaveBeenCalledWith(session.sessionKey);
    expect(harness.getSession).toHaveBeenCalledWith(session.sessionKey);
    expect(harness.openLocal).toHaveBeenCalledWith(session);
  });

  it("finishes a remote restore after a delayed launching progress event", async () => {
    vi.useFakeTimers();
    try {
      await finishRemoteRestore({
        target: "codex",
        targetSessionId: "restored-session",
        targetFilePath: "C:\\Codex\\restored-session.jsonl",
        strategy: "complete",
        resumeCommand: "codex resume restored-session",
        indexed: true,
        launched: true,
      });

      expect(container.querySelector(".action-toast.running")).toBeNull();
      expect(container.querySelector(".action-toast.success")?.textContent).toContain("Codex");

      await act(async () => vi.advanceTimersByTimeAsync(1800));
      expect(container.querySelector(".action-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a remote restore launch failure after delayed progress", async () => {
    vi.useFakeTimers();
    try {
      const warning = "Codex could not be opened.";

      await finishRemoteRestore({
        target: "codex",
        targetSessionId: "restored-session",
        targetFilePath: "C:\\Codex\\restored-session.jsonl",
        strategy: "complete",
        resumeCommand: "codex resume restored-session",
        indexed: true,
        launched: false,
        warning,
      });

      expect(container.querySelector(".action-toast.running")).toBeNull();
      expect(container.querySelector(".action-toast.error")?.textContent).toContain(warning);

      await act(async () => vi.advanceTimersByTimeAsync(1800));
      expect(container.querySelector(".action-toast.error")?.textContent).toContain(warning);
    } finally {
      vi.useRealTimers();
    }
  });
});
