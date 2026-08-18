// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionBulkDeletePreview } from "../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../core/types";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog } from "./session-dialogs";

function session(sessionKey: string): SessionSearchResult {
  return {
    sessionKey,
    source: "codex-cli",
    sourceAvailable: true,
    displayTitle: `Session ${sessionKey}`,
    filePath: `/fixtures/${sessionKey}.jsonl`,
  } as SessionSearchResult;
}

function bulkPreview(overrides: Partial<SessionBulkDeletePreview> = {}): SessionBulkDeletePreview {
  return {
    requestedCount: 1,
    matchedCount: 1,
    expandedCount: 1,
    deletableCount: 1,
    hasRelatedSessions: false,
    includesOpenSession: false,
    liveSessionCheckFailed: false,
    confirmationFingerprint: "preview",
    sourceCounts: [{ source: "codex-cli", count: 1 }],
    skipped: [],
    ...overrides,
  };
}

async function typeInto(input: HTMLInputElement | null, value: string): Promise<void> {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("session dialogs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 9, 12));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("offers restoring the source title only for renamed Cursor sessions", async () => {
    const onRestoreDefault = vi.fn();
    const cursorSession = {
      source: "cursor-agent",
      customTitle: "AgentRecall title",
      originalTitle: "Cursor title",
    } as SessionSearchResult;
    await act(async () => root.render(createElement(CommandDialog, {
      dialog: {
        kind: "rename",
        session: cursorSession,
        value: cursorSession.customTitle ?? "",
        useDefaultTitle: false,
      },
      tags: [],
      language: "zh",
      onChange: vi.fn(),
      onRestoreDefault,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    })));

    const restoreButton = container.querySelector<HTMLButtonElement>(".rename-default-button");
    expect(restoreButton?.textContent).toContain("恢复默认名称");
    await act(async () => restoreButton?.click());
    expect(onRestoreDefault).toHaveBeenCalledOnce();

    await act(async () => root.render(createElement(CommandDialog, {
      dialog: {
        kind: "rename",
        session: { ...cursorSession, source: "codex-cli" },
        value: cursorSession.customTitle ?? "",
        useDefaultTitle: false,
      },
      tags: [],
      language: "zh",
      onChange: vi.fn(),
      onRestoreDefault,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    })));
    expect(container.querySelector(".rename-default-button")).toBeNull();
  });

  it("opens a styled year grid and returns the selected local date", async () => {
    const onDateChange = vi.fn();
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "cleanup",
      preview: null,
      dateValue: "2025-03-18",
      favoriteCount: 0,
      busy: false,
      language: "zh",
      onDateChange,
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    await act(async () => container.querySelector<HTMLButtonElement>(".cleanup-date-trigger")?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".cleanup-date-heading")?.click());
    expect(container.querySelectorAll(".cleanup-year-grid button")).toHaveLength(12);

    const year = [...container.querySelectorAll<HTMLButtonElement>(".cleanup-year-grid button")]
      .find((button) => button.textContent === "2024");
    await act(async () => year?.click());
    const day = [...container.querySelectorAll<HTMLButtonElement>(".cleanup-day-grid button")]
      .find((button) => button.textContent === "8");
    await act(async () => day?.click());

    expect(onDateChange).toHaveBeenCalledWith("2024-03-08");
    expect(container.querySelector(".cleanup-date-popover")).toBeNull();
  });

  it("confirms an ordinary single-session deletion without typed text", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session: session("ordinary"),
      cascadeCount: 1,
      hasLiveSession: false,
      isOpen: false,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm,
      onCancel: vi.fn(),
    })));

    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    const confirmButton = container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action");
    expect(confirmButton?.textContent).toBe("确认");
    expect(confirmButton?.disabled).toBe(false);
    await act(async () => confirmButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("keeps an unknown preview error blocked without asking for typed text", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session: session("blocked"),
      cascadeCount: 1,
      hasLiveSession: false,
      isOpen: false,
      blockedMessage: "Unknown deletion preview error",
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("Unknown deletion preview error");
    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(true);
  });

  it("requires typed confirmation while offering force deletion for a live session", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session: session("live"),
      cascadeCount: 1,
      hasLiveSession: true,
      isOpen: false,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm,
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("可强制删除");
    const input = container.querySelector<HTMLInputElement>(".delete-confirmation-field input");
    const confirmButton = container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action");
    expect(confirmButton?.textContent).toBe("强制删除");
    expect(confirmButton?.disabled).toBe(true);
    await typeInto(input, "确认删除");
    expect(confirmButton?.disabled).toBe(false);
    await act(async () => confirmButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("requires typed confirmation when running state cannot be verified", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session: session("unverified"),
      cascadeCount: 1,
      hasLiveSession: false,
      liveSessionCheckFailed: true,
      isOpen: false,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("无法确认该会话树是否仍在运行");
    expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(true);
  });

  it("requires typed confirmation for an open session and clears it for a new candidate", async () => {
    const props = {
      cascadeCount: 1,
      hasLiveSession: false,
      isOpen: true,
      blockedMessage: null,
      language: "zh" as const,
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      ...props,
      session: session("first"),
    })));

    const input = container.querySelector<HTMLInputElement>(".delete-confirmation-field input");
    await typeInto(input, "确认删除");
    expect(input?.value).toBe("确认删除");

    await act(async () => root.render(createElement(DeleteSessionDialog, {
      ...props,
      session: session("second"),
    })));

    expect(container.querySelector<HTMLInputElement>(".delete-confirmation-field input")?.value).toBe("");
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(true);
  });

  it("clears typed confirmation when the same candidate receives a refreshed risk preview", async () => {
    const props = {
      session: session("same"),
      cascadeCount: 2,
      hasLiveSession: false,
      isOpen: false,
      blockedMessage: null,
      language: "zh" as const,
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(DeleteSessionDialog, { ...props, confirmationVersion: 1 })));
    await typeInto(container.querySelector(".delete-confirmation-field input"), "确认删除");

    await act(async () => root.render(createElement(DeleteSessionDialog, { ...props, confirmationVersion: 2 })));
    expect(container.querySelector<HTMLInputElement>(".delete-confirmation-field input")?.value).toBe("");
  });

  it("uses a simple confirmation below 10 sessions and typed confirmation at 10", async () => {
    const common = {
      mode: "selection" as const,
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh" as const,
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...common,
      preview: bulkPreview({
        requestedCount: 9,
        matchedCount: 9,
        expandedCount: 9,
        deletableCount: 9,
      }),
    })));

    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.textContent).toBe("确认");
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(false);

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...common,
      preview: bulkPreview({
        requestedCount: 10,
        matchedCount: 10,
        expandedCount: 10,
        deletableCount: 10,
      }),
    })));

    expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(true);
  });

  it("requires typed bulk confirmation for related trees and the open session", async () => {
    const cases = [
      {
        preview: bulkPreview({
          requestedCount: 1,
          expandedCount: 2,
          deletableCount: 2,
          hasRelatedSessions: true,
        }),
        favoriteCount: 0,
      },
      {
        preview: bulkPreview({ includesOpenSession: true }),
        favoriteCount: 0,
      },
    ];

    for (const testCase of cases) {
      await act(async () => root.render(createElement(BulkDeleteDialog, {
        mode: "selection",
        preview: testCase.preview,
        dateValue: "",
        favoriteCount: testCase.favoriteCount,
        busy: false,
        language: "zh",
        onDateChange: vi.fn(),
        onPreview: vi.fn(),
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      })));
      expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.disabled).toBe(true);
    }
  });

  it("keeps a small favorite bulk deletion on simple confirmation", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "selection",
      preview: bulkPreview(),
      dateValue: "",
      favoriteCount: 1,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm,
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("其中包含 1 个收藏会话");
    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    const confirmButton = container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action");
    await act(async () => confirmButton?.click());
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("passes dangerous confirmation only after the typed phrase", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "selection",
      preview: bulkPreview({ deletableCount: 10 }),
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm,
      onCancel: vi.fn(),
    })));

    await typeInto(
      container.querySelector<HTMLInputElement>(".delete-confirmation-field input"),
      "确认删除",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".dialog-actions .danger-action")?.click());
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("clears typed bulk confirmation whenever the preview is replaced", async () => {
    const props = {
      mode: "selection" as const,
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh" as const,
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...props,
      preview: bulkPreview({ deletableCount: 10 }),
    })));
    await typeInto(container.querySelector(".delete-confirmation-field input"), "确认删除");

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...props,
      preview: bulkPreview({ deletableCount: 10, liveSessionCheckFailed: true }),
    })));
    expect(container.querySelector<HTMLInputElement>(".delete-confirmation-field input")?.value).toBe("");
  });
});
