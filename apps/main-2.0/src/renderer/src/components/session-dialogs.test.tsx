// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult } from "../../../core/types";
import { BulkDeleteDialog, CommandDialog } from "./session-dialogs";

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
});
