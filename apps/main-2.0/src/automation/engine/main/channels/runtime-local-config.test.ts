import { describe, expect, test, vi } from "vitest";
import { loadRuntimeLocalConfig } from "./runtime-local-config";

describe("runtime local config import", () => {
  test("imports a Codex API key as plaintext channel configuration", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "codex",
      executable: "codex",
      dependencies: {
        homeDir: "/home/demo",
        loadCodexConfig: async () => ({
          modelProvider: "custom",
          providerName: "Custom",
          baseUrl: "https://provider.example/v1",
          wireApi: "responses",
          httpHeaders: { "x-tenant": "demo" },
          apiKey: "plain-codex-token",
          modelId: "gpt-local",
          modelCatalogJson: null,
          modelReasoningEffort: null,
          plugins: null,
        }),
      },
    });

    expect(result.channel).toMatchObject({
      id: "codex-openai",
      models: [{ id: "default" }, { id: "gpt-local" }],
      httpHeaders: { "x-tenant": "demo", Authorization: "Bearer plain-codex-token" },
    });
  });

  test("imports Claude environment tokens without redaction", async () => {
    const result = await loadRuntimeLocalConfig({
      runtimeId: "claude",
      executable: "claude",
      dependencies: {
        homeDir: "/home/demo",
        readTextFile: vi.fn(async () => JSON.stringify({
          env: {
            ANTHROPIC_MODEL: "claude-local",
            ANTHROPIC_AUTH_TOKEN: "plain-claude-token",
          },
        })) as never,
      },
    });

    expect(result.channel.models).toEqual([{ id: "default", label: "Default" }, { id: "claude-local", label: "claude-local" }]);
    expect(result.channel.environment?.ANTHROPIC_AUTH_TOKEN).toBe("plain-claude-token");
  });

  test("rejects local import for the virtual API runtime", async () => {
    await expect(loadRuntimeLocalConfig({ runtimeId: "api", executable: "api" })).rejects.toThrow(
      "API does not have a local CLI config to import",
    );
  });
});
