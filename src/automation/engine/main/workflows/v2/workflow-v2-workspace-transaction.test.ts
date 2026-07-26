import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowV2WorkspaceTransaction } from "./workflow-v2-workspace-transaction";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("WorkflowV2WorkspaceTransaction", () => {
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
    await transaction.createSavepoint({ savepointId: "node-1-attempt-1", nodeId: "node-1", attempt: 1, now: 20 });

    await transaction.restoreSavepoint("node-1-attempt-1");

    expect(await readFile(path.join(prepared.workspaceDir, "file.txt"), "utf8")).toBe("baseline");
    await expect(readFile(path.join(prepared.workspaceDir, "metadata.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}
