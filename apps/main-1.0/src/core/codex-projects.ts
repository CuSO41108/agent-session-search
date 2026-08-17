import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectSummary } from "./types";

export interface CodexDesktopProject {
  path: string;
  label: string;
}

const CODEX_GLOBAL_STATE_FILE = ".codex-global-state.json";
const PROJECT_ROOT_KEYS = ["project-order", "electron-saved-workspace-roots"] as const;
const PROJECT_LABEL_KEY = "electron-workspace-root-labels";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function projectKey(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase();
}

function projectLabel(projectPath: string): string {
  const parts = projectPath.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) || projectPath;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function readStringMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const object = record(value);
  if (!object) return map;
  for (const [key, label] of Object.entries(object)) {
    if (typeof label === "string" && label.trim()) map.set(projectKey(key), label.trim());
  }
  return map;
}

export function readCodexDesktopProjects(codexHome: string): CodexDesktopProject[] {
  let state: Record<string, unknown> | null = null;
  try {
    state = record(JSON.parse(fs.readFileSync(path.join(codexHome, CODEX_GLOBAL_STATE_FILE), "utf8")));
  } catch {
    return [];
  }
  if (!state) return [];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const key of PROJECT_ROOT_KEYS) {
    for (const root of readStringArray(state[key])) {
      const identity = projectKey(root);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      roots.push(root);
    }
  }
  const labels = readStringMap(state[PROJECT_LABEL_KEY]);
  return roots.map((root) => ({ path: root, label: labels.get(projectKey(root)) || projectLabel(root) }));
}

export function mergeCodexDesktopProjects(
  indexedProjects: ProjectSummary[],
  desktopProjects: CodexDesktopProject[],
): ProjectSummary[] {
  const merged = indexedProjects.map((project) => ({ ...project }));
  const byPath = new Map(merged.map((project) => [projectKey(project.path), project]));
  for (const project of desktopProjects) {
    const key = projectKey(project.path);
    if (!key) continue;
    const indexed = byPath.get(key);
    if (indexed) {
      if (indexed.labelKind === "path" && project.label.trim()) indexed.label = project.label.trim();
      continue;
    }
    const emptyProject: ProjectSummary = {
      path: project.path,
      label: project.label.trim() || projectLabel(project.path),
      labelKind: "path",
      labelSuffix: null,
      sessionCount: 0,
      environmentId: "local",
      environmentLabel: "Local",
      createdAt: 0,
      lastActivityAt: 0,
    };
    merged.push(emptyProject);
    byPath.set(key, emptyProject);
  }
  return merged;
}
