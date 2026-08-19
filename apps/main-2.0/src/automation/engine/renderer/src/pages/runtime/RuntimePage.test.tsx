import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AgentChannel } from "../../../../shared/types";
import { RuntimePage } from "./RuntimePage";

const dshChannel: AgentChannel = {
  id: "dsh-default",
  agentId: "dsh",
  label: "DeepSeek Harness",
  presetId: "dsh-default",
  models: [{ id: "default", label: "Default (DSH: deepseek-v4-flash)" }],
};

describe("RuntimePage DeepSeek Harness config", () => {
  test("renders the Runtime and explains its Default-only model contract", () => {
    const html = renderToStaticMarkup(
      <RuntimePage
        channels={[dshChannel]}
        selectedChannelId="dsh-default"
        selectedRuntimeId="dsh"
        providerKeys={{}}
        codexPluginCatalog={[]}
        pluginCatalogStatus=""
        agentTestResults={{}}
        testingAgentId={undefined}
        agentTestTick={0}
        onUpdateChannel={vi.fn()}
        onAddModel={vi.fn()}
        onUpdateModel={vi.fn()}
        onRemoveModel={vi.fn()}
        onSave={async () => undefined}
        onLoadCodexPluginCatalog={async () => undefined}
        onSelectChannel={vi.fn()}
        onSelectRuntime={vi.fn()}
        onAddConfig={vi.fn()}
        onImportLocalConfig={async () => undefined}
        onDeleteConfig={vi.fn()}
        onTestChannel={async () => undefined}
        onUpdateProviderKey={vi.fn()}
      />,
    );

    expect(html).toContain("DeepSeek Harness");
    expect(html).toContain("Select Default");
    expect(html).toContain("standard dsh headless command cannot override a model per run");
    expect(html).toContain("Default (DSH: deepseek-v4-flash)");
    expect(html).toContain("Managed by DSH");
    expect(html).toContain('aria-label="DSH runtime environment"');
    expect(html).not.toContain("Change provider");
    expect(html).not.toContain("Base URL");
    expect(html).not.toContain("Model Provider");
    expect(html).not.toContain('aria-label="Agent model id"');
    expect(html).not.toContain('aria-label="Agent model label"');
  });
});
