import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../../../core/platform";
import { SettingsDialog } from "./settings-dialog";

const noop = () => undefined;

function renderShortcuts(): string {
  return renderToStaticMarkup(createElement(SettingsDialog, {
    platform: "darwin",
    initialSection: "shortcut",
    settings: null,
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
    onSettingsChange: noop,
    onCheckAppUpdate: noop,
    onInstallAppUpdate: noop,
    onSkipAppUpdate: noop,
    onThemeChange: noop,
    onLanguageChange: noop,
    onDefaultTerminalChange: noop,
    onGlobalShortcutChange: noop,
    sessionHookStatus: null,
    sessionHookBusy: false,
    onSessionHookChange: noop,
    onRefreshEnvironment: noop,
    onDiagnoseEnvironment: noop,
    onDeleteEnvironment: noop,
    onAddSsh: noop,
    onOpenApiConfig: noop,
    onOpenRemoteSessions: noop,
    onClose: noop,
  }));
}

function renderSessions(): string {
  return renderToStaticMarkup(createElement(SettingsDialog, {
    platform: "darwin",
    initialSection: "sources",
    settings: { ...defaultSettings, includePi: true },
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
    onSettingsChange: noop,
    onCheckAppUpdate: noop,
    onInstallAppUpdate: noop,
    onSkipAppUpdate: noop,
    onThemeChange: noop,
    onLanguageChange: noop,
    onDefaultTerminalChange: noop,
    onGlobalShortcutChange: noop,
    sessionHookStatus: null,
    sessionHookBusy: false,
    onSessionHookChange: noop,
    onRefreshEnvironment: noop,
    onDiagnoseEnvironment: noop,
    onDeleteEnvironment: noop,
    onAddSsh: noop,
    onOpenApiConfig: noop,
    onOpenRemoteSessions: noop,
    onClose: noop,
  }));
}

describe("SettingsDialog shortcut reference", () => {
  it("shows Command+F as the main search focus shortcut", () => {
    const html = renderShortcuts();
    const focusSearchRow = html.match(/<div class="shortcut-reference-row"><dt>聚焦搜索<\/dt><dd>.*?<\/dd><\/div>/)?.[0];

    expect(focusSearchRow).toContain("<kbd>⌘</kbd>");
    expect(focusSearchRow).toContain("<kbd>F</kbd>");
    expect(focusSearchRow).not.toContain("<kbd>K</kbd>");
  });
});

describe("SettingsDialog session sources", () => {
  it("shows the enabled Pi read-only indexing option", () => {
    const html = renderSessions();
    const piTitleIndex = html.indexOf("Include Pi");
    const piRow = html.slice(
      html.lastIndexOf('<label class="settings-field settings-toggle">', piTitleIndex),
      html.indexOf("</label>", piTitleIndex) + "</label>".length,
    );

    expect(piRow).toContain("Include Pi");
    expect(piRow).toContain("以只读方式索引本地 Pi 会话。");
    expect(piRow).toContain('checked=""');
  });
});
