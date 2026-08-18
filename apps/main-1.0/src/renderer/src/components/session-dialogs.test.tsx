// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionBulkDeletePreview } from "../../../core/session-bulk-delete";
import type { SessionSearchResult } from "../../../core/types";
import { BulkDeleteDialog, CommandDialog, DeleteSessionDialog } from "./session-dialogs";

const session = {
  sessionKey: "codex:session-a",
  source: "codex-cli",
  sourceAvailable: true,
  displayTitle: "Session A",
  filePath: "/synthetic/session-a.jsonl",
} as SessionSearchResult;

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

  it("requires typed confirmation at 10 bulk deletions but not at 9", async () => {
    const onConfirm = vi.fn();
    const props = {
      mode: "selection" as const,
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh" as const,
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm,
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...props,
      preview: bulkPreview(9),
    })));

    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    const simpleConfirm = buttonByText(container, "确认");
    expect(simpleConfirm.disabled).toBe(false);
    await act(async () => simpleConfirm.click());
    expect(onConfirm).toHaveBeenLastCalledWith(false);

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...props,
      preview: bulkPreview(10),
    })));
    expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
    const deleteButton = buttonByText(container, "永久删除");
    expect(deleteButton.disabled).toBe(true);
    await enterConfirmationText(container, "确认删除");
    expect(deleteButton.disabled).toBe(false);
    await act(async () => deleteButton.click());
    expect(onConfirm).toHaveBeenLastCalledWith(true);
  });

  it.each([
    {
      label: "related sessions",
      preview: bulkPreview(2, { hasRelatedSessions: true }),
    },
    {
      label: "the currently open session",
      preview: bulkPreview(1, { includesOpenSession: true }),
    },
  ])("requires typed confirmation when bulk deletion includes $label", async ({ preview }) => {
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "selection",
      preview,
      dateValue: "",
      favoriteCount: 0,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
    expect(buttonByText(container, "永久删除").disabled).toBe(true);
  });

  it("warns about a favorite in a small bulk deletion without requiring typed text", async () => {
    await act(async () => root.render(createElement(BulkDeleteDialog, {
      mode: "selection",
      preview: bulkPreview(1),
      dateValue: "",
      favoriteCount: 1,
      busy: false,
      language: "zh",
      onDateChange: vi.fn(),
      onPreview: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("其中包含 1 个收藏会话");
    expect(container.querySelector(".delete-confirmation-field")).toBeNull();
    expect(buttonByText(container, "确认").disabled).toBe(false);
  });

  it("confirms an ordinary single-session deletion without typed text", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
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
    const confirmButton = buttonByText(container, "确认");
    expect(confirmButton.disabled).toBe(false);
    await act(async () => confirmButton.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("requires exact text for related sessions and clears it when the candidate changes", async () => {
    const props = {
      cascadeCount: 2,
      hasLiveSession: false,
      isOpen: false,
      blockedMessage: null,
      language: "zh" as const,
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    };
    await act(async () => root.render(createElement(DeleteSessionDialog, { ...props, session })));

    const confirmButton = buttonByText(container, "永久删除");
    expect(confirmButton.disabled).toBe(true);
    await enterConfirmationText(container, "确认删除");
    expect(confirmButton.disabled).toBe(false);

    await act(async () => root.render(createElement(DeleteSessionDialog, {
      ...props,
      session: { ...session, sessionKey: "codex:session-b" },
    })));
    expect((container.querySelector(".delete-confirmation-field input") as HTMLInputElement).value).toBe("");
    expect(buttonByText(container, "永久删除").disabled).toBe(true);
  });

  it("requires typed confirmation before force deleting a live session", async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
      cascadeCount: 1,
      hasLiveSession: true,
      isOpen: false,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm,
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("会话树中有会话正在运行");
    const confirmButton = buttonByText(container, "强制删除");
    expect(confirmButton.disabled).toBe(true);
    await enterConfirmationText(container, "确认删除");
    expect(confirmButton.disabled).toBe(false);
    await act(async () => confirmButton.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("requires typed confirmation when running state cannot be verified", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
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
    expect(buttonByText(container, "强制删除").disabled).toBe(true);
  });

  it("clears typed confirmation when the same candidate receives a refreshed risk preview", async () => {
    const props = {
      session,
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
    await enterConfirmationText(container, "确认删除");

    await act(async () => root.render(createElement(DeleteSessionDialog, { ...props, confirmationVersion: 2 })));
    expect((container.querySelector(".delete-confirmation-field input") as HTMLInputElement).value).toBe("");
  });

  it("requires typed confirmation for the session currently open in details", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
      cascadeCount: 1,
      hasLiveSession: false,
      isOpen: true,
      blockedMessage: null,
      language: "zh",
      deleting: false,
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    })));

    expect(container.textContent).toContain("当前正在 AgentRecall 中打开");
    expect(container.querySelector(".delete-confirmation-field")).not.toBeNull();
    expect(buttonByText(container, "永久删除").disabled).toBe(true);
  });

  it("keeps an unknown preview error blocked even without typed confirmation", async () => {
    await act(async () => root.render(createElement(DeleteSessionDialog, {
      session,
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
    expect(buttonByText(container, "确认").disabled).toBe(true);
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
      preview: bulkPreview(10),
    })));
    await enterConfirmationText(container, "确认删除");

    await act(async () => root.render(createElement(BulkDeleteDialog, {
      ...props,
      preview: bulkPreview(10, { liveSessionCheckFailed: true }),
    })));
    expect((container.querySelector(".delete-confirmation-field input") as HTMLInputElement).value).toBe("");
  });
});

async function enterConfirmationText(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector(".delete-confirmation-field input") as HTMLInputElement;
  await act(async () => {
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setNativeValue?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function bulkPreview(
  deletableCount: number,
  overrides: Partial<SessionBulkDeletePreview> = {},
): SessionBulkDeletePreview {
  return {
    requestedCount: deletableCount,
    matchedCount: deletableCount,
    expandedCount: deletableCount,
    deletableCount,
    hasRelatedSessions: false,
    includesOpenSession: false,
    liveSessionCheckFailed: false,
    confirmationFingerprint: "preview",
    sourceCounts: [{ source: "codex-cli", count: deletableCount }],
    skipped: [],
    ...overrides,
  };
}
