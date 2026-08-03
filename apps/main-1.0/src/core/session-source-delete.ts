import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionSource } from "./types";

export interface SessionSourceDeleteTarget {
  source: SessionSource;
  rawId: string;
  filePath: string;
  isSubagent: boolean;
}

export interface SessionSourceDeletionPaths {
  files: string[];
  directories: string[];
  emptyDirectories: string[];
}

type PathOperations = Pick<typeof path.posix, "basename" | "dirname" | "extname" | "join">;

export function sessionSourceDeletionPaths(
  targets: readonly SessionSourceDeleteTarget[],
  pathOperations: PathOperations = path,
): SessionSourceDeletionPaths {
  const files = new Set<string>();
  const directories = new Set<string>();
  const emptyDirectories = new Set<string>();

  for (const target of targets) {
    const filePath = target.filePath.trim();
    if (!filePath) throw new Error("Session source file path is missing.");
    files.add(filePath);
    if (target.source !== "claude-cli") continue;

    const extension = pathOperations.extname(filePath);
    if (extension.toLowerCase() !== ".jsonl") continue;
    if (target.isSubagent) {
      files.add(`${filePath.slice(0, -extension.length)}.meta.json`);
      continue;
    }
    if (!target.rawId || pathOperations.basename(filePath, extension) !== target.rawId) continue;

    const sessionDirectory = pathOperations.join(pathOperations.dirname(filePath), target.rawId);
    directories.add(pathOperations.join(sessionDirectory, "subagents"));
    directories.add(pathOperations.join(sessionDirectory, "tool-results"));
    emptyDirectories.add(sessionDirectory);
  }

  return {
    files: [...files],
    directories: [...directories],
    emptyDirectories: [...emptyDirectories],
  };
}

export function deleteLocalSessionSources(targets: readonly SessionSourceDeleteTarget[]): void {
  const deletionPaths = sessionSourceDeletionPaths(targets);
  for (const filePath of deletionPaths.files) deleteRegularFile(filePath);
  for (const directoryPath of deletionPaths.directories) deleteOwnedDirectory(directoryPath);
  for (const directoryPath of deletionPaths.emptyDirectories) removeEmptyDirectory(directoryPath);
}

function deleteRegularFile(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isDirectory()) throw new Error("Refusing to delete a directory as a session file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(filePath, { force: true });
}

function deleteOwnedDirectory(directoryPath: string): void {
  try {
    if (!fs.lstatSync(directoryPath).isDirectory()) {
      throw new Error("Refusing to recursively delete a non-directory session artifact.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

function removeEmptyDirectory(directoryPath: string): void {
  try {
    fs.rmdirSync(directoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}
