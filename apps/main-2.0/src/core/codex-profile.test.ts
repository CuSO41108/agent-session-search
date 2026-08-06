import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadActiveCodexSummaryEndpointDefaults } from "./codex-profile";

describe("loadActiveCodexSummaryEndpointDefaults", () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(tmpdir(), "codex-profile-test-"));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  it("returns null for the official provider without any credentials", () => {
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
    writeFileSync(path.join(codexHome, "auth.json"), "{}");
    return expect(loadActiveCodexSummaryEndpointDefaults(codexHome)).resolves.toBeNull();
  });

  it("falls back to OPENAI_API_KEY for the official provider", async () => {
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
    writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-test-official" }),
    );
    await expect(loadActiveCodexSummaryEndpointDefaults(codexHome)).resolves.toEqual({
      baseUrl: "",
      model: "gpt-5.5",
      apiKey: "sk-test-official",
      apiFormat: "openai_responses",
    });
  });

  it("falls back to OPENAI_API_KEY when no model_provider is set", async () => {
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    await expect(loadActiveCodexSummaryEndpointDefaults(codexHome)).resolves.toEqual({
      baseUrl: "",
      model: "",
      apiKey: "sk-test",
      apiFormat: "openai_responses",
    });
  });

  it("keeps custom provider endpoint resolution unchanged", async () => {
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "provider-model"',
        'model_provider = "dms"',
        "",
        "[model_providers.dms]",
        'base_url = "http://127.0.0.1:45678/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-dms" }));
    await expect(loadActiveCodexSummaryEndpointDefaults(codexHome)).resolves.toEqual({
      baseUrl: "http://127.0.0.1:45678/v1",
      model: "provider-model",
      apiKey: "sk-dms",
      apiFormat: "openai_responses",
    });
  });
});
