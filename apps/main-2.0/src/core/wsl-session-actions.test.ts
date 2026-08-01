import { describe, expect, it, vi } from "vitest";
import type { SessionEnvironment } from "./types";
import { deleteWslSessionFiles } from "./wsl-session-actions";

const environment: SessionEnvironment = {
  id: "wsl-ubuntu", kind: "wsl", label: "Ubuntu", wslDistribution: "Ubuntu",
  hostAlias: null, host: null, user: null, port: null, authMode: "none", identityFile: null,
  enabled: true, syncState: "idle", lastSyncedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};

describe("deleteWslSessionFiles", () => {
  it("deletes all paths in one remote command", async () => {
    const run = vi.fn(async (_environment: SessionEnvironment, _command: string) => "");
    await deleteWslSessionFiles(environment, ["/home/me/one.jsonl", "/home/me/two's.jsonl"], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toContain("'/home/me/one.jsonl' '/home/me/two'\"'\"'s.jsonl'");
  });
});
