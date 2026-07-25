import { agentRecallMcpLaunchConfig } from "../workflow/workflow-mcp-launch";

export function codexWorkflowMcpArgs(
  discoveryPath: string | undefined,
  workflowId: string | undefined,
  runId?: string,
  nodeId?: string,
  studioToken?: string,
): string[] {
  const config = agentRecallMcpLaunchConfig(discoveryPath, {
    ...(workflowId ? { workflowId } : {}),
    ...(runId ? { runId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(studioToken ? { studioToken } : {}),
  });
  if (!config) return [];
  return [
    "-c", `mcp_servers.agent_recall.command=${JSON.stringify(config.command)}`,
    "-c", `mcp_servers.agent_recall.args=[${config.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ...Object.entries(config.env).flatMap(([name, value]) => [
      "-c",
      `mcp_servers.agent_recall.env.${name}=${JSON.stringify(value)}`,
    ]),
  ];
}
