import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeApiProviderPreset,
  findClaudeApiProviderPresetByBaseUrl,
  normalizeClaudeApiConfig,
  type ClaudeApiConfig,
} from "./api-config";

export interface ApplyClaudeProfileResult {
  profile: string;
  claudeHome: string;
  settingsPath: string;
  backupPaths: string[];
}

const CLAUDE_ROUTE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "API_TIMEOUT_MS",
] as const;

export async function loadClaudeApiConfigDefaults(claudeHome = path.join(os.homedir(), ".claude")): Promise<Partial<ClaudeApiConfig>> {
  const settings = parseJsonObject(await readOptionalFile(path.join(claudeHome, "settings.json")));
  if (!settings) return {};

  const env = isPlainObject(settings.env) ? settings.env : {};
  const baseUrl = readString(env.ANTHROPIC_BASE_URL);
  const token = readString(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = readString(env.ANTHROPIC_API_KEY);
  const routeModel = readString(env.ANTHROPIC_MODEL);
  const model = routeModel || readString(settings.model);
  const hasRouteEnv = Boolean(baseUrl || token || apiKey || routeModel);
  if (!hasRouteEnv) return { activeProvider: "official" };

  const preset = baseUrl ? findClaudeApiProviderPresetByBaseUrl(baseUrl) : null;
  return normalizeClaudeApiConfig({
    activeProvider: "custom",
    customProviderId: preset?.id ?? "custom",
    customProviderName: preset?.providerName ?? providerNameFromBaseUrl(baseUrl),
    customBaseUrl: baseUrl,
    customApiKey: token || apiKey,
    customModel: model,
    customHaikuModel: readString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    customSonnetModel: readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    customOpusModel: readString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    customApiFormat: preset?.apiFormat ?? "anthropic",
    customApiKeyField: apiKey && !token ? "ANTHROPIC_API_KEY" : (preset?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN"),
  });
}

export async function applyClaudeApiConfig(options: {
  claudeHome?: string;
  apiConfig: Partial<ClaudeApiConfig>;
  now?: Date;
}): Promise<ApplyClaudeProfileResult> {
  const apiConfig = claudeApiConfigWithPresetDefaults(options.apiConfig);
  const claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeHome, "settings.json");
  const backupDir = path.join(claudeHome, "backups");
  const profile = apiConfig.activeProvider === "custom" ? claudeProviderId(apiConfig) : "claude-official";
  const stamp = backupStamp(options.now ?? new Date());

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTarget(settingsPath, path.join(backupDir, `settings.json.before-${profile}-${stamp}`));
  const settings = await loadMutableSettings(settingsPath);

  if (apiConfig.activeProvider === "custom") {
    applyCustomClaudeEnv(settings, apiConfig);
  } else {
    clearClaudeRouteEnv(settings);
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(settingsPath, 0o600);

  return {
    profile,
    claudeHome,
    settingsPath,
    backupPaths,
  };
}

function claudeApiConfigWithPresetDefaults(config: Partial<ClaudeApiConfig>): ClaudeApiConfig {
  const normalized = normalizeClaudeApiConfig(config);
  const preset = claudeApiProviderPreset(normalized.customProviderId);
  const model = config.customModel?.trim() || preset.model;
  return normalizeClaudeApiConfig({
    ...normalized,
    customProviderId: preset.id,
    customProviderName: config.customProviderName?.trim() || preset.providerName,
    customBaseUrl: config.customBaseUrl?.trim() || preset.baseUrl,
    customModel: model,
    customHaikuModel: config.customHaikuModel?.trim() || preset.haikuModel || model,
    customSonnetModel: config.customSonnetModel?.trim() || preset.sonnetModel || model,
    customOpusModel: config.customOpusModel?.trim() || preset.opusModel || model,
    customApiFormat: config.customApiFormat ?? preset.apiFormat,
    customApiKeyField: config.customApiKeyField ?? preset.apiKeyField,
  });
}

function applyCustomClaudeEnv(settings: Record<string, unknown>, apiConfig: ClaudeApiConfig): void {
  if (!apiConfig.customApiKey) throw new Error(`API key is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customModel) throw new Error(`Model is required to apply ${apiConfig.customProviderName}.`);

  const env = ensureEnv(settings);
  clearClaudeRouteEnv(settings);
  env.ANTHROPIC_BASE_URL = apiConfig.customBaseUrl;
  env[apiConfig.customApiKeyField] = apiConfig.customApiKey;
  env.ANTHROPIC_MODEL = apiConfig.customModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = apiConfig.customHaikuModel || apiConfig.customModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = apiConfig.customSonnetModel || apiConfig.customModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = apiConfig.customOpusModel || apiConfig.customModel;

  const preset = claudeApiProviderPreset(apiConfig.customProviderId);
  for (const [key, value] of Object.entries(preset.extraEnv ?? {})) {
    env[key] = value;
  }
}

function clearClaudeRouteEnv(settings: Record<string, unknown>): void {
  if (!isPlainObject(settings.env)) return;
  for (const key of CLAUDE_ROUTE_ENV_KEYS) {
    delete settings.env[key];
  }
}

function ensureEnv(settings: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(settings.env)) settings.env = {};
  return settings.env as Record<string, unknown>;
}

async function loadMutableSettings(settingsPath: string): Promise<Record<string, unknown>> {
  const text = await readOptionalFile(settingsPath);
  if (!text) return {};
  const parsed = parseJsonObject(text);
  if (!parsed) throw new Error(`Claude settings must be a JSON object: ${settingsPath}`);
  return parsed;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath, constants.R_OK);
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function backupExistingTarget(target: string, backup: string): Promise<string[]> {
  try {
    await stat(target);
  } catch {
    return [];
  }
  await copyFile(target, backup);
  return [backup];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerNameFromBaseUrl(baseUrl: string): string {
  if (!baseUrl) return "Custom Claude";
  try {
    return new URL(baseUrl).host || "Custom Claude";
  } catch {
    return baseUrl;
  }
}

function claudeProviderId(apiConfig: ClaudeApiConfig): string {
  if (apiConfig.customProviderId !== "custom") return apiConfig.customProviderId;
  const normalized = apiConfig.customProviderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "custom";
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
