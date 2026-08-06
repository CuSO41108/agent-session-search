import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OpenVikingHookManifestService } from "./openviking-hook-manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenVikingHookManifestService", () => {
  it("writes only managed workspace credentials to an app-owned mode-0600 manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-manifest-"));
    roots.push(root);
    await chmod(root, 0o700);
    const service = new OpenVikingHookManifestService({
      rootDir: root,
      realpath: async (value) => value,
      credentials: {
        get: async (workspaceId) => workspaceId === "managed"
          ? {
              accountId: "agent-recall-v2",
              userId: "workspace_user",
              apiKey: "workspace-key",
            }
          : null,
      },
      control: {
        listOpenVikingMemoryControls: async (workspaceId) => workspaceId === "managed"
          ? [{
              workspaceId,
              uri: "viking://user/memories/preferences/editor.md",
              memoryType: "preferences",
              authority: "user",
              lifecycle: "active",
              locked: true,
              evidenceStatus: "verified",
              source: "user-edit",
              title: "Editor",
              lockedContent: "Prefer concise diffs.",
              evidenceCount: 2,
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            }]
          : [],
      },
    });

    const manifestPath = await service.write({
      baseUrl: "http://127.0.0.1:21933",
      integrations: { claude: true, codex: false, opencode: true },
      workspaces: [
        workspace("managed", true),
        workspace("retained", false),
      ],
      recallTokenBudget: 1_600,
    });

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.version).toBe(2);
    expect(manifest.workspaces).toEqual([expect.objectContaining({
      id: "managed",
      apiKey: "workspace-key",
      recallTokenBudget: 1_600,
      policyPath: expect.any(String),
    })]);
    const policy = JSON.parse(await readFile(manifest.workspaces[0].policyPath, "utf8"));
    expect(policy).toMatchObject({ version: 2, strict: true, workspaceId: "managed" });
    expect(policy.memories["viking://user/memories/preferences/editor.md"]).toMatchObject({
      authority: "user",
      locked: true,
      lockedContent: "Prefer concise diffs.",
      evidenceStatus: "verified",
    });
    if (process.platform !== "win32") {
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes the active manifest when the application stops", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-manifest-"));
    roots.push(root);
    const service = new OpenVikingHookManifestService({
      rootDir: root,
      realpath: async (value) => value,
      credentials: { get: async () => null },
      control: { listOpenVikingMemoryControls: async () => [] },
    });
    const manifestPath = await service.write({
      baseUrl: "http://127.0.0.1:21933",
      integrations: { claude: false, codex: true, opencode: false },
      workspaces: [],
      recallTokenBudget: 1_200,
    });

    await service.clear();

    await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function workspace(id: string, managed: boolean) {
  return {
    id,
    userId: `user_${id}`,
    rootPath: `/projects/${id}`,
    identity: `path:${id}`,
    displayName: id,
    managed,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}
