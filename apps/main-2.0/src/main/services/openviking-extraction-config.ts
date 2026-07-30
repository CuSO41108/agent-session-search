import type { CodexConfigSnapshot } from "../../core/codex-profile";
import type {
  AppSettings,
  OpenVikingExtractionReasoningEffort,
} from "../../core/platform";

export interface ResolvedOpenVikingVlmConfig {
  provider: "openai-codex" | "openai";
  model: string;
  api_base?: string;
  api_key?: string;
  reasoning_effort: OpenVikingExtractionReasoningEffort;
}

export function resolveOpenVikingExtractionConfig(input: {
  settings: AppSettings;
  codex: Pick<CodexConfigSnapshot, "activeModel">;
}): ResolvedOpenVikingVlmConfig {
  const modelOverride = input.settings.openVikingExtractionModel.trim();
  const reasoningEffort = input.settings.openVikingExtractionReasoningEffort;

  if (input.settings.summarySource === "claude") {
    throw new Error("Claude CLI cannot be used for OpenViking memory extraction.");
  }

  if (input.settings.summarySource === "codex") {
    const model = modelOverride || input.codex.activeModel.trim();
    if (!model) {
      throw new Error("Choose a memory extraction model or configure a Codex model.");
    }
    return {
      provider: "openai-codex",
      model,
      api_base: "https://chatgpt.com/backend-api/codex",
      reasoning_effort: reasoningEffort,
    };
  }

  const config = input.settings.summaryApiConfig;
  if (config.customApiFormat !== "openai_chat") {
    throw new Error("OpenViking currently supports custom OpenAI Chat providers only.");
  }
  const model = modelOverride || config.customModel.trim();
  const apiBase = config.customBaseUrl.trim();
  const apiKey = config.customApiKey.trim();
  if (!apiBase || !apiKey || !model) {
    throw new Error("Complete the summary Provider URL, API key, and model before starting Memory.");
  }
  return {
    provider: "openai",
    model,
    api_base: apiBase,
    api_key: apiKey,
    reasoning_effort: reasoningEffort,
  };
}
