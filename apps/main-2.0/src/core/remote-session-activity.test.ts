import { describe, expect, it } from "vitest";
import { loadRemoteLiveSessions } from "./remote-session-activity";
import type { SessionEnvironment } from "./types";

const wslEnvironment: SessionEnvironment = {
  id: "wsl-ubuntu",
  kind: "wsl",
  label: "Ubuntu",
  wslDistribution: "Ubuntu",
  hostAlias: null,
  host: null,
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
  syncState: "idle",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
};

function sshEnvironment(index: number): SessionEnvironment {
  return {
    ...wslEnvironment,
    id: `ssh-${index}`,
    kind: "ssh",
    label: `ssh-${index}`,
    wslDistribution: undefined,
    hostAlias: `ssh-${index}`,
  };
}

describe("remote live session deletion guards", () => {
  it("loads Claude sessions from WSL", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () =>
      '{"family":"claude","rawId":"remote-claude","pid":43}')).resolves.toEqual([
      { family: "claude", rawId: "remote-claude", pid: 43, environmentId: "wsl-ubuntu" },
    ]);
  });

  it("fails closed when WSL inspection fails", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () => {
      throw new Error("offline");
    })).rejects.toThrow("Could not inspect live sessions in WSL environment Ubuntu: offline");
  });

  it("bounds concurrent remote probes", async () => {
    let active = 0;
    let maximumActive = 0;

    await loadRemoteLiveSessions(Array.from({ length: 8 }, (_, index) => sshEnvironment(index)), async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "";
    });

    expect(maximumActive).toBe(3);
  });

  it("does not unlock saved SSH passwords during passive detection", async () => {
    let called = false;

    await expect(loadRemoteLiveSessions([
      { ...sshEnvironment(1), authMode: "password" },
    ], async () => {
      called = true;
      return "";
    })).resolves.toEqual([]);

    expect(called).toBe(false);
  });

  it("includes password-authenticated SSH when a fresh safety check requires it", async () => {
    await expect(loadRemoteLiveSessions([
      { ...sshEnvironment(1), authMode: "password" },
    ], async () => '{"family":"codex","rawId":"remote-codex","pid":42}', {
      includePasswordAuthenticated: true,
    })).resolves.toEqual([
      { family: "codex", rawId: "remote-codex", pid: 42, environmentId: "ssh-1" },
    ]);
  });
});
