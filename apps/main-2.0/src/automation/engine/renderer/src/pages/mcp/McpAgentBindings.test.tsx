import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { ConfiguredAgent, McpServerDefinition } from "../../../../shared/types";
import { McpAgentBindings } from "./McpAgentBindings";

const dshAgent: ConfiguredAgent = {
  id: "dsh-agent",
  name: "DSH Agent",
  description: "",
  runtimeAgentId: "dsh",
  channelId: "dsh-default",
  modelId: "default",
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

const server: McpServerDefinition = {
  id: "team-docs",
  name: "Team docs",
  transport: "stdio",
  command: "team-docs",
  args: [],
  env: {},
  enabled: true,
  tools: [{ name: "search", inputSchema: {}, readOnly: true }],
  status: "connected",
  createdAt: 1,
  updatedAt: 1,
};

describe("McpAgentBindings", () => {
  test("does not offer unbound custom MCP servers to DeepSeek Harness", () => {
    const html = renderToStaticMarkup(
      <McpAgentBindings
        agents={[dshAgent]}
        servers={[server]}
        onSaveAgents={vi.fn()}
      />,
    );

    expect(html).toContain("This Runtime does not support custom MCP");
    expect(html).not.toContain("Team docs");
    expect(html).not.toContain('aria-label="Bind Team docs"');
  });

  test("keeps a legacy binding visible so the user can remove it", () => {
    const html = renderToStaticMarkup(
      <McpAgentBindings
        agents={[{
          ...dshAgent,
          mcpBindings: [{ serverId: "team-docs", toolAllowlist: [] }],
        }]}
        servers={[server]}
        onSaveAgents={vi.fn()}
      />,
    );

    expect(html).toContain("Team docs");
    expect(html).toContain('aria-label="Bind Team docs"');
  });
});
