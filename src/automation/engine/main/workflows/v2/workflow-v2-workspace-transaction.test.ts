import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

    await writeFile(path.join(sourceDir, "conflict.txt"), "baseline", "utf8");
    await writeFile(path.join(sourceDir, "user-only.txt"), "baseline", "utf8");
    const retried = await transaction.commit();
    expect(retried.conflicts).toEqual([]);
    expect(retried.applied.sort()).toEqual(["apply.txt", "conflict.txt", "created.txt", "delete.txt", "user-only.txt"]);
    expect(await readFile(path.join(sourceDir, "apply.txt"), "utf8")).toBe("workflow");
    expect(await readFile(path.join(sourceDir, "created.txt"), "utf8")).toBe("created by workflow");
    await expect(readFile(path.join(sourceDir, "delete.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}
