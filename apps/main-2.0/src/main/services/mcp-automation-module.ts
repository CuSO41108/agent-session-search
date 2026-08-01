import type { AppSnapshot, ConfiguredAgent, McpServerDefinition } from "../../automation/contracts";
import type { BuiltinSessionSearchServer } from "../../automation/engine/main/mcp-builtin-server";
import { discoverMcpTools } from "../../automation/engine/main/mcp-client";
import type { McpAgentManagementService } from "../../automation/engine/main/mcp/agent-management-service";
import type { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import type { McpInstallRequest } from "../../automation/engine/shared/mcp-config";
import type { McpToolDefinition } from "../../automation/engine/shared/mcp/types";

interface McpRuntimeState {
  listConfiguredAgents(): ConfiguredAgent[];
  setMcpServers(servers: McpServerDefinition[]): void;
  updateConfiguredAgents(agents: ConfiguredAgent[]): AppSnapshot;
}

interface McpAutomationModuleDependencies {
  registry: Pick<McpRegistryStore, "list" | "upsert" | "recordTest" | "delete">;
  agents: Pick<McpAgentManagementService, "status" | "listInstalled" | "listForAgent" | "install" | "uninstall">;
  runtime: McpRuntimeState;
  builtin?: BuiltinSessionSearchServer;
  discoverTools?: typeof discoverMcpTools;
}

export class McpAutomationModule {
  private readonly discoverTools: typeof discoverMcpTools;

  constructor(private readonly dependencies: McpAutomationModuleDependencies) {
    this.discoverTools = dependencies.discoverTools ?? discoverMcpTools;
  }

  list(): Promise<McpServerDefinition[]> {
    return this.listWithBuiltin();
  }

  private async listWithBuiltin(): Promise<McpServerDefinition[]> {
    const servers = await this.dependencies.registry.list();
    if (!this.dependencies.builtin) return servers;
    const builtin = await this.dependencies.builtin.resolve();
    return [builtin, ...servers.filter((server) => server.id !== builtin.id)];
  }

  async save(server: McpServerDefinition): Promise<McpServerDefinition> {
    const builtin = this.dependencies.builtin;
    if (builtin && builtin.isBuiltinId(server.id)) {
      const saved = await builtin.saveDraft(server);
      await this.publishRegistry();
      return saved;
    }
    const saved = await this.dependencies.registry.upsert(server);
    await this.publishRegistry();
    return saved;
  }

  async test(server: McpServerDefinition): Promise<McpServerDefinition> {
    const builtin = this.dependencies.builtin;
    const useBuiltin = Boolean(builtin && builtin.isBuiltinId(server.id));
    // Test against the fixed launch config for the built-in server, never
    // against client-supplied connection fields.
    const target = useBuiltin && builtin ? await builtin.resolve() : server;
    const record = useBuiltin && builtin
      ? (tools: McpToolDefinition[], error?: string) => builtin.recordTest(server, tools, error)
      : (tools: McpToolDefinition[], error?: string) => this.dependencies.registry.recordTest(target, tools, error);
    try {
      const tested = await record(await this.discoverTools(target));
      await this.publishRegistry();
      return tested;
    } catch (error) {
      const tested = await record([], error instanceof Error ? error.message : String(error));
      await this.publishRegistry();
      return tested;
    }
  }

  async delete(serverId: string): Promise<boolean> {
    const builtin = this.dependencies.builtin;
    if (builtin && builtin.isBuiltinId(serverId)) {
      throw new Error("The built-in session-search MCP server cannot be deleted. Turn it off in Settings instead.");
    }
    const deleted = await this.dependencies.registry.delete(serverId);
    if (!deleted) return false;

    await this.publishRegistry();
    const agents = this.dependencies.runtime.listConfiguredAgents().map((agent) => ({
      ...agent,
      ...(agent.mcpBindings
        ? {
            mcpBindings: agent.mcpBindings.filter(
              (binding) => binding.serverId !== serverId,
            ),
          }
        : {}),
    }));
    this.dependencies.runtime.updateConfiguredAgents(agents);
    return true;
  }

  setupStatus(): ReturnType<McpAgentManagementService["status"]> {
    return this.dependencies.agents.status();
  }

  listInstalled(): ReturnType<McpAgentManagementService["listInstalled"]> {
    return this.dependencies.agents.listInstalled();
  }

  listForAgent(agentId: string): ReturnType<McpAgentManagementService["listForAgent"]> {
    return this.dependencies.agents.listForAgent(agentId);
  }

  install(request: McpInstallRequest): ReturnType<McpAgentManagementService["install"]> {
    return this.dependencies.agents.install(request);
  }

  uninstall(request: McpInstallRequest): ReturnType<McpAgentManagementService["uninstall"]> {
    return this.dependencies.agents.uninstall(request);
  }

  private async publishRegistry(): Promise<void> {
    this.dependencies.runtime.setMcpServers(await this.listWithBuiltin());
  }
}
