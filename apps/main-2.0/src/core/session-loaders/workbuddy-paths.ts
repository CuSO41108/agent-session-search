import * as path from "node:path";

export interface WorkBuddySessionIdentity {
  rawId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
}

export function workBuddySessionIdentity(
  projectsDir: string,
  filePath: string,
): WorkBuddySessionIdentity | null {
  const relativePath = path.relative(projectsDir, filePath);
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => !segment || segment === "..")) return null;

  const validSessionId = /^[A-Za-z0-9_-]+$/u;
  if (segments.length === 2 && segments[1].endsWith(".jsonl")) {
    const rawId = path.basename(segments[1], ".jsonl");
    return validSessionId.test(rawId)
      ? { rawId, isSubagent: false, parentSessionId: null }
      : null;
  }
  if (
    segments.length !== 4
    || segments[2] !== "subagents"
    || !segments[3].endsWith(".jsonl")
  ) return null;

  const parentSessionId = segments[1];
  const fileId = path.basename(segments[3], ".jsonl");
  if (!validSessionId.test(parentSessionId) || !fileId || fileId === "." || fileId === "..") return null;
  return {
    rawId: `${parentSessionId}:subagent:${fileId}`,
    isSubagent: true,
    parentSessionId,
  };
}

export function isWorkBuddySessionFile(projectsDir: string, filePath: string): boolean {
  return workBuddySessionIdentity(projectsDir, filePath) !== null;
}
