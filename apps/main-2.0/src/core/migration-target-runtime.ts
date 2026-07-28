import { readFile } from "node:fs/promises";
import path from "node:path";
import { migrationTargetDescriptor } from "./migration-targets";
import type { MigrationTarget } from "./types";

export interface MigrationTargetRuntimeMetadata {
  codexModelProvider?: string;
  claudeModel?: string;
}

export async function loadMigrationTargetRuntimeMetadata(
  target: MigrationTarget,
  targetHome: string,
): Promise<MigrationTargetRuntimeMetadata> {
  const family = migrationTargetDescriptor(target).family;
  if (family === "claude") {
    const settings = parseJsonObject(await readOptionalFile(path.join(targetHome, "settings.json")));
    const env = isRecord(settings?.env) ? settings.env : null;
    return {
      claudeModel: readString(env?.ANTHROPIC_MODEL) || readString(settings?.model) || "session-migration",
    };
  }
  if (family !== "codex") return {};

  const config = await readOptionalFile(path.join(targetHome, "config.toml"));
  const activeProfile = readRootTomlString(config, "profile");
  const profileModelProvider = activeProfile
    ? readProfileTomlString(config, activeProfile, "model_provider")
    : null;
  return {
    codexModelProvider: profileModelProvider
      ?? readRootTomlString(config, "model_provider")
      ?? defaultCodexModelProvider(target),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function defaultCodexModelProvider(target: MigrationTarget): string {
  return target === "tcodex" ? "tencent" : "openai";
}

function readRootTomlString(text: string, key: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    if (!trimmed || trimmed.startsWith("#")) continue;

    const value = readTomlAssignment(trimmed, key);
    if (value !== undefined) return value;
  }
  return null;
}

function readProfileTomlString(text: string, profile: string, key: string): string | null {
  let inSelectedProfile = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      if (inSelectedProfile) break;
      inSelectedProfile = tomlProfileName(trimmed) === profile;
      continue;
    }
    if (!inSelectedProfile || !trimmed || trimmed.startsWith("#")) continue;

    const value = readTomlAssignment(trimmed, key);
    if (value !== undefined) return value;
  }
  return null;
}

function readTomlAssignment(line: string, key: string): string | null | undefined {
  const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
  if (assignment?.[1] !== key) return undefined;
  return parseQuotedTomlString(assignment[2]);
}

function tomlProfileName(sectionHeader: string): string | null {
  const bare = sectionHeader.match(/^\[profiles\.([A-Za-z0-9_-]+)\]$/)?.[1];
  if (bare) return bare;

  const quoted = sectionHeader.match(/^\[profiles\.("(?:\\.|[^"\\])*")\]$/)?.[1];
  if (!quoted) return null;
  try {
    const parsed = JSON.parse(quoted) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseQuotedTomlString(rawValue: string): string | null {
  const doubleQuoted = rawValue.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
  if (doubleQuoted) {
    try {
      const parsed = JSON.parse(doubleQuoted[1]) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return null;
    }
  }

  const singleQuoted = rawValue.match(/^'([^']*)'\s*(?:#.*)?$/);
  const value = singleQuoted?.[1]?.trim();
  return value || null;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
