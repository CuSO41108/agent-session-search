import { createHash } from "node:crypto";
import type { SkillSyncFile } from "./skill-sync";

const MAX_TEXT_DIFF_LINES = 800;

export interface SkillContentSnapshot {
  contentHash: string;
  files: SkillSyncFile[];
}

export type SkillDiffState = "identical" | "different" | "local-only" | "remote-only";
export type SkillFileDiffStatus = "added" | "removed" | "modified" | "unchanged";

export interface SkillFileDiff {
  relativePath: string;
  status: SkillFileDiffStatus;
  binary: boolean;
  localSize: number;
  remoteSize: number;
  localHash: string;
  remoteHash: string;
  diff: string | null;
}

export interface SkillDiffSnapshot {
  state: SkillDiffState;
  localHash: string;
  remoteHash: string;
  files: SkillFileDiff[];
}

export function buildSkillDiffSnapshot(
  local: SkillContentSnapshot | null,
  remote: SkillContentSnapshot | null,
): SkillDiffSnapshot {
  const localFiles = new Map((local?.files ?? []).map((file) => [file.relativePath, decode(file)]));
  const remoteFiles = new Map((remote?.files ?? []).map((file) => [file.relativePath, decode(file)]));
  const paths = [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort(comparePaths);
  const files = paths.map((relativePath) => compareFile(relativePath, localFiles.get(relativePath) ?? null, remoteFiles.get(relativePath) ?? null));
  const materializedFilesMatch = files.every((file) => file.status === "unchanged");
  const state: SkillDiffState = !local
    ? "remote-only"
    : !remote
      ? "local-only"
      : materializedFilesMatch
        ? "identical"
        : "different";
  return {
    state,
    localHash: local?.contentHash ?? "",
    remoteHash: remote?.contentHash ?? "",
    files,
  };
}

function compareFile(relativePath: string, local: Buffer | null, remote: Buffer | null): SkillFileDiff {
  const localHash = local ? sha256(local) : "";
  const remoteHash = remote ? sha256(remote) : "";
  const binary = isBinary(local) || isBinary(remote);
  const status: SkillFileDiffStatus = !local
    ? "added"
    : !remote
      ? "removed"
      : local.equals(remote)
        ? "unchanged"
        : "modified";
  return {
    relativePath,
    status,
    binary,
    localSize: local?.byteLength ?? 0,
    remoteSize: remote?.byteLength ?? 0,
    localHash,
    remoteHash,
    diff: binary || status === "unchanged" ? null : renderLineDiff(local?.toString("utf8") ?? "", remote?.toString("utf8") ?? ""),
  };
}

function renderLineDiff(local: string, remote: string): string {
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const truncated = localLines.length > MAX_TEXT_DIFF_LINES || remoteLines.length > MAX_TEXT_DIFF_LINES;
  const a = localLines.slice(0, MAX_TEXT_DIFF_LINES);
  const b = remoteLines.slice(0, MAX_TEXT_DIFF_LINES);
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      output.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) {
      output.push(`-${a[i]}`);
      i += 1;
    } else {
      output.push(`+${b[j]}`);
      j += 1;
    }
  }
  if (truncated) output.push(" … diff truncated …");
  return output.join("\n");
}

function decode(file: SkillSyncFile): Buffer {
  return Buffer.from(file.contentBase64, "base64");
}

function isBinary(value: Buffer | null): boolean {
  if (!value || value.length === 0) return false;
  if (value.includes(0)) return true;
  let controls = 0;
  for (const byte of value.subarray(0, Math.min(value.length, 4096))) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / Math.min(value.length, 4096) > 0.2;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(a: string, b: string): number {
  if (a === "SKILL.md") return b === "SKILL.md" ? 0 : -1;
  if (b === "SKILL.md") return 1;
  return a.localeCompare(b);
}
