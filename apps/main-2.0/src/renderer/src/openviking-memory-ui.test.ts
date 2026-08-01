import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../core/platform";
import { OpenVikingMemoryPage } from "./features/openviking-memory/openviking-memory-page";
import { OpenVikingMemorySettings } from "./features/settings/openviking-memory-settings";

describe("OpenViking directory memory UI", () => {
  it("shows an opt-in empty state instead of the old rules-file editor", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemoryPage, {
      language: "zh",
      enabled: false,
      onOpenSettings: () => undefined,
    }));

    expect(html).toContain("目录记忆默认关闭");
    expect(html).toContain("前往设置");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("AGENTS.md");
    expect(html).not.toContain("CLAUDE.md");
    expect(html).not.toContain("Cursor Rules");
  });

  it("offers one local model and the three supported lifecycle integrations", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: defaultSettings,
      saving: false,
      onSettingsChange: () => undefined,
    }));

    expect(html).toContain("目录记忆");
    expect(html).toContain("BAAI/bge-small-zh-v1.5");
    expect(html).toContain("47.9 MB");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("OpenCode");
  });

  it("keeps AI Provider, model, and reasoning settings out of Memory", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: {
        ...defaultSettings,
        summarySource: "codex",
        openVikingExtractionModel: "gpt-5.6-sol",
        openVikingExtractionReasoningEffort: "medium",
      },
      saving: false,
      onSettingsChange: () => undefined,
    }));

    expect(html).not.toContain("记忆提取");
    expect(html).not.toContain("摘要 Provider");
    expect(html).not.toContain("提取模型");
    expect(html).not.toContain("推理强度");
  });

  it("renders live runtime download stages, byte counts and a progress bar", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/settings/openviking-memory-settings.tsx"),
      "utf8",
    );

    expect(source).toContain("openviking-runtime-progress");
    expect(source).toContain("downloadedBytes");
    expect(source).toContain("totalBytes");
    expect(source).toContain("bytesPerSecond");
    expect(source).toContain("Generated");
    expect(source).toContain("已生成");
    expect(source).toContain("installedBytes");
    expect(source).toContain("runtimeInstalledSize");
    expect(source).toContain("${runtimeInstalledSize} / ${runtimeInstalledSize} MB");
    expect(source).not.toContain("Managed runtime");
    expect(source).not.toContain("托管运行时");
    expect(source).not.toContain("system Python");
    expect(source).not.toContain("系统 Python");
    expect(source).toContain("服务运行中");
    expect(source).toContain("服务已停止");
    expect(source).toContain("/s");
    expect(source).toContain("window.setInterval");
    expect(source).toContain('&& action !== "start"');
  });

  it("wires directory management, import control and memory CRUD through the new preload API", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    for (const operation of [
      "chooseOpenVikingDirectory",
      "addOpenVikingWorkspace",
      "pauseOpenVikingImport",
      "resumeOpenVikingImport",
      "searchOpenVikingMemories",
      "saveOpenVikingMemory",
      "deleteOpenVikingMemory",
      "stopManagingOpenVikingWorkspace",
      "deleteOpenVikingWorkspace",
    ]) {
      expect(source).toContain(operation);
    }
    expect(source).toContain('action === "import"');
    expect(source).toContain("正在导入并提取记忆");
    expect(source).toContain("已导入 ${workspace.importedTurns} / ${workspace.totalTurns}");
    expect(source).toContain("正在扫描可导入的会话");
    expect(source).toContain("正在传送会话内容");
    expect(source).toContain("正在提取当前会话的记忆");
    expect(source).toContain("workspace.importActivity.sessionTitle");
  });

  it("keeps the picker available but disables sessions already being imported", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );
    const workspaceHeader = source.slice(
      source.indexOf('className="openviking-workspace-head"'),
      source.indexOf('className={`openviking-import-status'),
    );

    expect(workspaceHeader).toMatch(
      /workspace\.managed\s*\?\s*\([\s\S]*?openImportPicker\(workspace\)/u,
    );
    expect(source).toContain('disabled={!isImportSessionSelectable(session)}');
    expect(source).toContain('return session.state === "new" || session.state === "changed";');
    expect(source).toContain('localize(language, "Importing", "导入中")');
  });

  it("keeps refresh and directory management independent from unrelated memory actions", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(source).toContain('run("refresh"');
    expect(source).toContain('disabled={action === "refresh"}');
    expect(source).toContain('className={action === "refresh" ? "spin" : ""}');
    expect(source).toContain('disabled={!ready || action === "choose" || action === "add"}');
    expect(source).not.toContain('disabled={action !== null || !ready}');
    expect(css).toMatch(/\.openviking-page-actions\s*\{[^}]*-webkit-app-region:\s*no-drag;/su);
  });

  it("allows identity and soul memories to be edited in place", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain('candidate === "identity.md" || candidate === "soul.md"');
    expect(source).toContain("uri: editableMemoryUri");
    expect(source).toContain('l("Identity memory", "身份记忆")');
  });

  it("loads existing memories without requiring a search query", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain('searchOpenVikingMemories(workspace.id, "", 200)');
    expect(source).toContain("browseLoading");
    expect(source).toContain("正在加载已有记忆");
    expect(source).toContain("还没有生成记忆");
  });

  it("does not request memories while OpenViking is stopping or stopped", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain('snapshot?.runtime.state !== "running"');
    expect(source).toContain('action === "import"');
    expect(source).toMatch(
      /\[action,\s*enabled,\s*query,\s*snapshot\?\.runtime\.state,\s*workspace\?\.id,\s*workspace\?\.importState\]/su,
    );
  });

  it("does not keep the page locked while a background import is running", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );
    const beginSelectedImportStart = source.indexOf("const beginSelectedImport = () =>");
    const beginSelectedImport = source.slice(
      beginSelectedImportStart,
      source.indexOf("const startImport =", beginSelectedImportStart),
    );

    expect(beginSelectedImport).toContain("importOpenVikingWorkspace(target.id, selectedKeys)");
    expect(beginSelectedImport).not.toContain('setAction("import")');
    expect(beginSelectedImport).not.toContain("setAction(null)");
  });

  it("silently invalidates an automatic memory request before pausing", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain("const browseRequestVersion = useRef(0)");
    expect(source).toMatch(
      /const startImport[\s\S]*?browseRequestVersion\.current \+= 1;[\s\S]*?pauseOpenVikingImport/u,
    );
    expect(source).toContain(
      "if (current && browseRequestVersion.current === requestVersion) setError(errorMessage(cause));",
    );
    expect(source).toContain(
      'disabled={!query.trim() || action !== null || snapshot.runtime.state !== "running"}',
    );
  });

  it("refreshes stale workspace state even when permanent deletion reports an error", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );
    const deleteWorkspaceStart = source.indexOf("const deleteWorkspace = () =>");
    const deleteWorkspace = source.slice(
      deleteWorkspaceStart,
      source.indexOf("if (!enabled)", deleteWorkspaceStart),
    );

    expect(deleteWorkspace).toMatch(
      /browseRequestVersion\.current \+= 1;[\s\S]*?try \{[\s\S]*?deleteOpenVikingWorkspace[\s\S]*?\} finally \{[\s\S]*?await refresh\(\);/u,
    );
  });

  it("treats a paused runtime as a read-only cached memory view", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );

    expect(source).toContain('const runtimeRunning = snapshot?.runtime.state === "running"');
    expect(source).toContain("if (!isOpenVikingPausedError(cause)) setError(errorMessage(cause));");
    expect(source).toContain("function isOpenVikingPausedError(error: unknown): boolean");
    expect(source).toContain("disabled={!runtimeRunning");
    expect(source).toContain("readOnly={!runtimeRunning}");
  });

  it("bounds the memory browser to the page so long result lists can scroll", async () => {
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(css).toMatch(/\.openviking-memory-page\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/su);
    expect(css).toMatch(/\.openviking-memory-layout\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/su);
    expect(css).toMatch(/\.openviking-memory-browser\s*\{[^}]*grid-template-rows:[^;]*minmax\(0,\s*1fr\);[^}]*min-height:\s*0;/su);
    expect(css).toMatch(/\.openviking-memory-content\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/su);
    expect(css).toMatch(/\.openviking-result-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su);
  });

  it("keeps memory detail actions horizontal when the panel is narrow", async () => {
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(css).toMatch(/\.openviking-memory-detail > footer > div\s*\{[^}]*flex:\s*0 0 auto;/su);
    expect(css).toMatch(/\.openviking-memory-detail > footer > div > button\s*\{[^}]*white-space:\s*nowrap;/su);
  });

  it("keeps memory detail actions inside the panel when its height is limited", async () => {
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(css).toMatch(/\.openviking-memory-detail\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto;[^}]*overflow:\s*hidden;/su);
    expect(css).toMatch(/\.openviking-memory-detail > textarea\s*\{[^}]*min-height:\s*0;/su);
  });

  it("renders accessible collapsible memory category groups", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/features/openviking-memory/openviking-memory-page.tsx"),
      "utf8",
    );
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(source).toContain("groupOpenVikingMemories");
    expect(source).toContain("collapsedCategories");
    expect(source).toContain('aria-expanded={!isCollapsed}');
    expect(source).toContain('className="openviking-result-group-head"');
    expect(source).toContain("group.memories.length");
    expect(source).toContain('aria-hidden="true"');
    expect(css).toContain(".openviking-result-group-head");
    expect(css).toContain(".openviking-result-group-body");
  });
});
