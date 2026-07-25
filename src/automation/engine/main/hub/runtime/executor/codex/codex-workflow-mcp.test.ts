import { describe, expect, test } from "vitest";
import { codexWorkflowMcpArgs } from "./codex-workflow-mcp";

describe("codexWorkflowMcpArgs", () => {
  test("injects a workflow-scoped MCP server for planning", () => {
    const args = codexWorkflowMcpArgs("C:/app/mcp-bridge.json", "wf-1");
    expect(args.join("\n")).toContain("mcp_servers.agent_recall.command");
    expect(args.join("\n")).toContain("AGENT_RECALL_WORKFLOW_MCP_BRIDGE");
    expect(args.join("\n")).toContain("wf-1");
  });

  test("does not inject workflow tools without a planning id", () => {
    expect(codexWorkflowMcpArgs("C:/app/mcp-bridge.json", undefined)).toEqual([]);
  });

  test("injects Workflow and Studio through one AgentRecall MCP server", () => {
    const args = codexWorkflowMcpArgs(
      "C:/app/mcp-bridge.json",
      "wf-1",
      undefined,
      undefined,
      "studio-scope",
    );
    const text = args.join("\n");

    expect(text.match(/mcp_servers\.agent_recall\.command/g)).toHaveLength(1);
    expect(text).toContain("AGENT_RECALL_WORKFLOW_ID");
    expect(text).toContain("AGENT_RECALL_STUDIO_TOKEN");
  });
});
