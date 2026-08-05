// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, type AppSettingsUpdate } from "../../../../core/platform";
import { SettingsDialog } from "./settings-dialog";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setNativeValue?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

describe("SettingsDialog responsive setting persistence", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Reflect.set(window, "sessionSearch", {
      getMcpStatus: vi.fn(async () => false),
      getWorkflowMcpStatus: vi.fn(async () => false),
      onSummaryProgress: vi.fn(() => () => undefined),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderDialog(onSettingsChange: (settings: AppSettingsUpdate) => Promise<void>): Promise<void> {
    await act(async () => root.render(createElement(SettingsDialog, {
      platform: "darwin",
      initialSection: "remote",
      settings: {
        ...defaultSettings,
        remoteSyncEnabled: true,
        remoteSyncSupabaseUrl: "https://old.example.supabase.co",
      },
      runtimeChannels: [],
      appUpdateStatus: null,
      appUpdateProgress: null,
      appUpdateBusy: false,
      appUpdateError: null,
      environments: [],
      environmentHealthReports: {},
      diagnosingEnvironmentId: null,
      theme: "light",
      language: "zh",
      feedback: null,
      onSettingsChange,
      onCheckAppUpdate: () => undefined,
      onInstallAppUpdate: () => undefined,
      onSkipAppUpdate: () => undefined,
      onThemeChange: () => undefined,
      onLanguageChange: () => undefined,
      sessionHookStatus: null,
      sessionHookBusy: false,
      onSessionHookChange: () => undefined,
      onRefreshEnvironment: () => undefined,
      onDiagnoseEnvironment: () => undefined,
      onDeleteEnvironment: () => undefined,
      onAddSsh: () => undefined,
      onOpenApiConfig: () => undefined,
      onOpenRemoteSessions: () => undefined,
      onClose: () => undefined,
    })));
  }

  it("saves URL fields only on commit and keeps unrelated controls usable", async () => {
    const pendingSave = deferred();
    const onSettingsChange = vi.fn(() => pendingSave.promise);
    await renderDialog(onSettingsChange);

    const urlInput = container.querySelector('input[placeholder="https://your-project.supabase.co"]') as HTMLInputElement;
    const attachmentToggle = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest("label")?.textContent?.includes("同步会话附件"));

    await act(async () => {
      urlInput.focus();
      setInputValue(urlInput, "https://new.example.supabase.co");
    });
    expect(onSettingsChange).not.toHaveBeenCalled();

    await act(async () => urlInput.blur());
    expect(onSettingsChange).toHaveBeenCalledOnce();
    expect(onSettingsChange).toHaveBeenCalledWith({ remoteSyncSupabaseUrl: "https://new.example.supabase.co" });
    expect(urlInput.disabled).toBe(true);
    expect(attachmentToggle?.disabled).toBe(false);

    await act(async () => pendingSave.resolve());
    expect(urlInput.disabled).toBe(false);
  });

  it("cancels a text edit on Escape without persisting it", async () => {
    const onSettingsChange = vi.fn(async () => undefined);
    await renderDialog(onSettingsChange);

    const urlInput = container.querySelector('input[placeholder="https://your-project.supabase.co"]') as HTMLInputElement;
    await act(async () => {
      urlInput.focus();
      setInputValue(urlInput, "https://cancelled.example.supabase.co");
      urlInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(urlInput.value).toBe("https://old.example.supabase.co");
  });
});
