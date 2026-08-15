// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSyncItem } from "../../../../core/remote-session-sync";
import type { SessionSearchResult } from "../../../../core/types";
import type { RemoteSessionsCache } from "../../remote-sessions-cache";
import { RemoteSessionsDialog } from "./remote-sessions-dialog";

function cursorUpdateItem(): SessionSyncItem {
  const local = {
    sessionKey: "cursor:workspace:conversation",
    source: "cursor-agent",
    displayTitle: "Cursor branch history",
    projectPath: "C:\\repo",
    lastActivityAt: Date.parse("2026-08-15T02:00:00Z"),
    messageCount: 12,
    tags: [],
    gitBranch: null,
    aiSummary: null,
  } as unknown as SessionSearchResult;
  return {
    id: "cursor-sync-item",
    state: "local-newer",
    local,
    remote: {
      id: "remote-cursor",
      sourceSessionKey: local.sessionKey,
      sourceAgent: "cursor",
      sourceSource: "cursor-agent",
      sourceEnvironmentId: "local",
      sourceEnvironmentKind: "local",
      sourceEnvironmentLabel: "Local",
      title: local.displayTitle,
      projectPath: local.projectPath,
      startedAt: "2026-08-15T01:00:00Z",
      updatedAt: Date.parse("2026-08-15T01:30:00Z"),
      contentHash: "remote-hash",
      messageCount: 12,
      traceEventCount: 0,
      aiSummary: null,
      tags: [],
      searchText: "",
      detailObjectKey: "detail.json",
      portableObjectKey: "portable.json",
      detailSha256: "detail-sha",
      portableSha256: "portable-sha",
      createdAt: Date.parse("2026-08-15T01:00:00Z"),
      syncedAt: Date.parse("2026-08-15T01:30:00Z"),
    },
    localRevision: "local-revision",
    remoteRevision: "remote-revision",
    lastSyncedAt: Date.parse("2026-08-15T01:30:00Z"),
  };
}

describe("remote session sync status", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T03:00:00Z"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("explains Cursor updates that only change the complete archive", async () => {
    const cache: RemoteSessionsCache = {
      status: { kind: "ready", setupSql: "" },
      items: [cursorUpdateItem()],
      initialized: true,
      loading: false,
      refreshing: false,
      error: null,
      uploadTasks: {},
      uploadBatch: null,
      deleteTasks: {},
      deleteBatch: null,
    };

    await act(async () => root.render(createElement(RemoteSessionsDialog, {
      cache,
      language: "zh",
      onRefresh: vi.fn(),
      onQueueUploads: vi.fn(),
      onQueueDeletions: vi.fn(),
      onContinueInBackground: vi.fn(),
      onClose: vi.fn(),
      onRestored: vi.fn(),
      onOpenDetail: vi.fn(),
    })));

    const badge = container.querySelector<HTMLElement>(".sync-state-badge.local-newer");
    expect(badge?.textContent).toBe("完整会话有更新");
    expect(badge?.title).toContain("消息数只统计当前可见分支");
    expect(badge?.title).toContain("隐藏分支");
  });
});
