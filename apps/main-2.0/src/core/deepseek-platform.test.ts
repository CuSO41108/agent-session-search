import { describe, expect, it, vi } from "vitest";
import { defaultSettings, getResumeCommand, openDeepSeekWebInTerminal } from "./platform";
import type { SessionSearchResult } from "./types";

describe("DeepSeek Harness resume", () => {
  it("builds an exact command-line fallback through the TUI profile", () => {
    const session = {
      source: "deepseek-cli",
      rawId: "session-1",
      projectPath: "/repo",
    } as SessionSearchResult;
    expect(getResumeCommand(session, defaultSettings, { platform: "darwin" })).toBe(
      "cd /repo && dsh --profile tui --resume session-1",
    );
  });

  it("starts the DeepSeek web profile in the selected workspace", async () => {
    const runProcess = vi.fn(async () => undefined);
    await openDeepSeekWebInTerminal("/repo", defaultSettings, { platform: "linux", runProcess });
    expect(runProcess).toHaveBeenCalledWith("sh", ["-lc", "cd /repo && dsh --profile web"]);
  });
});
