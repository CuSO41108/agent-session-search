import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import { WorkflowV2WorkspaceTransaction, workflowV2WorkspaceIsolationPlanError } from "./workflow-v2-workspace-transaction";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("WorkflowV2WorkspaceTransaction", () => {
  test("rejects unconstrained and unbrokered external scripts in strict mode", () => {
    const strictPlan = (script: Record<string, unknown>) => ({
      definition: {
        transactionPolicy: { defaultMode: "strict_atomic" },
        nodes: [{ id: "script-1", execModel: "script", script }],
      },
      nodes: [{ nodeId: "script-1", scriptGovernance: { capabilities: [] } }],
    }) as unknown as WorkflowV2Plan;

    expect(workflowV2WorkspaceIsolationPlanError(strictPlan({
      effectMode: "workspace_only",
      idempotency: "safe_retry",
      stderrPolicy: "warn",
      executable: { kind: "command", command: "echo unsafe" },
    }))).toContain("unconstrained command");
    expect(workflowV2WorkspaceIsolationPlanError(strictPlan({
      effectMode: "brokered_external",
      idempotency: "safe_retry",
      stderrPolicy: "fail",
      compensationAdapter: "undo-test",
      executable: { kind: "inline", handler: "test" },
    }))).toContain("Broker execution port");
  });

  test("freezes dirty and untracked files into an isolated workspace without changing the source", async () => {
    const root = await temporaryRoot("workflow-workspace-prepare-");
    const sourceDir = path.join(root, "source");
    await mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await mkdir(path.join(sourceDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(sourceDir, "tracked.txt"), "dirty baseline", "utf8");
    await writeFile(path.join(sourceDir, "nested", "untracked.txt"), "untracked baseline", "utf8");
    await writeFile(path.join(sourceDir, "node_modules", "pkg", "ignored.js"), "ignored", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));

    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1", now: 10 });

    expect(prepared.reused).toBe(false);
    expect(prepared.manifest.files.map((file) => file.relativePath)).toEqual(["nested/untracked.txt", "tracked.txt"]);
    expect(prepared.manifest.excluded).toContainEqual({ relativePath: "node_modules", reason: "dependency" });
    await writeFile(path.join(prepared.workspaceDir, "tracked.txt"), "workflow edit", "utf8");
    expect(await readFile(path.join(sourceDir, "tracked.txt"), "utf8")).toBe("dirty baseline");

    const resumed = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "different-id", now: 20 });
    expect(resumed.reused).toBe(true);
    expect(resumed.baselineId).toBe("baseline-1");
    expect(await readFile(path.join(resumed.workspaceDir, "tracked.txt"), "utf8")).toBe("workflow edit");

    await writeFile(path.join(transaction.paths().baselineDir, "tracked.txt"), "corrupted baseline", "utf8");
    await expect(transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" })).rejects.toThrow("baseline snapshot");
  });

  test("rejects transaction storage nested inside the governed source", async () => {
    const root = await temporaryRoot("workflow-workspace-overlap-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "file.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(sourceDir, ".transactions", "run-1"));

    await expect(transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" })).rejects.toThrow("must be outside");
  });

  test("fails closed when disk capacity is insufficient or cannot be verified", async () => {
    const root = await temporaryRoot("workflow-v2-disk-");
    const source = path.join(root, "source");
    const transactionRoot = path.join(root, "transaction");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "input.txt"), "input", "utf8");
    const lowSpace = new WorkflowV2WorkspaceTransaction(transactionRoot, async () => ({ bavail: 1, bsize: 1 } as never));
    const unavailable = new WorkflowV2WorkspaceTransaction(`${transactionRoot}-unavailable`, async () => { throw new Error("statfs unavailable"); });

    await expect(lowSpace.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" })).rejects.toThrow("insufficient disk space");
    await expect(unavailable.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" })).rejects.toThrow("could not be verified");
  });

  test("rejects resume after an isolated workspace disappears", async () => {
    const root = await temporaryRoot("workflow-v2-missing-isolation-");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "input.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" });
    await rm(prepared.workspaceDir, { recursive: true, force: true });

    await expect(transaction.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" })).rejects.toThrow("directory");
  });

  test("cleans an interrupted baseline staging directory before freezing a new baseline", async () => {
    const root = await temporaryRoot("workflow-v2-baseline-crash-");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "input.txt"), "baseline", "utf8");
    const stagingKey = createHash("sha256").update("workflow\0run").digest("hex").slice(0, 16);
    const abandonedStaging = path.join(root, `.transaction-workspace-${stagingKey}.staging`);
    await mkdir(abandonedStaging, { recursive: true });
    await writeFile(path.join(abandonedStaging, "partial.txt"), "partial snapshot", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));

    const prepared = await transaction.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" });

    expect(await readFile(path.join(prepared.workspaceDir, "input.txt"), "utf8")).toBe("baseline");
    await expect(access(abandonedStaging)).rejects.toThrow();
  });

  test("resumes file commit safely before, during, and after a crash boundary", async () => {
    const root = await temporaryRoot("workflow-v2-commit-resume-");
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "first.txt"), "baseline", "utf8");
    await writeFile(path.join(source, "second.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow", runId: "run", sourceDir: source, baselineId: "baseline" });
    await writeFile(path.join(prepared.workspaceDir, "first.txt"), "workflow-first", "utf8");
    await writeFile(path.join(prepared.workspaceDir, "second.txt"), "workflow-second", "utf8");

    // Fault injection: the first atomic rename completed, then the process died.
    await writeFile(path.join(source, "first.txt"), "workflow-first", "utf8");
    const resumed = await transaction.commit();
    expect(resumed).toEqual({ applied: ["first.txt", "second.txt"], conflicts: [] });
    expect(await readFile(path.join(source, "second.txt"), "utf8")).toBe("workflow-second");

    const afterCommitCrash = await transaction.commit();
    expect(afterCommitCrash).toEqual({ applied: ["first.txt", "second.txt"], conflicts: [] });
  });

  test("refuses to commit links introduced inside the isolated workspace", async () => {
    const root = await temporaryRoot("workflow-workspace-link-");
    const sourceDir = path.join(root, "source");
    const outsideDir = path.join(root, "outside");
    await mkdir(path.join(sourceDir, "replace"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(sourceDir, "replace", "file.txt"), "baseline", "utf8");
    await writeFile(path.join(outsideDir, "file.txt"), "outside", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" });
    await rm(path.join(prepared.workspaceDir, "replace"), { recursive: true });
    await symlink(outsideDir, path.join(prepared.workspaceDir, "replace"), process.platform === "win32" ? "junction" : "dir");

    await expect(transaction.commit()).rejects.toThrow("cannot be committed safely");
    expect(await readFile(path.join(sourceDir, "replace", "file.txt"), "utf8")).toBe("baseline");
    expect(await readFile(path.join(outsideDir, "file.txt"), "utf8")).toBe("outside");
  });

  test("restores a node savepoint before a retry", async () => {
    const root = await temporaryRoot("workflow-workspace-savepoint-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "file.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" });
    await transaction.createSavepoint({ savepointId: "node-1-attempt-1", nodeId: "node-1", attempt: 1, now: 10 });
    await writeFile(path.join(prepared.workspaceDir, "file.txt"), "failed attempt", "utf8");
    await writeFile(path.join(prepared.workspaceDir, "created.txt"), "attempt artifact", "utf8");
    expect(await transaction.inspectDiffSinceSavepoint("node-1-attempt-1")).toEqual({ created: ["created.txt"], modified: ["file.txt"], deleted: [] });
    await transaction.createSavepoint({ savepointId: "node-1-attempt-1", nodeId: "node-1", attempt: 1, now: 20 });

    await transaction.restoreSavepoint("node-1-attempt-1");

    expect(await readFile(path.join(prepared.workspaceDir, "file.txt"), "utf8")).toBe("baseline");
    await expect(readFile(path.join(prepared.workspaceDir, "metadata.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("replaces an interrupted savepoint staging copy without accepting partial contents", async () => {
    const root = await temporaryRoot("workflow-v2-savepoint-crash-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "file.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    await transaction.prepare({ workflowId: "workflow", runId: "run", sourceDir, baselineId: "baseline" });
    const staging = path.join(transaction.paths().snapshotsDir, ".node-1-attempt-1.staging");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "partial.txt"), "partial", "utf8");

    await transaction.createSavepoint({ savepointId: "node-1-attempt-1", nodeId: "node-1", attempt: 1, now: 10 });

    await expect(access(staging)).rejects.toThrow();
    expect(await readFile(path.join(transaction.paths().snapshotsDir, "node-1-attempt-1", "contents", "file.txt"), "utf8")).toBe("baseline");
  });

  test("applies non-conflicting workspace changes and preserves concurrent user edits", async () => {
    const root = await temporaryRoot("workflow-workspace-commit-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "apply.txt"), "baseline", "utf8");
    await writeFile(path.join(sourceDir, "conflict.txt"), "baseline", "utf8");
    await writeFile(path.join(sourceDir, "user-only.txt"), "baseline", "utf8");
    await writeFile(path.join(sourceDir, "delete.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" });
    await writeFile(path.join(prepared.workspaceDir, "apply.txt"), "workflow", "utf8");
    await writeFile(path.join(prepared.workspaceDir, "conflict.txt"), "workflow", "utf8");
    await writeFile(path.join(prepared.workspaceDir, "created.txt"), "created by workflow", "utf8");
    await rm(path.join(prepared.workspaceDir, "user-only.txt"));
    await rm(path.join(prepared.workspaceDir, "delete.txt"));
    expect(await transaction.inspectDiff()).toEqual({
      created: ["created.txt"],
      modified: ["apply.txt", "conflict.txt"],
      deleted: ["delete.txt", "user-only.txt"],
    });
    expect(JSON.parse(await readFile(path.join(transaction.paths().reportsDir, "last-diff.json"), "utf8"))).toMatchObject({ created: ["created.txt"] });
    await writeFile(path.join(sourceDir, "conflict.txt"), "user", "utf8");
    await writeFile(path.join(sourceDir, "user-only.txt"), "user", "utf8");

    const result = await transaction.commit();

    expect(result.applied).toEqual([]);
    expect(result.conflicts.sort()).toEqual(["conflict.txt", "user-only.txt"]);
    expect(await readFile(path.join(sourceDir, "apply.txt"), "utf8")).toBe("baseline");
    await expect(readFile(path.join(sourceDir, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(sourceDir, "conflict.txt"), "utf8")).toBe("user");
    expect(await readFile(path.join(sourceDir, "user-only.txt"), "utf8")).toBe("user");
    expect(await readFile(path.join(sourceDir, "delete.txt"), "utf8")).toBe("baseline");
    const conflictReport = JSON.parse(await readFile(path.join(transaction.paths().reportsDir, "last-commit.json"), "utf8")) as { conflictDetails: Array<{ relativePath: string; baseline?: { sha256: string }; workspace?: { sha256: string }; current?: { sha256: string } }> };
    expect(conflictReport.conflictDetails.find((entry) => entry.relativePath === "conflict.txt")).toMatchObject({
      relativePath: "conflict.txt",
      baseline: { sha256: expect.any(String) },
      workspace: { sha256: expect.any(String) },
      current: { sha256: expect.any(String) },
    });

    await writeFile(path.join(sourceDir, "conflict.txt"), "baseline", "utf8");
    await writeFile(path.join(sourceDir, "user-only.txt"), "baseline", "utf8");
    const retried = await transaction.commit();
    expect(retried.conflicts).toEqual([]);
    expect(retried.applied.sort()).toEqual(["apply.txt", "conflict.txt", "created.txt", "delete.txt", "user-only.txt"]);
    expect(await readFile(path.join(sourceDir, "apply.txt"), "utf8")).toBe("workflow");
    expect(await readFile(path.join(sourceDir, "created.txt"), "utf8")).toBe("created by workflow");
    await expect(readFile(path.join(sourceDir, "delete.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(sourceDir, "apply.txt"), "user after commit", "utf8");
    const conflictedRollback = await transaction.rollbackCommitted();
    expect(conflictedRollback.applied).toEqual([]);
    expect(conflictedRollback.conflicts).toEqual(["apply.txt"]);
    expect(await readFile(path.join(sourceDir, "conflict.txt"), "utf8")).toBe("workflow");

    await writeFile(path.join(sourceDir, "apply.txt"), "workflow", "utf8");
    const rollback = await transaction.rollbackCommitted();
    expect(rollback.conflicts).toEqual([]);
    expect(rollback.applied.sort()).toEqual(["apply.txt", "conflict.txt", "created.txt", "delete.txt", "user-only.txt"]);
    expect(await readFile(path.join(sourceDir, "apply.txt"), "utf8")).toBe("baseline");
    expect(await readFile(path.join(sourceDir, "delete.txt"), "utf8")).toBe("baseline");
    await expect(readFile(path.join(sourceDir, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("builds a bounded redacted three-way conflict preview", async () => {
    const root = await temporaryRoot("workflow-workspace-conflict-preview-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "config.txt"), "token=baseline-secret\nvalue=baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" });
    await writeFile(path.join(prepared.workspaceDir, "config.txt"), "token=workflow-secret\nvalue=workflow", "utf8");
    await writeFile(path.join(sourceDir, "config.txt"), "token=user-secret\nvalue=user", "utf8");

    const preview = await transaction.inspectConflictPreview(["config.txt"]);

    expect(preview).toEqual([expect.objectContaining({
      path: "config.txt",
      baseline: expect.objectContaining({ preview: "token=[REDACTED]\nvalue=baseline" }),
      isolated: expect.objectContaining({ preview: "token=[REDACTED]\nvalue=workflow" }),
      current: expect.objectContaining({ preview: "token=[REDACTED]\nvalue=user" }),
    })]);
  });

  test("revalidates and applies a confirmed per-file conflict resolution", async () => {
    const root = await temporaryRoot("workflow-workspace-resolve-conflict-");
    const sourceDir = path.join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "result.txt"), "baseline", "utf8");
    const transaction = new WorkflowV2WorkspaceTransaction(path.join(root, "transaction"));
    const prepared = await transaction.prepare({ workflowId: "workflow-1", runId: "run-1", sourceDir, baselineId: "baseline-1" });
    await writeFile(path.join(prepared.workspaceDir, "result.txt"), "workflow", "utf8");
    await writeFile(path.join(sourceDir, "result.txt"), "user", "utf8");
    const [preview] = await transaction.inspectConflictPreview(["result.txt"]);
    await expect(transaction.resolveConflict({ path: "result.txt", resolution: "manual", expectedCurrentSha256: "stale", content: "merged" })).rejects.toThrow("changed after preview");
    const resolved = await transaction.resolveConflict({ path: "result.txt", resolution: "manual", expectedCurrentSha256: preview!.current.sha256, content: "merged" });
    expect(resolved.current.sha256).toBe(resolved.isolated.sha256);
    expect(await readFile(path.join(sourceDir, "result.txt"), "utf8")).toBe("merged");
    expect(await readFile(path.join(prepared.workspaceDir, "result.txt"), "utf8")).toBe("merged");
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}
