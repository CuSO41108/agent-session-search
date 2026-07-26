import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";

const execFileAsync = promisify(execFile);
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".cache", "dist", "build"]);
const MANIFEST_VERSION = 1 as const;
const WORKSPACE_CAPABILITIES = new Set(["workspace_read", "workspace_write", "workspace_delete"]);

export function workflowV2WorkspaceIsolationPlanError(plan: WorkflowV2Plan): string | undefined {
  if (plan.definition.transactionPolicy?.defaultMode !== "strict_atomic") return undefined;
  for (const planNode of plan.nodes) {
    if (!planNode.scriptGovernance) continue;
    const unsupported = planNode.scriptGovernance.capabilities.filter((capability) => !WORKSPACE_CAPABILITIES.has(capability));
    if (unsupported.length > 0) {
      return `Workflow strict_atomic workspace isolation cannot execute node ${planNode.nodeId} with unbrokered capabilities: ${unsupported.join(", ")}.`;
    }
  }
  return undefined;
}

export interface WorkflowWorkspaceFileEntry {
  relativePath: string;
  type: "file";
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface WorkflowWorkspaceExcludedEntry {
  relativePath: string;
  reason: "git_metadata" | "dependency" | "cache" | "special_file" | "symbolic_link";
}

export interface WorkflowWorkspaceBaselineManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  workflowId: string;
  runId: string;
  sourceDir: string;
  baselineId: string;
  createdAt: number;
  files: WorkflowWorkspaceFileEntry[];
  excluded: WorkflowWorkspaceExcludedEntry[];
  git?: { head?: string; branch?: string; status?: string };
}

export interface WorkflowWorkspaceTransactionPaths {
  rootDir: string;
  baselineDir: string;
  workspaceDir: string;
  snapshotsDir: string;
  reportsDir: string;
  manifestPath: string;
}

export interface WorkflowWorkspacePreparation {
  baselineId: string;
  workspaceDir: string;
  manifest: WorkflowWorkspaceBaselineManifest;
  reused: boolean;
}

export interface WorkflowWorkspaceCommitResult {
  applied: string[];
  conflicts: string[];
}

export class WorkflowV2WorkspaceTransaction {
  constructor(private readonly transactionRoot: string) {}

  async prepare(input: { workflowId: string; runId: string; sourceDir: string; baselineId: string; now?: number }): Promise<WorkflowWorkspacePreparation> {
    const sourceDir = await existingDirectory(input.sourceDir);
    const paths = this.paths();
    const existing = await readManifest(paths.manifestPath);
    if (existing) {
      if (existing.workflowId !== input.workflowId || existing.runId !== input.runId || path.resolve(existing.sourceDir) !== sourceDir) {
        throw new Error("Workflow workspace transaction belongs to a different run or source directory.");
      }
      return { baselineId: existing.baselineId, workspaceDir: paths.workspaceDir, manifest: existing, reused: true };
    }
    await mkdir(paths.rootDir, { recursive: true });
    const manifest = await buildManifest({ workflowId: input.workflowId, runId: input.runId, sourceDir, baselineId: input.baselineId, now: input.now ?? Date.now() });
    await assertSufficientSpace(sourceDir, manifest.files.reduce((sum, file) => sum + file.size, 0));
    const stagingKey = createHash("sha256").update(`${input.workflowId}\0${input.runId}`).digest("hex").slice(0, 16);
    const stagingRoot = path.join(path.dirname(paths.rootDir), `.transaction-workspace-${stagingKey}.staging`);
    await assertInside(path.dirname(paths.rootDir), stagingRoot);
    await rm(stagingRoot, { recursive: true, force: true });
    try {
      await mkdir(stagingRoot, { recursive: true });
      const stagingPaths = workspacePaths(stagingRoot);
      await mkdir(stagingPaths.baselineDir, { recursive: true });
      await mkdir(stagingPaths.workspaceDir, { recursive: true });
      await mkdir(stagingPaths.snapshotsDir, { recursive: true });
      await mkdir(stagingPaths.reportsDir, { recursive: true });
      for (const file of manifest.files) {
        const source = path.join(sourceDir, toNative(file.relativePath));
        const baselineTarget = path.join(stagingPaths.baselineDir, toNative(file.relativePath));
        const workspaceTarget = path.join(stagingPaths.workspaceDir, toNative(file.relativePath));
        await mkdir(path.dirname(baselineTarget), { recursive: true });
        await mkdir(path.dirname(workspaceTarget), { recursive: true });
        await copyFile(source, baselineTarget);
        await copyFile(source, workspaceTarget);
      }
      await writeJson(stagingPaths.manifestPath, manifest);
      await assertInside(path.dirname(paths.rootDir), paths.rootDir);
      await rm(paths.rootDir, { recursive: true, force: true });
      await rename(stagingRoot, paths.rootDir);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    return { baselineId: manifest.baselineId, workspaceDir: paths.workspaceDir, manifest, reused: false };
  }

  async createSavepoint(input: { savepointId: string; nodeId: string; attempt: number; now?: number }): Promise<void> {
    assertSafeSegment(input.savepointId, "savepoint id");
    const paths = this.paths();
    await assertInside(paths.rootDir, paths.workspaceDir);
    const source = await existingDirectory(paths.workspaceDir);
    const target = path.join(paths.snapshotsDir, input.savepointId);
    await assertInside(paths.snapshotsDir, target);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    await writeJson(path.join(paths.snapshotsDir, `${input.savepointId}.json`), { savepointId: input.savepointId, nodeId: input.nodeId, attempt: input.attempt, createdAt: input.now ?? Date.now() });
  }

  async restoreSavepoint(savepointId: string): Promise<void> {
    assertSafeSegment(savepointId, "savepoint id");
    const paths = this.paths();
    const snapshotDir = path.join(paths.snapshotsDir, savepointId);
    await assertInside(paths.snapshotsDir, snapshotDir);
    const source = await existingDirectory(snapshotDir);
    await assertInside(paths.rootDir, paths.workspaceDir);
    await rm(paths.workspaceDir, { recursive: true, force: true });
    await cp(source, paths.workspaceDir, { recursive: true, force: false, errorOnExist: true });
  }

  async commit(): Promise<WorkflowWorkspaceCommitResult> {
    const paths = this.paths();
    const manifest = await readManifest(paths.manifestPath);
    if (!manifest) throw new Error("Workflow workspace baseline manifest was not found.");
    const sourceDir = await existingDirectory(manifest.sourceDir);
    const baseline = await scanDirectory(paths.baselineDir, new Set());
    const workspace = await scanDirectory(paths.workspaceDir, new Set());
    const current = await scanDirectory(sourceDir, new Set());
    const baselineByPath = new Map(baseline.files.map((file) => [file.relativePath, file]));
    const workspaceByPath = new Map(workspace.files.map((file) => [file.relativePath, file]));
    const currentByPath = new Map(current.files.map((file) => [file.relativePath, file]));
    const pathsToInspect = new Set([...baselineByPath.keys(), ...workspaceByPath.keys()]);
    const conflicts: string[] = [];
    const pathsToApply: string[] = [];
    const applied: string[] = [];
    for (const relativePath of pathsToInspect) {
      const before = baselineByPath.get(relativePath);
      const desired = workspaceByPath.get(relativePath);
      const actual = currentByPath.get(relativePath);
      const changedByWorkflow = !sameFile(before, desired);
      if (!changedByWorkflow) continue;
      const changedByUser = !sameFile(before, actual);
      if (changedByUser && !sameFile(actual, desired)) {
        conflicts.push(relativePath);
        continue;
      }
      pathsToApply.push(relativePath);
    }
    if (conflicts.length > 0) {
      await writeJson(path.join(paths.reportsDir, "last-commit.json"), { applied, conflicts, completedAt: Date.now() });
      return { applied, conflicts };
    }
    for (const relativePath of pathsToApply) {
      const desired = workspaceByPath.get(relativePath);
      const actual = currentByPath.get(relativePath);
      const target = safeJoin(sourceDir, relativePath);
      if (desired) {
        await assertNoSymlinkSegments(sourceDir, target);
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${createHash("sha256").update(relativePath).digest("hex").slice(0, 12)}.tmp`;
        await copyFile(safeJoin(paths.workspaceDir, relativePath), temporary);
        await rename(temporary, target);
      } else if (actual) {
        await assertNoSymlinkSegments(sourceDir, target);
        await rm(target, { force: true });
      }
      applied.push(relativePath);
    }
    await writeJson(path.join(paths.reportsDir, "last-commit.json"), { applied, conflicts, completedAt: Date.now() });
    return { applied, conflicts };
  }

  async discard(): Promise<void> {
    const root = this.paths().rootDir;
    await assertInside(path.dirname(root), root);
    await rm(root, { recursive: true, force: true });
  }

  paths(): WorkflowWorkspaceTransactionPaths {
    return workspacePaths(this.transactionRoot);
  }
}

function workspacePaths(rootDir: string): WorkflowWorkspaceTransactionPaths {
  return {
    rootDir,
    baselineDir: path.join(rootDir, "baseline"),
    workspaceDir: path.join(rootDir, "workspace"),
    snapshotsDir: path.join(rootDir, "snapshots"),
    reportsDir: path.join(rootDir, "reports"),
    manifestPath: path.join(rootDir, "manifest.json"),
  };
}

async function buildManifest(input: { workflowId: string; runId: string; sourceDir: string; baselineId: string; now: number }): Promise<WorkflowWorkspaceBaselineManifest> {
  const scanned = await scanDirectory(input.sourceDir, new Set());
  const git = await readGitMetadata(input.sourceDir);
  return {
    schemaVersion: MANIFEST_VERSION,
    workflowId: input.workflowId,
    runId: input.runId,
    sourceDir: input.sourceDir,
    baselineId: input.baselineId,
    createdAt: input.now,
    files: scanned.files,
    excluded: scanned.excluded,
    ...(git ? { git } : {}),
  };
}

async function scanDirectory(rootDir: string, _inheritedExcluded: Set<string>): Promise<{ files: WorkflowWorkspaceFileEntry[]; excluded: WorkflowWorkspaceExcludedEntry[] }> {
  const files: WorkflowWorkspaceFileEntry[] = [];
  const excluded: WorkflowWorkspaceExcludedEntry[] = [];
  const visit = async (currentDir: string): Promise<void> => {
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const absolute = path.join(currentDir, entry.name);
      const relativePath = toPortable(path.relative(rootDir, absolute));
      if (EXCLUDED_NAMES.has(entry.name)) {
        excluded.push({ relativePath, reason: entry.name === ".git" ? "git_metadata" : entry.name === "node_modules" ? "dependency" : "cache" });
        continue;
      }
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        excluded.push({ relativePath, reason: "symbolic_link" });
      } else if (metadata.isDirectory()) {
        await visit(absolute);
      } else if (metadata.isFile()) {
        files.push({ relativePath, type: "file", size: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await fileHash(absolute) });
      } else {
        excluded.push({ relativePath, reason: "special_file" });
      }
    }
  };
  await visit(rootDir);
  return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), excluded: excluded.sort((a, b) => a.relativePath.localeCompare(b.relativePath)) };
}

async function readGitMetadata(sourceDir: string): Promise<WorkflowWorkspaceBaselineManifest["git"] | undefined> {
  try {
    const options = { cwd: sourceDir, timeout: 1_500, windowsHide: true } as const;
    const inside = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], options).then((result) => result.stdout.trim());
    if (inside !== "true") return undefined;
    const [head, branch, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], options).then((result) => result.stdout.trim()),
      execFileAsync("git", ["branch", "--show-current"], options).then((result) => result.stdout.trim()),
      execFileAsync("git", ["status", "--short", "--", "."], options).then((result) => result.stdout.trim()),
    ]);
    return { head, branch, status };
  } catch {
    return undefined;
  }
}

async function assertSufficientSpace(sourceDir: string, bytes: number): Promise<void> {
  try {
    const disk = await statfs(sourceDir);
    if (disk.bavail * disk.bsize < Math.max(bytes * 3, 16 * 1024 * 1024)) throw new Error("Workflow workspace transaction preflight failed: insufficient disk space.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("insufficient disk")) throw error;
  }
}

async function existingDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Workflow workspace path is not a real directory: ${directory}`);
  return resolved;
}

async function fileHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sameFile(left: WorkflowWorkspaceFileEntry | undefined, right: WorkflowWorkspaceFileEntry | undefined): boolean {
  return left?.type === right?.type && left?.sha256 === right?.sha256 && left?.size === right?.size;
}

function safeJoin(rootDir: string, relativePath: string): string {
  const target = path.resolve(rootDir, toNative(relativePath));
  const relative = path.relative(path.resolve(rootDir), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Workflow workspace path escapes its governed root: ${relativePath}`);
  return target;
}

async function assertInside(rootDir: string, target: string): Promise<void> {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workflow workspace transaction path is outside its transaction root.");
}

async function assertNoSymlinkSegments(rootDir: string, target: string): Promise<void> {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workflow workspace target escapes its governed root.");
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Workflow workspace refuses to follow a symbolic link: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) throw new Error(`Workflow ${label} is not a safe path segment.`);
}

function toPortable(value: string): string { return value.split(path.sep).join("/"); }
function toNative(value: string): string { return value.split("/").join(path.sep); }

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readManifest(filePath: string): Promise<WorkflowWorkspaceBaselineManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as WorkflowWorkspaceBaselineManifest;
    if (value.schemaVersion !== MANIFEST_VERSION || !value.workflowId || !value.runId || !value.sourceDir || !Array.isArray(value.files)) throw new Error("Malformed workspace manifest.");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
