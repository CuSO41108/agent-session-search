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

  it("configures memory extraction through the summary Provider", () => {
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

    expect(html).toContain("记忆提取");
    expect(html).toContain("摘要 Provider");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain('value="medium"');
    expect(html).toContain('value="xhigh"');
    expect(html).toContain('value="max"');
    expect(html).toContain('value="ultra"');
    expect(html).not.toContain("跟随");
  });

  it("recognizes Codex model ids without requiring exact casing", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: {
        ...defaultSettings,
        summarySource: "codex",
        openVikingExtractionModel: "GPT-5.6-Sol",
        openVikingExtractionReasoningEffort: "medium",
      },
      saving: false,
      onSettingsChange: () => undefined,
    }));

    expect(html).toContain('value="xhigh"');
    expect(html).toContain('value="max"');
    expect(html).toContain('value="ultra"');
  });

  it("explains when the summary Provider cannot extract memories", () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: { ...defaultSettings, summarySource: "claude" },
      saving: false,
      onSettingsChange: () => undefined,
    }));

    expect(html).toContain("Claude CLI");
    expect(html).toContain("暂不支持");
  });

  it("shows the exact missing custom Provider field in a compact extraction layout", async () => {
    const html = renderToStaticMarkup(createElement(OpenVikingMemorySettings, {
      language: "zh",
      settings: {
        ...defaultSettings,
        summarySource: "custom",
        summaryApiConfig: {
          ...defaultSettings.summaryApiConfig,
          customProviderName: "CodexZH",
          customApiFormat: "openai_chat",
          customBaseUrl: "https://api.codexzh.com/v1",
          customApiKey: "",
          customModel: "gpt-5.5",
        },
      },
      saving: false,
      onSettingsChange: () => undefined,
    }));
    const css = await readFile(
      path.join(process.cwd(), "src/renderer/src/styles/openviking-memory.css"),
      "utf8",
    );

    expect(html).toContain("CodexZH");
    expect(html).toContain("缺少 API Key");
    expect(html).not.toContain("地址、API Key 和模型");
    expect(html).toContain('value="gpt-5.5" selected=""');
    expect(html).toContain('value="gpt-5.6-sol"');
    expect(html).not.toContain("跟随");
    expect(html).toContain("openviking-extraction-fields");
    expect(css).toMatch(/\.openviking-extraction-fields\s*\{[^}]*grid-template-columns:/su);
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
