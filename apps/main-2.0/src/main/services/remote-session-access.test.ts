import { describe, expect, it, vi } from "vitest";

import type { SessionStore } from "../../core/session-store";
import type { SessionSearchResult } from "../../core/types";
import { RemoteSessionAccess } from "./remote-session-access";

const session = {
  sessionKey: "codex-cli:ssh:remote-session",
  rawId: "remote-session",
  source: "codex-cli",
  environmentId: "ssh:test",
  environmentKind: "ssh",
  fileMtimeMs: 123,
  fileSize: 456,
} as SessionSearchResult;

function createAccess(contentFresh: boolean) {
  const isSessionContentFresh = vi.fn(async () => contentFresh);
  const getMessages = vi.fn(async () => [{ role: "assistant" }]);
  const store = {
    getSession: vi.fn(async () => session),
    isSessionContentFresh,
    getMessages,
  } as unknown as SessionStore;
  const runSshCommand = vi.fn(async () => "");
  return {
    access: new RemoteSessionAccess({
      getStore: () => store,
      runSshCommand,
      runSshHealthCommand: vi.fn(async () => ""),
    }),
    getMessages,
    isSessionContentFresh,
    runSshCommand,
  };
}

describe("RemoteSessionAccess", () => {
  it("uses the indexed source version instead of message presence for hydration", async () => {
    const stale = createAccess(false);
    await expect(stale.access.hasHydratedDetails(session.sessionKey)).resolves.toBe(false);
    expect(stale.isSessionContentFresh).toHaveBeenCalledWith(
      session.sessionKey,
      session.fileMtimeMs,
      session.fileSize,
    );
    expect(stale.getMessages).not.toHaveBeenCalled();

    const fresh = createAccess(true);
    await expect(fresh.access.hasHydratedDetails(session.sessionKey)).resolves.toBe(true);
    expect(fresh.getMessages).not.toHaveBeenCalled();
  });

  it("does not fetch an unchanged remote version again", async () => {
    const fresh = createAccess(true);

    await fresh.access.ensureDetails(session.sessionKey);
    await fresh.access.ensureDetails(session.sessionKey);

    expect(fresh.runSshCommand).not.toHaveBeenCalled();
    expect(fresh.isSessionContentFresh).toHaveBeenCalledTimes(2);
  });
});
