import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServerDefinition } from "../../../../shared/mcp/types";

const model = vi.hoisted(() => ({
  servers: [] as McpServerDefinition[],
  draft: undefined as McpServerDefinition | undefined,
  dirty: false,
  busy: undefined,
  error: undefined,
  create: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  toggleTool: vi.fn(),
  save: vi.fn(),
  toggleEnabled: vi.fn(),
  toggleServerEnabled: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  importServers: vi.fn(),
  setDirty: vi.fn(),
}));

vi.mock("./useMcpRegistry", () => ({ useMcpRegistry: () => model }));

import { McpPage } from "./McpPage";

function server(overrides: Partial<McpServerDefinition>): McpServerDefinition {
  return {
    id: "custom",
    name: "Custom server",
    transport: "stdio",
    args: [],
    env: {},
    enabled: true,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("McpPage", () => {
  it("separates the three project MCPs from user-configured servers without exposing internal ids", () => {
    const sessionSearch = server({
      id: "agent-recall-session-search",
      name: "AgentRecall Session Search",
      managed: true,
      tools: [{ name: "search_sessions", inputSchema: {} }],
    });
    model.servers = [
      sessionSearch,
      server({ id: "agent-recall-skills", name: "AgentRecall Skills", managed: true }),
      server({ id: "agent-recall-workflow", name: "AgentRecall Workflow", managed: true }),
      server({ id: "team-docs", name: "Team docs" }),
    ];
    model.draft = sessionSearch;

    const html = renderToStaticMarkup(<McpPage language="zh" agents={[]} />);

    expect(html).toContain("项目内置");
    expect(html).toContain("自定义");
    expect(html).toContain("AgentRecall 会话检索");
    expect(html).toContain("AgentRecall Skill 库");
    expect(html).toContain("AgentRecall Workflow");
    expect(html).toContain("检索已索引的 Agent 会话、查看上下文，并准备可恢复的迁移");
    expect(html).not.toContain("STDIO · agent-recall-session-search");
  });

  it("renders an enable switch on every server row, custom and built-in", () => {
    model.servers = [
      server({ id: "agent-recall-workflow", name: "AgentRecall Workflow", managed: true }),
      server({ id: "team-docs", name: "Team docs" }),
    ];
    model.draft = model.servers[1];

    const html = renderToStaticMarkup(<McpPage language="zh" agents={[]} />);

    expect(html).toContain("mcp-server-row");
    expect(html).toContain("mcp-server-row-switch");
    // one switch per row (built-in + custom), plus the reused binding-switch style
    expect(html).toContain('aria-label="启用 Team docs"');
    expect(html).toContain('aria-label="启用 AgentRecall Workflow"');
  });

  it("marks a disabled server row and reflects the switch as unchecked", () => {
    const teamDocs = server({ id: "team-docs", name: "Team docs", enabled: false });
    model.servers = [teamDocs];
    model.draft = teamDocs;

    const html = renderToStaticMarkup(<McpPage language="zh" agents={[]} />);

    expect(html).toContain("mcp-server-row is-disabled");
    // an unchecked checkbox must not carry the checked attribute
    expect(html).not.toContain('aria-label="启用 Team docs" checked');
  });

  it("keeps the managed power button in the detail toolbar", () => {
    const workflow = server({
      id: "agent-recall-workflow",
      name: "AgentRecall Workflow",
      managed: true,
    });
    model.servers = [workflow];
    model.draft = workflow;

    const html = renderToStaticMarkup(<McpPage language="zh" agents={[]} />);

    // managed servers still expose the original Power enable/disable button
    expect(html).toContain("禁用");
  });
});
