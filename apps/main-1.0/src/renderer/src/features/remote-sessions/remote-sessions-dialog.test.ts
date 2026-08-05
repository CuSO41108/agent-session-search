// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionSyncItem } from "../../../../core/remote-session-sync";
import type { SessionSearchResult } from "../../../../core/types";
import type { RemoteSessionsCache } from "../../remote-sessions-cache";
import { EMPTY_REMOTE_SESSIONS_CACHE } from "../../remote-sessions-cache";
import { RemoteSessionsDialog } from "./remote-sessions-dialog";

const noop = () => undefined;

function localItem(id: string, title: string): SessionSyncItem {
  const local = {
    sessionKey: `local:${id}`,
    rawId: id,
    source: "codex-cli",
    projectPath: "/tmp/project",
    filePath: `/tmp/${id}.jsonl`,
    originalTitle: title,
    firstQuestion: title,
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    displayTitle: title,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 1,
    messageCount: 1,
    aiSummary: null,
    aiSummaryStale: false,
  } satisfies SessionSearchResult;
  return {
    id: `local:${local.sessionKey}`,
    state: "local-only",
    local,
    remote: null,
    localRevision: "",
    remoteRevision: "",
    lastSyncedAt: null,
  };
}

function renderDialog(cache: RemoteSessionsCache): string {
  return renderToStaticMarkup(createElement(RemoteSessionsDialog, {
    cache,
    language: "zh",
    onRefresh: async () => undefined,
    onQueueUploads: noop,
    onQueueDeletions: noop,
    onContinueInBackground: noop,
    onClose: noop,
    onRestored: noop,
    onOpenDetail: noop,
  }));
}

describe("RemoteSessionsDialog loading state", () => {
  it("shows the foreground loading action only before the first result", () => {
    const markup = renderDialog(EMPTY_REMOTE_SESSIONS_CACHE);

    expect(markup).toContain("正在加载远程会话...");
    expect(markup).toContain("转到后台");
    expect(markup).not.toContain("正在后台刷新");
  });

  it("removes the loading panel after the first result completes", () => {
    const markup = renderDialog({
      ...EMPTY_REMOTE_SESSIONS_CACHE,
      initialized: true,
      status: { kind: "ready", setupSql: "" },
    });

    expect(markup).not.toContain("正在加载远程会话...");
    expect(markup).not.toContain("转到后台");
    expect(markup).toContain("没有找到可同步的会话");
  });

  it("keeps completed results visible during a background refresh", () => {
    const markup = renderDialog({
      ...EMPTY_REMOTE_SESSIONS_CACHE,
      initialized: true,
      refreshing: true,
      status: { kind: "ready", setupSql: "" },
    });

    expect(markup).toContain("正在后台刷新，当前显示上次结果");
    expect(markup).not.toContain("正在加载远程会话...");
    expect(markup).not.toContain("转到后台");
  });

  it("keeps unrelated rows interactive while one upload runs", () => {
    const first = localItem("first", "First session");
    const second = localItem("second", "Second session");
    const markup = renderDialog({
      ...EMPTY_REMOTE_SESSIONS_CACHE,
      initialized: true,
      refreshing: true,
      status: { kind: "ready", setupSql: "" },
      items: [first, second],
      uploadTasks: {
        [first.local!.sessionKey]: {
          itemId: first.id,
          sessionKey: first.local!.sessionKey,
          title: first.local!.displayTitle,
          state: "running",
          error: null,
        },
      },
      uploadBatch: { running: true, total: 1, completed: 0, succeeded: 0, failed: 0 },
    });
    const host = document.createElement("div");
    host.innerHTML = markup;
    const rows = [...host.querySelectorAll<HTMLElement>(".remote-session-row")];

    expect(host.textContent).toContain("正在后台上传");
    expect(host.textContent).toContain("可以关闭窗口，任务会继续在后台执行");
    expect(rows[0].querySelector<HTMLButtonElement>(".remote-session-primary-action")?.disabled).toBe(true);
    expect(rows[1].querySelector<HTMLButtonElement>(".remote-session-primary-action")?.disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>(".remote-select-visible input")?.disabled).toBe(false);
  });

  it("limits the initial row render for large remote session lists", () => {
    const markup = renderDialog({
      ...EMPTY_REMOTE_SESSIONS_CACHE,
      initialized: true,
      status: { kind: "ready", setupSql: "" },
      items: Array.from({ length: 80 }, (_, index) => localItem(String(index), `Session ${index}`)),
    });
    const host = document.createElement("div");
    host.innerHTML = markup;

    expect(host.querySelectorAll(".remote-session-row")).toHaveLength(50);
    expect(host.textContent).toContain("当前显示 50 / 80 个会话");
    expect(host.textContent).toContain("显示更多");
  });
});
