import type {
  McpServerDefinition,
  McpToolDefinition,
} from "../shared/mcp/types";

/**
 * Persisted runtime state for the built-in session-search MCP server. Stored in
 * app settings rather than the user MCP registry, so user-created servers and
 * the app-managed server stay fully isolated.
 */
export interface McpBuiltinRuntime {
  tools: McpToolDefinition[];
  disabledTools: string[];
  status: McpServerDefinition["status"];
  lastError?: string;
  lastTestedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Dependencies injected from the app shell. `launchConfig` is the fixed launch
 * command used both by `setup-mcp.cjs` (external CLI registration) and by this
 * module, keeping the two in lock-step.
 */
export interface BuiltinSessionSearchDeps {
  isEnabled(): boolean;
  setEnabled(next: boolean): Promise<boolean>;
  launchConfig(): {
    id: string;
    name: string;
    command: string;
    args: string[];
  };
  readRuntime(): McpBuiltinRuntime | undefined;
  writeRuntime(runtime: McpBuiltinRuntime): void;
}

function emptyRuntime(): McpBuiltinRuntime {
  const now = Date.now();
  return { tools: [], disabledTools: [], status: "untested", createdAt: now, updatedAt: now };
}

/**
 * Synthesizes the app-managed AgentRecall session-search MCP server. It is
 * never written to the user `mcp_servers` table; connection fields are fixed
 * and only the enable state and per-tool toggles are editable, mirrored into
 * app settings so the Settings dialog and the MCP page share one source of
 * truth.
 */
export class BuiltinSessionSearchServer {
  constructor(private readonly deps: BuiltinSessionSearchDeps) {}

  isBuiltinId(id: string): boolean {
    return id === this.deps.launchConfig().id;
  }

  async resolve(): Promise<McpServerDefinition> {
    const config = this.deps.launchConfig();
    const runtime = this.deps.readRuntime();
    return {
      id: config.id,
      name: config.name,
      transport: "stdio",
      command: config.command,
      args: config.args,
      env: {},
      enabled: this.deps.isEnabled(),
      tools: runtime?.tools ?? [],
      disabledTools: runtime?.disabledTools ?? [],
      status: runtime?.status ?? "untested",
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime?.lastTestedAt ? { lastTestedAt: runtime.lastTestedAt } : {}),
      createdAt: runtime?.createdAt ?? Date.now(),
      updatedAt: runtime?.updatedAt ?? Date.now(),
      managed: true,
    };
  }

  /**
   * Applies the editable subset of a draft for the managed server: enable
   * state (routed to the settings/setup-mcp toggle) and tool catalog. Any
   * connection fields sent by the client are ignored and re-derived.
   */
  async saveDraft(server: McpServerDefinition): Promise<McpServerDefinition> {
    const current = this.deps.isEnabled();
    if (server.enabled !== current) {
      await this.deps.setEnabled(server.enabled);
    }
    const runtime = this.deps.readRuntime() ?? emptyRuntime();
    this.deps.writeRuntime({
      ...runtime,
      tools: server.tools,
      disabledTools: server.disabledTools ?? [],
      updatedAt: Date.now(),
    });
    return this.resolve();
  }

  /**
   * Records a connection-test outcome for the managed server into the runtime
   * cache. Returns the re-resolved entry with the new tool catalog.
   */
  async recordTest(
    server: McpServerDefinition,
    tools: McpToolDefinition[],
    error?: string,
  ): Promise<McpServerDefinition> {
    const runtime = this.deps.readRuntime() ?? emptyRuntime();
    const next: McpBuiltinRuntime = {
      ...runtime,
      tools,
      disabledTools: server.disabledTools ?? runtime.disabledTools,
      status: error ? "error" : "connected",
      lastTestedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (error) next.lastError = error;
    else delete next.lastError;
    this.deps.writeRuntime(next);
    return this.resolve();
  }
}
