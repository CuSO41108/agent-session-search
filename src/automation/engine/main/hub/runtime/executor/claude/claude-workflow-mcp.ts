import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import { agentRecallMcpLaunchConfig } from "../workflow/workflow-mcp-launch";

export function claudeWorkflowMcpServers(
  discoveryPath: string | undefined,
  workflowId: string | undefined,
  runId?: string,
  nodeId?: string,
  studioToken?: string,
): ClaudeAgentSdkRunInput["mcpServers"] | undefined {
  const config = agentRecallMcpLaunchConfig(discoveryPath, {
    ...(workflowId ? { workflowId } : {}),
    ...(runId ? { runId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(studioToken ? { studioToken } : {}),
  });
  if (!config) return undefined;
  return { agent_recall: { type: "stdio", ...config } };
}
