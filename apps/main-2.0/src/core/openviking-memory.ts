import { createHash } from "node:crypto";
import path from "node:path";

import type {
  OpenVikingControlDiagnostics,
  OpenVikingMemoryAuthority,
  OpenVikingMemoryEvidenceStatus,
  OpenVikingMemoryLifecycle,
} from "./openviking-memory-control";

export const OPENVIKING_ACCOUNT_ID = "agent-recall-v2";
export const OPENVIKING_LOCAL_EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5";
export const OPENVIKING_MEMORY_URI_PREFIX = "viking://user/memories/";

export type OpenVikingEmbeddingMode = "local" | "remote";
export type OpenVikingIntegration = "claude" | "codex" | "opencode";
export type OpenVikingRuntimeState =
  | "not-installed"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "error";
export type OpenVikingRuntimeInstallPhase =
  | "resolving-runtime"
  | "downloading-python"
  | "building-runtime"
  | "packaging-runtime"
  | "downloading-runtime"
  | "verifying-runtime"
  | "installing-runtime";

export interface OpenVikingRuntimeInstallProgress {
  phase: OpenVikingRuntimeInstallPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

export interface OpenVikingWorkspace {
  id: string;
  userId: string;
  rootPath: string;
  identity: string;
  displayName: string;
  managed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OpenVikingMemoryItem {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
  source?: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
  memoryType?: string;
  authority?: OpenVikingMemoryAuthority;
  lifecycle?: OpenVikingMemoryLifecycle;
  locked?: boolean;
  evidenceStatus?: OpenVikingMemoryEvidenceStatus;
  evidenceCount?: number;
}

export interface OpenVikingRuntimeStatus {
  state: OpenVikingRuntimeState;
  version?: string;
  port?: number;
  installedBytes?: number;
  progress?: OpenVikingRuntimeInstallProgress;
  error?: string;
}

export interface OpenVikingModelStatus {
  model: typeof OPENVIKING_LOCAL_EMBEDDING_MODEL;
  installed: boolean;
  downloading?: boolean;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface OpenVikingMemorySnapshot {
  runtime: OpenVikingRuntimeStatus;
  model: OpenVikingModelStatus;
  workspaces: OpenVikingWorkspace[];
}

export type OpenVikingRuntimeHealth = "healthy" | "unhealthy" | "not-running" | "unknown";

export interface OpenVikingRuntimeEvent {
  id: string;
  level: "info" | "warning" | "error";
  type: "start" | "ready" | "stop" | "exit" | "error";
  message: string;
  createdAt: string;
}

export interface OpenVikingRuntimeDiagnostics {
  status: OpenVikingRuntimeStatus;
  health: OpenVikingRuntimeHealth;
  pid?: number;
  port?: number;
  startedAt?: string;
  uptimeSeconds?: number;
  healthLatencyMs?: number;
  events: OpenVikingRuntimeEvent[];
}

export interface OpenVikingDiagnosticsSnapshot {
  capturedAt: string;
  runtime: OpenVikingRuntimeDiagnostics;
  model: OpenVikingModelStatus;
  workspaces: OpenVikingWorkspace[];
  control: OpenVikingControlDiagnostics;
}

export function workspaceUserId(identity: string): string {
  const normalizedIdentity = identity.trim();
  if (!normalizedIdentity) throw new Error("Workspace identity is required.");
  return `workspace_${sha256(normalizedIdentity).slice(0, 24)}`;
}

export function canonicalOpenVikingMemoryUri(uri: string, userId?: string): string {
  const normalized = uri.trim();
  if (
    !normalized.startsWith("viking://user/")
    || normalized.includes("\0")
    || normalized.includes("\\")
    || normalized.includes("?")
    || normalized.includes("#")
  ) {
    throw new Error("Memory URI must stay inside the OpenViking user memory scope.");
  }

  const segments = normalized.slice("viking://user/".length).split("/");
  let memoryIndex = -1;
  if (segments[0] === "memories") {
    memoryIndex = 0;
  } else if (segments[0] && segments[1] === "memories") {
    if (userId && segments[0] !== userId) {
      throw new Error("Memory URI does not belong to the selected OpenViking workspace.");
    }
    memoryIndex = 1;
  }

  const memoryPath = segments.slice(memoryIndex + 1);
  if (
    memoryIndex < 0
    || memoryPath.length === 0
    || memoryPath.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Memory URI must stay inside the OpenViking user memory scope.");
  }

  return `${OPENVIKING_MEMORY_URI_PREFIX}${memoryPath.join("/")}`;
}

export function tryCanonicalOpenVikingMemoryUri(uri: string, userId?: string): string | null {
  try {
    return canonicalOpenVikingMemoryUri(uri, userId);
  } catch {
    return null;
  }
}

export function normalizeWorkspacePath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (rootPath.includes("\0")) throw new Error("Workspace path cannot contain NUL characters.");
  const input = rootPath.trim();
  if (!input) throw new Error("Workspace path is required.");
  const normalized = (platform === "win32" ? path.win32 : path.posix).resolve(input);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
