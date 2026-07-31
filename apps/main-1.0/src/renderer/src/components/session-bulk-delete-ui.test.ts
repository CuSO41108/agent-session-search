// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult } from "../../../core/types";
import { SessionRow } from "../features/search/session-row";
import { BulkDeleteDialog } from "./session-dialogs";

const session: SessionSearchResult = {
  sessionKey: "codex:session-a", rawId: "session-a", source: "codex-cli",
  projectPath: "/synthetic/repo", filePath: "/synthetic/repo/session-a.jsonl",
  originalTitle: "Session A", firstQuestion: "Question", timestamp: 1_000,
  fileMtimeMs: 1_000, fileSize: 100, prUrl: null, prNumber: null,
  environmentId: "local", environmentKind: "local", environmentLabel: "Local",
  tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
  customTitle: null, displayTitle: "Session A", favorited: false, hidden: false,
  tags: [], matchSnippet: null, lastOpenedAt: null, lastResumedAt: null,
  lastActivityAt: 1_000, messageCount: 1, aiSummary: null, aiSummaryStale: false,
};

describe("session bulk delete UI", () => {
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

  it("selects a row without opening it", async () => {
    const onToggleBulk = vi.fn();
    const onOpen = vi.fn();
    await act(async () => root.render(createElement(SessionRow, {
      session, selected: false, liveState: "closed", language: "zh",
      bulkSelected: false, onToggleBulk, onOpen,
      onSelect: vi.fn(), onOpenMatch: vi.fn(), onRename: vi.fn(), onFavorite: vi.fn(), onContextMenu: vi.fn(),
    })));

    await act(async () => (container.querySelector(".session-bulk-checkbox") as HTMLInputElement).click());
    expect(onToggleBulk).toHaveBeenCalledWith("codex:session-a");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("previews cleanup before confirmation and warns about selected favorites", async () => {
    const onPreview = vi.fn();
    const onConfirm = vi.fn();
    const common = { language: "zh" as const, busy: false, onDateChange: vi.fn(), onPreview, onConfirm, onCancel: vi.fn() };
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...common, mode: "cleanup", preview: null, dateValue: "2026-01-01", favoriteCount: 0,
    })));
    await act(async () => buttonByText(container, "预览").click());
    expect(onPreview).toHaveBeenCalledTimes(1);

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...common,
      mode: "selection",
      dateValue: "",
      favoriteCount: 1,
      preview: {
        requestedCount: 3, matchedCount: 3, deletableCount: 1,
        sourceCounts: [{ source: "codex-cli", count: 1 }],
        skipped: [{ sessionKey: "live", reason: "live", message: "Live" }],
      },
    })));
    expect(container.textContent).toContain("其中包含 1 个收藏会话");
    expect(container.textContent).toContain("正在运行 · 1");
    await act(async () => buttonByText(container, "永久删除").click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}
