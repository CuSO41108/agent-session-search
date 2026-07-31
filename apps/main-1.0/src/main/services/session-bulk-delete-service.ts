import * as fs from "node:fs";
import type { SessionStore } from "../../core/session-store";
import type {
  SessionBulkDeleteIssue,
  SessionBulkDeletePreview,
  SessionBulkDeleteRequest,
  SessionBulkDeleteResult,
  SessionBulkDeleteTarget,
} from "../../core/session-bulk-delete";
import type { SessionEnvironment, SessionSource } from "../../core/types";
import { deleteWslSessionFiles } from "../../core/wsl-session-actions";
import { deleteZcodeSessions } from "../../core/zcode-session-writer";

const SHARED_DATABASE_SOURCES = new Set<SessionSource>(["hermes", "opencode-cli", "codewiz-cli"]);
const WSL_FILE_SOURCES = new Set<SessionSource>(["codex-cli", "codex-app", "claude-cli", "claude-app"]);

export class SessionBulkDeleteService {
  constructor(private readonly store: SessionStore) {}

  preview(request: SessionBulkDeleteRequest): SessionBulkDeletePreview {
    return this.preflight(request).preview;
  }

  async delete(request: SessionBulkDeleteRequest): Promise<SessionBulkDeleteResult> {
    const { preview, targets } = this.preflight(request);
    const failed: SessionBulkDeleteIssue[] = [];
    const successfulKeys = new Set<string>();
    const environments = new Map(this.store.listEnvironments().map((environment) => [environment.id, environment]));

    for (const target of targets.filter((item) => !item.sourceAvailable)) successfulKeys.add(target.sessionKey);
    await deleteZcodeGroups(targets.filter((item) => item.sourceAvailable && item.source === "zcode-cli"), successfulKeys, failed);
    await deleteWslGroups(
      targets.filter((item) => item.sourceAvailable && item.environmentKind === "wsl"),
      environments,
      successfulKeys,
      failed,
    );
    deleteLocalFileGroups(
      targets.filter((item) => item.sourceAvailable && item.environmentKind === "local" && item.source !== "zcode-cli"),
      successfulKeys,
      failed,
    );

    const deletedSessionKeys = targets
      .map((target) => target.sessionKey)
      .filter((sessionKey) => successfulKeys.has(sessionKey));
    this.store.deleteSessionRecords(deletedSessionKeys);
    return { ...preview, deletedSessionKeys, failed };
  }

  private preflight(request: SessionBulkDeleteRequest): { preview: SessionBulkDeletePreview; targets: SessionBulkDeleteTarget[] } {
    const sessionKeys = normalizeRequest(request);
    const rows = this.store.getSessionDeletionTargets(sessionKeys);
    return buildPreflight(request, sessionKeys, rows);
  }
}

function normalizeRequest(request: SessionBulkDeleteRequest): string[] {
  if (!request || !Array.isArray(request.sessionKeys) || !Array.isArray(request.liveSessionKeys)) {
    throw new Error("The bulk deletion request is invalid.");
  }
  const keys = [...new Set(request.sessionKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) throw new Error("Select at least one session to delete.");
  if (keys.length > 100_000) throw new Error("Too many sessions were selected.");
  if (request.inactiveBefore !== undefined && (!Number.isFinite(request.inactiveBefore) || request.inactiveBefore <= 0)) {
    throw new Error("The inactivity cutoff is invalid.");
  }
  return keys;
}

function buildPreflight(
  request: SessionBulkDeleteRequest,
  sessionKeys: string[],
  rows: SessionBulkDeleteTarget[],
): { preview: SessionBulkDeletePreview; targets: SessionBulkDeleteTarget[] } {
  const liveKeys = new Set(request.liveSessionKeys);
  const byKey = new Map(rows.map((row) => [row.sessionKey, row]));
  const skipped: SessionBulkDeleteIssue[] = [];
  const targets: SessionBulkDeleteTarget[] = [];
  for (const sessionKey of sessionKeys) {
    const target = byKey.get(sessionKey);
    const issue = target ? classifyTarget(target, request, liveKeys) : issueFor(sessionKey, "not-found", "Session was not found.");
    if (issue) skipped.push(issue);
    else if (target) targets.push(target);
  }
  const sourceCounts = [...countSources(targets).entries()].map(([source, count]) => ({ source, count }));
  return {
    targets,
    preview: { requestedCount: sessionKeys.length, matchedCount: rows.length, deletableCount: targets.length, sourceCounts, skipped },
  };
}

function classifyTarget(
  target: SessionBulkDeleteTarget,
  request: SessionBulkDeleteRequest,
  liveKeys: Set<string>,
): SessionBulkDeleteIssue | null {
  if (liveKeys.has(target.sessionKey)) return issueFor(target.sessionKey, "live", "Live sessions cannot be deleted.");
  if ((request.protectFavorites || request.inactiveBefore !== undefined) && target.favorited) {
    return issueFor(target.sessionKey, "favorite", "Favorite session was protected.");
  }
  if (request.inactiveBefore !== undefined && target.lastActivityAt >= request.inactiveBefore) {
    return issueFor(target.sessionKey, "recent", "Session is not older than the selected cutoff.");
  }
  if (target.source === "pi-cli") return issueFor(target.sessionKey, "read-only", "Pi session source files are read-only.");
  if (SHARED_DATABASE_SOURCES.has(target.source)) return issueFor(target.sessionKey, "shared-database", "This source stores multiple sessions in a shared database.");
  if (target.source === "cursor-agent" && /(^|[\\/])state\.vscdb$/iu.test(target.filePath) && target.sourceAvailable) {
    return issueFor(target.sessionKey, "shared-database", "This Cursor session is stored in a shared database.");
  }
  if (target.environmentKind === "ssh") return issueFor(target.sessionKey, "remote-source", "SSH session source files cannot be deleted here.");
  if (target.environmentKind === "wsl" && !WSL_FILE_SOURCES.has(target.source)) {
    return issueFor(target.sessionKey, "remote-source", "This WSL session source is not supported for deletion.");
  }
  return null;
}

function issueFor(sessionKey: string, reason: SessionBulkDeleteIssue["reason"], message: string): SessionBulkDeleteIssue {
  return { sessionKey, reason, message };
}

function countSources(targets: SessionBulkDeleteTarget[]): Map<SessionSource, number> {
  const counts = new Map<SessionSource, number>();
  for (const target of targets) counts.set(target.source, (counts.get(target.source) ?? 0) + 1);
  return counts;
}

async function deleteZcodeGroups(targets: SessionBulkDeleteTarget[], successful: Set<string>, failed: SessionBulkDeleteIssue[]): Promise<void> {
  for (const group of groupBy(targets, (target) => target.filePath).values()) {
    try {
      deleteZcodeSessions(group[0].filePath, group.map((target) => target.rawId));
      for (const target of group) successful.add(target.sessionKey);
    } catch (error) {
      addGroupFailure(group, error, failed);
    }
  }
}

async function deleteWslGroups(
  targets: SessionBulkDeleteTarget[],
  environments: Map<string, SessionEnvironment>,
  successful: Set<string>,
  failed: SessionBulkDeleteIssue[],
): Promise<void> {
  for (const [environmentId, group] of groupBy(targets, (target) => target.environmentId)) {
    try {
      const environment = environments.get(environmentId);
      if (!environment) throw new Error("WSL environment was not found.");
      await deleteWslSessionFiles(environment, group.map((target) => target.filePath));
      for (const target of group) successful.add(target.sessionKey);
    } catch (error) {
      addGroupFailure(group, error, failed);
    }
  }
}

function deleteLocalFileGroups(targets: SessionBulkDeleteTarget[], successful: Set<string>, failed: SessionBulkDeleteIssue[]): void {
  for (const group of groupBy(targets, (target) => target.filePath).values()) {
    try {
      deleteLocalFile(group[0].filePath);
      for (const target of group) successful.add(target.sessionKey);
    } catch (error) {
      addGroupFailure(group, error, failed);
    }
  }
}

function deleteLocalFile(filePath: string): void {
  const normalized = filePath.trim();
  if (!normalized) throw new Error("Session source file path is missing.");
  try {
    if (fs.lstatSync(normalized).isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(normalized, { force: true });
}

function addGroupFailure(group: SessionBulkDeleteTarget[], error: unknown, failed: SessionBulkDeleteIssue[]): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const target of group) failed.push(issueFor(target.sessionKey, "delete-failed", message));
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
