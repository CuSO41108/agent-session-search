import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexQuotaCard } from "./quota";
import { loadLiveSessionSnapshot } from "./session-activity";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...childProcessMocks,
}));

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe("background child processes", () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
  });

  it("hides the Windows process used to refresh live sessions", async () => {
    childProcessMocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      (args[3] as ExecFileCallback)(null, "", "");
    });

    await loadLiveSessionSnapshot({ platform: "win32" });

    expect(childProcessMocks.execFile).toHaveBeenCalledOnce();
    expect(childProcessMocks.execFile.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });

  it("hides the PowerShell process used to refresh Codex quota", async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), "agent-recall-background-process-"));
    const authPath = path.join(homeDir, ".codex", "auth.json");
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: "test-access-token", account_id: "test-account-id" },
    }));
    childProcessMocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      (args[3] as ExecFileCallback)(null, JSON.stringify({ plan_type: "plus", rate_limit: {} }), "");
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await loadCodexQuotaCard({ homeDir, env: {} });

      expect(childProcessMocks.execFile).toHaveBeenCalledOnce();
      expect(childProcessMocks.execFile.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
    } finally {
      platformSpy.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
